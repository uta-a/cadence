package app.disk.patches

import app.disk.patches.dex.BundlePin
import app.morphe.patcher.patch.bytecodePatch

/**
 * Pins React Native to the bundle shipped in the APK (DESIGN.md §4.4). The disk runtime is injected into
 * `assets/index.android.bundle`, so a downloaded OTA bundle would silently replace it.
 */
@Suppress("unused")
val bundlePin = bytecodePatch(
    name = "bundle pin",
    description = "Always load the bundle packaged in the APK instead of a downloaded or cached OTA bundle.",
    default = true,
) {
    compatibleWith(discord)

    execute {
        BundlePin.pin(this)
    }
}
