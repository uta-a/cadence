# Venus Patches からの移植

## 方針（2026-11-11、ユーザーの指示）

[Venus Patches](https://github.com/VenusIsJaded/Venus-Patches)（GPL-3.0、Discord 351.11対象）を参考にし、コードを流用して機能を実装する。それまでの「Venusは設計の参考のみ」という方針は、ユーザーの指示でこの時点から変更した。disk も GPL-3.0 なので、著作権表示を保って流用できる。

- 移植は**機能ごと**に、今のランタイムの構造（`runtime/src/features/venus/`）へ移す。Venusの`bootstrap.js`をまとめて取り込むことはしない。
- Venusはmodule IDを351.11で固定している。352.17のIDは、Venusの`scripts/hbc/port_check.py`（ソースパスとexport名で照合）で候補を出し、使う前に実バンドルの命令で確認して`runtime/modules/352.17.json`に記録する。候補だけでは使わない。
- 移植した機能は、**Morpheのpatchを機能ごとに**用意する（ユーザーの指示、`patches/.../VenusPatches.kt`）。選んだ機能だけがランタイムに埋め込まれ、disk設定画面の「Venus から移植した機能」には埋め込まれた機能のスイッチだけが出る。アプリ内の初期値はオフ。設定はschema 2の任意の`extras`配列（オンの機能IDだけ、ひとつもなければ省略）に保存する。
- 実機確認はpipaで行い、送信・削除・ピン留めなどの操作は確認を取らずに進めてよい（ユーザーの指示、2026-11-11）。
- 既存の安全策（exportの形の検査、失敗時は元の動作、固定文字列だけのログ）とテストを付ける。
- アカウント・規約に関わる機能（アカウント切替、Platform spoof、Fake deafen、Questの自動完了など）も対象から外さない（ユーザーの判断）。
- 帰属: 移植したファイルの先頭にVenus由来であることを書き、[NOTICE](../NOTICE)にも記録する。Venusが他のプラグインに基づくと書いている機能は、その表記も引き継ぐ。

## ID対応

`port_check.py`を352.17のバンドル（SHA-256 `09dcdd87…`）に対して実行し、Venusが使う449 moduleのうち448に候補が出た（`SearchField`のみ候補なし）。結果は`work/venus-port-352.17.txt`（gitignore対象）。privacy系の102 closureは別途対応する（diskは独自のprivacy patchを持つ）。

## 対象（ユーザーが選んだグループ）

1. 既存機能の置き換え・強化（Show device indicators、Nitro stickers and emojis、Privacy）
2. Messages系の小物（削除・ピン留めの確認を省く、Always trust links、Jump to first message、Double-tap to reply など）
3. Keep deleted messages
4. Servers系（Show hidden channels、Read all、Server info など）

## 進捗

| 機能 | Venus | 352.17のmodule | 状態 |
| --- | --- | --- | --- |
| 削除の確認を省く（patch: Skip delete confirmation） | Skip delete confirmation（`quickConfirm`） | AlertActionCreators 5941、intl 1128 | 実機確認済み: 確認なしで削除され、`quick-confirm skipped`を記録 |
| ピン留めの確認を省く（patch: Skip pin confirmation） | Skip pin confirmation（NoConfirmPin by Skamt） | 同上 | 実機確認済み: ピン留めと解除が確認なしで行われた |
| リンクとファイルを常に信頼（patch: Always trust links and files） | Always trust links and files（AlwaysTrust by zt and Trwy） | MaskedLinkStore 8894、SuspiciousDownloadUtils 8642 | 実機確認済み: 名前付きリンク`[disk-trust](https://example.org/…)`で、オフでは「Discordを退出」が出て、オンでは直接ブラウザが開いた。ファイルの警告は実機未確認 |
| 最初のメッセージへ移動（patch: Jump to first message） | Jump to first message（`jumpButton`） | JumpToPresentButton 13192、ピル 13193、矢印画像 13194、入力欄の高さ 9814、MessageStore 6042、MessageActions 7598 | 実機確認済み: DMで上へスクロールすると「最新へ移動」の横に上向きのボタンが出て、押すと先頭（2025-04-19）へ移動した |
| ダブルタップで返信（patch: Double-tap to reply） | Double-tap to reply（Geastures+ by kmmiio99o の移植） | DoubleTapToReactUtils 8358、MessagesHandlers 11269、通知・バナー 9868/14023/13207、canReply 8365、replyToMessage 11370、canEdit 11371、handleEdit 10117、haptics 5244、定数 1087、UserStore 1392 | 実機確認済み: 相手のメッセージで返信、自分のメッセージで編集、トリプルタップ（別スイッチ、初期オフ）で自分のメッセージを削除 |

## 移植中に見つけた問題

- 矢印画像（351.11の12922）は、照合ツールの候補（1133）が誤りで、JumpToPresentButtonの依存にある13194（`registerAsset`）が正しかった。候補は必ず実バンドルで確かめる。
- captureに加えたmoduleが観測対象（`MODULE_PROBES`）にないと、オブザーバー全体が起動せず、すべての機能が止まる。全機能を組み込んだときのcaptureがすべて観測対象にあることをテストで確かめるようにした。
- Venusは、ユーザー操作のときに必要なmoduleを`__r(id)`で読み込む（`inspectedExport`）。diskは自然に読み込まれたmoduleだけを使っていたため、返信・編集に使うmoduleが未読み込みで、ダブルタップがDiscordのリアクションに戻っていた。ユーザー操作の時点に限り、navigationの準備ができていれば`requireModule`で読み込む`onDemand`を追加した（起動中には呼ばない）。
- 352.17では、ネイティブのダブルタップがラップした`handleDoubleTapMessage`を通らずに`handleAddDefaultDoubleTapReaction`へ届く。Venusの「本物のダブルタップだけ」の判定は、ラップした処理が一度でも呼ばれたあとにだけ使う。
- Venusは、ダブルタップ関連のバナーを非表示にするとき元のcomponentを関数として呼ぶため、表示中に切り替えるとhookの数が変わる。diskでは元のcomponentを要素として描くようにした。
- トリプルタップ削除はVenusでは既定でオンだが、誤削除を避けるため別スイッチにして初期オフにした。
