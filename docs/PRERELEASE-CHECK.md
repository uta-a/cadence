# 公開前チェックの途中経過

**未完了。公開可能という判定ではありません。** Phase 4の未実装機能とManager経由の導入確認が残っています。

## 今回の追加

- ボイスメッセージ保存: ボタンからDownloadsへ保存できることをpipaで確認。Ogg Opus、1.72秒、5,679 bytes。
- サーバー情報の基本表示: 長押しメニューと読み込み済み情報のダイアログを実機確認。
- ビルド情報: normalとsmokeを識別。配布準備ツールがsmokeやDEX欠落、バージョン不一致を拒否。
- 配布準備: MPP、Morpheメタデータ、ライセンス、SHA-256一覧をローカルに生成。公開する処理なし。

## 最終ローカル検証

| 検証 | 結果 |
| --- | --- |
| TypeScript | 成功 |
| Node | 122件成功、skipなし |
| Python、実入力指定 | 24件成功、skipなし |
| Kotlin、実バンドル・DEX・Hermesあり | 57件成功、skipなし |
| normal / smoke APK | ビルド成功 |
| 最新normal APK | pipaのuser0へ同署名で上書き。`loaded`と`settings ready`を確認。起動ログのFATAL・TypeError・ReferenceErrorなし |
| 最新の配布準備 | `work/release-staging/local-prepare-3/`。公開なし |
| クリーン作業ディレクトリ | `def4aa2`のgit archiveからビルド・配布準備成功。実入力なしの検証はskip |

`work/`はローカル専用でコミットしません。配布するのはMPPと公開用メタデータなどで、Discord APK、署名用秘密鍵、アカウント画面や録音データは含めません。

## 新規環境

既存のアプリデータを消さず、一時仕事用プロファイルuser10で確認しました。

- 新規アプリデータでDiscordのようこそ画面を表示。
- プロセス再起動後もdiskの`loaded`・`observer installed`・`settings ready`を確認。
- Morphe ManagerのLocalからdisk 0.0.1のMPPを取り込めた。
- **パッチ実行は未確認。** Manager 1.28.0の内蔵patcherは1.11.0で、MPPが要求する2.3.0に対応していなかった。更新要求とpatch数0を確認。
- 既存Managerは更新していない。試験用user10は削除し、user0だけが残ることを確認。
- user0には最新normal APKを残し、新しく試したvoiceDownloadとserverInfoはオフに戻した。

## 残っている公開前の作業

- Platform Indicatorの残りの表示箇所と場所別設定。
- 非表示チャンネルと削除・編集履歴。
- サーバー情報の友達一覧など、Venusとの機能差を最終確定。
- グループDMや浅い返信など未確認経路の実機試験。
- 未実装分も含めた全機能の統合再試験。
- 対応するManagerでパッチ適用から新規インストールまで確認。
- v0.1の範囲とバージョン確定。

タグ作成、push、GitHub Release、リポジトリ公開は行っていません。
