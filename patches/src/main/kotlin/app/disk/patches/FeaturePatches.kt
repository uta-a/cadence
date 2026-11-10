package app.disk.patches

import app.disk.patches.dex.AdvertisingId
import app.morphe.patcher.patch.bytecodePatch
import app.morphe.patcher.patch.rawResourcePatch

// Runtime features are only embedded here; each one stays off until enabled in Discord's disk settings.

@Suppress("unused")
val fakeNitro = rawResourcePatch(
    name = "Fake Nitro",
    description = "Send emojis that need Nitro as image links. Off until enabled in the disk settings.",
    default = true,
) {
    compatibleWith(discord)
    dependsOn(diskRuntime)
    execute { BuildFeatures.select(this, "fakeNitro") }
}

@Suppress("unused")
val platformIndicator = rawResourcePatch(
    name = "Platform Indicator",
    description = "Show which devices a user is connected from next to their avatar. Off until enabled in the disk settings.",
    default = true,
) {
    compatibleWith(discord)
    dependsOn(diskRuntime)
    execute { BuildFeatures.select(this, "platformIndicator") }
}

@Suppress("unused")
val disableAnalytics = rawResourcePatch(
    name = "Disable analytics",
    description = "Drop Discord's JavaScript analytics events before they are queued.",
    default = true,
) {
    compatibleWith(discord)
    dependsOn(diskRuntime)
    execute { BuildFeatures.select(this, "disableAnalytics") }
}

@Suppress("unused")
val disableAdvertisingId = bytecodePatch(
    name = "Disable advertising ID",
    description = "Report no Google advertising ID to Discord's JavaScript.",
    default = true,
) {
    compatibleWith(discord)
    execute { AdvertisingId.disable(this) }
}
