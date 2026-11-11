package app.disk.patches

import java.util.WeakHashMap

/**
 * Per-APK feature manifest. Feature patches record their selection against the patching context in `execute`;
 * the runtime patch takes it in `finalize` (Morphe runs every `execute` before any `finalize`). The registry is
 * keyed by that context and weakly held, so one patching run can never see another run's selection.
 */
internal object BuildFeatures {
    private const val MARKER = "/*__DISK_FEATURES__*/"
    /** Runtime features, in manifest order. Ported Venus features follow the original three (docs/VENUS-PORT.md). */
    val known = listOf("fakeNitro", "platformIndicator", "disableAnalytics", "quickDelete", "noConfirmPin", "alwaysTrust", "jumpToTop", "gestures", "fullImages", "readAll", "quietReplies")
    private val selections = WeakHashMap<Any, MutableSet<String>>()

    fun select(context: Any, id: String) {
        require(id in known) { "Unknown disk build feature" }
        synchronized(selections) { selections.getOrPut(context) { linkedSetOf() }.add(id) }
    }

    /** Removes and returns the selection, so a repeated finalize cannot embed a stale manifest. */
    fun take(context: Any): Set<String> = synchronized(selections) { selections.remove(context)?.toSet() ?: emptySet() }

    fun render(runtime: String, selected: Set<String> = emptySet()): String {
        require(selected.all { it in known }) { "Unknown disk build feature" }
        val markers = listOf("\"$MARKER\"", "'$MARKER'")
        val matches = markers.sumOf { token -> Regex(Regex.escape(token)).findAll(runtime).count() }
        check(matches == 1) { "Expected exactly one disk feature manifest marker" }
        val manifest = known.filter { it in selected }.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }
        return markers.fold(runtime) { text, token -> text.replace(token, manifest) }
    }
}
