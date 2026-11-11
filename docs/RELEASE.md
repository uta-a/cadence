# 公開前の確認と配布準備

**現在は未リリースです。** この手順は成果物をローカルまたはActionsのartifactにまとめるだけです。タグ作成、push、GitHub Releaseへの公開は行いません。

## 公開を止めている項目

- [x] Platform Indicatorの表示箇所と場所別設定。メッセージ欄は文字ラベル方式。
- [ ] 音声通話中の端末表示など、未確認の経路を追加試験。
- [x] Servers系の読み取り専用メタデータ表示を実装。非表示チャンネルのネイティブ一覧への混在は行わない。
- [x] 起動中のみの本文履歴を実装し、編集・削除・消去・再起動を実機確認。
- [ ] 非表示の拒否項目、一括削除、相手からの削除など未確認経路の追加試験。
- [ ] グループDMなど未確認経路の実機確認。
- [x] 全機能を組み込んだAPKで追加機能の併存・設定保存・プロセス再起動・上書き更新を確認。未確認経路は上記のとおり残る。
- [x] Manager 2.5.0でローカルMPP→正規APKM→20 patch適用→APK保存まで成功。生成物を開発用同署名にそろえて一時プロファイルへ導入し、新規データの起動を確認。Manager自身のインストールボタンは使っていない。
- [ ] 公開するバージョンと機能範囲の最終確認。

これらが残っている間は、準備ツールが成功しても「公開可能」とは扱いません。

## 通常ビルド

JDK 21、Node.js 22、Python 3.10以降、GitHub Packagesのread権限が必要です。

```bash
export JAVA_HOME=/path/to/jdk-21
export GITHUB_ACTOR=your-account
export GITHUB_TOKEN="$(gh auth token)"
export DISK_UI_SMOKE=0
./gradlew :patches:test :patches:generatePatchesList :patches:buildAndroid --no-daemon
python3 -I -m unittest discover -s tools/tests -v
```

`buildAndroid`を最後に実行します。これを実行しないMPPには、Morphe Managerで必要な`classes.dex`が入りません。

Discordの実バンドルやDEX、Hermes VMがない環境では対応する検証はskipされます。公開前には、ローカルの実入力を使うテストも別途通してください。詳細は `tools/README.md` にあります。

生成される `disk/build-info.json` の `uiSmoke` はfalseでなければなりません。smokeビルドは起動後に設定画面を開くテスト専用です。配布しません。

## ローカルで配布物をまとめる

```bash
python3 tools/prepare_release.py \
  --mpp patches/build/libs/patches-0.0.1.mpp \
  --version 0.0.1 \
  --repository uta-a/disk \
  --notes CHANGELOG.md \
  --out work/release-staging/0.0.1
```

出力先は空のディレクトリにします。MPPのmanifestと`patches-list.json`のバージョンが指定値に一致しない場合、DEXやビルド情報がない場合、smoke版の場合は拒否します。

出力:

- `patches-<version>.mpp`
- `patches-bundle.json`
- `patches-list.json`
- `CHANGELOG.md`
- `LICENSE`
- `NOTICE`
- `SHA256SUMS`

`patches-bundle.json`はMorphe公式ソースの形式に合わせています。`download_url`は将来のReleaseを指します。**公開前にはそのURLから取得できません。** 存在しない配布先をREADMEの導入ボタンなどで案内しないでください。

チェックサムは破損確認用で、署名や作者の証明ではありません。バンドル署名は未導入なので`public_key`と`signature_download_url`を空にしています。

## Actionsでの準備

`Prepare release artifacts`を手動実行し、現在のGradleバージョンに一致する値を指定します。処理はビルド・テスト・検査・artifact保存までです。contents権限はreadのみで、公開ジョブはありません。

## 最終的な実機確認

既存のログイン済み端末のアプリデータは消さないでください。新規導入は別端末か独立したAndroidユーザーで行います。

