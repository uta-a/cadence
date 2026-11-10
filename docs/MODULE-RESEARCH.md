# Discord 352.17 Metro モジュール調査（Phase 3 前提）

## 結論・適用範囲

`runtime/modules/352.17.json` は**静的調査の台帳**。実装用の承認済み ID 表ではない。
全エントリ `verified: false`、`runtimeChecked: false`。`confidence: high` は
export の構築と利用側から見た**静的な同定の確度**であり、起動安全性やネイティブ API の保証ではない。
`shape` は `require(id)` からのドット区切りプロパティパス（確認予定項目）で、既存ランタイム用 schema を新設したものではない。
特に `default` を落としたり、store の prototype メソッドを named export と扱ってはいけない。

| 対象 | Metro ID → factory | export の入口 | 確度 / runtime |
| --- | --- | --- | --- |
| React 公開入口 | **19 → 20** | `module.exports`（実装 **20 → 21** を再 export） | high / 未確認 |
| react-native | **17 → 18** | `module.exports` の lazy getters | high / 未確認 |
| RN AppRegistry 初期化 | **244 → 245** | `exports.AppRegistry` + global 登録の副作用 | high / 未確認 |
| 設定ページ renderer registry | **15865 → 15866** | `SETTING_RENDERER_CONFIG`（freeze 済み） | high / 未確認 |
| 設定画面列挙 helper | **16016 → 16017** | `getSettingScreens`, `toSettingListItems` | high / 未確認 |
| 設定トップ画面 | **18400 → 18401** | `default`、非公開 section builder 80703 | high / 未確認 |
| 共通設定 renderer | **16013 → 16014** | `SearchableSettingsList`（React.memo）ほか | high / 未確認 |
| NativeFileModule | **1164 → 1165** | `default`（TurboModule） | high / 未確認 |
| ファイル保存 helper | **8728 → 8729** | `readFile`, `writeFile` | high / 未確認 |
| PresenceStore | **5744 → 5745** | `default` の instance / prototype methods | high / 未確認 |
| EmojiStore | **6757 → 6758** | `default` の instance / prototype methods | high / 未確認 |
| sendMessage | **7598 → 7599** | `default.sendMessage` | high / 未確認 |

RN 初期化の候補を単に `17` または AppRegistry 実装 `245` とするのは不正確。
**244 が RN$AppRegistry / SurfaceRegistry の設定と callable module 登録を行う**。
一方 Discord / Share のアプリ登録は **0 → factory 1**。
この区別は静的に追跡できたが、244 の factory 完了時点で任意の import が安全になるとはまだ言えない。

## 入力と再現条件

- 読み取り専用入力: `work/352.17/assets/index.android.bundle`
- HBC98、70,404,633 bytes、SHA-256:
  `09dcdd872df4fb7aa84b2a5ecc62946735de7a63447b848d549bd99d6f4505ee`
- `tools/hbc.py` / `tools/find_module.py` の既存解析器を変更せず使用。
- 以下の `function:offset` は**関数内の十進バイトオフセット**。ファイル offset や行番号ではない。
  `0:offset` は global の `__d` 登録呼び出し。Metro ID と function index は別概念。
- factory ABI の `LoadParam 2/3/4/5/6/7` はそれぞれ
  require / importDefault / importAll / module / exports / deps（param 0 は this）。

```sh
# この worktree のルートで実行。work/ は非コミットの解析出力。
BUNDLE=work/352.17/assets/index.android.bundle
mkdir -p work
shasum -a 256 "$BUNDLE"
python3 tools/find_module.py "$BUNDLE" createElement useState --kind export --exact --limit 4
python3 tools/find_module.py "$BUNDLE" View StyleSheet --kind export --exact --limit 4
python3 tools/find_module.py "$BUNDLE" AppRegistry registerComponent --exact --limit 6
# FileModule の exact 検索はヒットしない。実名は NativeFileModule。
python3 tools/find_module.py "$BUNDLE" FileModule --limit 4
python3 tools/find_module.py "$BUNDLE" SETTING_RENDERER_CONFIG getSettingScreens --exact --limit 8
python3 tools/find_module.py "$BUNDLE" getClientStatus --exact --limit 4
python3 tools/find_module.py "$BUNDLE" getCustomEmojiById getUsableGuildEmoji --exact --limit 4
# export 検索だけだと sendMessage は見逃される（default 内の buffer object）。
python3 tools/find_module.py "$BUNDLE" sendMessage --kind property --exact --limit 5

# 対象 factory と直接関係する closure のみ disassemble する。
for f in 1 18 20 21 245 246 1165 8729 5745 6758 7599 15866 16017 \
         16140 73207 19764 15864 16004 72421 72851 125376 18397 135527 \
         48350 48354 48349 101511 145829 145826 \
         9182 102879 35468 7487 42529 43054 8484 145757; do
  python3 tools/hbc_inspect.py "$BUNDLE" func "$f" --disasm > "work/research-f$f.txt"
done
python3 -m json.tool runtime/modules/352.17.json > /dev/null
```

