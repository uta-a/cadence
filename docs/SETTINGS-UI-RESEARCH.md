# Discord 352.17 設定 UI の接続候補

## 状態と入力

静的調査のみ。すべて `verified: false` / `runtimeChecked: false`。
対象は `work/352.17/assets/index.android.bundle`、SHA-256
`09dcdd872df4fb7aa84b2a5ecc62946735de7a63447b848d549bd99d6f4505ee`。
以下の `function:offset` は HBC 関数内の十進**バイト** offset。
バンドル実行・native require・端末・通信操作はしていない。

## 接続候補の追跡

| 役割 | Metro ID → factory | 静的証拠 |
| --- | --- | --- |
| SettingsNavigator | 18396 → 18397 | 非 compiler 分岐80700の OVERVIEW route が closure135536 を使う。135536:11..22 は deps[33]=18400 の default を返す |
| SettingsOverviewScreen | **18400 → 18401** | 18401:20 で closure80703 を作り、:27 で環境slot6へ保存。:157/:166 で compiler 非使用/使用の80705/80704を選び、:198 で default export |
| LIST node 構築 | 11240 → 11241 | createList=57095。57095:13..29 は type=LIST と渡された sections 等を結合 |
| 共通 renderer | **16013 → 16014** | SearchableSettingsList は72817/72816を選び、16014:493 で React.memo、:529 で named export |
| rows への展開 | 16016 → 16017 | toSettingListItems=72853 が node.sections を反復。callback125378でsection表示、152319:68..78でregistry[key]をrow.nodeに設定 |
| renderer 定義 | 15865 → 15866 | SETTING_RENDERER_CONFIG は freeze 済み。section の key はこの map にも存在する必要がある |

主な dependency edge は `18400.deps[11]=11240`、`[12]=16013`、
`16013.deps[14]=16016`、`18396.deps[33]=18400`。

トップ階層の順序は公開 category registry ではなく、**非公開 closure80703** が作る。
`80703:236` で10要素の配列を確保し、`:1204` で返す。各要素は `{label, settings}`、
logout は `{settings}`。設定キーの順序・premium 条件・翻訳済みラベルを含む。
概ねアカウント、課金、アプリ設定、サポート、変更履歴、logout、開発情報、バグ報告、
Build Status、Staff Settings の順だが、blocklist により空になった section は表示されない。
**10 section が実機ですべて見えるという意味ではない。**

非 compiler 側は80705 →135550が80703を呼び、135550:69でsections、:78でcreateList。
80705:129..145がSearchableSettingsListへnodeを渡す。
compiler 側80704も:221で80703、:230でcreateList、:286..302で同じexportを使う。
片側の分岐だけのpatchでは不十分。

## 実装前に必要な判断

1. **props 境界が第一候補。** `16013.SearchableSettingsList` に渡る `node.sections` を
   複製して disk section を加える案。ただし export は **React.memo の戻り値**であり、
   普通の関数として `.apply` してはいけない。元 component を element として描画する方式を検討する。
2. **トップ画面限定の guard は未確定。** 汎用 renderer なので無条件挿入は不可。
   ACCOUNT / VOICE / LOGOUT 等の配置検査は候補でしかない。全 consumer、固有 marker、検索時の挙動を確認する。
3. **定義追加は別作業。** frozen registry 自体には追記できない。新しい map への export 差替えには
   descriptor と利用側の参照取得タイミングの確認が必要。map を変えず key だけ足すと node が undefined になる。
4. **初回 mount 前に固定する。** SettingHookHarness の72421は registry の列挙順で hooks を呼ぶ。
   mount 後の key 追加・並び替えは hook 順序を壊す可能性がある。useMemo / compiler cache も考慮する。
5. **route 登録も別。** getSettingScreens=72851は ROUTE 型だけを採る（125376:66..169）。
   navigator の screens は空依存 useMemo で保持される経路がある。section追加だけでは新画面に遷移できない。

現時点では UI を接続しない。`1087.UserSettingsSections` enum の追記や80703の配列へのpushで代替しない。

## 起動ゲートとの関係

RN の AppRegistry bootstrap **244** は `exports.AppRegistry` を返す副作用モジュール。
現行 `core/loader.ts` が求める callable default initializer ではない。
244 の factory 完了だけで全機能を ready にしたり、gate を null にして制約を回避したりしない。

次の接続設計では、自然にロード済みの exports だけを観測し、getter を不用意に評価せず shape / descriptor を
確認する必要がある。共通の「RN初期化完了」を仮定するより、native・registry・renderer ごとの
初期化と初回消費の関係を追う。既に初回 mount を過ぎている場合は UI 追加を見送る方式も検討する。
これらのタイミングは静的同定だけでは検証できていない。

## 追加調査：トップ設定を開く入力経路

実機ではUI4候補が未ロードだったため、Android ACTION_VIEW用の安全なURLを静的に追ったが、
トップ設定までの経路は証明できなかった。**ディープリンクが存在しないという断定ではない。**

- 6410→6411はRPC定数。6411:68,72のUSER_SETTINGSと:252,256のsettingsは、37388が対応付けるだけでURL登録ではない。
- 125374:139 / 152317:95のUSER_SETTINGSはanalytics用。実際のnavigateは:158..174 / :114..130でrow.routeを渡す。
- Android受信側は81841のnativeDeepLink→137763→19495.DeepLinkProcessor→19492.handleIncomingURL。
  157422:1083..1096の5728.parseURLから15127.handleSupportedURLへ進むが、調査した分岐にトップ設定への対応は見つからなかった。
- 5729:376,394や70338:497..529のsettings系はguild設定。23422:13の `/settings` もguild API pathの部品であり根拠にはならない。

推測のURL、盲目的な画面タップ、先行requireは実行していない。型だけの実機観測は [診断記録](DIAGNOSTICS.md) を参照。

## 再現

```sh
BUNDLE=work/352.17/assets/index.android.bundle
mkdir -p work/352.17/research/ui
for f in 18401 80703 80704 80705 135550 135536 16014 72817 72853 125378 152319; do
  python3 tools/hbc_inspect.py "$BUNDLE" func "$f" --disasm > "work/352.17/research/ui/f$f.txt"
done
python3 tools/hbc_inspect.py "$BUNDLE" modules --id 18400
python3 tools/hbc_inspect.py "$BUNDLE" modules --id 16013
```

ID・exports と命令境界は子エージェントによる対象限定調査の後、親でも元バンドルから
18400/16013の登録・factory対応、列挙した接続点の命令とliteral buffer keysを再読して照合した。
これは実行時 shape / descriptor / 表示検証の代わりではない。
