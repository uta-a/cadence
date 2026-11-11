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
| 高画質で画像を読み込む（patch: Load full-quality images） | Load full-quality images（Uncompressed Discord Images by Knewest、HighResProfileImages by Kawtious） | ImageUtils 1498、AvatarUtils 1417 | 実機確認済み: チャットの画像が元ファイルのURLで読み込まれた（`full-images image`）。Venusの場所別・GIFの設定は省き、チャットと全画面とアイコンをまとめて1つのスイッチにした（GIFはDiscordのまま） |
| すべて既読にする（patch: Read all） | Read all（ReadAllNotificationsButton の移植） | useGuildsBarProps 17778、GuildsBarConstants 17768。押したときに読む: GuildReadStateStore 6846、SortedGuildStore 6733、LurkingStore 4936、GuildStore 4877、ReadStateStore 6803、ReadStateTypes 6737、markGuildsAsRead 15243、Constants 1087、PrivateChannelReadStateStore 15096、PrivateChannelSortStore 7354、MessageRequestUtils 6844、ReadStateActionCreators 7238 | 実機確認済み: サーバー一覧のDMボタンの下にボタンが出る。タップでサーバーの未読マークが消え、長押し→DMで未読バッジ4件が消えることを確認（`read-all cleared`）。設定オフ／オンも再起動なしで反映。未読がないときは`nothing`になる。Venusの長押しシートとトーストは使わず、AndroidのAlert（ボタン3つ、外側タップで閉じる）と、消せたときの✓表示にした |

### Reply without pinging（サーバーの初期オフ・手動切替を実機確認）

- `runtime/src/features/venus/quietReplies.ts` はVenusの`quietReplyCreate`を移植。個別patch `Reply without pinging` と初期オフの `quietReplies` 設定を追加した。
- 実バンドルでVenus 9990 → 352.17 **10119 / factory10120** を確認。通常返信`createPendingReply`（export offset89、closure53522）と浅い返信`createShallowPendingReply`（offset100、closure53523）は、ともに引数の`shouldMention`をdispatchする。
- サーバー／グループDMの返信開始時だけ`shouldMention:false`にする。引数は変更せず複製し、手動の`setPendingReplyShouldMention`（offset111）は包まない。未知の形・1対1DM・既にオフの返信は元のまま。
- Venusのサーバー別／グループDM別設定と「自分へのメンションには通知する」例外設定は未移植。今回は単一スイッチ。
- 実機で、設定オン→サーバー返信欄が`@ OFF`で開始、返信欄をタップ→`@ ON`、設定オフ→通常どおり`@ ON`で開始することを確認した。返信本文の送信や相手端末の通知受信は試していない。グループDMと浅い返信の経路はユニットテストのみ。
- 以前の「返信欄が出ない」症状を、無patch・disk単独・disk+quietReplies・全機能で比較した。無patchとdisk単独は正常。quietRepliesのラッパーをループ内で作る形から、元関数を引数に受け取る関数ファクトリへ変えると、全機能ビルドでも解消した（引数の複製方式は元のまま）。Android Hermes eval上のループ内クロージャが、通常返信を浅い返信へ誤って渡していた可能性がある。手元のNode／Hermes CLIでは旧コードの小再現が成功せず、エンジン内部の原因までは断定しない。通常・浅い返信に異なる元関数を使うテストを追加した。
- 実機証跡（ローカルのみ）: `reply-unpatched-control.png`、`quiet-replies-fixed-off.png`（設定オン時の`@ OFF`）、`quiet-replies-manual-on.png`、`quiet-replies-feature-disabled.png`、いずれも`work/phase4-device/`内。検証後はquietRepliesをオフに戻した。
- 再開時の切り分け用にPendingReplyStore **7785 / factory7786** を静的確認し、自然ロード時のみ捕捉する診断を追加した。ユーザーの返信操作後に既存の`getPendingReply(channelId)`を読むだけで、モジュールの強制ロードや状態変更はしない。本文・ID・相手の情報は出さず、`quiet-replies state-quiet` / `state-mention` / `state-missing` / `state-unavailable`のいずれかだけを記録する。設定オフでも同じ操作を比較できる。浅い返信の状態は別マップなので、この診断の`missing`だけでは浅い返信の失敗を意味しない。
- `changed`の記録を元アクションの正常return後へ移動。元アクションが同期例外を投げた場合は、変更済みと記録せず、再実行もしない。返り値・Promiseの同一性は維持する（非同期完了の保証ではない）。
- 返信直後に加え250ms後にも同じ固定ラベルで診断する。修正前は`state-missing` / `delayed-missing`、修正後は設定オンで`state-quiet` / `delayed-quiet`、設定オフで`state-mention` / `delayed-mention`を実機確認した。
- 最終確認: 型検査、Node **114件**、Python **20件**、Gradleテスト、normal/smoke両APKのビルド成功。pipaには全機能を含む**normal APKを再インストール**し、通常画面への起動と起動ログに`FATAL` / `TypeError` / `ReferenceError`がないことを確認。全機能の統合再試験は別途残る。

