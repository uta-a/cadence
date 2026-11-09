package app.disk.patches

import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.patch.rawResourcePatch

/**
 * Ships the disk runtime inside the APK as assets/disk/runtime.js.
 * Phase 0: only copies the file; injecting it into index.android.bundle comes in Phase 2.
 */
@Suppress("unused")
val diskRuntime = rawResourcePatch(
    name = "disk",
    description = "The disk runtime. Every other disk feature needs it.",
    default = true,
) {
    compatibleWith(discord)

    execute {
        val runtime = object {}.javaClass.getResourceAsStream("/disk/runtime.js")?.use { it.readBytes() }
            ?: throw PatchException("disk runtime missing from the patches bundle")
        val asset = get("assets/disk/runtime.js", false)
        asset.parentFile.mkdirs()
        asset.writeBytes(runtime)
    }
}
