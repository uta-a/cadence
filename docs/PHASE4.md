# Phase 4: 機能の実装・検証記録

## 状態

Fake Nitro・Platform Indicator・Privacy（JS analyticsの停止と広告IDの無効化）を実装し、Android 13（pipa）のDiscord 352.17 - Stableで動作を確認した。
静的解析の根拠と設計判断は[調査記録](PHASE4-RESEARCH.md)にある。Sentry・AppsFlyerの停止は未実装（理由は後述）。

## 機能の選び方（Morphe）

| パッチ | 種類 | 既定 | 内容 |
| --- | --- | --- | --- |
| `Cadence` | resource | 選択 | ランタイム注入と設定画面。依存として`bundle pin`が入る |
| `Fake Nitro` | resource（`Cadence`に依存） | 選択 | ランタイムへ機能を埋め込む。Discord内の設定で有効にするまでオフ |
| `Platform Indicator` | resource（`Cadence`に依存） | 選択 | 同上 |
| `Disable analytics` | resource（`Cadence`に依存） | 選択 | JSの`track`を止める。Discord内の設定はない |
| `Disable advertising ID` | bytecode | 選択 | 広告IDを常に`null`で返す。Discord内の設定はない |

- 各機能patchは`execute`で選択を記録し、`Cadence`は`finalize`で選択をまとめて埋め込む（Morphe 2.3.0は全`execute`の後に`finalize`を呼ぶ）。選択はpatching contextをキーにした弱参照の表に置き、取り出すと消える。
- ランタイムは埋め込まれた機能だけmoduleの取得とフックを行う。設定画面には、組み込まれた機能だけスイッチを出し、含まれない機能はその旨を表示する。

## 実装

### Fake Nitro（`runtime/src/features/fakeNitro.ts`）

- `MessageActions`（module 7598）の`default.sendMessage`を、元関数を保持した関数で差し替える。
- Discordのparserは、送れない絵文字を`message.invalidEmojis`に入れつつ`content`には`<:name:id>`を残す。その絵文字だけをCDNの画像リンク（`https://cdn.discordapp.com/emojis/{id}.{webp|gif}?size=48&name={name}`）に置き換え、`invalidEmojis`から除く。使える絵文字はそのまま送る。
- 前後に空白がなければ空白を補う。変換後が2000文字を超える場合、形が想定外の場合、設定が読めない場合は、元のmessageのまま元関数を呼ぶ。呼び出し元のmessageは書き換えない。Discordが内部で`sendMessage`を再度呼んでも、2回目は変換しない（冪等）。
- **設定**: 画像サイズ（48/64/96/128）と名前付きリンク（`[name](URL)`）を、Cadence設定画面のFake Nitroの下で選べる。設定ファイルはschema 2のまま、任意の`nitro`オブジェクトとして保存する（旧ビルドはallowlistのキーしか読まないので無視する。旧ビルドで設定を保存すると`nitro`は消え、既定値に戻る）。不正な値は読み込み時に既定値（48・オフ）に戻し、保存時は拒否する。
- **スタンプ**（`installStickerHooks`）: スタンプピッカー（function 105918）は、`getStickerSendability`（module 7475）の結果が`SENDABLE`のときだけ送信へ進む。Fake Nitroがオンのとき、Nitro限定（`SENDABLE_WITH_PREMIUM`）でPNG・APNG・GIF形式のスタンプだけを`SENDABLE`と返し、そのIDを最大64件記憶する。`sendStickers`は、送るスタンプがすべて記憶済みのときだけ、`https://media.discordapp.net/stickers/{id}.{png|gif}?size=160`を通常のメッセージとして送る。それ以外（Lottie、送信不可、混在、オフ）はDiscordの元の処理のまま。本文は、元の`sendStickers`と同じ扱いにする（文字列はそのまま、真偽値・未指定は本文なし、`content`を持つobjectはその`content`）。スタンプピッカー（150051:416）は本文の代わりに`chatInputValidateContentLength`の結果を渡すので、この扱いが必要。Discord自身が送信可能と答えるようになったスタンプ（Nitro加入後など）や、オフの間に判定されたスタンプは記憶から外し、本物のスタンプとして送る。名前付きリンクのラベルはスタンプ名から英数字・`_`・`-`・空白だけを残し（他人が付けた名前でメンションや書式が入らないように）、空なら`sticker`にする。
  - 制約: 偽装したスタンプと通常のスタンプを一度に送る場合と、本文の形が分からない場合は元の送信に回すので、サーバーに拒否されて何も起きないように見える。ピッカーでは、偽装したスタンプのロック表示が消え（意図どおり）、並び順が変わることがある。
