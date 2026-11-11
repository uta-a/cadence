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

## 進捗

| 機能 | Venus | 352.17のmodule | 状態 |
| --- | --- | --- | --- |
| 削除の確認を省く（patch: Skip delete confirmation） | Skip delete confirmation（`quickConfirm`） | AlertActionCreators 5941、intl 1128 | 実機確認済み: 確認なしで削除され、`quick-confirm skipped`を記録 |
| ピン留めの確認を省く（patch: Skip pin confirmation） | Skip pin confirmation（NoConfirmPin by Skamt） | 同上 | 実機確認済み: ピン留めと解除が確認なしで行われた |
| リンクとファイルを常に信頼（patch: Always trust links and files） | Always trust links and files（AlwaysTrust by zt and Trwy） | MaskedLinkStore 8894、SuspiciousDownloadUtils 8642 | 実機確認済み: 名前付きリンク`[disk-trust](https://example.org/…)`で、オフでは「Discordを退出」が出て、オンでは直接ブラウザが開いた。ファイルの警告は実機未確認 |
