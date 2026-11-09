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
4. prelude 全体を **try/catch（例外テーブル）** で囲む。ランタイムが失敗しても元の Discord コードはそのまま続行する（フェイルオープン）
5. `[prelude][元の global #0 本体]` をファイル末尾に再配置し、関数ヘッダ（拡張ヘッダ・例外ハンドラ数・サイズ・フラグ）を更新する
6. ファイル長を更新し、末尾の SHA-1 フッタを再計算する

prelude が使う定数（global #0 のオフセット、サイズ、ハッシュ、`join` と `eval` の文字列 ID）は `HbcTarget.kt` にバージョンごとにまとめ、移植ツールで自動生成する。

### 4.3 起動時コストの抑え方
- ランタイムは「すぐ実行するヘッダ」と「機能本体」に分ける。機能本体は文字列のまま持ち、使うときに初めて `eval` する
- `__d` ラッパーは全モジュール分呼ばれるので、判定は `Uint8Array` の添字参照 1 回だけにする

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
- RN の初期化モジュールが終わるまでは差し替えを保留し、終わってから順に適用する
- 機能ごとのフックは try/catch で囲む。1 つ失敗しても、その機能が無効になるだけで済むようにする

### 5.3 モジュール ID 表（`core/modules`）
- ID はビルドごとに変わるので、**`modules/<discord-version>.json` に名前 → ID の表を持つ**
  ```json
  { "EmojiStore": { "id": 6243, "shape": ["getCustomEmojiById", "getUsableGuildEmoji"] } }
  ```
- `shape` は差し替え前に確認する exports のプロパティ名。合わなければその機能を無効にし、ログに残す
- 実行時に全モジュールを走査して探すことはしない（起動が遅くなるため）。探索は開発時のツールで行う（§9）

### 5.4 設定（`core/settings`）
- `{ features: { fakeNitro: { enabled, ...options } }, ... }` の JSON 1 ファイルを、Discord が持っているファイル系ネイティブモジュールで読み書きする
- 変更は購読者（React フック `useSetting`）に通知する。再起動が必要な機能だけ再起動を促す
- パッチ時に組み込まれた機能（`/*__DISK_FEATURES__*/` に Kotlin 側が埋め込む）以外は、設定画面に表示しない

### 5.5 設定 UI（`core/ui`）
- Discord の設定画面のセクション定義モジュールをフックし、「disk」セクションを追加する
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

新しい TurboModule を追加するのは難しいので、**Discord の既存ネイティブメソッドの先頭に分岐を入れて**通信路にする。

```
JS:  FileModule.readAsset("disk-v1:settings/read", "utf8")
DEX: readAsset の先頭 → 引数が "disk-v1:" で始まる？
        Yes → app.disk.Bridge.handle(...) で処理して Promise を resolve
        No  → 元の処理
```

- プレフィックスはバージョン付き（`disk-v1:`）。1 メソッドにつき disk の分岐は 1 つまで
- v0.1 で使う用途: 設定ファイルの読み書き（Discord の既存 API で足りれば不要）

---

## 8. リポジトリ構成

```
disk/
├─ patches/                     Kotlin: Morphe パッチ
│  └─ src/main/kotlin/app/disk/patches/
│     ├─ Compatibility.kt       対応する Discord（パッケージ名、バージョン）
│     ├─ hbc/HbcFile.kt         HBC98 の読み込み（ヘッダ、関数、文字列）
│     ├─ hbc/HbcInjector.kt     prelude の生成と注入
│     ├─ hbc/HbcTarget.kt       バージョン固定の定数（ツールで生成）
│     ├─ RuntimePatch.kt        ランタイム注入 + 機能フラグ埋め込み
│     ├─ BundlePinPatch.kt      OTA 無効化
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
│  └─ gen_target.py             HbcTarget.kt と modules/<ver>.json を生成
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
| 2-4 | `BundlePinPatch.kt`: OTA バンドルを無効にし、APK 同梱のバンドルに固定する |
| 2-5 | `console.log("[disk] loaded")` だけのランタイムで、注入済みバンドルを Hermes VM で実行して確かめる |
| 2-6 | 実機でパッチ → インストール → `adb logcat` でログを確認する |
| 2-7 | わざと例外を出すランタイムで、Discord が普通に起動すること（フェイルオープン）を確かめる |

**完了条件:** 実機の起動ログに `[disk] loaded` が出る。ランタイムが例外を出しても Discord は起動する。

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