- **ピッカー**（`installEmojiPickerUnlock`）: 絵文字ピッカーはmodule 4953の`default.getEmojiUnavailableReason(s)`でロックを判定する。Fake Nitroがオンで、用途が`EmojiIntention.CHAT`のときだけ、`bypassPremiumEmojiEntitlement: true`を付けた引数のコピーで元関数を呼ぶ（Nitroの判定だけを省き、サーバー側の制限は残る）。送信時の判定（parserの`isEmojiPremiumLocked`）は同じ実装をclosure経由で呼ぶのでこの影響を受けず、選んだ絵文字は送信時にリンクへ変換される。リアクションとカスタムステータスはリンクにできないので対象外。
- **実機確認（2026-11-11、pipa、ユーザーの許可を得て`peer-account`とのDMに送信・撮影）**: Devサーバーにテスト用のアニメ絵文字`:emoji_2:`とスタンプ`cadence_test`を追加した（許可済み）。
  - ピッカー: チャットの絵文字ピッカーに、それまで出ていなかった「Dev」欄が現れ、`:emoji_1:`と`:emoji_2:`をロックなしで選べた。選んだ絵文字は入力欄に入り、送信時に`fake-nitro converted`でリンクに変換され、画像として表示された。アニメ絵文字も同様。スタンプの関連絵文字を選ぶピッカー（用途がCHATでない）ではロック表示のままで、設計どおり。
  - スタンプ: 1回目はリンクにならず、スタンプのまま送られてサーバーに拒否された（自分にだけ見える失敗表示とClydeの通知。相手には届いていない）。原因は上記の本文の扱いで、修正後は`fake-nitro sticker-linked`を記録し、スタンプ画像のリンクとして送られて表示された。スタンプ一覧のロック表示は、当初は残っていた（一覧の行106004/106011/106012は`isSendableSticker`を使い、これが元の判定を内部参照で呼ぶため）。`isSendableSticker`のexportも、差し替えた判定を通すように置き換え、ロック表示が消えたことを実機で確認した。
  - Platform Indicator: DM一覧の**行**、上部のカード、チャットのヘッダーにバッジが出た。相手がPCとモバイルの両方で接続すると「PC M」と並んだ。

### Platform Indicator（`runtime/src/features/platformIndicator.ts`）

- design-systemの`Avatar`（module 15449、default export = `React.memo`）を、元のAvatar要素を必ず描画するwrapperで差し替える。オンのときだけ、Avatarを`position: relative`のViewで包み、右上に小さなバッジを重ねる。
- 状態は`PresenceStore.getClientStatus(user.id)`をflux（module 504）の`useStateFromStores`で購読する。desktop/mobile/web/vrの順に、オンライン・退席中・取り込み中・配信中の色で表示し、オフラインと不明なキーは出さない。
- hookの数がインスタンスごとに変わらないよう、PresenceStore・flux・RNの部品がそろっているかを最初のrenderで固定する。RNの部品は、ルートnavigationの準備ができてから読む。
- アイコンは、自然にロード済みのDiscordのアイコン部品（ScreenIcon等）を使い、未ロードなら文字（PC/M/W/VR）で代替する。
- hookの数を一定にするため、PresenceStoreの購読を行うかどうかは最初のrenderで決める（PresenceStoreとfluxは起動直後にロード済み）。RNの部品は毎回取りに行くので、navigationの準備前に描画されたAvatarにも後からバッジが出る。設定がオフでも購読は続ける（オンにした瞬間に表示するため）。
- 差し替え後のコンポーネントには、元のmemoオブジェクトの静的プロパティ（`displayName`等）を写す。React 19では`ref`は通常のpropsとして元の要素へ渡る。
- 表示範囲: このAvatar部品を使う箇所だけ。実機ではDM一覧の行・上部のカード・チャットヘッダーで表示を確認した（DM一覧の行（module 17498）はdesign-systemのbarrel module 1202経由で同じAvatarを描く）。メッセージ横のアバターには出ない。

