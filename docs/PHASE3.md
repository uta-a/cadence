# Phase 3: core 実装・検証記録

## 状態

**Phase 3完了。** 設定UI・保存・再起動後の復元・診断ログ画面・空の機能表を実機確認し、最新通常版へ同署名でデータ保持更新済み。coreと追加ログ/manifest差分の独立レビューも完了した。
対象はDiscord 352.17 - Stable / Android 13 / pipaのみ。Fake Nitro・Platform Indicator・Privacy本体は未実装。

## 実装

- `core/modules.ts`: 自然に得られたReact19・RN17・RootNavigation5183・FileModule1164を利用。Overview18400.defaultはfactory正常終了後、最初のconsumer前にwrapする。RNのUI getterはnavigation refの`isReady()`がtrueになった実renderまで評価しない。
- `core/ui.ts`: 元Overviewをkey付きの同じ位置に常時保持し、Cadence画面はnative Modalで表示。共通React.memo renderer16013・frozen registry15865・非公開section builderは変更しない。購読直後にstateを読み直し、購読直前の更新も反映する。readiness未成立ならmounted中だけ1本のtimerを維持し、初期250ms、40回後は2000msで再確認する。ready/unmountで停止する。
- `core/settings.ts`: schema2。既存feature APIを維持し、表示用の`compact` preferenceと購読APIを追加。schema1はcompact=falseとして読み、次の保存で移行する。feature/preferenceは共通の順序付きsnapshot queueで保存する。
- `core/settings-controller.ts`: 現在のJS stack終了後にnative loadを開始。load失敗中は書かず、明示的な再試行を用意。save失敗もUIに表示し、現在値の再保存を可能にする。
- `core/storage.ts`: 検査済みprivate files root内の`cadence/settings-v1.json`だけを扱う（schema2でも同じパス）。writeの戻りpathとread-backの完全一致を要求する。nativeがrenameToのbooleanを捨てるため、atomicity・電源断時の耐久性は保証しない。
- `core/log.ts`: 固定診断文字列だけを最大80件、各1024文字までメモリに保持。コピーをfreezeして返し、設定画面から開閉して表示する。例外本文・アカウント・メッセージ・storeの値は残さない。ファイル保存や自動送信はしない。
- `BuildFeatures.render`: 引用符付き`/*__CADENCE_FEATURES__*/`が厳密に1個あることを確認し、allowlist内の選択IDを決定的なJS配列として埋め込む。現時点は選べる機能patchが0件なので実際は`[]`。未知ID・marker欠落/重複はビルドを拒否する。ランタイム側も未知/重複IDや未置換markerを空配列として扱う。機能patchとの選択連携はPhase 4で追加する。

## 実機で確認済み

専用smokeビルドだけがRootNavigationの自然captureと`isReady()`を確認してから7522をimportし、静的に追跡した`openUserSettings(undefined, undefined, {pop:false})`を一度呼ぶ。推測URL・座標タップは使わない。通常版はこの自動操作を無効にする。

1. 観測14件すべてが静的候補と一致。UI4件（18400/15865/16016/16013）も観測できた。
2. `[cadence] ui installed`、`settings ready`を確認し、名前付きのCadence入口から設定画面を表示。初期画面の見た目も確認した。
3. コンパクト表示false→true。UIがnative write/read-back完了を示した後にcold restartし、trueの復元を確認。
4. 検証値をfalseへ戻し、保存完了後、もう一度cold restartしてfalseの復元を確認。
5. Androidの戻る操作でModalが閉じ、元OverviewのCadence入口が残ることを確認。元componentの保持はhook harnessでも検証。
6. 追加した診断ログ画面・空の組み込み機能表を固定labelで検証。コンパクト表示がfalseのまま残ること、元Overviewへ戻れることも再確認。
7. 最新通常版を同署名の`adb install -r --user 0`で更新。cold start後に自動settings遷移なし、`settings ready`、fatal marker/JS TypeError/ReferenceErrorなしを確認。正常起動時の自然観測は9件。残り5件は設定へ遷移したsmoke版の観測であり、通常版が先行requireするわけではない。

`tools/android/CadenceUiSmoke.java`はCadence自身の固定labelだけを検査する。アカウント画面のdump・値取得・盲目的タップ・送信・ログアウト・データ消去は行わない。UIAutomatorのMIUI theme互換ファイル警告はテストrunner側のもので、成功判定は`OK (1 test)`だけでなくFailure/aborted/shortMsgも確認する。

## ローカル検証

- Node: 77件成功。controllerのload/write失敗、再試行、mixed write順序、loadとの競合、再入、UI購読race、元画面保持、45回後のreadiness、メモリログ、manifestを含む。
- TypeScript型検査成功。
- Kotlin: 42件成功、失敗/skipなし。Hermes VM、実HBC/DEX、feature manifestの検証を含む。
- Python解析: 20件成功（Hermes source/compiler・実バンドル指定）。
- HBC98コンパイル・MPP・FULL patch・署名・16KB zipalign成功。
- 最新通常APKのpreludeからJSを復元し、生成runtimeに空manifestを埋めたものと完全一致。coreへのsmoke引数=false、未置換markerなし、既存開発署名との一致を確認。
- core/UI/controllerとschema2変更は独立レビューで指摘を解消し、最終「問題なし」。追加ログ/manifest差分も、対象コードを直接提示した限定レビューで「問題なし」。レビュー担当者はテストや端末操作を独立実行しておらず、上記検証は実装担当によるもの。
- インストール後のbase.apkのSHA-256も端末上で計算し、最新通常APKと一致することを確認した。

nativeのdisk-fullや電源断は実機再現していない。失敗時の表示・再試行は単体テストの範囲。descriptor一致は各機能の意味論・全契約・フック安全性の一括承認ではない。

## 実施した最終端末操作

中断後にADB接続を復旧し、最新smoke版で以下を成功させた。

```bash
bash tools/run_ui_smoke.sh SERIAL open-cadence
bash tools/run_ui_smoke.sh SERIAL check-compact false
bash tools/run_ui_smoke.sh SERIAL show-logs
bash tools/run_ui_smoke.sh SERIAL close-cadence
# signerを再確認した最新通常版を、削除せず上書き
adb -s SERIAL install --no-incremental -r --user 0 work/install-35217/phase3-normal/signed.apk
adb -s SERIAL shell am start -W -n com.discord/.main.MainDefault
```

現在入っているのは通常版で、自動settings遷移は無効。最終APKのSHA-256は`e7b971928babb1d3a2ee19d2c72f96a1a17056114151bb04da44a1ba38cbda35`。各APKと観測範囲は`runtime/modules/352.17-observed.json`に分けて記録した。データ消去・ログアウト・アカウント変更・メッセージ送信はしていない。
