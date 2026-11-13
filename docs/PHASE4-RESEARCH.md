# Phase 4 調査記録（352.17 静的解析）

## 状態

Phase 3完了時の`f8b1454`を起点に、Phase 4の静的解析を行った。対象はDiscord 352.17 - Stableの`work/352.17/assets/index.android.bundle`（HBC98）と`base.apk`のDEXのみ。
bundleの実行・実機操作・送信は行っていない。以下は静的に読んだ呼び出し契約であり、実行時の承認ではない。
各機能は、実行時のshape/descriptor検査と、失敗時に元の動作へ戻す設計を前提に実装する。

調査はサブエージェントに委譲した。中間出力は`/tmp/cadence-p4/`（リポジトリ外・一時）に置いた。証拠は`function:offset`、moduleは`module→factory`で示す。

## 共通: 機能選択の受け渡し

- Morphe Patcher 2.3.0の`Patcher$invoke$2`を`javap -c`で読み、全patchの`execute`が終わった後に、`finalize`を`asReversed`の順で呼ぶことを確認した。
- 方針: 各機能patch（`Cadence`に依存）は`execute`で自分の選択を記録し、`Cadence`は`finalize`で選択をまとめて`BuildFeatures.render`に渡してから注入する。選択はAPKごとの作業領域に置き、singletonのmutable stateは使わない。記録物は注入後に必ず消す。
- 実際のCLIで、選択した機能だけが埋め込まれることをビルドして確かめる。

## 4a Fake Nitro

### 送信経路

- MessageActions **7598→7599**。default exportの実体は`7599:1683`で代入されるobjectで、`sendMessage`=43054（`7599:1439`）、`_sendMessage`=43065（`7599:1538`）、`validateMessage`=43064、`sendStickers`=43061がそのプロパティ。
- `sendMessage(channelId, message, arg3 = true, options)`。43054はgenerator **145141**を作る。145141は`nonce`補完・`recordMessageSendAttempt`・channelのready待ちを行い、`_sendMessage`を呼ぶ。messageからは`reaction`以外を読まない。条件付きで同じexport objectの`sendMessage`を再帰呼出しする（`145141:530-571`）。
- `_sendMessage(channelId, message, options)`はgenerator **145142**。messageから`content`(`:1169`)・`invalidEmojis`(`:1178`)・`validNonShortcutEmojis`(`:1184`)・`tts`(`:1194`)・`components`を、optionsから`stickerIds`(`:1251`)・`messageReference`・`allowedMentions`・`nonce`等を読む。`content`はそのまま送信bodyに入る（`:2329-2389`）。
- **使えない絵文字は送信を止めず、ローカル通知だけを出す。** `145142:2181-2258`で`invalidEmojis.length > 0`なら`validateMessage(invalidEmojis, currentUser, channelId)`の文言を`sendBotMessage`する。送信自体は続く（静的に読んだ限り。実行では未確認）。
- 通常のチャット入力: **63829**（module 13126）が`parse(...)`でmessageを作り（`:462`）、`message.tts`を上書き（`:490`）。`:767`で`sendMessage`をプロパティ参照で取り、`:829`で`sendMessage(channel.id, message, undefined, options)`を呼ぶ。export objectのプロパティを差し替えれば、この経路に効く。
- `_sendMessage`を直接呼ぶ`sendInvite`・`sendActivityBookmark`・`sendStickers`・`sendPollMessage`には、`sendMessage`の差し替えが効かない。

### message の作られ方（parser）

- `parse`=44632（module **7787**→7788、`7788:1927`）。`parse(channel, text, ctx?, opts?)`は`{content, tts:false, invalidEmojis:[], validNonShortcutEmojis:[]}`を返す（`44632:50-76`）。
- カスタム絵文字は`{type:'customEmoticon', content:'<'+(animated?'a':'')+':'+(originalName??name)+':'+id+'>', emoji}`のnodeになる（`44618:113-212`、`44620:110-196`）。**使えない絵文字でもcontentは`<:name:id>`のまま**で、置換はどこにもない。
- 検証callback 99690は`isEmojiPremiumLocked({emoji, channel, intention: CHAT})`（32987、module 4953）で判定し、lockedなら`invalidEmojis`へ、そうでなく非shortcutなら`validNonShortcutEmojis`へpushする。contentは書き換えない。
- 配列の要素はemoji objectそのもの。`id`・`name`・`animated`・`originalName`の読み出しは確認済み。`guildId`は未確認。

