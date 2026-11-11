package app.disk.patches

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class BuildFeaturesTest {
    @Test
    fun `no selected feature patches means an empty embedded manifest`() {
        assertEquals("parseBuildFeatures([])", BuildFeatures.render("parseBuildFeatures(\"/*__DISK_FEATURES__*/\")"))
    }

    @Test
    fun `selection is deterministic and each APK is independent`() {
        val runtime = "parseBuildFeatures('/*__DISK_FEATURES__*/')"
        assertEquals(
            "parseBuildFeatures([\"fakeNitro\", \"disableAnalytics\"])",
            BuildFeatures.render(runtime, setOf("disableAnalytics", "fakeNitro")),
        )
        assertEquals("parseBuildFeatures([])", BuildFeatures.render(runtime))
    }

    @Test
    fun `unknown IDs and missing or duplicate markers fail closed`() {
        assertFailsWith<IllegalArgumentException> { BuildFeatures.render("'/*__DISK_FEATURES__*/'", setOf("unknown")) }
        assertFailsWith<IllegalStateException> { BuildFeatures.render("nothing") }
        assertFailsWith<IllegalStateException> { BuildFeatures.render("'/*__DISK_FEATURES__*/' + \"/*__DISK_FEATURES__*/\"") }
    }

    @Test
    fun `selections are kept per patching context and taken once`() {
        val first = Any()
        val second = Any()
        BuildFeatures.select(first, "platformIndicator")
        BuildFeatures.select(first, "fakeNitro")
        BuildFeatures.select(first, "fakeNitro")
        BuildFeatures.select(second, "disableAnalytics")
        assertEquals(setOf("platformIndicator", "fakeNitro"), BuildFeatures.take(first))
        assertEquals(emptySet(), BuildFeatures.take(first))
        assertEquals(setOf("disableAnalytics"), BuildFeatures.take(second))
        assertFailsWith<IllegalArgumentException> { BuildFeatures.select(first, "privacy") }
        assertEquals(emptySet(), BuildFeatures.take(first))
    }

    @Test
    fun `runtime feature patches depend on the runtime and are selected by default`() {
        for (patch in listOf(fakeNitro, platformIndicator, disableAnalytics, skipDeleteConfirmation, skipPinConfirmation, alwaysTrustLinksAndFiles, jumpToFirstMessage, doubleTapToReply, loadFullQualityImages, readAll, replyWithoutPinging, downloadVoiceMessages, serverInformation)) {
            assertTrue(patch.default)
            assertTrue(patch.dependencies.contains(diskRuntime))
            assertEquals("com.discord", patch.compatibility!!.single().packageName)
        }
    }
}