Read all の安全性と確認範囲:
- DMのリクエスト／スパム除外APIが欠落・例外・不正な返り値の場合は、DM既読化を行わない。APIが候補外のIDを返した場合も停止する。
- `cleared`と✓はDiscordのアクションへの送信を示し、サーバー側の永続化成功を保証しない。実機では画面上の未読表示が消えることまで確認した。
- 実機証跡（ローカル、コミット対象外）: `work/phase4-device/read-all-dm-before.png` / `read-all-dm-after.png`。修正後smoke APKでもDM既読化を再確認。
- Node 109件、Python 20件、型検査、Gradle `:patches:test`とsmoke APKビルド成功。サーバーとDMを同時に既読化する選択、通信失敗時、実際のスパムDMでの動作は実機未確認。

## 移植中に見つけた問題

- 矢印画像（351.11の12922）は、照合ツールの候補（1133）が誤りで、JumpToPresentButtonの依存にある13194（`registerAsset`）が正しかった。候補は必ず実バンドルで確かめる。
- captureに加えたmoduleが観測対象（`MODULE_PROBES`）にないと、オブザーバー全体が起動せず、すべての機能が止まる。全機能を組み込んだときのcaptureがすべて観測対象にあることをテストで確かめるようにした。
- Venusは、ユーザー操作のときに必要なmoduleを`__r(id)`で読み込む（`inspectedExport`）。diskは自然に読み込まれたmoduleだけを使っていたため、返信・編集に使うmoduleが未読み込みで、ダブルタップがDiscordのリアクションに戻っていた。ユーザー操作の時点に限り、navigationの準備ができていれば`requireModule`で読み込む`onDemand`を追加した（起動中には呼ばない）。
- 352.17では、ネイティブのダブルタップがラップした`handleDoubleTapMessage`を通らずに`handleAddDefaultDoubleTapReaction`へ届く。Venusの「本物のダブルタップだけ」の判定は、ラップした処理が一度でも呼ばれたあとにだけ使う。
- Venusは、ダブルタップ関連のバナーを非表示にするとき元のcomponentを関数として呼ぶため、表示中に切り替えるとhookの数が変わる。diskでは元のcomponentを要素として描くようにした。
- トリプルタップ削除はVenusでは既定でオンだが、誤削除を避けるため別スイッチにして初期オフにした。
- 独立レビュー（`ccf85da`時点）の指摘を反映した: Venus機能のために読み込むMessageActions（7598）に、Fake Nitroを組み込んでいないビルドでもsendMessageのフックが入っていた（回帰テストを追加）。MessagesHandlersがコンストラクタでなければ置き換えず、インスタンスへの差し替えに失敗してもDiscordのインスタンスを返す。確認の省略は、`onConfirm`の実行が始まったら失敗してもダイアログを重ねて出さない。トリプルタップ削除の「3秒間無視」は削除に成功したときだけ。チャット高さのmodule（9814）は最初の描画時に解決する。
- トリプルタップ削除は、ネイティブのダブルタップのあとに`handleTapMessage`が自動では呼ばれないこと、`nativeEvent.messageId`があることを前提にしている（実機でダブルタップだけでは削除されず、3回目のタップで削除されたことを確認済み）。前提が崩れた場合は削除しない側に倒れる。650ms以内にダブルタップを2回続けた場合も削除になる。
- 高画質画像の4096px・1600万画素の上限は、`getMobileOptimizedSrc`に渡る幅と高さを使う。これが元画像の大きさか表示の大きさかは未確認（Venusと同じ前提）。
- `extras`に未知のIDがあるファイルを保存し直すと、そのIDは消える（古い版・新しい版の間を行き来した場合）。
- react-nativeのindexはgetterで公開しているため、`Alert`は`Reflect.get`で読む（`dataProperty`では読めない）。`Alert`はクラスなので`typeof`は`function`。AndroidのAlertはボタンを3つまでしか出さない。
