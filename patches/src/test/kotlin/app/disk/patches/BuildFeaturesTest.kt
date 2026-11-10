package app.disk.patches

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class BuildFeaturesTest {
    @Test
    fun `no selected feature patches means an empty embedded manifest`() {
        assertEquals("parseBuildFeatures([])", BuildFeatures.render("parseBuildFeatures(\"/*__DISK_FEATURES__*/\")"))
    }

    @Test
    fun `selection is deterministic and each APK is independent`() {
        val runtime = "parseBuildFeatures('/*__DISK_FEATURES__*/')"
        assertEquals("parseBuildFeatures([\"fakeNitro\", \"privacy\"])", BuildFeatures.render(runtime, setOf("privacy", "fakeNitro")))
        assertEquals("parseBuildFeatures([])", BuildFeatures.render(runtime))
    }

    @Test
    fun `unknown IDs and missing or duplicate markers fail closed`() {
        assertFailsWith<IllegalArgumentException> { BuildFeatures.render("'/*__DISK_FEATURES__*/'", setOf("unknown")) }
        assertFailsWith<IllegalStateException> { BuildFeatures.render("nothing") }
        assertFailsWith<IllegalStateException> { BuildFeatures.render("'/*__DISK_FEATURES__*/' + \"/*__DISK_FEATURES__*/\"") }
    }
}
