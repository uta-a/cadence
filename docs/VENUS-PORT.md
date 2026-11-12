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

## v0.1の範囲（2026-11-12確定）

ユーザーの判断で、v0.1ではPrivacyの不足分（telemetry・タップ記録）だけを追加し、それ以外の未移植項目はv0.2以降へ回す。選んだ4グループに含まれるVenusの機能と、diskでの扱いは次のとおり。

| グループ | Venusの機能 | disk v0.1 |
| --- | --- | --- |
| 既存強化 | Show device indicators | 実装。場所別6設定とメッセージ名の文字表示。Venusの「モバイルを隠す」設定は未移植。通話中のMemberRowItemは実機未確認 |
| 既存強化 | Send Nitro stickers and emojis as links | 実装（disk独自のFake Nitro。サイズ・名前付きリンク設定あり） |
| Privacy | Disable analytics | 実装（JSのtrack送信を破棄） |
| Privacy | Disable crash reporting | 実装（Sentry SDKを起動しない） |
| Privacy | Disable telemetry and touch logging | **一部**。タップ記録とTelemetryRingへの書き込みを停止。jank・フレーム計測・TTI・metric monitorは止めない（送信はJS analytics経由で、Disable analyticsで破棄） |
| Privacy | Disable advertising identifiers | 実装（JSへの広告ID）。AppsFlyer自身の読み取りは、Disable install attributionでAppsFlyerを起動しないことで防ぐ |
| Privacy | Disable install attribution | 実装（AppsFlyerの起動とイベント送信）。InstallReferrerModuleは止めない |
| Messages | Keep deleted messages | **一部**。起動中のみ専用画面へ保持。チャット内表示・永続化・添付保持・検索はなし |
| Messages | Double-tap to reply | 実装（トリプルタップ削除は別スイッチで初期オフ） |
| Messages | Load full-quality images | 実装（場所別・GIF設定は1スイッチに統合） |
| Messages | Skip delete / pin confirmation | 実装 |
| Messages | Download voice messages | 実装 |
| Messages | Always trust links and files | 実装（ファイル警告は実機未確認） |
| Messages | Jump to first message | 実装 |
| Messages | Reply without pinging | 実装（サーバー別・グループDM別・自分宛て例外の設定は未移植） |
| Messages | Bulk delete、Hide blocked or ignored、Message highlights、Translate、Keep media playing、Banners in DND、Favourite any image | v0.2以降 |
| Servers | Read all button | 実装（Androidの3ボタンAlert） |
| Servers | Show hidden channels | **一部**。長押しメニューの読み取り専用一覧。ネイティブ一覧への鍵付き表示はしない |
| Servers | Server info | **一部**。読み込み済みの基本情報のみ。友達一覧・所有者遷移・コピー・装飾シートなし |
| Servers | Edit servers locally、Clone emojis and stickers、Clean channel names、Preview servers、Pause invites、Fast delete channels | v0.2以降 |

「一部」は安全側に絞った移植で、v0.1の仕様とする。

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

### Disable telemetry and touch logging（Privacy、DEX）

- Venusの`NativePrivacy.telemetry`の対象一覧を参考に、352.17で実在と命令を確認した4メソッドだけを`return-void`にする。既存のSentry・AppsFlyer停止と同じ`MethodStub`で、メソッド全体のダイジェストが一致しなければパッチを止める。
  - `TouchEventAnalyticsModule.enableTouchLogging()` / `onEventRecognized(z5.c)`: タッチ・ビュー階層・メモリ量の記録を始めない。
  - `crash_reporting.u.a(String,long,String,Map,List)`（TelemetryRingの書き込み口）と`TelemetryRingModule.append`: 端末内テレメトリーログへ何も書かない。snapshotは空を返す。
- Promiseを受け取るメソッドや値を返すメソッドは変更しない。JSの待ち状態が残らないようにするため。
- jank計測は対象外とした。`JankStatsModule.startTracking`だけを止めても、`MainActivity.onResume`がネイティブで計測を始めることをエミュレーターのログで確認したため。集計オブジェクトの初期化を止めると`setJankHeuristicMultiplier`が例外になる。これらの値はJS analyticsのイベントとして送られ、Disable analyticsで破棄される。
- 検証: Kotlinテストで4メソッドのダイジェスト・先頭分岐なし・再パッチの冪等性・DEX往復を確認。通常APKのDEXで4メソッドの先頭が`return-void`になっていることを確認。専用AVD（Android 17、arm64、16KBページ）で新規データの起動と`loaded 0.1.0` / `settings ready`、FATAL・TypeError・ReferenceErrorなしを確認。**実機とログイン状態での確認は未実施**。

### Keep deleted messages（起動中の本文履歴）

