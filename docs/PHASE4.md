# Phase 4: 機能の実装・検証記録

## 状態

Fake Nitro・Platform Indicator・Privacy（JS analyticsの停止と広告IDの無効化）を実装し、Android 13（pipa）のDiscord 352.17 - Stableで動作を確認した。
静的解析の根拠と設計判断は[調査記録](PHASE4-RESEARCH.md)にある。Sentry・AppsFlyerの停止は未実装（理由は後述）。

## 機能の選び方（Morphe）

| パッチ | 種類 | 既定 | 内容 |
| --- | --- | --- | --- |
| `disk` | resource | 選択 | ランタイム注入と設定画面。依存として`bundle pin`が入る |
| `Fake Nitro` | resource（`disk`に依存） | 選択 | ランタイムへ機能を埋め込む。Discord内の設定で有効にするまでオフ |
| `Platform Indicator` | resource（`disk`に依存） | 選択 | 同上 |
| `Disable analytics` | resource（`disk`に依存） | 選択 | JSの`track`を止める。Discord内の設定はない |
| `Disable advertising ID` | bytecode | 選択 | 広告IDを常に`null`で返す。Discord内の設定はない |

- 各機能patchは`execute`で選択を記録し、`disk`は`finalize`で選択をまとめて埋め込む（Morphe 2.3.0は全`execute`の後に`finalize`を呼ぶ）。選択はpatching contextをキーにした弱参照の表に置き、取り出すと消える。
- ランタイムは埋め込まれた機能だけmoduleの取得とフックを行う。設定画面には、組み込まれた機能だけスイッチを出し、含まれない機能はその旨を表示する。

## 実装

### Fake Nitro（`runtime/src/features/fakeNitro.ts`）

- `MessageActions`（module 7598）の`default.sendMessage`を、元関数を保持した関数で差し替える。
- Discordのparserは、送れない絵文字を`message.invalidEmojis`に入れつつ`content`には`<:name:id>`を残す。その絵文字だけをCDNの画像リンク（`https://cdn.discordapp.com/emojis/{id}.{webp|gif}?size=48&name={name}`）に置き換え、`invalidEmojis`から除く。使える絵文字はそのまま送る。
- 前後に空白がなければ空白を補う。変換後が2000文字を超える場合、形が想定外の場合、設定が読めない場合は、元のmessageのまま元関数を呼ぶ。呼び出し元のmessageは書き換えない。Discordが内部で`sendMessage`を再度呼んでも、2回目は変換しない（冪等）。
- 未実装: 絵文字ピッカーで送れない絵文字を選べるようにすること、スタンプのリンク送信、サイズ・マスクドリンクのオプション。

### Platform Indicator（`runtime/src/features/platformIndicator.ts`）

- design-systemの`Avatar`（module 15449、default export = `React.memo`）を、元のAvatar要素を必ず描画するwrapperで差し替える。オンのときだけ、Avatarを`position: relative`のViewで包み、右上に小さなバッジを重ねる。
- 状態は`PresenceStore.getClientStatus(user.id)`をflux（module 504）の`useStateFromStores`で購読する。desktop/mobile/web/vrの順に、オンライン・退席中・取り込み中・配信中の色で表示し、オフラインと不明なキーは出さない。
- hookの数がインスタンスごとに変わらないよう、PresenceStore・flux・RNの部品がそろっているかを最初のrenderで固定する。RNの部品は、ルートnavigationの準備ができてから読む。
- アイコンは、自然にロード済みのDiscordのアイコン部品（ScreenIcon等）を使い、未ロードなら文字（PC/M/W/VR）で代替する。
- hookの数を一定にするため、PresenceStoreの購読を行うかどうかは最初のrenderで決める（PresenceStoreとfluxは起動直後にロード済み）。RNの部品は毎回取りに行くので、navigationの準備前に描画されたAvatarにも後からバッジが出る。設定がオフでも購読は続ける（オンにした瞬間に表示するため）。
- 差し替え後のコンポーネントには、元のmemoオブジェクトの静的プロパティ（`displayName`等）を写す。React 19では`ref`は通常のpropsとして元の要素へ渡る。
- 表示範囲: このAvatar部品を使う箇所だけ。実機ではDM一覧上部のカードとチャットヘッダーで表示を確認した。DMの行やメッセージ横のアバターは別の部品で、表示されない。

### Privacy