### 利用可否の判定

- module **2053→2054**のdefault exportはshape付きobject（`2054:1480`）。`canUseAnimatedEmojis`=27731、`canUseEmojisEverywhere`=27732、`canUseCustomStickersEverywhere`=27751。引数`(user)`、戻り値boolean。いずれも`canUserUse(EntitlementFeatureNames.X, user)`（module 5060の33540）へ委譲し、最終的に`user.premiumType`から判定する。
- 不可理由: module **4953**（`utils/EmojiUtils.tsx`）の32980（getEmojiDisabledReason）が`PREMIUM_LOCKED`・`DISALLOW_EXTERNAL`等を返す。`bypassPremiumEmojiEntitlement`が真ならcanUse*を呼ばない。ギルド側の制約（`available`・`USE_EXTERNAL_EMOJIS`権限など）はcanUse*とは別に残る。
- スタンプ: module **7475→7476**。`StickerSendability`（`SENDABLE`=0、`SENDABLE_WITH_PREMIUM`=1、`NONSENDABLE`=2、`SENDABLE_WITH_BOOSTED_GUILD`=3）、`getStickerSendability(sticker, user, channel)`=42462、`isSendableSticker`=42463。
- `sendStickers(channelId, stickerIds, content = '', options, tts = false)`は`_sendMessage(channelId, message, {...options, stickerIds})`を呼ぶ（`43061:142`）。stickerのpickerは150051（module 13120）`:289`。
- URL: module 4953の`getEmojiUrl`=32993。CDN文字列の組み立てとスタンプURL helperは未確認。

### 実装方針（Phase 4a）

1. **入力した絵文字の変換**（最優先）: `7598.default.sendMessage`を元関数保持で差し替える。`message.invalidEmojis`（Discord自身がlockedと判定したもの）について、`content`中の`<a?:name:id>`をCDNリンクへ置換し、`invalidEmojis`を空にしてから元関数を呼ぶ。判定をDiscordに任せるので、使える絵文字はそのまま送られる。変換は冪等（再帰呼出しでも安全）にし、例外時は元の引数で元関数を呼ぶ。
2. pickerで選べるようにする（canUse*の差し替え）は、上記の判定（parserのlocked判定）まで変えてしまう。元関数を一時的に戻して判定する仕組みが必要で、後回しにする。
3. スタンプは`sendStickers`を差し替え、送信不可のスタンプだけリンク送信に変える。判定に必要なsticker object・userの取得経路が未確認なので、1の後に追加調査する。
4. 実送信を伴う確認は、ユーザーの承認を得てから行う。

## 4b Platform Indicator

### データと購読

- PresenceStore **5744→5745**。内部slot15が`{[userId]: {desktop|mobile|web|vr: status}}`。書き込みは35447（flattenPresence）・35449（updatePresence）・35471・35477。`getClientStatus`=35468（`5745:516..521`）。action mapは`5745:565`（`PRESENCE_UPDATES`・`PRESENCES_REPLACE`・`CONNECTION_OPEN`等）。
- ClientTypes（module 1098→1099、`PutById @12535`）の値は`desktop`・`web`・`mobile`・`vr`。
- 購読: flux module **504→505**が`useStateFromStores`・`useStateFromStoresObject`をplain data propertyで再export（`@340/@345`・`@360/@366`）。実装はmodule 573→574の21420/21421。
  - `useStateFromStores(stores, getter, deps?, areStatesEqual?)`。depsがあれば浅い比較で再計算を省く。
  - 呼び出し例: 9182`@120-159`で`useStateFromStoresObject([PresenceStore], getter, [user_id])`。

### 表示境界

- **Avatar**: module **15449→15450**（`design/void/Avatar/native/Avatar.tsx`）。default exportは`React.memo(70989 | 70990)`で、plain data property（`15450@297`）。propsは`user`・`guildId`・`isMobileOnline`・`isVROnline`・`status`・`size`・`autoStatusCutout`等。design-system barrel module 1202経由で674 moduleから参照される。
- 70990は`props.user`を読み（`@219`）、`.id`を`userId`として下位へ渡す（`@1197/@1202`）。`user`が`id`を持つuser objectであるという点は有力な推定で、レジスタの追跡は未完了。
- アイコン: 1 module 1アイコンで、`ScreenIcon`=9514、`MobilePhoneIcon`=7085、`GlobeEarthIcon`=9524、`GameControllerIcon`=9648、`VrHeadsetIcon`=16280。propsは`style`・`color`（既定`colors.INTERACTIVE_ICON_DEFAULT`）と残りを`BaseIconImage`へ渡す。`size`の扱いは未確認。

