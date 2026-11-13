package app.cadence.patches

import java.util.WeakHashMap

/**
 * Per-APK feature manifest. Feature patches record their selection against the patching context in `execute`;
 * the runtime patch takes it in `finalize` (Morphe runs every `execute` before any `finalize`). The registry is
 * keyed by that context and weakly held, so one patching run can never see another run's selection.
 */
internal object BuildFeatures {
    private const val MARKER = "/*__CADENCE_FEATURES__*/"
    /** Runtime features, in manifest order. */
    val known = listOf("fakeNitro", "platformIndicator", "disableAnalytics")
    private val selections = WeakHashMap<Any, MutableSet<String>>()

    fun select(context: Any, id: String) {
        require(id in known) { "Unknown Cadence build feature" }
        synchronized(selections) { selections.getOrPut(context) { linkedSetOf() }.add(id) }
    }

    /** Removes and returns the selection, so a repeated finalize cannot embed a stale manifest. */
    fun take(context: Any): Set<String> = synchronized(selections) { selections.remove(context)?.toSet() ?: emptySet() }

    fun render(runtime: String, selected: Set<String> = emptySet()): String {
        require(selected.all { it in known }) { "Unknown Cadence build feature" }
        val markers = listOf("\"$MARKER\"", "'$MARKER'")
        val matches = markers.sumOf { token -> Regex(Regex.escape(token)).findAll(runtime).count() }
        check(matches == 1) { "Expected exactly one Cadence feature manifest marker" }
        val manifest = known.filter { it in selected }.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }
        return markers.fold(runtime) { text, token -> text.replace(token, manifest) }
    }
}