- `messageHistory.ts` はVenusの`rememberEdit`、`rememberDeleted`、`dispatchEvent`を参考にした移植。個別patch `Keep deleted messages` と初期オフの`messageHistory`設定。専用画面は`historyUi.ts`。
- **削除済みの吹き出しをチャット内へ復元する機能ではない。** 削除・編集前の読み込み済み本文をdiskの履歴画面へ保持する。Dispatcher **584**のJS `addInterceptor`で処理前に読み取り、常にfalseを返してDiscordの元アクションをそのまま通す。MessageStoreの内容や削除・未読・通知処理を書き換えない。
- メモリ内のみで最大200件、本文は各4,000文字、合計262,144 UTF-16単位まで。一括削除も200件までを記録。画像・音声・添付ファイルの実体は保持しない。編集は`edited_timestamp`があり、本文が変わったときだけ記録する。
- 機能オフ、ログアウト、アカウント変更時は消去。プロセス再起動で復元しない。チャンネル削除と把握できているサーバーからの離脱でも対応する履歴を消す。保持件数の上限で古いものを捨てる。手動の全消去も可能。
- pipaで自分の試験メッセージを送信・編集・削除し、ビューアで編集前`disk-history-before`、編集後・削除前`disk-history-beforeafter`を確認。履歴2件→一括消去→0件を確認。別の試験メッセージを削除して再び履歴ありを確認してから強制停止・起動し、0件になることも確認した。試験後は機能をオフへ戻した。
- `message-history edited` / `deleted`を確認。ログには本文、名前、IDを出さない。証跡は`work/phase4-device/history-edited-deleted.png`。単体テストではアカウント変更、ログアウト、容量制限、例外時も元処理を通すこと、ビューアの消去とフック数を確認した。相手アカウントからの削除通知・実ログアウト・一括削除の実機試験は未実施。
- Node **143件**、Python **24件**、型検査、Gradleテスト、smoke APKビルド成功。Venusのディスク永続化・チャットへの再挿入・添付保持は未移植。

### Show hidden channels（読み取り専用の情報表示）

- `runtime/src/features/venus/hiddenChannels.ts` はVenusの`hiddenMetadata`、`hiddenDirectory`、`hiddenDetails`を参考にした安全側の移植。個別patch `Show hidden channels` と初期オフの`hiddenChannels`設定。
- **Venusと同じネイティブ一覧への混在表示ではない。** サーバー長押しメニューに項目を追加し、読み込み済みのメタデータをダイアログへ表示する。PermissionStore.can、標準チャンネル一覧、未読集計、入室、履歴取得は一切変更しない。
- ユーザー操作時のみChannelStore **4855**のfull/basicテーブルとPermissionStore **4935**を読む。共有Constants **1098**の実際の`Permissions.VIEW_CHANNEL`を使い、権限が明確にfalseの項目だけを表示する。basic専用レコードには`canBasicChannel`を使い、APIがなければ判定不能として省く。判定不能・例外は非表示として推測しない。
- チャンネル名が未取得ならその旨を表示。表示40件、走査は各テーブル2,000件まで。DM・スレッド・別サーバーの項目は含めない。追加通信・チャンネルへの移動ボタン・メッセージ取得はなし。
- pipaで初期オフ・設定保存・メニュー・空の情報画面を確認。試験サーバーに実際の拒否権限の項目がないため、**非表示項目を含む実機の表示は未確認**。単体テストでは明確な拒否、未知の判定、full優先、件数制限、既存処理の維持を確認した。
- `hidden-channels opened`、FATAL/TypeError/ReferenceErrorなし。証跡は`work/phase4-device/hidden-channel-metadata.png`。Node **135件**、Python **24件**、型検査、Gradleテスト、smoke APKビルド成功。

### Platform Indicatorの場所別拡張

- `runtime/src/features/venus/platformPlacements.ts` はVenusの`platformName`、`platformHeader`、`platformDmRow`、`placePlatformTree`を移植。既存の独自Avatar表示と組み合わせた。
- 352.17で検証した表示部品: UserRow **10659**、UserProfilePrimaryInfo **11110**、PrivateChannelHeader **14049**、MessagesItemChannelContent **17499**、Voice MemberRowItem **9196**。各memo/forwardRefの元部品は毎回同じフック順で呼び、子の部品をReactの描画外で実行しない。
- DM行の兄弟Avatarまで制御するためMessagesItemChannel **17494**のFast/Flash/LegendをContextで囲み、プロフィールのAvatar **8778**も同様に処理。Contextはレイアウトを追加しない。既存のAvatar表示と名前横の表示が重複することを防ぐ。
- 設定はschema2の任意の`platform`オブジェクト。`avatars`、`dmList`、`dmHeader`、`memberList`、`profile`、`messages`の6項目。旧ファイルは全場所オンを既定とし、機能の主スイッチ自体は従来どおり初期オフ。全場所が既定なら追加フィールドを省略する。
- ネイティブのメッセージ欄はRowGenerator **8165**の表示結果だけを複製し、表示用`username`へPC/M/W/VRを付加する。CreateMessageContent **8301**のusername/authorIdの構築を静的確認。送信内容・MessageRecord・authorIdは変更しない。音声保存CTAとの併存をテスト。
- pipaでDM一覧の行、DMヘッダー、DMのメンバー一覧、プロフィール名、過去メッセージの`peer-account · PC`を目視確認。その他AvatarをオンのままDM行とヘッダーを個別オフにして表示が消えること、プロセス再起動後の設定復元も確認した。DMカードのAvatarは「その他のアバター」で別に制御する。
- メッセージ欄の端末表示は再描画時点のPresenceを使う。設定変更後はチャンネルを開き直す。音声通話のMemberRowItemは、2026-11-12にpipa（0.1.0）で自分1人のボイスチャンネル参加中に、9196の読み込み・`placement installed`・`memberList rendered`とエラーなしを確認した。自分の行にバッジは出なかった（自分の端末状態がPresenceStoreに無いためと推定、未検証）。他人の行のバッジ表示は未確認。
- 証跡は`work/phase4-device/platform-new-header.png`、`platform-new-profile.png`、`platform-native-messages.png`、`platform-scoped-off.png`。固定文字列の場所別診断のみを記録し、IDやPresence値はログに出さない。Node **130件**、Python **24件**、型検査、Gradleテスト、smoke APKビルド成功。場所設定は試験後にすべて既定へ戻した。

