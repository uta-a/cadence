package app.cadence.patches

import app.morphe.patcher.patch.ApkFileType
import app.morphe.patcher.patch.AppTarget
import app.morphe.patcher.patch.Compatibility

/** The one Discord build Cadence is pinned to. Every HBC constant and module ID is for this build. */
internal const val DISCORD_VERSION = "352.17 - Stable"

internal val discord = Compatibility(
    name = "Discord",
    packageName = "com.discord",
    apkFileType = ApkFileType.APKM,
    appIconColor = 0x5865F2,
    targets = listOf(AppTarget(version = DISCORD_VERSION)),
)
