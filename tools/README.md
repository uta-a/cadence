# Phase 1: HBC98 解析ツール

Python 3.10+、標準ライブラリのみ。バンドルは**読み取り専用**で解析し、JS は実行しない。
既存の中断作業を継続し、Phase 2 に必要なヘッダ・文字列・関数配置・ハッシュ・定数生成を検証した。
**Phase 1 全体の完了ではない**。後続の静的調査で `runtime/modules/352.17.json` を候補台帳として追加したが、
全件 `verified: false` で exports の実行時検証と最終 ID 表は未完成。詳細は [モジュール調査](../docs/MODULE-RESEARCH.md)。
この解析ツール自体による注入、APK 書き換え、端末操作、インストールは対象外。

## 入力と参照元

検証入力（リポジトリ外、コミットしない）:

- Discord **352.17 - Stable**
- `work/352.17/assets/index.android.bundle`
- `work/352.17/apks/base.apk` と同ディレクトリの split APK
- 比較先（読み取りのみ）: `patches/src/main/kotlin/app/disk/patches/hbc/HbcTarget.kt`

フォーマットの根拠は Meta Hermes の MIT ライセンスのソース:

- release `hermes-v250829098.0.19`
- commit `40b4c8d4e22ed2b9af46aba81aec3ca8aa5e169c`
- [BytecodeFileFormat.h](https://github.com/facebook/hermes/blob/40b4c8d4e22ed2b9af46aba81aec3ca8aa5e169c/include/hermes/BCGen/HBC/BytecodeFileFormat.h)
- 同コミットの `lib/BCGen/HBC/BytecodeStream.cpp`（配置・SHA-1）、
  `include/hermes/BCGen/HBC/{BytecodeList.def,StringKind.h}`、
  `include/hermes/BCGen/SerializedLiteralParser.h`（literal buffer）
- ローカル参照: `/tmp/disk-ref/hfull`（上記 commit）、`/tmp/disk-ref/hsrc`
- 固定コンパイラ: `/tmp/disk-ref/hc/package/hermesc/osx-bin/hermesc`
  （`-version`: release 250829098.0.19 / HBC98）
- 参照ソースからビルドされた `/tmp/disk-ref/hfull/build/bin/hbcdump` でも配置を照合

`opcodes98.json` は `BytecodeList.def` の命令順・型・ID注釈から作成した219命令の表。
上流で ID 注釈が省略されている `DefineOwnById` の第4 operand、
`CreateBaseClass[LongIndex]` / `CreateDerivedClass[LongIndex]` の最終 operand は、
上流のコメント・意味に従い string / function ID として補足している。
出典との一致を self-test で検証できる。ライセンス表示は `HERMES-LICENSE`。
Venus のコードは使用していない。

## 使い方

リポジトリルートで実行する。出力先はこの worktree 内の `work/` を使用し、他の worktree は変更しない。

```sh
# APKM、base.apk、または base.apk を含む split APK ディレクトリ
python3 -I tools/extract.py work/352.17/apks/ --out work/extracted35217
# --version は manifest から読めない場合の明示的な上書き
# base.apk、assets/index.android.bundle、classes*.dex、extraction.json のみ出力

BUNDLE=work/352.17/assets/index.android.bundle
python3 tools/hbc_inspect.py "$BUNDLE" header
python3 tools/hbc_inspect.py "$BUNDLE" global
python3 tools/hbc_inspect.py "$BUNDLE" string-id join
python3 tools/hbc_inspect.py "$BUNDLE" strings --grep '^eval$'
python3 tools/hbc_inspect.py "$BUNDLE" func 0 --disasm > work/global.txt
python3 tools/hbc_inspect.py "$BUNDLE" modules --id 5744

python3 tools/gen_target.py "$BUNDLE" --version '352.17 - Stable' --write work/HbcTarget.kt
cmp work/HbcTarget.kt patches/src/main/kotlin/app/disk/patches/hbc/HbcTarget.kt
# extraction.json が assets/ の親にあれば --version を省略できる。
# 両方ない場合はエラー（未知の入力を自動で 352.17 と名付けない）。

python3 tools/find_module.py "$BUNDLE" getClientStatus --exact --limit 5
python3 tools/find_module.py "$BUNDLE" canUseEmojisEverywhere canUseAnimatedEmojis --exact
python3 tools/find_module.py "$BUNDLE" track --kind export --exact
```

`gen_target.py` は stdout または指定した `--write` 先に Kotlin のみ出力する。
footer不一致、global index != 0、必要な文字列の欠落/重複では拒否する。
デフォルトの探索キャッシュは `work/module-index.sqlite`。`--cache` で変更可能。
バンドル全体の SHA-256 と解析スキーマでキャッシュを無効化する。
`--kind` は `string`（literal）、`export`（Metro 引数から追跡できた書き込み）、
`property`、`name`、`any`。ヒットの function と offset は関数内バイトオフセットであり、
`hbc_inspect.py ... func <function> --disasm` で追跡できる。
SQLite TEXT に格納できない単独 surrogate を含む証拠のみ、インデックス構築時に警告して除外する。
その他の証拠は検索できる。

## 確認済みの配置と定数

実バンドルからの `gen_target.py` 出力は比較先 `HbcTarget.kt` と**バイト単位で一致**した。

| 定数 | 値 |
| --- | --- |
| DISCORD_VERSION | `352.17 - Stable` |
| BYTECODE_VERSION | `98` |
| FILE_SIZE | `70404633` |
| FUNCTION_COUNT | `163874` |
| STRING_COUNT | `349546` |
| GLOBAL_OFFSET | `15094404` |
| GLOBAL_SIZE | `644227` |
| GLOBAL_FRAME_SIZE | `30` |
| JOIN_ID | `152` |
| EVAL_ID | `31623` |
| EMPTY_ID | `255` |
| GLOBAL_SHA256 | `22fe8eb9f4638caf834404cd6f82a1d5f22780bbfbfbec793e1728a53404c51c` |

- バンドル全体 SHA-256: `09dcdd872df4fb7aa84b2a5ecc62946735de7a63447b848d549bd99d6f4505ee`
- footer SHA-1: `50501551e8944cf43af2213e16e9e091adf09f21`。末尾20バイト以外の SHA-1 と一致。
- global index `0`、expanded header offset `51887520`、flags `18`、例外ハンドラなし。
- global の name ID `32629`、read/write cache `25/30`、number/non-pointer registers `5/2`。
- コンパクト関数ヘッダ `1878` 件、拡張ヘッダ `161996` 件。
- `join` / `eval` / `""` の string kind はいずれも Identifier (`1`)。
- `num_string_switch_imms=113`、`segment_id=0`、`cjs_module_count=0`、
  `function_source_count=2709`、`debug_info_offset=59252256`、`options=0`。
- function source table `[15072732,15094404)`、debug section `[59252256,70404613)`。
- `hbcdump -show-section-ranges -c quit "$BUNDLE"` および
  `hbcdump -c 'function-info 0;quit' "$BUNDLE"` と配置・global サイズが一致。

### 移植時に重要なフォーマット上の制約

- execution-form HBC98 のみ対応。delta-form magic と他の version は拒否する。
- ファイルヘッダは128バイト。offset32から **20個** の uint32、options は offset112。
  `numStringSwitchImms`（offset92）を飛ばすと segment/CJS/source/debug/options がずれる。
  中断時の実装のこの欠落を修正した。
- 各静的セクションは4バイト境界。function source/CJS の1要素は8バイト。
- 関数の small header は12バイト。flags bit5 のときは body offset ではなく拡張ヘッダのポインタ。
  low24 と functionName フィールドの high8 から復元する。
- 拡張ヘッダは40バイト（8 uint32 + 5 uint8 + 3 padding）。
  例外テーブルは続く4バイト境界に count + `(start,end,target)` の12バイト要素。
  end は排他的。例外フラグを持つ関数は serializer が拡張ヘッダにする。
- 関数 size は **命令バイトのみ**。switch table は後続するが body SHA-256 には含まれない。
  重複排除で複数関数が body を共有する場合がある。
- compact string は UTF16 flag1bit、offset23bit、length8bit。
  length255 は overflow table の index。UTF16 length はコード単位、offset はバイト。
  UTF16 の単独 surrogate も失わず保持する。文字列の格納領域共有を許容する。
- SHA-1 footer は整合性検査であり、署名・信頼性の保証ではない。

## モジュール探索: 未確定の候補のみ

global の `__d` 登録を19,539件検出した（設計書の約17.7k件はこの実入力とは異なる）。
登録位置と factory 対応は静的解析であり、実際の require / exports 形確認を代替しない。
以下は探索の再開点にすぎず、採用済み ID ではない。

| 用途候補 | module → factory | 静的根拠 (function:offset) | 未確認事項 |
| --- | --- | --- | --- |
| Fake Nitro の利用可否 | `2053 → 2054` | `2054:1480` の object write keys: `canUseEmojisEverywhere`, `canUseAnimatedEmojis` | exports の帰属・形・仕様 |
| PresenceStore 周辺 | `5744 → 5745` | `5745:510` literal / `5745:521` write: `getClientStatus` | store の export と購読・返り値 |
| analytics 周辺 | `16702 → 16703` | `16703:91` export write: `track` | 目的の analytics か、別経路の有無 |

`confidence` は文字列証拠の重み付きランキングのみ。`high` でも検証済みではなく、
全候補で **`verified: false`** を出力する。全 Fake Nitro / Platform UI / analytics の
対象が揃ったわけではない。sendMessage、sticker、UI、privacy の経路検証は残っている。

レジスタ値を直線的に追跡する限定的な解析で、CFG/分岐の合流、環境変数経由の alias、
動的プロパティ、全 call variant、実行順・実際の exports は完全には扱わない。
子 closure の証拠は factory に集約されるため、内部 object の write や property read は
export の証拠とは区別する必要がある。`-O0` fixture の環境に spill した exports は
意図的に export と認定せず、property/write 候補に留めている。
登録スキャンも任意の Metro 生成形を扱うものではなく、未解決の既知 `__d` call はエラーにする。

## 再利用可能な self-test

```sh
# 外部入力なし: 12 passed、4 skipped
python3 -I -m unittest discover -s tools/tests -v

# 固定コンパイラ、出典、実バンドル、read-only比較先を含める: 16 passed
# HERMES_SOURCE は上記 commit の Hermes ソースを取得した場所に合わせる。
# Linux では osx-bin を linux64-bin に変更する。
HERMES_SOURCE=/path/to/hermes \
HERMESC="$PWD/runtime/node_modules/hermes-compiler/hermesc/osx-bin/hermesc" \
DISK_BUNDLE="$PWD/work/352.17/assets/index.android.bundle" \
HBC_TARGET_REFERENCE="$PWD/patches/src/main/kotlin/app/disk/patches/hbc/HbcTarget.kt" \
python3 -I -m unittest discover -s tools/tests -v
```

合成ファイルは一時ディレクトリだけに作成する。テスト対象:

- 手組みヘッダ（遅い位置の非ゼロ項目）、compact/expanded 関数、例外テーブル
- ASCII / UTF16 / 単独 surrogate / overflow、footer、global body SHA-256
- 長さ・範囲・version・magic・string kind・文字列 ID の破損、定数生成の拒否条件
- 小型 ZIP の APK/APKM 抽出と archive path を出力に使用しないこと
- 自作 JS fixture の `-O0 -g0` / `-O -g` / `-O -g -fstatic-builtins` コンパイル
  （文字列、例外、string/uint switch、命令サイズ、Metro 登録、export 証拠）
- 全219命令の出典照合、実バンドル全163,874関数・8,089,716命令の幅とID参照範囲
- 352.17 固定値、既存 Kotlin の生成結果との一致

実 APK からの抽出も実行し、元バンドルとの `cmp` が一致した。
外部 `hermesc -commonjs` は、配布版と上記ソースからのビルド版の両方で SIGSEGV になったため、
CommonJS のコンパイラ生成経路は未検証（手組みのセクション配置のみ検証）。
これは Discord の Metro バンドルと通常 fixture の検証を妨げない。

この parser は完全な Hermes verifier / decompiler ではない。命令の分岐先、switch table 全要素、
debug 情報内部の意味、regexp/BigInt の値は全面検証しない。信頼できるローカルの入力を対象とする。
Phase 2 の注入と VM での動作・フェイルオープン検証、実機での確認は別工程。
