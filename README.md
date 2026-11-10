# disk

Discord (Android) 向けの Morphe パッチ。Fake Nitro、Platform Indicator、プライバシー保護をオフラインで追加する。

> 開発中（**Phase 3: core 準備中**）。設計とフェーズは [docs/DESIGN.md](docs/DESIGN.md) を参照。

**開発対象:** Discord **352.17 - Stable**（APKM）。Fake Nitro・Platform Indicator・Privacy 本体はまだ未実装です。

## 現在の状態

| 項目 | 状態 | 根拠 |
| --- | --- | --- |
| HBC prelude 注入（`disk`） | ローカル検証済み | `:patches:test`。`hermesc` で作ったバンドルと Hermes VM で、prelude が元コードより先に走ること、例外時のフェイルオープン、`SwitchImm` テーブルの再配置、二重注入の拒否、実 352.17 バンドルへの注入を確認 |
| OTA バンドル固定（`bundle pin`） | ローカル検証済み・**実機未検証** | 352.17 の実 DEX で、`i()` の全命令（invoke active count を含む）・全4呼び出し元＋manifest null 消費側の全命令/フレーム/access/try を固定。旧ウィンドウ外のフィールド変更や null 分岐の mutation を拒否し、debug 削除後の `return null` を DEX 書き出し・再読込で確認（DESIGN §4.4） |
| 実機での起動 | **起動・entry実行を確認** | Android 13で同署名の上書き更新後、`[disk] loaded 0.0.1 (native)` を確認。coreは引き続き未接続（[実機記録](docs/DEVICE-TEST.md)） |
| 起動時 OTA チェックの停止 | 未実装（意図的） | OTA のダウンロードは続くが、読み込まれるのは APK 同梱バンドルの想定。実機では未確認（DESIGN §4.4） |
| Metro ローダー基盤 | 単体テストのみ | `runtime/src/core/loader.ts` の遅延 `__d`、init gate、hook 分離を Node でテスト。候補 244 は関数型 gate に使えないため、ランタイムには接続しない |
| 設定コア・保存アダプター | 単体・静的テストのみ | `runtime/src/core/settings.ts` / `storage.ts` は許可リスト・初期オフ・保存順序・固定パス・読み戻しを検証。native 契約は DEX から追跡したが、実行時未検証・ランタイム未接続 |

**実機でdisk entryの実行を確認した。Metro loader・settings・native storageは未接続・実行時未検証。** `bundle pin` は OTA がコミット済みの
端末でも APK 同梱バンドルを読む想定だが、その条件では実機未検証。ガードは対象メソッドの固定であり、
APK 全体や追加 callsite・外部 helper の任意の改変を検証するものではない。対象メソッドを変更する他パッチは拒否する。

## ビルド

必要なもの: JDK 21、Node.js、`read:packages` 権限のある GitHub トークン（Morphe の Gradle プラグイン取得用）

```bash
GITHUB_ACTOR=<user> GITHUB_TOKEN=$(gh auth token) \
  ./gradlew :patches:generatePatchesList :patches:buildAndroid
# -> patches/build/libs/patches-<version>.mpp
```

`buildAndroid` は Morphe Manager が必要とする `classes.dex` を追加する。`build` や `generatePatchesList` は DEX なしで `.mpp` を書き直すので、`buildAndroid` を最後に実行する。

Morphe Manager で選ぶパッチは `disk`（`bundle pin` は依存として自動で入る）。

ランタイムだけをビルドする場合:

```bash
cd runtime && npm ci && node build.mjs   # 型チェック + HBC98 へのコンパイル確認
```

## テスト

```bash
GITHUB_ACTOR=<user> GITHUB_TOKEN=$(gh auth token) ./gradlew :patches:test
```

ローカルの Discord 352.17 を使うテストがあり、次のどちらかがあると実行される（APK はコミットしない）:

- `work/352.17/dex/classes*.dex`
- `work/352.17/apks/base.apk`（読み取りのみ。dex は一時ディレクトリに展開）

無い場合は理由付きで skip される。実バンドル／実 DEX を使うテストは、この環境では通っている。
HBC の実行テストには `work/hermes/hermes`、実バンドルの検証には
`work/352.17/assets/index.android.bundle` も必要。

解析ツールの使い方・制約は [tools/README.md](tools/README.md)、静的モジュール ID 調査と未検証事項は [docs/MODULE-RESEARCH.md](docs/MODULE-RESEARCH.md) を参照。
保存 API と設定画面の接続候補は [保存調査](docs/STORAGE-RESEARCH.md)・[設定 UI 調査](docs/SETTINGS-UI-RESEARCH.md) に記録。

```bash
python3 -I -m unittest discover -s tools/tests -v
```

ローカル検証結果: Kotlin **39件成功（skipなし）**、解析ツール **19件成功（入力を指定した場合）**、ランタイムのテスト **36件成功（entryの早期ログ・未接続 core の HBC98 コンパイル検証を含む）**。
解析ツールの全件実行には `HERMESC`・`HERMES_SOURCE`・`DISK_BUNDLE` の指定が必要（tools の README を参照）。
モジュール ID 表は静的候補（すべて `verified: false`）。保存先と設定 UI の候補は特定したが、RN 初期化 gate・native 実行・初回 mount 前の接続可否は未検証。

## 実機で確認すること（一部実施）

1. **実施済み:** 352.17に `disk` を適用し、端末へ新規導入。ログイン画面まで確認
2. **実施済み:** `adb logcat` の `[disk] loaded 0.0.1 (native)` でentry実行を確認
3. OTA がコミット済みの状態（設定 → 開発者向けの OTA 表示、または一度 OTA を取得した端末）でも起動し、
   同梱バンドルが読まれること
4. ランタイムが例外を投げても Discord が通常起動すること（フェイルオープン）
5. 起動時 OTA チェックの停止を入れるか判断するための、`onResume` 時の blocking check の挙動確認

## ライセンス

[GPL-3.0](LICENSE)。Morphe patches template を元にしている（[NOTICE](NOTICE)）。
