# Cadence

Discord Android向けのMorphe patchバンドルです。Fake Nitro、端末表示、Privacyを追加します。旧名は **disk** で、0.1.0はその名前で公開しています。

**最新版は0.2.0です。対応はDiscord 352.17 Stableのみです。** 0.1.0にあったVenus由来のメッセージ操作などは0.2.0で削除しました。設定の保存先が変わったため、0.1.0から更新すると全機能がオフに戻ります（[変更履歴](CHANGELOG.md)）。

> Discord公式の製品ではありません。利用規約違反やアカウント停止の可能性があります。利用は自己責任です。APKや認証情報は配布しません。

## 実装済みの機能

| 機能 | 内容と確認範囲 |
| --- | --- |
| Fake Nitro | 使用できない絵文字・スタンプを画像リンクへ変換。ピッカー、アニメ絵文字、スタンプの送信を実機確認。画像サイズを選べる |
| Platform Indicator | 接続中の端末をDiscordのアイコンで表示。アバター・DM一覧・DMヘッダー・メンバー一覧・プロフィール名に加え、メッセージ欄では名前横のタグ枠にアイコンを2つまで出す。場所別スイッチと保存復元を実機確認 |
| Privacy | JS analytics、広告ID、Sentry、AppsFlyer、タップ記録と端末内テレメトリーログの停止。SentryとAppsFlyer宛ての接続がなくなることをホスト名で確認。テレメトリー停止後の通常動作を実機確認 |

Morpheで組み込むpatchを選び、Discordの設定画面下部にある **Cadence** から有効にします。アプリ内機能は初期オフです。PrivacyのDEX patchは適用時から有効で、アプリ内の切替はありません。

設定画面はDiscord自身の行・スイッチ・ラジオ・ボタンの部品で描き、メッセージ・表示・プライバシー・情報のカテゴリに分けています。端末表示の配置処理はVenus Patches、メッセージ欄のアイコン画像はPlatformIndicators（Martinz64/vendetta-plugins）に基づきます。帰属は [NOTICE](NOTICE) を参照してください。

## 使い方

[Releases](https://github.com/uta-a/cadence/releases)から`patches-0.2.0.mpp`を取得できます。自分でビルドすることもできます。Morphe Managerのリモートソース追加（Add to Morphe）は未確認のため、MPPをLocalソースとして読み込んでください。**patcher 2.3.0以降を内蔵したMorphe Managerが必要です。** Manager 2.5.0でローカルMPP（0.0.1、20 patch）を適用し、生成APKの導入・起動を確認しました。0.1.0は21 patch、0.2.0は9 patchです。旧Manager 1.28.0の内蔵patcher 1.11.0では実行できません。

1. 自分で用意したDiscord **352.17 Stable** の正規APKMを使います。別バージョンや改変済み入力は対象外です。
2. Releasesの通常MPPを取得するか、以下の手順でビルドします。
3. Morphe ManagerのSourcesからLocalを選び、生成した`.mpp`を読み込みます。
4. DiscordのAPKMと必要なpatchを選び、パッチ後のAPKをインストールします。
5. DiscordのCadence設定で必要な機能を有効にします。

公式版と署名が異なる場合は上書きできません。**既存アプリのデータ消去やアンインストールを安易に行わないでください。** 新規導入は別端末などで試すことを勧めます。パッチ済みAPKを更新するときは同じ署名を使います。

## ビルド

JDK 21、Node.js 22、GitHub Packagesのread権限があるトークンが必要です。

```bash
export JAVA_HOME=/path/to/jdk-21
export GITHUB_ACTOR=your-account
export GITHUB_TOKEN="$(gh auth token)"
export CADENCE_UI_SMOKE=0
./gradlew :patches:test :patches:generatePatchesList :patches:buildAndroid --no-daemon
# patches/build/libs/patches-0.2.0.mpp
```

`buildAndroid`を最後に実行します。`build`や`generatePatchesList`だけでは必要なDEXが入らないためです。smokeビルドはテスト専用で配布しません。

ランタイム単体:

```bash
cd runtime
npm ci --no-audit --no-fund
npm run typecheck
npm test
node build.mjs
```

ビルドは固定したHermesコンパイラでHBC98へ変換できることも確認します。

## テストと制限

```bash
./gradlew :patches:test --no-daemon
python3 -I -m unittest discover -s tools/tests -v
```

実バンドル・DEX・Hermes VMを使うテストは、入力がない環境では理由付きでskipされます。ローカルの入力を指定する方法は [tools/README.md](tools/README.md) を参照してください。実機試験の代わりにはなりません。

- 対応外のバンドルやDEXはパッチ時に拒否します。ランタイムではexportの形を確認し、未対応なら元の動作を優先します。
- OTAの読み込み先は同梱バンドルに固定します。OTAのダウンロード自体を止めるpatchではありません。
- モジュール表の`verified: false`は、IDの一致だけでフックを承認しないことを示します。実機の確認範囲は機能ごとに別途記録しています。
- 外部コードの読み込みやCadence独自のサーバーは使いません。リンク送信、CDN画像取得、保存などではDiscord既存の通信が発生します。
- 通話中の端末表示は通話プレビューの参加者行が対象で、サイドバーの参加者行には出ません。メッセージ欄のアイコンはタグ枠を借りるため2つまでで、作成者が本物のサーバータグを付けている場合はその枠を使いません。アイコンのタグ枠をタップしても何も開きません。

## 配布物の準備

[公開前チェックと配布準備](docs/RELEASE.md)に手順をまとめています。準備ツールは通常MPP、Morphe用メタデータ、ライセンス、チェックサムをまとめるだけで、タグ作成・push・公開はしません。

## 開発記録

- [残作業](docs/PLAN.md)
- [公開前チェックの途中経過](docs/PRERELEASE-CHECK.md)
- [変更履歴](CHANGELOG.md)
- [Phase 4](docs/PHASE4.md)
- [Venus移植と実機確認（0.1.0時点）](docs/VENUS-PORT.md)
- [モジュール調査](docs/MODULE-RESEARCH.md)
- [設計書](docs/DESIGN.md)

## ライセンス

[GPL-3.0](LICENSE)。Morphe patches template、Venus Patches由来のコード、PlatformIndicators（Unlicense）由来のアイコン形状を含みます。帰属と制限は [NOTICE](NOTICE) を参照してください。
