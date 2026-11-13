# Cadence

Discord Android向けのMorphe patchバンドルです。Fake Nitro、端末表示、Privacy、メッセージ操作を追加します。旧名は **disk** で、0.1.0はその名前で公開しています。

**最新版は0.1.0です。対応はDiscord 352.17 Stableのみです。** 実機で確認できていない経路が一部残っています（[既知の未確認点](CHANGELOG.md#既知の未確認点)）。v0.1の機能範囲とVenusとの差は[移植記録](docs/VENUS-PORT.md#v01の範囲2026-11-12確定)を参照してください。

> Discord公式の製品ではありません。利用規約違反やアカウント停止の可能性があります。利用は自己責任です。APKや認証情報は配布しません。

## 実装済みの機能

| 機能 | 内容と確認範囲 |
| --- | --- |
| Fake Nitro | 使用できない絵文字・スタンプを画像リンクへ変換。ピッカー、アニメ絵文字、スタンプの送信を実機確認。サイズと名前付きリンクの設定あり |
| Platform Indicator | DM行・ヘッダー・メンバー一覧・プロフィール名にバッジ。メッセージ名はPC/M/W/VRの文字表示。場所別スイッチと保存復元を実機確認 |
| Privacy | JS analytics、広告ID、Sentry、AppsFlyer、タップ記録と端末内テレメトリーログの停止。SentryとAppsFlyer宛ての接続がなくなることをホスト名で確認。テレメトリー停止後の通常動作を実機確認 |
| 確認の省略 | 削除・ピン留めの確認を省略。各機能を個別に選択 |
| Always trust | リンクとファイルの警告を省略。リンクは実機確認、ファイル警告は未確認 |
| 最初のメッセージへ移動 | チャット先頭へ移動するボタン |
| ジェスチャー | ダブルタップで返信・編集。削除は別の初期オフ設定 |
| 高画質画像 | 通常画像の縮小指定を外す。アイコンを高解像度化。GIFは元のまま |
| すべて既読 | タップでサーバー、長押しでDMや両方を選択。サーバー・DMの未読消去を実機確認 |
| 返信メンション初期オフ | サーバー返信が`@ OFF`で開始。手動で`@ ON`へ戻せる。グループDMと浅い返信は単体テストのみ |
| ボイスメッセージ保存 | 音声の下に保存ボタンを追加。AndroidのDownloadsへのOpus保存を実機確認 |
| サーバー情報 | アイコンの長押しメニューから読み込み済みのID・所有者・作成日時などを表示。追加取得通信なし |
| 非表示チャンネル情報 | 長押しメニューから読み込み済みメタデータだけを表示。実際の閲覧拒否チャンネルで実機確認。通常一覧への混在表示や権限の迂回はしない |
| 削除・編集履歴 | 読み込み済み本文を起動中だけ専用画面に保持。最大200件。相手からの削除の記録、消去と再起動時の破棄を実機確認。チャットの削除は通常どおり進む |

Morpheで組み込むpatchを選び、Discordの設定画面下部にある **Cadence** から有効にします。アプリ内機能は初期オフです。PrivacyのDEX patchは適用時から有効で、アプリ内の切替はありません。

Venus由来のコード、元作者、実機の確認範囲は [移植記録](docs/VENUS-PORT.md) と [NOTICE](NOTICE) に記載しています。

## 使い方

[Releases](https://github.com/uta-a/cadence/releases)から`patches-0.1.0.mpp`を取得できます。自分でビルドすることもできます。Morphe Managerのリモートソース追加（Add to Morphe）は未確認のため、MPPをLocalソースとして読み込んでください。**patcher 2.3.0以降を内蔵したMorphe Managerが必要です。** Manager 2.5.0でローカルMPP（0.0.1、20 patch）を適用し、生成APKの導入・起動を確認しました。0.1.0は21 patchです。旧Manager 1.28.0の内蔵patcher 1.11.0では実行できません。

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
# patches/build/libs/patches-0.1.0.mpp
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
- 履歴は起動中の本文だけで、ディスクへの永続保存やチャットへの復元はしません。非表示チャンネルは読み取り専用のメニュー方式です。サーバー情報は基本情報のみで、友達一覧などは含みません。通話中の端末表示は通話プレビューの参加者行が対象で、サイドバーの参加者行には出ません。

## 配布物の準備

[公開前チェックと配布準備](docs/RELEASE.md)に手順をまとめています。準備ツールは通常MPP、Morphe用メタデータ、ライセンス、チェックサムをまとめるだけで、タグ作成・push・公開はしません。

## 開発記録

- [残作業](docs/PLAN.md)
- [公開前チェックの途中経過](docs/PRERELEASE-CHECK.md)
- [変更履歴](CHANGELOG.md)
- [Phase 4](docs/PHASE4.md)
- [Venus移植と実機確認](docs/VENUS-PORT.md)
- [モジュール調査](docs/MODULE-RESEARCH.md)
- [設計書](docs/DESIGN.md)

## ライセンス

[GPL-3.0](LICENSE)。Morphe patches templateとVenus Patches由来のコードを含みます。帰属と制限は [NOTICE](NOTICE) を参照してください。
