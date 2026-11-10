# 初回実機導入（2026-11-10）

最新のcore検証は[Phase 3記録](PHASE3.md)を参照。設定画面の表示、コンパクト表示の保存/read-back、cold restart後の復元、オフへの復帰と再起動、戻る操作を確認済み。追加ログ画面・空の機能表も実機確認し、最新通常版へ同署名更新済み。通常cold startでsettings ready、自動遷移なし、fatal/JS型エラーマーカーなしを確認した。以下は初回導入・読み取り専用段階の履歴であり、当時の未接続状態を記録している。

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

## 初回導入時に確認できなかったこと（起動ログは下記追記で確認）

**ログイン画面の起動確認は、disk runtimeの実行確認と同義ではない。**

- 対象PIDの選択したlogcat buffers/tagsで `[disk] loaded` を確認できなかった。
  同じ条件でfatal/errorの該当行も観測しなかったが、全例外・将来のクラッシュがないという保証ではない。
- 初回entryはpreludeの時点でconsoleが存在するときだけconsole.logする。
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

初回確認はログイン画面まで。Fake Nitro・Platform Indicator・Privacy本体は依然未実装。

## 追記：ログイン後の同署名更新と早期ログ確認

- ユーザーからログイン完了の報告後、データ保持の上書き更新と再起動を明示承認された。
- entryに任意のhost関数 `nativeLoggingHook(message, 1)` を優先するログ経路を追加。
  loggerの取得・呼び出しの例外を分離し、consoleへフォールバックする。Metro/RNモジュールはrequireしない。
- Node36件・Kotlin39件（skipなし）、型チェック、HBC98コンパイルとMPPビルド成功。独立レビューOK。
  ログ文言変更に合わせてHermes VMテストの期待値も更新した。
- 元の352.17 APKMへ適用し、同じ開発用署名であることを確認。
  `adb install --no-incremental -r --user 0` がSuccess。**アンインストールやデータ消去は行っていない。**
- 再起動はCOLD / Status: ok。新PIDのmain/crash buffersで次の固定マーカーを観測した。

```text
11-10 09:44:29.349 I ReactNativeJS: [disk] loaded 0.0.1 (native)
```

これにより、今回の上書きAPKで**同梱HBCのpreludeからdisk entryが実行され、native loggerで出力した**ことを確認した。
同時点でプロセスと前面Activityが存在し、対象PIDのbuffersにfatal markerは見つからなかった。
ログイン状態の画面を読み取ったり、アカウントやメッセージの情報を取得したりはしていない。
上書き後のログイン状態そのものはユーザー側の確認に委ねる。

- 更新APK: `work/install-35217/bootlog/disk-352.17-signed.apk`
- SHA-256: `549c595da8de53195a021f0d796e84a3f65f5d5d78c9abc51e4eda79909850b7`
- マーカー: `work/install-35217/bootlog/disk-markers.log`（固定診断行だけを保存）

**未検証のまま残るもの:** core/Metro IDの実行時shape、初期化ゲート、設定I/O、UI差し込み、
OTAコミット済み状態の明示的な再現、実機での例外fail-open、長時間動作。この時点ではcore未接続。

## 追記：受動観測と読み取り専用設定

その後、ユーザーから通常の開発・データ保持更新を自律的に進める依頼を受け、2回の同署名上書きで検証した。
8/12候補のdescriptorを自然ロード時に観測し、FileModule限定の読み取り専用設定bootstrapでreadyを確認。
設定UI4候補、native書込、機能フックは未接続・未確認。アカウントやメッセージは取得・操作せず、データ消去も行っていない。
現在のAPK・証拠・限界は [診断記録](DIAGNOSTICS.md) と [型のみのreceipt](../runtime/modules/352.17-observed.json) を参照。