依存先と literal-buffer key の再現（文字列検索のヒットだけでは exports の証明にならない）:

```sh
python3 - <<'PY'
import sys
sys.path.insert(0, 'tools')
from hbc import HbcFile
h = HbcFile('work/352.17/assets/index.android.bundle')
mods = h.modules()
for mid in [0, 17, 19, 20, 244, 245, 1164, 8728, 5744, 6757,
            7598, 15865, 16016, 15863, 16139, 9181, 7486, 8483, 18396]:
    print(mid, mods[mid])
for f, wanted in [(7599, 1262), (16004, 86), (16004, 126)]:
    ins = next(i for i in h.instructions(f) if i.offset == wanted)
    shape_index, values_offset = ins.args[-2:]
    shape, count = h.unpack('<II', h.sections['object_shapes'][0] + shape_index * 8)
    keys = h.literals('object_keys', shape, count)
    print(f, wanted, [h.strings[k[1]] for k in keys])
    print(h.literals('literal_values', values_offset, count))
PY
```

## export 構築 → 利用側の証拠

### React / react-native

- `0:1980`: module 19 の factory 20、deps `[20]`。
  `20:12` が実装 require、`20:20` が `module.exports` への代入。
- 実装 factory 21 は `21:620` で exports 引数を取得し、`21:820` に createElement、
  `21:1037` に useMemo、`21:1081` に useState、`21:1115` に version `19.2.3` を書く。
- 利用側 module 16139 は deps[0]=19 を `16140:66` で importAll、environment slot 2 に `:71` で保存。
  closure `73207:41..65` はその namespace の useMemo を実際に呼ぶ。
- RN factory 18 は `18:477` View、`:735` AppRegistry、`:1338` StyleSheet の getter を定義し、
  `18:1567` で完成した object を module.exports に代入。
  同じ利用側の `16140:75..89` は deps[1]=17 から View を取得・slot 3 に保存し、
  `73207:80..132` はその View を JSX component として使用する。

### AppRegistry の初期化（gate 候補）

- `0:8265`: module 244、factory 245、deps `[245,236]`。
- `245:52..72`: 実装 module 245 の registerComponent に `LogBox` と closure 20631 を渡す。
  `245:87`: global の `RN$AppRegistry`、`:143`: `RN$SurfaceRegistry` を設定。
  `245:176`: dependency 236 経由で `AppRegistry` を登録、`:191`: `exports.AppRegistry` を書く。
- 実装 factory 246 は `246:178` registerComponent、`:287` runApplication を named export に書く。
- RN getter `19764:11..22` は RN deps[46]=244 を require して `.AppRegistry` を返す。
- アプリ入口 `1:173..205` は deps[8]=17 の AppRegistry.registerComponent(`Discord`, closure 19570)
  を呼び、`1:243..260` で `Share` も登録。module 0 と module 244 は役割が違う。
- **未検証**: 完了通知フックの reentrancy、Bridgeless 起動順、他モジュールの早期 import 安全性。

### 設定ページ / section registry

- factory `15866:75` から MobileUserSettings の computed key → importDefault(設定定義) の map を構築。
  ACCOUNT は `15866:97..112`、deps[2]=16003。
- 設定定義 module 16003 / factory 16004 の `:86` buffer shape 7023 は
  `[useTitle,parent,IconComponent,screen]`、`:126` shape 7024 は `[route,getComponent]`。
  `16004:80..161` は createRoute にこの定義を渡し、`:191` に default を export。
- `15866:5814..5825` は通知設定を合成、`:5829` は **Object.freeze**、`:5865` は
  `exports.SETTING_RENDERER_CONFIG`。単純な配列 push / object 追記フックにはできない。
- 消費側 module 15863 は deps[6]=15865。closure `72421:104..119` で map の Object.entries、
  `:173..238` で predicate / blocklist、`:275..328` で title / search terms を処理。
- module 16016 の getSettingScreens は `16017:213` で closure 72851 を export。
  `72851:61..95` は deps[10]=15865 の registry を列挙する。
  callback `125376:66..169` は ROUTE 型を選び `[settingKey,screen]` を生成、screen.route で重複排除。
- 外側 module 18396 は deps[22]=16016。closure `135527:11..28` は getSettingScreens を呼ぶ。
- **追加調査**: top-level の section は18400内の非公開closure80703が構築する。
  接続候補は16013.SearchableSettingsListのprops境界だが、React.memoであり普通の関数として呼べない。
  [設定 UI 調査](SETTINGS-UI-RESEARCH.md)に両compiler分岐・frozen registry・初回mountの制約を記録した。
  トップ画面限定guard・差替え可能性・route登録は未検証。`1087.UserSettingsSections` は enum であり registry の代わりにはならない。

