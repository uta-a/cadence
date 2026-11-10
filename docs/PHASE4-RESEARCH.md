# Phase 4 調査・再開メモ

## 作業範囲

Phase 3完了時の`f8b1454`を起点に、Phase 4の静的調査だけを開始した。ユーザーの「キリがいいところで止めて」という指示に従い、進行中の調査を整理して停止する。機能実装・新しいAPKの作成/導入・実機操作・送信は行わない。
Fake Nitro・Platform Indicator・Privacy本体はまだ未実装。以下は実装承認済みの契約一覧ではなく、再開時に確認するための記録。

## 共通基盤で確認したこと

- 現在の`core/settings.ts`はschema2。設定のfeature keyは`fakeNitro`と`platformIndicator`で、初期値は両方false。compactだけが表示用preference。Phase 4のサイズ/表示箇所等を追加するなら、既存schema1/2との互換性・書込順序・再試行を維持する必要がある。
- ビルド機能IDは`fakeNitro` / `platformIndicator` / `privacy`。`BuildFeatures.render`は選択setの直列化・不明ID拒否・marker一意性を検証するが、現在の`RuntimePatch`は空setを渡す。Morpheの機能選択との接続はまだない。
- ローカルのMorphe Patcher **2.3.0**を`javap`で確認。`RawResourcePatchBuilder`は`execute(ResourcePatchContext)`と`finalize(ResourcePatchContext)`の両方を公開する。`PatchBuilder`には`dependsOn`とdefaultの指定がある。
- `PatcherContext.fileWorkspace`はpublic。`allPatches`/`executablePatches`等のgetterは`$morphe_patcher`付きのinternal APIであり、公開された選択取得APIとみなさない。finalizeの順序・コンテキストからのworkspace到達方法・複数APK間の分離は未確認。
- 選択結果をsingletonのmutable Setに持たせない。後続の機能patchより前にruntimeを注入すると選択が反映できないので、注入タイミングとper-APKの選択情報の受渡しを先に設計・テストする。
- Privacyは設計上Morphe側の選択だけで、Discord内のオン/オフは作らない。Fake Nitro / Platform Indicatorは保存値に加えて、実際に組み込まれている機能と依存readinessを確認してから有効化する。

### API確認の再現

対象jar:
`~/.gradle/caches/modules-2/files-2.1/app.morphe/morphe-patcher/2.3.0/d7cf45fefa4860d14f57311fc592f841b37f4184/morphe-patcher-2.3.0.jar`

```sh
javap -classpath "$JAR" app.morphe.patcher.patch.RawResourcePatchBuilder \
  app.morphe.patcher.patch.PatchBuilder app.morphe.patcher.PatcherContext
```

## 4a Fake Nitro

既存記録を読み直した範囲に限る。サブエージェントのExplore環境は読み取り・検索のみで、Python/HBC追加逆アセンブルを実行できなかった。

- MessageActions7598/factory7599の`7599:1262`にobject shape2197、slot18。`1434..1439`でsendMessage43054を設定し、`1683`でdefault exportする。
- `43054:3..62`は4引数のasync wrapperで、第3引数undefinedの既定値はtrue。各引数の意味・配下generator・戻り値・content/stickerIdsの所有位置は未確認。
- consumer8483のclosure145757は`126..143`でsendMessageを取得し、`219..230`で呼ぶ。引数構築元の追加追跡が必要。
- EmojiStore6757/factory6758はgetUsableGuildEmoji38746とgetCustomEmojiById38752をprototypeへ設定する。既知consumer42529はgetCustomEmojiById(emojiId)を呼ぶが、戻り値と利用可否判定との関係は未確認。
- 利用可否候補2053/factory2054の`2054:1480`にcanUseEmojisEverywhere/canUseAnimatedEmojisのwrite keysがあると既存一覧に記載。export帰属・実consumer・sticker判定は未確認。名前だけで接続しない。

次回は43054とそのgenerator、145757の引数構築、38752/38746、2054の該当closureの順に限定して静的解析する。現時点ではcontentの書換え・stickerIds削除・送信可否上書きを実装できる根拠はない。送信関数を実行して契約を推測しない。

## 4b Platform Indicator

追加のbundle解析は実行できず、既存記録の確認にとどまる。

- PresenceStore5744/factory5745は`5745:516..521`でgetClientStatus35468をprototypeへ設定し、`688`でinstanceを構築、`717`でdefault exportする。
- `35468:3..10`は内部slot15をuserIdで参照して返す。fallbackは確認されていない。
- consumer9181/factory9182は`110..115`でStoreをimport。closure102879はisMobileOnline/isVROnline/getStatusを呼ぶ。getClientStatusの直接consumerは既存検索では未発見（不在とは断定しない）。
- desktop/mobile/web/embeddedの格納・更新、購読API、表示境界とpropsのuserId型、memo/frozen制約は未確認。

次回はfactory5745からslot15への書込み・dispatcher登録先を追い、102879の親componentとprops受渡しを確認する。実機のuserIdやstoreの内容は取得しない。

## 4c Privacy

安全に停止できる境界は未特定。Explore環境ではコマンドを実行できず、DEX/HBCの追加解析をしていない。対象が存在しないとは判断できない。

- `work/352.17/research/entry-f1.txt`の47〜49行にsentryEnd→record→Call1があるが、Sentry initの根拠にはならない。
- `work/352.17/research/native-file/DiskFileEvidence.java`はAPKの各classes*.dexをdexlib2で読み、限定ownerの命令・参照・分岐先を出力する再利用例。現在のowner指定はFileModule向けで、Privacy対象を調べたものではない。
- `tools/hbc.py`と既存BundlePinの検証方式は利用できるが、analyticsのmodule/export/consumer、Sentry init/Appsflyer start/AdvertisingId getterのclass・署名・全命令・副作用は未確認。

次回はtrack/analyticsの文字列参照からexportとconsumerを絞り、DEXでは各SDKへの参照元だけを列挙してから該当メソッドと呼出し元を検証する。SDK名の一致だけで初期化全体や複合onCreateをスタブ化しない。全APK decompileは不要。

## 調査上の制約と停止点

3件のサブ調査は結果を回収済み。既存資料から新たに実行時契約を承認できる情報は得られていない。上記のfunction:offsetは既存記録からの参照であり、今回bundleから独立再検証した値ではない。次回の追加解析は、親のbash/Python環境を使うか、コマンド実行可能な委譲種別を明示して行う。ツール制約を避けるために無断で別CLIエージェントへ切り替えてはいない。

この区切りで作業を停止する。変更はREADMEと本メモのみで、runtime/Kotlinコード・APK・端末は変更していない。文書のみのためPhase 3のテストは再実行していない。pushなし。

## 再開時の注意

- 原本は352.17の固定bundle/DEXを使い、Venusコードは複製しない。
- descriptor一致だけで機能の意味論・呼出し契約・起動安全性を承認しない。
- 送信はモックで検証し、実送信が必要なら別途ユーザーに確認する。
- アカウント/メッセージ/store内容を調査用に取得・保存しない。初期オフとエラー時の元動作を維持する。
- Phase 4は未完了。端末はPhase 3で確認した通常版のまま変更していない。