1. Morphe ManagerへローカルMPPを追加し、352.17 Stableの正規APKMへ適用する。
2. 新規インストールしてログイン画面まで起動する。
3. ログイン済みの試験環境では、アプリ内の機能が初期オフであることを確認する。DEXのPrivacy系patchは選択時点から有効で、アプリ内スイッチはない。
4. 機能をオンにして設定保存を確認し、プロセス再起動後も復元されることを確認する。
5. 既存の通常APKへの上書き更新でも保存設定が残ることを確認する。
6. 誤ったバージョン、改変済み入力、APIの形が違う場合に安全に拒否・フォールバックすることを確認する。
7. 実機にはnormal APKを残し、試験設定と作成したデータを記録する。

「Add to Morphe」のリモート追加は公開されたソースURLが必要です。非公開のままでこの経路を完了したとは記録しません。

## ローカル検証結果

- 通常MPPの配布準備を実行済み。生成メタデータ、DEX、ビルド情報、チェックサムを検査。公開操作なし。
- `def4aa2`をgit archiveで新しい作業ディレクトリへ展開し、既存のnode_modulesやworkなしでビルドと配布準備に成功。Kotlin57件中48件、Python24件中6件は実入力なしのためskip。元の作業環境ではKotlin57件、Python24件がskipなしで成功した。
- pipaに独立した仕事用プロファイルuser10を作り、通常APKの既存インストールをそのユーザーへ登録。アプリデータは新規で、ログイン前のようこそ画面と`loaded` / `observer installed` / `settings ready`を確認した。これはAPKのパッチ適用工程を試した結果ではない。
- 同プロファイルへローカルMPPをMediaStore経由で渡し、Morphe ManagerのLocalソースとしてdisk 0.0.1を取り込めた。ただしManager 1.28.0にはpatcher 1.11.0しかなく、MPPの要求する2.3.0と不一致でpatch数0・更新要求となった。実行成功やインストールまで通ったとは扱わない。
- ログイン前の新規プロファイルではdisk設定のUIと保存復元は未確認。既存のログイン済みuser0で新機能の初期オフ・オン・オフ・書込/read-backと上書き更新を確認した。
- 初回試験のuser10は削除済み。その後のManager更新試験は下記のuser11で実施した。user0のDiscord・Managerのデータは消去していない。
- 証跡は`work/phase4-device/fresh-profile-start.png`と`manager-disk-compatibility-detail.png`。公開用資料にはアカウント画面の画像を含めない。

### Manager 2.5.0での後続確認

- 公式GitHub Releaseから2.5.0を取得し、端末の1.28.0と証明書SHA-256が一致することを確認してデータを残したまま更新した。現在の端末のManagerは2.5.0。
- 一時仕事用プロファイルuser11でLocalソースへdisk 0.0.1を追加し、352.17 Stableの正規APKMを選択。20個のpatchが成功し、署名済みAPKを保存できた。旧版のpatcher互換性不足は解消した。
- `9965e1d`の生成APKはv2署名検証に成功。`assets/index.android.bundle`は同時点のCLI通常版と完全一致し、SHA-256は`e4b4a8a98fc642722c74909ef7e5000b5353c56eb674aff3cc116c6f683a12e6`。
- AndroidのAPK署名はユーザー間で共有される。user0のDiscordをアンインストールしないため、Manager出力のコードやリソースは変えず、署名だけを既存の開発用キーにそろえてuser11へ実インストールした。ようこそ画面と`loaded` / `settings ready`を確認。通常の新端末ではこの再署名手順は不要。
- user11を削除してuser0のみへ戻し、CLI通常APKを再インストールした。ログイン済みデータと設定を維持し、起動を確認。証跡は`manager25-patch-result.png`と`manager25-built-fresh-start.png`。
- リモートソース追加は公開後の作業。現時点ではローカルソースのみ確認した。

## 公開を承認された後に行うこと

- 開発中のバージョンを確定し、Gradle・ランタイム・説明文の値を揃える。
- 確定版の変更履歴と配布物を作り直す。
- 公開先、ライセンス、対応バージョン、既知の制限を再確認する。
- 別途承認を得てタグ、push、Release作成、メタデータ公開を行う。
- 公開済みURLからMorphe Managerへ追加し、更新確認まで通す。

## 形式の参照元

- https://github.com/MorpheApp/morphe-patches/blob/main/patches-bundle.json
- https://github.com/MorpheApp/morphe-manager/blob/main/docs/patch-sources.md
