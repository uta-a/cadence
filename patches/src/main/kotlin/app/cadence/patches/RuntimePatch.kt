package app.cadence.patches

import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.patch.rawResourcePatch
import app.cadence.patches.hbc.HbcInjector
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Inject the bundled, local-only runtime before the pinned HBC global code. [bundlePin] must run first:
 * Discord would otherwise load a downloaded OTA bundle, which never contains the injected prelude.
 *
 * Injection happens in `finalize`, after every feature patch has recorded its selection in `execute`.
 */
@Suppress("unused")
val cadenceRuntime = rawResourcePatch(
    name = "Cadence",
    description = "Inject the Cadence runtime and its settings screen into the APK bundle.",
    default = true,
) {
    compatibleWith(discord)
    dependsOn(bundlePin)

    finalize {
        val runtime = object {}.javaClass.getResourceAsStream("/cadence/runtime.js")?.use { it.readBytes() }
            ?: throw PatchException("Cadence runtime missing from the patches bundle")
        val selected = BuildFeatures.take(this)
        val bundle = get("assets/index.android.bundle")
        // Verify and rewrite a sibling temporary file; a rejected layout never replaces the input asset.
        val temporary = Files.createTempFile(bundle.parentFile.toPath(), "cadence-hbc-", ".bundle")
        try {
            Files.copy(bundle.toPath(), temporary, StandardCopyOption.REPLACE_EXISTING)
            HbcInjector.inject(temporary.toFile(), BuildFeatures.render(runtime.toString(Charsets.UTF_8), selected))
            Files.move(temporary, bundle.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(temporary)
        }
    }
}
