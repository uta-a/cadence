# 公開前の確認と配布準備

**現在は未リリースです。** この手順は成果物をローカルまたはActionsのartifactにまとめるだけです。タグ作成、push、GitHub Releaseへの公開は行いません。

## 公開を止めている項目

- [x] Platform Indicatorの表示箇所と場所別設定。メッセージ欄は文字ラベル方式。
- [ ] 音声通話中の端末表示など、未確認の経路を追加試験。
- [x] Servers系の読み取り専用メタデータ表示を実装。非表示チャンネルのネイティブ一覧への混在は行わない。
- [x] 起動中のみの本文履歴を実装し、編集・削除・消去・再起動を実機確認。
- [ ] 非表示の拒否項目、一括削除、相手からの削除など未確認経路の追加試験。
- [ ] グループDMなど未確認経路の実機確認。
- [ ] 全機能の統合再試験とアプリ更新後の設定復元。
- [ ] patcher 2.3.0以降のMorphe Managerによるパッチ適用からインストールまで。新規プロファイルでのMPP取り込みは確認済みだが、端末のManager 1.28.0は内蔵patcher 1.11.0で実行できなかった。
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
- 試験用user10は試験後に削除し、user0のみが残ることを確認。user0のDiscord・Managerのデータを消去していない。user0のManagerは更新していない。
- 証跡は`work/phase4-device/fresh-profile-start.png`と`manager-disk-compatibility-detail.png`。公開用資料にはアカウント画面の画像を含めない。

## 公開を承認された後に行うこと

- 開発中のバージョンを確定し、Gradle・ランタイム・説明文の値を揃える。
- 確定版の変更履歴と配布物を作り直す。
- 公開先、ライセンス、対応バージョン、既知の制限を再確認する。
- 別途承認を得てタグ、push、Release作成、メタデータ公開を行う。
- 公開済みURLからMorphe Managerへ追加し、更新確認まで通す。

## 形式の参照元

- https://github.com/MorpheApp/morphe-patches/blob/main/patches-bundle.json
- https://github.com/MorpheApp/morphe-manager/blob/main/docs/patch-sources.md
