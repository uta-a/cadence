package app.disk.patches

import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.patch.rawResourcePatch
import app.disk.patches.hbc.HbcInjector
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Inject the bundled, local-only runtime before the pinned HBC global code. OTA pinning is not yet implemented. */
@Suppress("unused")
val diskRuntime = rawResourcePatch(
    name = "disk",
    description = "Inject the disk runtime into the APK bundle (experimental; OTA pinning not yet implemented).",
    default = true,
) {
    compatibleWith(discord)

    execute {
        val runtime = object {}.javaClass.getResourceAsStream("/disk/runtime.js")?.use { it.readBytes() }
            ?: throw PatchException("disk runtime missing from the patches bundle")
        val bundle = get("assets/index.android.bundle")
        // Verify and rewrite a sibling temporary file; a rejected layout never replaces the input asset.
        val temporary = Files.createTempFile(bundle.parentFile.toPath(), "disk-hbc-", ".bundle")
        try {
            Files.copy(bundle.toPath(), temporary, StandardCopyOption.REPLACE_EXISTING)
            HbcInjector.inject(temporary.toFile(), runtime.toString(Charsets.UTF_8))
            Files.move(temporary, bundle.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(temporary)
        }
    }
}