### 実装方針（Phase 4b）

- module 15449のdefault（React.memo）を、factory終了後・最初のconsumer前に、元の要素を常に保持するwrapperで差し替える。wrapperは`props.user?.id`が文字列のときだけ、`useStateFromStores([PresenceStore], () => getClientStatus(id), [id])`で状態を取り、Avatarの隣に小さなアイコンを並べる。
- Avatarは至る所で使われるため、表示箇所の絞り込み（サイズ条件など）と描画コストを実機で確認する。設定の「表示箇所」オプションは、確認後に決める。

## 4c Privacy

### JS analytics

- `track`=24981。module **1267→1268**で`{getCampaignParams, setSystemAccessibilityFeatures, expandEventProperties, track}`を作り、`1268:2469`でplain dataとして`exports.default`に代入する。
- trackは`throttlePercent`による間引き・`logEventProperties`の後、trackMaker（module 1275）経由で`dispatcher.dispatch({type: TRACK_ACTION_NAME, event, properties, flush, fingerprint, …})`する（142134`:108`）。戻り値のPromiseは解決されない（間引き時のみ`Promise.resolve()`）。
- 方針: `1267.default.track`を、`Promise.resolve()`を返すno-opに差し替える。`trackNetworkAction`（24989）等の別exportと、1268`:2331`の2つ目のtrackMaker経路は未確認。

### DEX

- **Sentry**: 全初期化は`Lio/sentry/android/core/e1;->b(Context,k0,c4)V`（classes3）に集まる。呼び出し元は3つ。
  - `SentryInitProvider.onCreate()`: Manifestの`io.sentry.auto-init=false`により、`e1.b`を呼ばずにreturnする（既に無効）。
  - `RNSentryModuleImpl.initNativeSdk(ReadableMap, Promise)`: JSの`Sentry.init`から呼ばれ、`e1.b`後に`promise.resolve(TRUE)`。
  - `Lu5/b;->call()`（classes.dex、アプリ独自のcrash reporting）: switchのcase0で設定を作り`e1.b`を呼び、続けて`NativeCrashReporting.initNative(Z)`。
  - 方針は未決。`e1.b`をreturn-voidにすると全経路が止まる見込みだが、SDK内部メソッドで、JS側Sentryの送信経路（native transportか、fetchか）とnative crash reportingは未確認。
- **AppsFlyer**: `MainApplication.onCreate`が`Ld6/a;`（`invoke`内のpacked switch。複数の用途を兼ねる）を別スレッドで実行し、case3で`getInstance`→`subscribeForDeepLink`→`init`→`start`を呼ぶ（`invoke` #45/#46）。アプリ側からのinit/start呼び出しはここだけ。`invoke`全体はスタブ化できない。case3の分岐だけを無効化する命令レベルの置換を、BundlePin同様に全命令を固定して検討する。
- **広告ID**: React Nativeから呼ばれる入口は`AdsModule.getGoogleAdvertisingId(Promise)`（`@ReactMethod`）のみ。既存のprivate `resolveWithNullId(Promise)`が`{googleAdvertisingId: null, isLimitAdTrackingEnabled: true}`をresolveする。方針: `getGoogleAdvertisingId`の本体を`invoke-direct {p0, p1}, resolveWithNullId` + `return-void`に置換する。AppsFlyer内部（`AFe1fSDK.getRevenue`）からの取得は、AppsFlyerを止めれば止まる。

## 実装順序

1. 共通: 機能patchの追加と`finalize`での埋め込み（Kotlin、テスト）。
2. Privacy: 広告ID（DEX、最小）とJS analytics（`track`のno-op）。AppsFlyer・Sentryは追加検証後。
3. Platform Indicator: Avatar wrapper（表示のみ）。
4. Fake Nitro: 入力した絵文字の変換。実送信の確認はユーザー承認後。
5. 全テスト・独立レビュー・同署名APKでの実機確認（送信以外）・資料更新。

## 注意

- Venusのコードは参照・複製しない。
- descriptor一致だけで機能の意味論や起動安全性を承認しない。差し替えは実行時にshapeを検査し、失敗時は元の動作のままにする。
- 送信はモックで検証し、実送信はユーザーに確認してから行う。アカウント・メッセージ・storeの内容は取得・保存しない。
