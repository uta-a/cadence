# 受動Metro観測と読み取り専用設定の実機検証

## 現在の到達点（2026-11-10）

Android 13 / pipa、Discord 352.17 - Stableで、同署名のデータ保持更新後に次を確認した。

```text
[disk] loaded 0.0.1 (native)
[disk] observer installed (native)
[disk] settings read-only ready (native)
```

全12候補中8件が自然にロードされ、exportsのdescriptor種別を観測できた。
値を含まない証拠は [`runtime/modules/352.17-observed.json`](../runtime/modules/352.17-observed.json)。
元の静的台帳は引き続き全件 `verified: false`。一部の型が一致しただけで、機能フックの安全性を承認しない。

| 候補 | ID | 観測したもの |
| --- | --- | --- |
| RNInit | 244 | AppRegistry objectとregisterComponent/runApplication function。callable default initializerではない |
| ReactNative | 17 | View/StyleSheet/AppRegistry/TurboModuleRegistryのaccessor。値は評価していない |
| React | 19 | createElement/useState/useMemo function、version string（実際の値は採取しない） |
| PresenceStore | 5744 | default object、getClientStatus/getStatus function。戻り値・購読契約は未検証 |
| MessageActions | 7598 | default object、sendMessage function。呼び出し・送信はしていない |
| FileModule | 1164 | default object、getConstants/fileExists/readFile/writeFile function |
| EmojiStore | 6757 | default object、getCustomEmojiById/getUsableGuildEmoji function。呼び出していない |
| FileStorageUtils | 8728 | readFile/writeFile function。helperを使ったI/Oはしていない |

SettingsRegistry 15865、SettingsScreens 16016、SettingsOverview 18400、SettingsListRenderer 16013は
この観測時点では自然にロードされず、未観測。先行requireで補完していない。

## 観測の実装と安全範囲

- `core/metro.ts` が `__d` の登録だけをinterceptする。既存accessorはgetter/setterを読まず、変更もせず失敗扱いにする。
- 許可したIDのfactoryだけを包み、元の引数参照・this・戻り値・投げられたオブジェクトを保持する。
  呼び出しはReflect.applyを使う。元のfactoryが投げた場合は診断を実行せず、そのまま伝播する。
- `diagnostics/observer.ts` は元のfactoryの正常終了後にだけexportsをdescriptor経由で見る。
  getterやstore methodを呼ばず、prototype探索は各path segmentで最大8段。
  Proxyはreflection trapを持てるため「reflectionの副作用が絶対にない」とは保証しない。
- ログには固定候補名・ID・path名・typeof相当のkindと順序だけを出す。
  factory引数、exports値、store内容、例外文言、アカウント、メッセージ、端末pathは出さない。
- started/completedは**対象factoryだけ**の境界カウンター。全Metroモジュールの初期化順や時刻ではない。
- 診断、callback、loggerの失敗は分離する。モジュールの探索・アプリの先行require・exports差替え・UI描画の変更はしない。
- active hook用の旧`createMetroLoader`とその関数型gateは引き続き未接続。
  244をgateへ入れたり、null gateで機能フックの条件を回避したりはしていない。

## 設定の読み取り専用bootstrap

8件の実機観測後に、FileModuleだけを受け取る限定callbackを追加した。

1. 自然に完了した1164のdefaultがdata descriptorで、必要なnative methodがfunction descriptorであることを検査。
2. `core/read-only-settings.ts` はPromiseが使える場合に限り、現在のJS stackの終了後へ処理を送る。
   これは一般的なRN初期化完了の保証ではない。利用不能・形の不一致は固定のunavailableログにして無効化する。
3. `core/storage.ts` のgetConstantsとprivate root guardを使い、固定の `disk/settings-v1.json` だけを対象に読む。
   他のDiscordファイル、KV storage、アカウント情報は参照しない。
4. 設定コアにはread capabilityだけを渡し、writeは必ず拒否する。未知のJSON fieldは保持しない。
   snapshotは既知の2機能のbooleanだけで、機能本体へ適用したり、外部へ公開したりはしていない。
5. 実機のreadyは、constants/root検証とfileExists結果の処理が通ったことを示す。
   missingならreadFileを呼ばず終了できるため、**readFile実行・writeFile実行・保存耐久性を確認したことにはならない**。
   File.exists()がアクセス不能をfalseにする可能性も残る（[保存API調査](STORAGE-RESEARCH.md)）。

今回、設定ファイルの作成・変更・削除は行っていない。

## 設定UIで止めた理由

ACTION_VIEWでトップ設定を開く経路も静的に調べたが、安全なURLを証明できなかった。
6410のUSER_SETTINGS/settingsはRPCの定数であり、Android受信URLのroute登録そのものではない。
`/settings` の一致はguild設定にも存在する。推測のURL、盲目的な画面タップ、先行requireは実行しなかった。
設定画面が自然に開かれれば残る4件も診断対象になるが、そのままUIを差し替える機能はない。

UI接続には、React.memo exportのdescriptor、トップ画面限定guard、初回mount・hook順序・route登録の確認が必要。
Fake NitroにはsendMessageの引数と利用権判定、Platform Indicatorにはstoreの戻り値・購読・表示componentの契約が必要。
関数が存在したという観測だけで実装可能とは扱わない。

## 検証と成果物

- Node **55件**、Kotlin **39件**（skipなし）、型チェック・HBC98コンパイル・MPP生成成功。
- 受動観測は独立レビューで指摘されたaccessor保持と独自apply対策を修正後に導入。
  読み取り専用接続もレビュー済み。形不一致時の固定unavailableログを回帰テストに追加。
- 現在のAPK: `work/install-35217/read-only-settings/disk-352.17-signed.apk`
- APK SHA-256: `d1ee2fd445d5327c1b948e0484326873f97a3fdae1f607d5c272ed7ec387e19e`
- 同じ開発用署名で `adb install --no-incremental -r --user 0` に成功。アンインストール・データ消去はしていない。
- 再起動はCOLD / Status: ok。対象PIDのmain/crash buffersにfatal markerは観測しなかった。
  これは全例外・長時間動作・全端末での安全性を保証しない。
- 保存した診断はallowlist済みの固定statusと型メタデータのみ。raw logcat、画面、account/storeの値は保存していない。