### Privacy

- **JS analytics**（`runtime/src/features/analytics.ts`）: module 1267の`default.track`を、何もせず解決済みPromiseを返す関数に置き換える。元の`track`は呼ばない。`trackNetworkAction`などの別exportと、trackMakerの2つ目の経路は未確認のため、設定画面では「JS の track 送信を停止」と範囲を限定して表示する。
- **広告ID**（`patches/.../dex/AdvertisingId.kt`）: `AdsModule.getGoogleAdvertisingId(Promise)`の本体を、既存の`resolveWithNullId(promise)`呼び出しと`return-void`に置き換える。置き換え前に、元の命令列と`resolveWithNullId`の命令列が352.17と完全に一致することを確かめ、一致しなければpatchを止める。
- **Sentry**（`Disable crash reporting`、`patches/.../dex/MethodStub.kt`）: Manifestの自動初期化・JSからの`RNSentryModuleImpl.initNativeSdk`・Discord独自のcrash reporting（`Lu5/b;->call()`）の3経路は、すべてSDKの`Lio/sentry/android/core/e1;->b(Context, k0, c4)V`に合流する。この先頭に`return-void`を入れ、SDKを初期化しない（Sentryの静的APIは既定の何もしない状態のまま）。元の本体は到達しないコードとして残す。
- **AppsFlyer**（`Disable install attribution`）: `start`の全オーバーロードが合流する`AFa1uSDK.start(Context, String, AppsFlyerRequestListener)`と、`logEvent`の2つのオーバーロードの先頭に`return-void`を入れる。`init`は送信しないので残す。
- どちらも、対象メソッドの命令列・レジスタ・try blockのSHA-256と命令数を352.17の実測値と照合してから書き換え、違えばpatchを止める。先頭の命令へ分岐やtry blockが入るメソッドは拒否する（先頭に入れた`return-void`へ戻ってくる経路を作らないため）。適用済みと判定するのは、先頭が`return-void`で命令数がちょうど元より1つ多い場合だけ。`bundle pin`が照合しているメソッド（`Ld6/a;->invoke()`・`Lu5/b;->call()`等）には触れない。
- **通信での確認（2026-11-11、接続先のホスト名のみ）**: ユーザーの判断により、証明書は入れず、Mac上のCONNECTプロキシで接続先の`host:port`だけを記録した（中身は復号しない）。端末はログインしていないテスト端末XIG07（Android 16）で、端末のシステムプロキシを一時的に設定し、確認後に元の`null`へ戻した。同じ署名鍵で、privacy系patchなし（`Cadence`のみ）の対照ビルドと全patchビルドを順に上書きし、それぞれ起動から75秒間を比べた。
  - 対照ビルド: `o64374.ingest.sentry.io`・`o4505093097586688.ingest.us.sentry.io`（Sentry）と、`*.appsflyersdk.com`の5ホスト（`launches`・`conversions`・`attr`・`dlsdk`・`cdn-settings`）へ接続した。
  - 全patchビルド: Sentry・AppsFlyer宛ての接続は0件。Discordの接続は`discord.com`・`gateway.discord.gg`・`cdn.discordapp.com`・`latency.discord.media`のみ。
  - 限界: システムプロキシなので他のアプリの接続も混ざる（Discord以外のホストは記録から除外した）。analyticsは`discord.com`と同じホストなので、この方法では判定できない。未ログインの起動75秒間だけで、ログイン後や長時間の利用は見ていない。Discord独自のnative crash reporting（`libcrash-reporting`）が単独で送信するかは、クラッシュを起こしていないので未確認。

## 設定の保存に失敗したとき

スイッチの値はすぐに反映し（機能も即座に切り替わる）、保存に失敗したら「保存できませんでした」と再試行ボタンを出す。メモリ上の値は変更後のままなので、再起動までは画面どおりに動き、再起動後はディスクに残った値に戻る。Phase 3のコンパクト表示と同じ扱い。

## 実機での確認（2026-11-10）

smoke版APK（SHA-256 `19850e32a1d24675bd603da8633b096b2a14739be4da2dc5167412b96d975ff5`）を同署名・データ保持で上書きした。

