# 公開前の確認と配布準備

**現在は未リリースです。** この手順は成果物をローカルまたはActionsのartifactにまとめるだけです。タグ作成、push、GitHub Releaseへの公開は行いません。

## 公開を止めている項目

- [ ] Platform Indicatorの残りの表示箇所と場所別設定。
- [ ] 選択済みのServers系機能と削除・編集履歴の実装。
- [ ] グループDMなど未確認経路の実機確認。
- [ ] 全機能の統合再試験とアプリ更新後の設定復元。
- [ ] 新規環境でのMorphe ManagerによるMPP読み込み、パッチ適用、インストール。
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

## 公開を承認された後に行うこと

- 開発中のバージョンを確定し、Gradle・ランタイム・説明文の値を揃える。
- 確定版の変更履歴と配布物を作り直す。
- 公開先、ライセンス、対応バージョン、既知の制限を再確認する。
- 別途承認を得てタグ、push、Release作成、メタデータ公開を行う。
- 公開済みURLからMorphe Managerへ追加し、更新確認まで通す。

## 形式の参照元

- https://github.com/MorpheApp/morphe-patches/blob/main/patches-bundle.json
- https://github.com/MorpheApp/morphe-manager/blob/main/docs/patch-sources.md