### Server info（基本情報を実機確認）

- `runtime/src/features/venus/serverInfo.ts` はVenusの`serverInfoMenu`を移植。Morpheの個別patch `Server info` と初期オフの`serverInfo`設定を追加した。
- メニューはVenus 17433 → 352.17 **17772 / factory17773**。`getGuildsBarGuildMenuItems.tsx`のdefault export offset153を実バンドルで確認。押したときだけGuildStore **4877**を解決する。
- サーバーアイコンの長押しメニューに「サーバー情報」を追加し、読み込み済みの名前・ID・所有者ID・作成日時・メンバー数・ブースト情報・言語・認証レベルを表示。取得できていない値は省略。追加通信やメンバー取得要求は行わない。
- Venusの友達一覧、所有者プロフィール遷移、コピーボタン、装飾付きシートは未移植。diskではAndroid標準ダイアログを使う。
- pipaで初期オフ、設定保存、長押しメニューとダイアログを確認。`server-info opened`を記録し、FATAL/TypeError/ReferenceErrorなし。証跡は`work/phase4-device/server-info-dialog.png`。型検査、Node **122件**、Python **24件**、Gradleテストとsmoke APKビルド成功。

### Download voice messages（実機保存確認済み）

- `runtime/src/features/venus/voiceDownload.ts` はVenusの同名機能（VoiceDownload由来）を移植。個別patch `Download voice messages`、初期オフの`voiceDownload`設定。
- 352.17のRowGenerator **8165 / factory8166**（prototype.generate）、MessagesHandlers **11269**（handleTapCtaButton）を接続。保存操作時だけMessageStore **6042**、NativeMediaManager **1447**、イベント変換 **10105** を解決する。起動時の強制ロードはしない。
- 音声フラグ8192とDiscordのCDN/media上のattachments URL、audio MIMEを検査。既存のCTAは上書きしない。署名付きURLをそのまま標準の`downloadMediaAssetWithContentType(url, 0, mime)`へ渡す。再エンコードなし。失敗・連打はbusy状態を解放して再試行可能。
- 設定変更はチャンネルを開き直して反映する。オフにした直後に残っているdiskのCTAは何も保存せず消費し、Discordの別CTA処理へは渡さない。現状は暗色の中立ボタン配色。テーマ別調整は未対応。
- pipa: 短いテスト音声を送信→ボタン表示→押して保存、`voice-download started` / `saved`、`/sdcard/Download/voice-message.ogg`（5,679 bytes、Opus、1.72秒）を確認。保存処理はユーザー操作時のみ。テスト音声のローカルコピーはgitignore対象の`work/phase4-device/`内。
- 型検査、Node **119件**、Python **20件**、Gradleテスト、smoke APKビルド成功。

### Reply without pinging（サーバーの初期オフ・手動切替を実機確認）

- `runtime/src/features/venus/quietReplies.ts` はVenusの`quietReplyCreate`を移植。個別patch `Reply without pinging` と初期オフの `quietReplies` 設定を追加した。
- 実バンドルでVenus 9990 → 352.17 **10119 / factory10120** を確認。通常返信`createPendingReply`（export offset89、closure53522）と浅い返信`createShallowPendingReply`（offset100、closure53523）は、ともに引数の`shouldMention`をdispatchする。
- サーバー／グループDMの返信開始時だけ`shouldMention:false`にする。引数は変更せず複製し、手動の`setPendingReplyShouldMention`（offset111）は包まない。未知の形・1対1DM・既にオフの返信は元のまま。
- Venusのサーバー別／グループDM別設定と「自分へのメンションには通知する」例外設定は未移植。今回は単一スイッチ。
- 実機で、設定オン→サーバー返信欄が`@ OFF`で開始、返信欄をタップ→`@ ON`、設定オフ→通常どおり`@ ON`で開始することを確認した。返信本文の送信や相手端末の通知受信は試していない。グループDMと浅い返信の経路はユニットテストのみ。浅い返信（`createShallowPendingReply`）の呼び出し元はmodule 17904（通知タブの`ForYouItemActionButtons`、フレンド承認などの「👋」）だけで、相手がいないと発火しない。
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
