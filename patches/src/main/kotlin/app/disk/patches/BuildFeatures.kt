package app.disk.patches

/** Per-APK feature manifest; no mutable global selection that could leak between patching runs. */
internal object BuildFeatures {
    private const val MARKER = "/*__DISK_FEATURES__*/"
    private val known = listOf("fakeNitro", "platformIndicator", "privacy")

    fun render(runtime: String, selected: Set<String> = emptySet()): String {
        require(selected.all { it in known }) { "Unknown disk build feature" }
        val markers = listOf("\"$MARKER\"", "'$MARKER'")
        val matches = markers.sumOf { token -> Regex(Regex.escape(token)).findAll(runtime).count() }
        check(matches == 1) { "Expected exactly one disk feature manifest marker" }
        val manifest = known.filter { it in selected }.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }
        return markers.fold(runtime) { text, token -> text.replace(token, manifest) }
    }
}