### FileModule / 設定保存

- `1165:54..72`: `require(17).TurboModuleRegistry.getEnforcing("NativeFileModule")`。
  `1165:102` でその戻り値を `exports.default` へ。JS factory は native method object の内部を構築しない。
- 利用側 module 8728 は deps[2]=1164。`48350:11..43` は importDefault から writeFile を読み、
  引数4つを渡す。戻り値の `.then` を `:47..59` で使用。
- helper factory `8729:149/:193` は writeFile / readFile を named export。
  readFile は `48354 → 48349 → 101511 → generator 145829` の非同期 wrapper。
  `145829:319..354` は同 native import の readFile に組み立てた path と encoding を渡す。
- 外側 module 8726 の closure `145826:214..277` は deps[4]=8728 の readFile を
  `("documents", computedPath, "utf8")` で呼ぶ。これは native readFile の引数数と同一ではない。
- **追加調査**: DEXからnative署名・documents=getFilesDir・UTF-8と一時ファイルの処理を追跡した。
  rename失敗を検出しないため、未接続アダプターは最終内容の読み戻しを必須とする。
  readAssetもnative specに存在するが、保存には使わない。詳細は[保存API調査](STORAGE-RESEARCH.md)。
  runtimeの形・root・permission・耐久性・競合は未検証で、実際の保存や読出しを実行していない。

### PresenceStore / EmojiStore / sendMessage

- Presence: `5745:292..305` は Store 派生 class と prototype、`:516..521` は prototype に
  getClientStatus=closure 35468 を定義。`:550` displayName PresenceStore、`:688` instance を構築、
  `:717` default export。`35468:3..10` は内部 slot 15 の userId 添字参照で返す（fallback なし）。
  利用側 module 9181 は deps[2]=5744 を `9182:110..115` で importDefault / 保存。
  子 closure `102879:13..78` はその instance の isMobileOnline / isVROnline / getStatus を呼ぶ。
  **getClientStatus 自体の直接 consumer は exact index 検索では見つからない**。
  desktop/mobile/web/embedded の keys や購読 API は確認していない。
- Emoji: `6758:1623..1630` は PersistedStore 派生 class と prototype。
  `:1806` getUsableGuildEmoji=38746、`:1890` getCustomEmojiById=38752。
  `:1981/:1993` に EmojiStore / persistKey EmojiStoreV2、`:2187` に instance を構築、`:2216` default export。
  利用側 `7487:61..72` は deps[0]=6757 を importDefault / slot 3 に保存。
  closure `42529:23..39` はその instance の getCustomEmojiById(emojiId) を呼ぶ。
- sendMessage: `7599:1262` の buffer shape **2197** は 43 keys、sendMessage は **slot 18**。
  `7599:1434..1439` は closure **43054** を slot 18 に入れ、`:1683` に同 object を default export。
  `43054:3..62` は4引数を取り async wrapper を開始（第3引数 undefined は true）。完全な契約は未監査。
  外部 consumer module 8483 の closure `145757:126..143` は deps[6]=7598 を importDefault し、
  `.sendMessage` を読む。`:219..230` で呼び出す。通信を伴う実行はしていない。

## 検証と次の判断

- `python3 -m json.tool runtime/modules/352.17.json` は成功。
  `hbc_inspect.py ... func 245 --disasm` と `func 1165 --disasm` を CLI で実行し、
  上記の他の対象も HbcFile.disassemble で確認した。
- 初回調査は52件の function:offset・全10件の ID → factory・登録 offset・入力 hash・
  43-key bufferのsendMessage=slot18を照合。追加の設定UI候補を含む全12件についても
  `tools/tests/test_module_catalog.py` で入力hash・factory・登録offset・命令境界を照合した。
  これはdetailの意味やexportsの実行時検証ではない。
- 初回調査のツールテストは16件中12件成功・4件は入力未指定でskip。
  追加調査では台帳の回帰テストも加え、指定入力付きで全19件成功。
- Hermes VM で実バンドルを起動していない。TurboModuleRegistry、AppRegistry、native 環境なしの
  require を「shape 検証」と見なせないため、無理な mock 実行は行わない。
- 次工程は承認された隔離 runtime で **自然に初期化された対象だけ** import/export shape を検査し、
  getter / prototype / default の扱い、RN gate の順序と失敗時の fail-open を確認する。
- UI接続前にfrozen registry置換の可否・トップ画面guard・初回mountとhook順序を確認する必要がある。
  保存アダプターはnative静的契約から実装したが未接続。nativeの実形・専用pathと失敗時の挙動は別途検証する。
- これら未検証部分を省略して Phase 3 prerequisite 完了とはしない。
  Fake Nitro・platform UI・analytics は対象外。Venus コードの複製、端末操作、APK 変更、push は行わない。
