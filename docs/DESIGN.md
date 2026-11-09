# disk 設計書 (draft v0.1)

Discord Android 向けの Morphe パッチバンドル。Fake Nitro、Platform Indicator、プライバシー保護などをオフラインで追加する。
[Venus Patches](https://github.com/VenusIsJaded/Venus-Patches) のアーキテクチャを参考にするが、コードは一から書く。

---

## 1. 目標と非目標

### 目標
- Morphe Manager に「ソース」として追加し、元の Discord APKM にパッチを当てて使えること
- 機能はすべて**オフライン・端末内**で動く。外部サーバーへの通信は追加しない（必要な機能だけ例外として明記する）
- 機能は Morphe 側で選んで組み込み、Discord 内の **disk 設定画面** でオン/オフを切り替える。初期状態はすべてオフ
- 対応バージョンの Discord では確実に動くこと。合わない場合は Discord を壊さずに**フェイルオープン**する（disk が無効になるだけで、Discord はそのまま起動する）

### 非目標（v0.1 時点）
- 複数の Discord バージョンへの同時対応（1 バージョン固定で始める）
- プラグインストアやリモートからのコード読み込み（Vendetta / Revenge のような汎用クライアント MOD にはしない）
- iOS 対応

---

## 2. 前提：Discord Android の構造

| 項目 | 内容 |
| --- | --- |
| UI | React Native（Bridgeless モード） |
| JS エンジン | Hermes。`assets/index.android.bundle` は **HBC98**（コンパイル済みバイトコード） |
| モジュール | Metro バンドル。`__d(factory, id, deps)` で約 17.7k 個のモジュールが登録される。ID は数値で、**ビルドごとに変わる** |
| ネイティブ | Kotlin/Java（DEX）。チャット一覧の描画、メディア、通知、Sentry、AppsFlyer など |
| 配布形式 | APKM（split APK） |

JS バンドルはソースではなくバイトコードなので、テキストを書き換えて機能を足すことはできない。ここが設計上の一番の制約になる。

---

## 3. 全体アーキテクチャ

```
┌───────────────────────── Morphe パッチバンドル (.mpp) ─────────────────────────┐
│                                                                                │
│  patches/  (Kotlin)                                                            │
│   ├─ RuntimeInjection   … disk ランタイムを HBC の global #0 に注入            │
│   ├─ BundlePin          … OTA バンドルを無効化し、APK 同梱バンドルに固定       │
│   ├─ NativeBridge       … JS↔ネイティブの通信路（既存ネイティブメソッドに仕込む）│
│   ├─ Feature patches    … Fake Nitro / Platform Indicator など（機能フラグを立てる）│
│   └─ Privacy patches    … DEX トラッカーのスタブ化 (Sentry, AppsFlyer, AdId)   │
│                                                                                │
│  resources/disk/runtime.js   ← runtime/ (TypeScript) をビルドしたもの          │
│                                                                                │
│  extensions/ (Kotlin, 任意) … ネイティブ側の補助コード（APK の DEX に追加される）│
└────────────────────────────────────────────────────────────────────────────────┘
                     │  Morphe Manager がパッチ時（端末上）に実行
                     ▼
┌──────────────────────────── パッチ後の Discord ────────────────────────────────┐
│ index.android.bundle                                                           │
│   global #0 の先頭: [disk prelude] → eval(runtime) → 元の Discord コード       │
│                                                                                │
│ disk runtime (JS)                                                              │
│   ├─ core/loader     … __d をラップし、対象モジュールの exports を差し替える    │
│   ├─ core/modules    … バージョン固定のモジュール ID 表と形チェック             │
│   ├─ core/settings   … 設定の保存・読み込み・変更通知                          │
│   ├─ core/ui         … Discord 設定画面に「disk」セクションを追加               │
│   └─ features/*      … 機能ごとのフック                                        │
└────────────────────────────────────────────────────────────────────────────────┘
```

処理は 3 層に分ける。

1. **Morphe パッチ（Kotlin）**: APK を書き換える層。パッチ時に端末上で一度だけ実行される
2. **disk ランタイム（JS）**: Discord の JS 内で動く層。機能の中身はほぼすべてここに置く
3. **extensions（Kotlin、任意）**: JS だけでは実現できないネイティブ処理。v0.1 では最小限にする

---

## 4. ランタイム注入（最重要・最難関）

### 4.1 方式の比較

| 方式 | 判断 | 理由 |
| --- | --- | --- |
| A. 別バンドルを先に読み込む | ✗ | Bridgeless では RN が早く ready になり、`AppRegistry` 登録前にネイティブ呼び出しが流れて壊れる（Venus が確認済み） |
| B. バンドルを JS に戻して再ビルド | ✗ | HBC の逆コンパイルは完全ではない。サイズも時間も現実的でない |
| C. **global #0 の先頭に prelude バイトコードを挿入し、ランタイムを `eval` する** | ◎ 採用 | 読み込むバンドルは 1 つのまま。Discord のモジュール定義より先に `__d` をラップできる |
| D. prelude からネイティブ経由でアセットを同期読み込みして `eval` | △ 調査枠 | prelude が小さくなりパッチも速くなるが、global #0 の時点で同期読み込みできるネイティブ API があるか未確認 |

### 4.2 方式 C の手順（パッチ時、`HbcInjector.kt`）

1. HBC ヘッダを検証する（version == 98、関数数、ファイル長）。global #0 本体の SHA-256 を**固定値と照合**し、違えばパッチを中止する
2. ランタイム文字列を、**バンドルの文字列テーブルに既にある短い文字列の連結**として表現する
   - 文字列テーブルを書き換えると後ろのオフセットがすべてずれるため、テーブルには手を付けない
   - 最初は貪欲法で実装し、prelude サイズが問題になってから DP（最少ピース数）に置き換える
3. prelude バイトコードを生成する: `NewArray` → 各ピースを `LoadConstString` + `DefineOwnInDenseArray` → `Array.prototype.join("")` → `GetGlobalObject` → 間接 `eval`
   - フレームサイズ（`frameSize`）は元の関数のまま変えない。Hermes は呼び出し引数をフレーム末尾の 9 枠に置くため、サイズを変えると元コードの `Call` がすべてずれる
   - prelude は r0..r8 だけを使い、成功・例外の両方の出口で r0..r8 とフレーム末尾 9 枠を 0 に戻してから元の本体へ入る。`frameSize >= 18`（9 ローカル + 7 metadata + this + 引数 1）でなければ注入しない
4. prelude 全体を **try/catch（例外テーブル）** で囲む。ランタイムが失敗しても元の Discord コードはそのまま続行する（フェイルオープン）
5. `[prelude][元の global #0 本体]` をファイル末尾に再配置し、関数ヘッダ（拡張ヘッダ・例外ハンドラ数・サイズ・フラグ）を更新する
   - `SwitchImm` のジャンプテーブルは `bodySize` の外（本体の直後）にある。次関数・debug info・ファイル末尾で検証した境界までの範囲をコピーし、元の本体が元と同じ絶対位置 mod 4 から始まるように prelude をパディングする（テーブルは絶対 4 バイト境界で読まれる）
6. ファイル長を更新し、末尾の SHA-1 フッタを再計算する

prelude が使う定数（global #0 のオフセット、サイズ、ハッシュ、`join` と `eval` の文字列 ID）は `HbcTarget.kt` にバージョンごとにまとめ、移植ツールで自動生成する。

### 4.3 起動時コストの抑え方
- ランタイムは「すぐ実行するヘッダ」と「機能本体」に分ける。機能本体は文字列のまま持ち、使うときに初めて `eval` する
- `__d` ラッパーは全モジュール分呼ばれるので、判定は `Uint8Array` の添字参照 1 回だけにする

### 4.4 OTA バンドルの固定（`BundlePinPatch.kt` / `dex/BundlePin.kt`）

注入した prelude は **APK 同梱の `assets/index.android.bundle`** にしか入っていない。しかし Discord は
OTA バンドルをダウンロードして SharedPreferences に記録し、起動時にそちらを読み込むことがある。
そのままだと、OTA がコミット済みの端末では disk が読み込まれない。`bundle pin` パッチは
バンドル選択を APK 同梱側に固定する。`disk` パッチは `bundle pin` に依存する。

#### 352.17 で確認した実装（DEX 実測）

| 要素 | 内容 |
| --- | --- |
| 選択関数 | `Lw6/z;->i()Lw6/v;`。`key_android_js_bundle` / `key_android_js_bundle_release_name` / `ota_version` を SharedPreferences から読み、有効な OTA バンドル（`Lw6/v;` = `File` + releaseName）または `null` を返す |
| 呼び出し元 | `Ld6/a;->invoke()`（Bridgeless の `ReactHostImpl` 生成）、`Ldl/o;->a()`（旧 `ReactInstanceManager` のビルダー）、`Lu5/b;->call()`（Sentry の release 名）、`Lw6/z;->j()`（manifest 情報） |
| ローダ選択 | `Ld6/a` は OTA バンドルが `null` のとき `JSBundleLoader.createAssetLoader(context, "assets://index.android.bundle", true)`、非 `null` のとき `createFileLoader(path)`。`Ldl/o` も `null` のとき `assets://index.android.bundle` を使う |
| null の扱い | 4 つの呼び出し元すべてが `null` を許容する。`z.j()` の `null` は `BundleUpdaterManager.getManifestInfo` が同梱 manifest を読む経路、`u5/b` は Sentry の既定 release 名にフォールバックする |

#### パッチ内容

`Lw6/z;->i()` の本体を `const/4 v0, 0` + `return-object v0` に置き換える。フレームは 7 レジスタのまま
変えない（この本体置換ではフレームを変える必要がない）。元コードの debug items は全 location
（末尾 sentinel を含む）から削除し、短縮した本体に古い行番号やローカル変数情報を残さない。これで両方のホストビルダーが
「OTA バンドル無し」の分岐に入り、APK 同梱バンドルを読む。

#### ガード（`BundlePin.verify`）

すべて `PatchException` で失敗し、**メソッドを書き換える前に**停止する（`verify` は読み取りのみ）。

1. クラス/フィールド: `Lw6/z;` の superclass と `a` / `c` / `q` の型・修飾子
2. メソッド: `i()Lw6/v;` が public final、7 レジスタ、例外ハンドラ無し
3. 命令列: `i()` の全命令をシグネチャ（opcode・レジスタ・**invoke の active registerCount**・
   リテラル・参照・分岐先）で完全一致。35c は C〜G の全スロットに加えて active count を比較する。
   既にパッチ済みの 2 命令も受理するので、パッチ済み DEX への再実行は no-op になる
4. 呼び出し元: 下表の **5 メソッド全体**を semantic SHA-256 で完全一致。旧ウィンドウの前後を含み、
   access flags・レジスタ数・全命令・switch payload の key/相対 offset・try 範囲・catch の型と順序と
   handler address を固定する。`i()` の実際の全 4 呼び出し元に加え、`j()` の null を消費する
   `getManifestInfo(Promise)` も対象とする

| メソッド | registers / code end（code units） | null 経路（元 DEX の PC） |
| --- | --- | --- |
| `Ld6/a;->invoke()Object` | 13 / 366 | 初期 v1=null (2)、`i()` (174)、null 分岐 (178→186)、同梱アセット生成 (223〜229)、delegate にローダを渡す (245) |
| `Ldl/o;->a()V` | 14 / 349 | `i()` (82)、null 分岐 (87→96)、同梱パスを `n.b` に設定 (129〜137)、**`n.b` を取得 (246)**、asset loader 生成 (291) |
| `Lu5/b;->call()Object` | 12 / 602 | `i()` (20)、null 分岐 (24→33)、既定 release `discord_android@352.17.0-0+352017` (33) |
| `Lw6/z;->j()String` | 19 / 223 | `i()` (0)、v1=null (4)、null 分岐 (5→220)、v1 を返す (222) |
| `BundleUpdaterManager.getManifestInfo(Promise)V` | 9 / 161 | `j()` (11)、null 分岐 (16→48→49→61)、AssetManager から同梱 manifest を読む (61〜63) |

#### 固定値の出所と再計算

元の **352.17 - Stable** の `work/352.17/apks/base.apk` を読み取り専用で調べた値のみを使用する。
他のパッチの実装や正規表現による推測からは生成していない。

- base.apk SHA-256: `852c6adead130fc7965c7014b07201f3cd5c25c2c5061635025bd7c34f4b40da`
- その `classes.dex` SHA-256: `3efc30958ce4de776f1240448e3ee7c99061928b70b2ed158c8eb04f9b0458be`
  （ローカルの抽出済み `classes.dex` も同値）
- 全 DEX の method reference を調べ、`Lw6/z;->i()Lw6/v;` への実呼び出しが上記 4 メソッドにあることを確認。
  PC・active count・debug を含む調査出力はローカルの `/tmp/disk-dex-evidence.txt`、
  canonical 出力は `/tmp/disk-bundle-pin-snapshots.txt`（調査用。テストやビルドはこれらに依存しない）。

`BundlePin.semanticSnapshot(method)` の文字列を UTF-8 にして SHA-256 を計算したものが
`semanticDigest` / `CALLERS` の値になる。スナップショットは LF 区切り、最後にも LF がある。
先頭は `class->name(parameterTypes)ReturnType`、次は `access=N registers=N`。
各命令は `PC/codeUnits signature`、末尾は `end=N`、続いて DEX 順の `try=start/count` と
`catch=type->address`（catch-all は `*`）。signature は `signatures` と共通で、参照は pool index ではなく
型・名前・引数型、分岐は絶対 PC、switch payload は `cases=key:relativeOffset,...` とする。
デバッグ行番号・source file・pool 順序は意味論ではないためハッシュに含めない。

| メソッド | semantic SHA-256 |
| --- | --- |
| `Ld6/a;->invoke` | `5edcb77dd3bb8af517a24b595f671dcb3fb98d2e17b85c7f5709230dda7fafc2` |
| `Ldl/o;->a` | `5205f1722374917bc80c778970856f2fdeaa02a0e3c54c47eed317ad6cc97715` |
| `Lu5/b;->call` | `f034e603d4e6d7a038f1a6b1b4e2179dc7b908f349875c4d1cc4e0e81be7b4c7` |
| `Lw6/z;->j` | `07613a503beeb4501a6317e7b4614c4a83fe09e8b22ea6c47e60bed06169fd29` |
| `BundleUpdaterManager.getManifestInfo` | `0b69d0e33bb209997a16794238a4e40e04d303ccb641ece749d8a419cfe3612c` |

元 DEX を置き、次のテストを実行すると全 5 個の実測 digest が標準出力に出る（不一致でも値は
例外メッセージに出る）。`i()` のリストは `BundlePin.signatures(implementation)` の出力と照合する。
バージョン更新時はハッシュの置換だけで済ませず、全命令と null 経路を再レビューする。
`tools/` の移植ツールには依存しない。

```bash
GITHUB_ACTOR=<user> GITHUB_TOKEN=$(gh auth token) ./gradlew :patches:test \
  --tests 'app.disk.patches.BundlePinTest.guards accept the packaged Discord layout' --rerun-tasks
```

#### debug items の短縮・書き出し検証

実測（dexlib2 `4220ae75f7`、address は code units）。古い「命令だけ削除」方式は debug を削除した
命令の location から末尾へ集約する。DexPool が一部を落としても、残った行番号は新しい本体の意味と
対応しないため、writer による補正には依存せず、置換前に明示的にすべて削除する。

| 状態 | debug 件数 | min / max / code end |
| --- | --- | --- |
| 元 `i()` | 63 | 0 / 62 / 63 |
| 旧方式の短縮直後 | 63 | 0 / 2 / 2（末尾は命令外） |
| 旧方式の DexPool 再読込後 | 4 | 0 / 1 / 2（範囲内だが古い行番号） |
| 修正後の短縮直後 | 0 | なし / なし / 2 |
| 修正後の DexPool 再読込後 | 0 | なし / なし / 2 |

`BundlePinTest` は元の min/max/end と、修正後・DexPool 再読込後の debug が空かつ命令範囲外の
address がないことを確認する。末尾 sentinel に debug を加えたケースも検証する。

#### 既知の制約・未対応

- このガードは対象メソッドと明記したフィールドの固定であり、APK 全体の真正性検証ではない。
  新たに追加された別の callsite や呼び出す helper/loader 自体の改変まで全 DEX を走査して検証しない。
  同じバージョン名でも対象メソッドを改変する他パッチとは併用できない（共有 lambda の別 case の変更も拒否）。
- 起動時の OTA チェックは**止めていない**。`Lsf/b;->h()`（"Checking for blocking OTA update" を出して
  `Lw6/z;->b()` の結果を同期的に待つ静的メソッド。呼び出し元は共有ラムダ `Lnf/c` の case で、どの
  画面遷移から呼ばれるかは未特定）、`Lsf/b;->i()`（`Ldl/g;->onCreate` から呼ばれ、10 秒後に遅延チェックを
  投入する）、JS からの `BundleUpdaterManager.checkForUpdateAndReload` は今もダウンロードを試みる。
  ただし読み込まれるのは常に APK 同梱バンドルで、ダウンロード済み OTA は使われない。停止するなら
  `Lw6/z;->b()` を潰すのではなく各呼び出し箇所を個別に無効化する。`b()` を潰すと
  `checkForUpdateAndReload` のスピナー解除と reload がコールバック側にあるため UI が止まる。
  なお、`checkForUpdateAndReload` の再読み込みは `ProcessPhoenix` によるプロセス再起動で、再起動後も
  `i()` は null を返すため、この経路でも同梱バンドルが読まれる。判断は実機で呼び出し元の意味論を
  確認してから行う。
- `i()` が SharedPreferences を読まなくなるため、OTA の状態表示（manifest 情報）は常に APK 同梱側を指す。
- **実機未検証**。パッチ済み APK の起動と `adb logcat` の `[disk] loaded` は Phase 2 の完了条件として残る。
- Discord が更新されたら、まず `BundlePinTest` を実行してガードの失敗箇所を確認する。

---

## 5. disk ランタイム（JS）

### 5.1 言語とビルド
- ソースは **TypeScript** で書き、`runtime/` 以下に機能ごとのファイルに分ける（Venus は 23k 行の単一ファイル）
- esbuild で 1 ファイルにまとめ、Hermes が対応する構文まで下げる（class / async / ES2015+ の一部は要確認）。ASCII のみで出力する
- ビルド時に固定バージョンの `hermesc` でコンパイルし、HBC として有効であることを確認する

### 5.2 モジュールフック（`core/loader`）
```ts
// 概念コード
const targets = new Uint8Array(32768);          // 対象モジュール ID
global.__d = wrap(global.__d);                  // Metro より先に設定されていれば getter で待つ
function wrap(define) {
  return (factory, id, deps) => {
    if (targets[id] !== 1) return define(factory, id, deps);
    return define(function (...args) {
      const r = factory.apply(this, args);
      const module = args[4];                   // Metro factory ABI: (global, require, importDefault, importAll, module, exports, deps)
      onModuleReady(id, module);                // ここで exports を差し替える
      return r;
    }, id, deps);
  };
}
```
- 初期化の安全な境界が確認できるまでは差し替えを保留する。244 の factory 完了だけで一括適用する設計は未検証
- 機能ごとのフックは try/catch で囲む。1 つ失敗しても、その機能が無効になるだけで済むようにする

**Phase 3 実装状況:** `runtime/src/core/loader.ts` に ID 未接続のローダー基盤を実装した。Node で遅延 `__d`、factory の戻り値と `this`、元の例外の伝播、hook の例外分離、関数型 RN 初期化ゲートを検証した。352.17 の AppRegistry 初期化候補 module 244 は `AppRegistry` の named export であり **関数型 default export ではない**。このゲートをそのまま接続してはいけない。初期化完了の境界と exports の実機確認が済むまで `runtime/src/index.ts` からはローダーを使用せず、Discord の起動に影響を与えない。

### 5.3 モジュール ID 表（`core/modules`）
- ID はビルドごとに変わる。`runtime/modules/352.17.json` は静的候補と証拠の台帳で、**全件 `verified: false`**。実装用の承認済み ID 表ではない
  ```json
  { "EmojiStore": { "id": 6757, "shape": ["default.getCustomEmojiById"], "verified": false } }
  ```
- `shape` は `require(id)` 基準の**検証予定パス**。getter / prototype の違いと起動順を確認するまで実際のモジュールを差し替えない
- 実行時に全モジュールを走査して探すことはしない（起動が遅くなるため）。探索は開発時のツールで行う（§9）

### 5.4 設定（`core/settings`）
- v1 は `{ version: 1, features: { fakeNitro: false, platformIndicator: false } }` の JSON 1 ファイルを想定する。保存先・Discord のネイティブ契約は未検証で、永続化アダプターは接続しない。機能オプションを追加する場合はスキーマを明示的に更新する
- 変更は購読者（React フック `useSetting`）に通知する。再起動が必要な機能だけ再起動を促す
- パッチ時に組み込まれた機能（`/*__DISK_FEATURES__*/` に Kotlin 側が埋め込む）以外は、設定画面に表示しない

**設定コアの進捗:** `runtime/src/core/settings.ts` で既知機能だけの allowlist と初期オフ、連続トグルの保存順序・失敗後の再試行を単体テスト済み。保存先と native method 署名は未確定で、I/O アダプターは未接続。ストアは Discord のアカウント情報を読まない。

### 5.5 設定 UI（`core/ui`）
- Discord の設定画面に「disk」セクションを追加したいが、category の挿入箇所は未特定。15865 の renderer registry は freeze されており、単純な追記では実現しない
- 画面は Discord 自身のコンポーネント（TableRow、Switch など）を使い、見た目を揃える
- 構成: 機能一覧 → 各機能の詳細オプション → 情報（バージョン、ログ表示）

---

## 6. 機能（v0.1）

### 6.1 Fake Nitro
Nitro がなくても、Nitro 限定の絵文字やスタンプを**画像リンクとして**送れるようにする。

| 処理 | 方法 |
| --- | --- |
| ピッカーで選べるようにする | 絵文字の利用可否を判定する関数（他サーバーの絵文字・アニメ絵文字・スタンプ）をフックし、「使える」と返す |
| 送信時の変換 | メッセージ送信関数をフックする。自分が使えない `<:name:id>` / `<a:name:id>` を `https://cdn.discordapp.com/emojis/{id}.{webp\|gif}?size={n}&name={name}` に置き換える |
| スタンプ | 使えないスタンプは送信をやめ、`https://media.discordapp.net/stickers/{id}.{png\|gif}?size=160` をメッセージとして送る |
| オプション | 絵文字 / スタンプのオン・オフ、サイズ（48 / 64 / 96 / 128）、マスクドリンク `[name](url)` にするか |

- 判定は**送信時**に行う。そのサーバーで使える絵文字はそのまま送る
- 2000 文字の上限を超えそうなときは、変換しない絵文字を残すか、警告を出す

### 6.2 Platform Indicator
相手がどのデバイスで接続しているか（デスクトップ / モバイル / Web / コンソール）をアイコンで表示する。

- データ元: PresenceStore の `getClientStatus(userId)` → `{ desktop?, mobile?, web?, embedded? }`（値はオンライン状態）
- 表示する場所（個別にオン/オフ可能）: メンバー一覧、DM 一覧、チャットのヘッダ、プロフィール、メッセージの名前の横
- アイコンは Discord が持っているアイコンコンポーネントを流用し、色はステータス色に合わせる
- PresenceStore の変更を購読し、再描画は対象の行だけに限る

### 6.3 Privacy
Morphe 側で選択（初期状態で選択済み）し、Discord 内の設定はない。

| パッチ | 層 | 方法 |
| --- | --- | --- |
| Disable analytics | JS | analytics の `track` 系 exports を何もしない関数に差し替える。v0.2 で HBC 関数のスタブ化（起動直後の分も止める）に移行するか検討 |
| Disable crash reporting | DEX | Sentry の初期化メソッドを `return-void` にする |
| Disable install attribution | DEX | AppsFlyer の起動処理をスタブ化する |
| Disable advertising ID | DEX | 広告 ID の取得を `null` 返しにする |

JS 層の方法はランタイムが動いていることが前提なので、Morphe の依存関係で RuntimeInjection を必須にする。

### 6.4 v0.2 以降の候補
優先度順。決まったら個別に設計を追記する。

- Platform spoof（アカウント停止のリスクがあるため、警告付き）
- NoDelete（削除・編集されたメッセージを残す）
- Hidden channels（見られないチャンネルを鍵付きで表示）
- Hide typing（入力中を送らない）
- Custom branding（パッケージ名を変えて公式 Discord と共存させる）

---

## 7. JS ↔ ネイティブ通信（`NativeBridge`）

**未設計・未実装。** 静的調査で module 1164 の `default` が `NativeFileModule`、helper 8728 が `readFile` / `writeFile` を使うことだけ確認した。ネイティブ署名、保存可能な root、専用 path、エラー時の動作は未確認。`FileModule.readAsset` は根拠がなく、実装の前提にしない。

- v0.1 の設定保存は既存 API で安全な専用 path を確保できるか先に調べる
- 既存 API で足りない場合に限り、DEX に分岐を加える方式と失敗時の安全性を再設計する

---

## 8. リポジトリ構成（予定のファイルを含む）

```
disk/
├─ patches/                     Kotlin: Morphe パッチ
│  └─ src/main/kotlin/app/disk/patches/
│     ├─ Compatibility.kt       対応する Discord（パッケージ名、バージョン）
│     ├─ hbc/HbcFile.kt         HBC98 の読み込み（ヘッダ、関数、文字列）
│     ├─ hbc/HbcInjector.kt     prelude の生成と注入
│     ├─ hbc/HbcTarget.kt       バージョン固定の定数（ツールで生成）
│     ├─ RuntimePatch.kt        ランタイム注入 + 機能フラグ埋め込み
│     ├─ BundlePinPatch.kt      OTA の読み込み先を同梱バンドルに固定（更新チェック自体は止めない）
│     ├─ dex/BundlePin.kt       OTA バンドル選択の検証（クラス・命令列・ローダ選択）と書き換え
│     ├─ FeaturePatches.kt      Fake Nitro / Platform Indicator など
│     └─ PrivacyPatches.kt
├─ extensions/                  Kotlin: APK に追加するネイティブコード（任意）
├─ runtime/                     TypeScript: disk ランタイム
│  ├─ src/core/{loader,modules,settings,ui,log}.ts
│  ├─ src/features/{fakeNitro,platformIndicator,privacy}.ts
│  ├─ modules/352.17.json       モジュール ID 表
│  └─ test/                     Node 上のユニットテスト（モジュールはモック）
├─ tools/                       開発・移植用ツール（Python）
│  ├─ extract.py                APKM → base.apk / index.android.bundle
│  ├─ hbc_inspect.py            HBC の解析（関数、文字列、モジュール定義の一覧）
│  ├─ find_module.py            文字列リテラルや export 名からモジュール ID を探す
│  └─ gen_target.py             HbcTarget.kt の定数を生成
├─ docs/DESIGN.md
├─ work/                        APK などの作業ファイル（.gitignore で除外）
├─ build.gradle.kts / settings.gradle.kts
└─ LICENSE
```

### ビルド
- Morphe 公式の [morphe-patches-template](https://github.com/MorpheApp/morphe-patches-template)（Gradle プラグイン）を使う。GitHub Packages の PAT（`read:packages`）が必要
- Gradle タスクの前段で `runtime/` をビルドし、`patches/src/main/resources/disk/runtime.js` に出力する
- GitHub Actions でタグを付けると `.mpp` をビルドして Release に公開し、`patches-bundle.json` を更新する

---

## 9. 移植（Discord のバージョンアップへの追従）

対応バージョンを変えると、固定値をすべて更新する必要がある。ツールで半自動化する。

1. `tools/extract.py Discord-NEW.apkm` → `work/<ver>/`
2. `tools/gen_target.py` → `HbcTarget.kt`（global #0 のオフセット、ハッシュ、文字列 ID）
3. `tools/find_module.py` → 前のバージョンの表の各モジュールについて、文字列や export 名から候補を探す → `modules/<ver>.json`
4. DEX フックはクラス名とシグネチャで指定（Morphe の Fingerprint）。変わっていればパッチ時にエラーで止まる
5. 実機で全機能を確認する

**最初の対応バージョンは 352.17（2026-11 時点の Play ストア最新版）にする。** Venus（351.11）の ID とは照合できないので、ツールの結果はモジュールの exports の形と、実機で `require` した結果で検証する。

開発用の APK は端末の Play ストア版から `adb pull` する（`work/352.17/apks/`）。Morphe Manager でのパッチには APKM が必要なので、配布時は APKMirror の 352.17 APKM を使う。

---

## 10. テスト

| 種類 | 内容 | どこで |
| --- | --- | --- |
| ランタイム ユニット | Fake Nitro の変換、設定の保存と検証など純粋なロジック | Node（CI） |
| HBC 構文 | ビルドしたランタイムが `hermesc` で HBC98 にコンパイルできる | CI |
| 注入 | 実バンドルに注入 → HBC として正しいか検証。Hermes VM で global #0 を実行し、prelude が動くか確認 | ローカル（APK はコミットしない） |
| DEX ガード | `bundle pin` の対象クラス・命令列・ローダ選択の検証、`return null` への書き換え、DEX への書き出しと再読込 | `:patches:test`（実 DEX が無ければ skip） |
| 実機 | パッチ → インストール → 各機能の確認 | 手動 |

---

## 11. フェーズ

各フェーズは完了条件を満たしてから次に進む。Phase 4 の 3 機能は Phase 3 の完了後なら並行して進められる。

```
Phase 0 準備 ─→ Phase 1 解析 ─→ Phase 2 注入 ─→ Phase 3 core ─┬→ 4a Fake Nitro ──────┐
                                                              ├→ 4b Platform Indicator ┼→ Phase 5 リリース
                                                              └→ 4c Privacy ─────────┘
```

### Phase 0: 準備
| タスク | 内容 |
| --- | --- |
| 0-1 | §13 の未決事項のうち、ライセンスと Custom branding の扱いを決める |
| 0-2 | `git init`、`.gitignore`（`work/`、APK、ビルド成果物）、LICENSE |
| 0-3 | morphe-patches-template をもとに Gradle 雛形を作る（GitHub Packages の PAT を設定） |
| 0-4 | `runtime/` の TypeScript + esbuild 環境。出力を `patches/src/main/resources/disk/runtime.js` へ |
| 0-5 | 固定バージョンの `hermesc` で出力を HBC98 にコンパイルするチェック（ここで esbuild の target を決める） |
| 0-6 | GitHub Actions: push ごとに `.mpp` をビルドして artifact に上げる |

**完了条件:** 何もしないパッチ 1 つを含む `.mpp` を Morphe Manager に読み込める。

### Phase 1: 解析ツール
| タスク | 内容 |
| --- | --- |
| 1-1 | 端末から Discord 352.17 を `adb pull` し、`tools/extract.py` で `work/352.17/` に展開する |
| 1-2 | `tools/hbc_inspect.py`: HBC98 のヘッダ、関数表、文字列表、global #0 を読む |
| 1-3 | `tools/hbc_inspect.py`: `__d` の呼び出しからモジュール ID と factory 関数を対応づける |
| 1-4 | `tools/find_module.py`: 文字列リテラルや export 名からモジュールを探す |
| 1-5 | `tools/gen_target.py`: `HbcTarget.kt` の定数（global #0 のオフセット・サイズ・ハッシュ、`join`/`eval` の文字列 ID）を出力する |
| 1-6 | 候補モジュールの exports の形を確かめ、ツールの結果が正しいか検証する（実機での確認は Phase 3） |

**完了条件:** v0.1 で使うモジュールの ID をすべて自作ツールで特定し、`runtime/modules/352.17.json` に書けている。

### Phase 2: ランタイム注入（山場）
| タスク | 内容 |
| --- | --- |
| 2-1 | `HbcFile.kt`: HBC98 の読み込みと検証（version、関数数、global #0 のハッシュ） |
| 2-2 | `HbcInjector.kt`: 既存の文字列を貪欲法で組み合わせてランタイム文字列を作る prelude を生成する |
| 2-3 | `HbcInjector.kt`: prelude と元の global #0 を再配置し、関数ヘッダ・例外テーブル・ファイル長・SHA-1 フッタを更新する |
| 2-4 | `BundlePinPatch.kt`: OTA バンドルを無効にし、APK 同梱のバンドルに固定する（実装済み。`Lw6/z;->i()` を null 固定。§4.4） |
| 2-5 | `console.log("[disk] loaded")` だけのランタイムで、注入済みバンドルを Hermes VM で実行して確かめる |
| 2-6 | 実機でパッチ → インストール → `adb logcat` でログを確認する |
| 2-7 | わざと例外を出すランタイムで、Discord が普通に起動すること（フェイルオープン）を確かめる |

**完了条件:** 実機の起動ログに `[disk] loaded` が出る。ランタイムが例外を出しても Discord は起動する。

**現状:** 2-1〜2-5 はローカル検証済み（`:patches:test`、実バンドル・実 DEX）。2-4 は `bundle pin` として
実装したが、起動時 OTA チェックの停止は未実装で、実機確認（2-6 / 2-7）も未実施。

### Phase 3: core
| タスク | 内容 |
| --- | --- |
| 3-1 | `core/loader`: `__d` のラップ、RN 初期化までの保留、機能ごとの try/catch |
| 3-2 | `core/modules`: ID 表の読み込みと `shape` チェック |
| 3-3 | `core/log`: ログをメモリに保持し、設定画面から見られるようにする |
| 3-4 | `core/settings`: 保存先を決め（§13）、読み込み・保存・`useSetting` を実装する |
| 3-5 | `core/ui`: Discord の設定画面に「disk」セクションと機能一覧を追加する |
| 3-6 | Kotlin 側: 選んだ機能を `/*__DISK_FEATURES__*/` に埋め込む |

**完了条件:** Discord の設定に disk セクションが出て、トグルの状態が再起動後も残る。

### Phase 4: 機能
| タスク | 内容 | 完了条件 |
| --- | --- | --- |
| 4a Fake Nitro | 利用可否の判定フック、送信時の絵文字変換、スタンプのリンク送信、オプション画面 | 他サーバーの絵文字・アニメ絵文字・スタンプをリンクで送れる。使える絵文字はそのまま送られる |
| 4b Platform Indicator | PresenceStore の購読、アイコン部品、表示場所ごとのフック、オプション画面 | メンバー一覧・DM 一覧・ヘッダ・プロフィール・メッセージにアイコンが出て、場所ごとに切り替えられる |
| 4c Privacy | analytics の JS フック、Sentry / AppsFlyer / 広告 ID の DEX スタブ | プロキシで見て、analytics / Sentry / AppsFlyer への通信がない |

**完了条件:** 3 機能すべてが実機で動き、オフにすると Discord の元の動作に戻る。

### Phase 5: リリース (v0.1)
| タスク | 内容 |
| --- | --- |
| 5-1 | README（インストール手順、機能一覧、アカウント処分のリスク） |
| 5-2 | CHANGELOG と `patches-bundle.json` |
| 5-3 | タグで `.mpp` を Release に公開するワークフロー |
| 5-4 | 「Add to Morphe」リンクで追加し、新しい端末でパッチからインストールまで通す |

**完了条件:** GitHub Release から誰でもインストールできる。

### Phase 6 以降
- 最新の Discord への移植（§9 の手順と移植ツールの整備）
- v0.2 の機能（§6.4）

---

## 12. リスク

| リスク | 対策 |
| --- | --- |
| Discord の更新で ID やハッシュが変わる | 1 バージョンに固定。ハッシュが違えばパッチを中止し、ランタイムは形チェックで機能ごとに無効化する |
| 利用規約違反によるアカウント処分 | Fake Nitro（リンク送信）は比較的リスクが低い。Platform spoof など目立つものは警告を出す。README に明記する |
| HBC 注入の失敗で起動しなくなる | prelude を try/catch で囲む。注入後の HBC を検証するテスト |
| 起動が遅くなる | 遅延 `eval`、`__d` 判定の最小化。起動時間を計測してから最適化する |
| ライセンス | Venus（GPL-3.0）のコードは写さない。Morphe テンプレートや patcher の利用条件に合わせて、disk も GPL-3.0 にする想定 |

---

## 13. 未決事項

- [x] ライセンス → **GPL-3.0**（Morphe テンプレートと同じ。Morphe の NOTICE に従い、名前に「Morphe」は使わない）
- [x] esbuild の target → **es2019、class は使わない**（`supported: { class: false }` でビルドを止める）。`hermesc 250829098.0.19` が HBC98 を出力することを確認済み。ただし実機では Discord 自身の Hermes がソースを `eval` するので、構文の最終確認は Phase 2 の実機テストで行う
- [ ] 方式 D（ネイティブ経由のアセット読み込み）を試すか
- [ ] 設定の保存先（Discord の既存ストレージを使うか、NativeBridge で専用ファイルにするか）
- [x] Custom branding → **v0.2 に回す**（v0.1 は公式 Discord を置き換えてインストールする。共存が必要になったら前倒しする）
- [ ] v0.2 以降に追加する「その他」の機能