1. 起動時の固定ログ: `analytics blocked`・`fake-nitro installed`・`platform-indicator installed`・`settings ready`・`ui installed`。fatal・TypeError・ReferenceError・hookの順序エラーは0件。
2. Cadence設定画面: 名前付き操作で、機能スイッチの初期値（オフ）、Platform Indicatorのオン・保存（read-back）・cold restart後の保持を確認。
3. Platform Indicator: `platform-indicator rendered`・`badge`を記録。ユーザーの許可を得て撮影し、`peer-account`のアバター右上に退席中の色の「PC」バッジが出て、レイアウトが崩れていないことを確認した。
4. Fake Nitro: ユーザーの許可を得て、Devサーバーにテスト用絵文字`:emoji_1:`を追加し、`peer-account`とのDMで`Cadence fake nitro test :emoji_1:`を1通送信した。送られた本文は`Cadence fake nitro test https://cdn.discordapp.com/emojis/1569606315754389565.webp?size=48&name=emoji_1`で、画像が埋め込み表示され、「使えない絵文字」の通知は出なかった。固定ログ`fake-nitro converted`を1回記録した。
5. レビュー指摘の修正後に通常版APK（SHA-256 `095755378b2c0f7c43bb48eb90b1c5c2d75a77afbc95e0787114cc69e3268746`、smoke=false）をビルドし、同署名・データ保持で上書きした。端末上のAPKのハッシュが一致し、cold startで設定画面への自動遷移がないこと、`platform-indicator rendered`・`badge`を含む固定ログ、エラー0件を確認した。
6. 広告ID・analytics: APK内のDEXで`getGoogleAdvertisingId`が置き換わっていること、ランタイムで`track`が置き換わったことを確認した。ネットワーク上で送信が止まったことは観測していない。

ログには固定の文字列だけを出し、ユーザーID・presence・メッセージの内容は出さない。

## 独立レビュー

2回目（ブランチ`feat/phase4-remaining`）: P1なし。P2のスタンプの記憶が残り続ける点と、名前付きリンクのラベルの無害化を修正した。P3のうち、適用済み判定を命令数で厳密にすることと、先頭命令への分岐の拒否をコードとテストに入れ、スタンプの制約と旧ビルドでの`nitro`の扱いを記録した。

1回目:

読み取り専用の独立レビューでP1（必須）の指摘はなかった。P2のうち、起動直後に描画されたAvatarにバッジが出ない点と、元のmemoの静的プロパティが失われる点を修正した。機能選択の受け渡しは実際のAPKで確認済みであることと、保存失敗時の扱い、analyticsの停止範囲を資料と画面の文言に反映した。オフ時は元のAvatar要素をそのまま返す（レイアウトを変えない）ため、オン・オフの切り替え時にはAvatarが再マウントされる。

## 端末に残した変更

- Devサーバーのテスト用カスタム絵文字`:emoji_1:`（ユーザーの許可を得て追加）
- `peer-account`とのDMへのテスト送信（許可済み）: 2026-11-10に1通、2026-11-11にピッカーの絵文字・アニメ絵文字・スタンプのリンクの計3通と、失敗したスタンプ1通（相手には届いていない）
- Devサーバーのテスト用アニメ絵文字`:emoji_2:`とスタンプ`cadence_test`（許可済み）
- Fake NitroとPlatform Indicatorはオンのまま

## ローカル検証

- Node: 96件成功（変換・冪等性・失敗時の元動作・hook数・機能別capture・設定画面の機能行を含む）。TypeScript型検査成功。
- Kotlin: 57件成功（Sentry・AppsFlyerの命令列ガードと置き換え、広告IDの命令列ガード・置き換え・DEX往復・改変の拒否、機能選択のcontext分離を含む）。
- Python: 20件成功（追加したmoduleの登録位置・命令境界を実バンドルで照合）。
- Kotlinの実DEXを使うテストは、`work/352.17/dex`がない環境ではskipされる。この環境ではskip 0件。
- 機能選択の受け渡しは、Morphe CLIで実際にビルドしたAPKで確認した（単体テストは`Any()`のcontextを使うため）。通常版APKでpreludeを復元し、生成したランタイムに`["fakeNitro", "platformIndicator", "disableAnalytics"]`を埋めたものと完全一致すること、smoke引数が`!1`であること、DEXの置き換えと`bundle pin`を確認した。
