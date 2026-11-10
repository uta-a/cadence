# Discord 352.17 の設定保存 API（静的調査）

## 状態

本文のDEX/HBC契約は静的調査に基づく。後続のPhase 3では自然ロード済み1164からcontrollerを初期化し、private pathのschema2設定を実機UIで変更→write/read-back→cold restart後に復元した。元のオフ状態へ戻した後も保存・再起動復元を確認済み。現在のentryは`read-only-settings.ts`ではなく`settings-controller.ts`を使う。生成時にはnativeを呼ばず、loadは現在のJS stack終了後に開始する。[Phase 3記録](PHASE3.md)を参照。

これはnativeのdisk-full・電源断・rename成功・耐久性の保証ではない。負のケースと再試行は単体テストで確認し、実機での故障注入はしていない。以下の未検証事項はこの範囲で読む。

## 入力と再現

Discord **352.17 - Stable** の `work/352.17/apks/base.apk`。

| 入力 | SHA-256 |
| --- | --- |
| base.apk | `852c6adead130fc7965c7014b07201f3cd5c25c2c5061635025bd7c34f4b40da` |
| classes.dex | `3efc30958ce4de776f1240448e3ee7c99061928b70b2ed158c8eb04f9b0458be` |
| classes3.dex | `0bd095f296bf126d1196aa77373a5d5467f01e3ee65e01461f6137aee21d2edc` |

APK 内の2 DEX と `work/352.17/dex/` の抽出結果はバイト単位で一致した。
JADX 1.5.6 の対象クラス出力と dexlib2 の命令を照合した。**以下の DEX offset はメソッド内の
十進 code unit（16 bit）**。HBC の関数内バイト offset とは単位が違う。

```sh
# 読み取り専用の DEX 証拠テスト。対象 APK がなければ明示的に skip。
GITHUB_ACTOR=<user> GITHUB_TOKEN=$(gh auth token) ./gradlew :patches:test \
  --tests app.disk.patches.FileStorageContractTest

# 補助的な decompile（命令の正確性は上記テストを優先する）
mkdir -p work/352.17/research/native-file
jadx -r --single-class com.discord.file_manager.FileModule \
  --single-class-output work/352.17/research/native-file/FileModule.java \
  work/352.17/dex/classes.dex
# 同様に NativeFileModuleSpec、sb.o、ey.j、h40.a、h40.w を追跡できる。
# ey.j / h40.a / h40.w の定義は classes3.dex。
```

## JS と native の境界

JS module **1164 → factory 1165** は `TurboModuleRegistry.getEnforcing("NativeFileModule")` を
`exports.default` に入れる（`1165:72,102`）。default の関数呼び出しではない。

`com.discord.codegen.NativeFileModuleSpec` は `NAME="NativeFileModule"`、各メソッドに
`@ReactMethod` を持つ。DEX の最後の Promise 引数は bridge が扱うので、JS 側からは渡さない。

| JS API（静的契約） | native 実装 |
| --- | --- |
| `getConstants()` → `{DocumentsDirPath, CacheDirPath}` | spec の getConstants が FileModule.getTypedExportedConstants へ委譲 |
| `fileExists(absolutePath)` → Promise<boolean> | FileModule → `androidx.lifecycle.q` の branch 8 → `File.exists()` |
| `readFile(absolutePath, "utf8")` → Promise<string> | FileModule → `ey.j` branch 5。root 引数はない |
| `writeFile("documents", relativePath, data, "utf8")` → Promise<absolutePath> | FileModule → `sb.o`。4文字列の順序に注意 |
| `readAsset(assetUri, encoding)` | 今回 DEX で存在を確認。ただし disk 保存アダプターでは使用しない |

`readAsset` は以前の HBC 調査だけでは存在を確認できなかったが、今回の DEX spec / FileModule で
確認できた。アセット・URI 読み込み API であり、disk-v1 コマンド用の通信路ではない。

### private root

`FileModule.<init>:41` は `Context.getFilesDir()`、`:51` の `"documents"` と対応する。
`getTypedExportedConstants:2,13` が同じ値を `DocumentsDirPath` として公開する。
`"cache"` は `Context.getCacheDir()`。

