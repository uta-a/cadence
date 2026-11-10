# 初回実機導入（2026-11-10）

## 結果

- 対象: Android 13、pipa / model 23043RP34G。Discord 352.17 - Stable、com.discord。
- ユーザーが既存LSPatch版の削除・再導入（ローカルデータ消失、再ログインが必要）を明示承認。
- 既存APK4本をローカルのgitignore対象へ退避した。アカウントデータのバックアップ・復元は行っていない。
- 元の352.17 APK4本の公式署名一致を確認し、Morphe Desktop 2.1.1でsplitをmerge、diskと依存のbundle pinを適用。
- FULLモードでDEXを出力。出力APKのBundlePin対象メソッドがconst/4 + return-objectであることを再読して確認した。
- HBC98の注入済みglobal先頭・SHA-1 footer・19,539件のMetro登録を出力から確認した。
- 開発用ローカル鍵で署名。apksignerのv2/v3検証とzipalign検証に成功。
- 現在ユーザー0の既存Discordを削除。初回installは端末側のUSER_RESTRICTEDで拒否されたが、ユーザー確認後の再試行でSuccess。
- 明示component `com.discord/.main.MainDefault` の起動はStatus: ok。PIDの存在とログイン画面の描画を確認。
- ログイン・パスワード入力・メッセージ送信・アプリ内設定操作は行っていない。

## 確認できていないこと

**ログイン画面の起動確認は、disk runtimeの実行確認と同義ではない。**

- 対象PIDの選択したlogcat buffers/tagsで `[disk] loaded` を確認できなかった。
  同じ条件でfatal/errorの該当行も観測しなかったが、全例外・将来のクラッシュがないという保証ではない。
- 現在のentryはpreludeの時点でconsoleが存在するときだけconsole.logする。
  未観測の原因は未確定。native側のログ経路やconsole初期化との関係を次に調べる。
- `globalThis.__disk` の実形、Metro loader・settings・native storageの実行時検証はしていない。
  coreは引き続きindex.tsから未接続。
- 新規導入でデータを消去したため、**既にOTAがコミット済みの状態**で同梱バンドルが選択されるかは未検証。
- runtime例外時の実機fail-open、長時間動作、ログイン後の画面、機能本体は未検証。

## ローカル成果物（コミット対象外）

- APK: `work/install-35217/disk-352.17-signed.apk`
- SHA-256: `5dde795c398ffe0dd5c8246b1471b195e6980cfb2032dc3a02bec83fcc8f1172`
- 署名証明書SHA-256: `0c5e8647c8cd44a6b56ce4511b2d29464b2f661b98707d3145d70272955da934`
- 開発用鍵: `work/install-35217/disk-local-test.jks`。ローカル検証用であり配布用の正式鍵ではない。
  今後の上書き検証には同じ鍵を使う。鍵・APK・端末データはGitに追加しない。
- 適用結果: `work/install-35217/patch-result.json`、署名検証: `signature-verification.txt`、DEX証拠: `patched-dex-evidence.txt`。
- 以前のLSPatch版APK退避: `work/device-readonly-SRWZsD/`。ログイン情報や設定を復元できるバックアップではない。

アプリを通常起動してログイン画面を確認しただけであり、Fake Nitro・Platform Indicator・Privacy本体は依然未実装。
