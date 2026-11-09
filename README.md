# disk

Discord (Android) 向けの Morphe パッチ。Fake Nitro、Platform Indicator、プライバシー保護をオフラインで追加する。

> 開発中（Phase 0）。設計とフェーズは [docs/DESIGN.md](docs/DESIGN.md) を参照。

**対応:** Discord **351.11 - Stable**（APKM）

## ビルド

必要なもの: JDK 21、Node.js、`read:packages` 権限のある GitHub トークン（Morphe の Gradle プラグイン取得用）

```bash
GITHUB_ACTOR=<user> GITHUB_TOKEN=$(gh auth token) \
  ./gradlew :patches:generatePatchesList :patches:buildAndroid
# -> patches/build/libs/patches-<version>.mpp
```

`buildAndroid` は Morphe Manager が必要とする `classes.dex` を追加する。`build` や `generatePatchesList` は DEX なしで `.mpp` を書き直すので、`buildAndroid` を最後に実行する。

ランタイムだけをビルドする場合:

```bash
cd runtime && npm ci && node build.mjs   # 型チェック + HBC98 へのコンパイル確認
```

## ライセンス

[GPL-3.0](LICENSE)。Morphe patches template を元にしている（[NOTICE](NOTICE)）。