アダプターは native の constants を取得し、現在の固定パッケージについて標準的な
`/data/user/<数字>/com.discord/files` または `/data/data/com.discord/files` だけを受け入れる。
**これらの実端末上の値を確認したわけではない。** 別の root / package はフォールバックせず失敗させる。
アクセス対象は固定の **`disk/settings-v1.json`** のみ。呼び出し側から任意の path / root は受け取らない。
この名前は disk が予約する候補であり、全設定ファイルとの衝突や symlink の不存在を保証するものではない。

### 書き込みの注意点

`sb.o.invokeSuspend` は root に相対 path を結合して処理する。

- `:86` は `".tmp"`。最終 path に `.tmp` を足したファイルへ書く。
- `:121` は parent の `mkdirs()`。失敗時に Promise.reject するが、その後の処理が継続する経路がある。
- `:165` の `"base64"` 以外は UTF-8。`:184` の `h40.a.a` は `h40.a.<clinit>:0,11` の UTF-8 Charset。
- `:202` で FileDescriptor.sync、`:205` で close。
- **`:208` の File.renameTo の boolean を捨て、`:211` で最終 path を読み、`:215` で resolve する。**
  rename に失敗しても成功として返る場合がある。resolve だけを永続化成功の根拠にしない。

そのためアダプターは writeFile の戻り値が想定 absolute path と一致することを確認し、
同じファイルを readFile で読み直して、書いた文字列と完全一致した場合だけ成功とする。
不一致・型違い・native rejection は呼び出し元へ返す。読み戻しは**最終内容が異なる** silent rename failure の検出用。
既存内容が今回と同一なら rename に失敗しても比較は成功する。最終内容の一致を確認するだけであり、
rename 自体の成功、電源断時の耐久性、directory fsync、複数プロセス競合まで保証しない。
設定ストアの保存キューで直列に使用することを前提とし、同じ path に複数 writer を置かない。

### 読み込みと helper を使わない理由

`ey.j.invokeSuspend` branch 5 の `:910,913` は absolute filename から FileInputStream を開き、
`:927` の `"base64"` 以外を `:945` の `h40.w.H0` で UTF-8 decode する。
エラーは `:961` の Promise.reject(Throwable) に流れる。

JS helper **8728** の readFile は root の解決・fileExists・ログ処理を含み、Android でエラーを
ログにして undefined を返す経路がある（HBC `145829:196..264`）。
helper が握りつぶす rejection を設定コアへ伝えるため、アダプターは helper を使わず、
fileExists が **厳密に false の場合だけ null** を返す。ただし native の File.exists() 自体が
アクセス不能などを false にする場合、実際の missing と区別できない。UTF-8 decode も
new String(bytes, charset) であり、不正バイト列が必ず rejection になるわけではない。
これらを厳密に区別するには別の native 契約が必要。返却文字列と入力は 65,536 UTF-16 code unit まで。
native 側のファイル読込量を制限するものではない。

## 検証の範囲 / 次の条件

- `FileStorageContractTest` は入力 DEX の SHA-256、spec 引数、private root、encoding と rename の命令を検証する。
- `runtime/test/storage.test.mjs` は mock native で固定 path、receiver、誤った shape/root/結果の拒否と読み戻しを検証する。
- `runtime/test/core-compile.test.mjs` は未接続のloader/settings/storageを隔離bundleにまとめ、HBC98へコンパイルできることを確認する。コードの実行やnative検証は行わない。
- 初回静的調査ではnative実行・端末操作なし。後続検証でデータ保持更新と読み取り専用bootstrapを実行した。
  disk設定の作成・変更・削除はしていない。readyだけではreadFileが実行されたかは区別できない。
- 接続前に、自然に初期化済みの native export / getConstants の実形、起動順、初回の missing / read / write / failed write を
  許可された隔離環境で確認する必要がある。アクセス不能が false になる場合・不正 UTF-8 の場合の扱いも確認し、
  既存ファイルを誤って missing として上書きするリスクを接続前に再評価する。
  root guard を緩めたり eager require で回避したりしない。