- **JS analytics**（`runtime/src/features/analytics.ts`）: module 1267の`default.track`を、何もせず解決済みPromiseを返す関数に置き換える。元の`track`は呼ばない。`trackNetworkAction`などの別exportと、trackMakerの2つ目の経路は未確認のため、設定画面では「JS の track 送信を停止」と範囲を限定して表示する。
- **広告ID**（`patches/.../dex/AdvertisingId.kt`）: `AdsModule.getGoogleAdvertisingId(Promise)`の本体を、既存の`resolveWithNullId(promise)`呼び出しと`return-void`に置き換える。置き換え前に、元の命令列と`resolveWithNullId`の命令列が352.17と完全に一致することを確かめ、一致しなければpatchを止める。
- **未実装**: Sentryは、全初期化経路の合流点がSDK内部のメソッドであり、JS側Sentryの送信経路が未確認。AppsFlyerは、初期化が複数の処理を兼ねる`Ld6/a;->invoke()`のswitchの1分岐にあり、さらに`bundle pin`がこのメソッドの全体を固定して照合しているため、単純には置き換えられない。どちらも追加の検証が必要。

## 設定の保存に失敗したとき

スイッチの値はすぐに反映し（機能も即座に切り替わる）、保存に失敗したら「保存できませんでした」と再試行ボタンを出す。メモリ上の値は変更後のままなので、再起動までは画面どおりに動き、再起動後はディスクに残った値に戻る。Phase 3のコンパクト表示と同じ扱い。

## 実機での確認（2026-11-10）

smoke版APK（SHA-256 `19850e32a1d24675bd603da8633b096b2a14739be4da2dc5167412b96d975ff5`）を同署名・データ保持で上書きした。

1. 起動時の固定ログ: `analytics blocked`・`fake-nitro installed`・`platform-indicator installed`・`settings ready`・`ui installed`。fatal・TypeError・ReferenceError・hookの順序エラーは0件。
2. disk設定画面: 名前付き操作で、機能スイッチの初期値（オフ）、Platform Indicatorのオン・保存（read-back）・cold restart後の保持を確認。
3. Platform Indicator: `platform-indicator rendered`・`badge`を記録。ユーザーの許可を得て撮影し、`peer-account`のアバター右上に退席中の色の「PC」バッジが出て、レイアウトが崩れていないことを確認した。
4. Fake Nitro: ユーザーの許可を得て、Devサーバーにテスト用絵文字`:emoji_1:`を追加し、`peer-account`とのDMで`disk fake nitro test :emoji_1:`を1通送信した。送られた本文は`disk fake nitro test https://cdn.discordapp.com/emojis/1569606315754389565.webp?size=48&name=emoji_1`で、画像が埋め込み表示され、「使えない絵文字」の通知は出なかった。固定ログ`fake-nitro converted`を1回記録した。
5. レビュー指摘の修正後に通常版APK（SHA-256 `095755378b2c0f7c43bb48eb90b1c5c2d75a77afbc95e0787114cc69e3268746`、smoke=false）をビルドし、同署名・データ保持で上書きした。端末上のAPKのハッシュが一致し、cold startで設定画面への自動遷移がないこと、`platform-indicator rendered`・`badge`を含む固定ログ、エラー0件を確認した。
6. 広告ID・analytics: APK内のDEXで`getGoogleAdvertisingId`が置き換わっていること、ランタイムで`track`が置き換わったことを確認した。ネットワーク上で送信が止まったことは観測していない。

ログには固定の文字列だけを出し、ユーザーID・presence・メッセージの内容は出さない。

## 独立レビュー

読み取り専用の独立レビューでP1（必須）の指摘はなかった。P2のうち、起動直後に描画されたAvatarにバッジが出ない点と、元のmemoの静的プロパティが失われる点を修正した。機能選択の受け渡しは実際のAPKで確認済みであることと、保存失敗時の扱い、analyticsの停止範囲を資料と画面の文言に反映した。オフ時は元のAvatar要素をそのまま返す（レイアウトを変えない）ため、オン・オフの切り替え時にはAvatarが再マウントされる。

## 端末に残した変更

- Devサーバーのテスト用カスタム絵文字`:emoji_1:`（ユーザーの許可を得て追加）
- `peer-account`とのDMへのテスト送信1通（許可済み）
- Fake NitroとPlatform Indicatorはオンのまま

## ローカル検証

- Node: 88件成功（変換・冪等性・失敗時の元動作・hook数・機能別capture・設定画面の機能行を含む）。TypeScript型検査成功。
- Kotlin: 49件成功（広告IDの命令列ガード・置き換え・DEX往復・改変の拒否、機能選択のcontext分離を含む）。
- Python: 20件成功（追加したmoduleの登録位置・命令境界を実バンドルで照合）。
- Kotlinの実DEXを使うテストは、`work/352.17/dex`がない環境ではskipされる。この環境ではskip 0件。
- 機能選択の受け渡しは、Morphe CLIで実際にビルドしたAPKで確認した（単体テストは`Any()`のcontextを使うため）。通常版APKでpreludeを復元し、生成したランタイムに`["fakeNitro", "platformIndicator", "disableAnalytics"]`を埋めたものと完全一致すること、smoke引数が`!1`であること、DEXの置き換えと`bundle pin`を確認した。
