package app.cadence.patches.hbc

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.io.TempDir

/**
 * Injects into small bundles compiled by the pinned hermesc and runs them on a Hermes VM built from the same
 * release (work/hermes/hermes, see DESIGN.md §4). Skipped when either tool is missing.
 */
class HbcInjectorTest {
    @TempDir lateinit var temporaryDirectory: File

    private val root = File(System.getProperty("cadence.root") ?: ".")
    private val hermesc = File(root, "runtime/node_modules/hermes-compiler/hermesc/" +
        if (System.getProperty("os.name").startsWith("Mac")) "osx-bin/hermesc" else "linux64-bin/hermesc")
    private val hermes = File(root, "work/hermes/hermes")

    /** A sample whose string table has every printable ASCII character, "join", "eval" and "". */
    private fun sample(body: String, compact: Boolean = false, adequateFrame: Boolean = true, identifierProperties: Boolean = true): File {
        assumeTrue(hermesc.canExecute() && hermes.canExecute(), "hermesc or the Hermes VM is missing")
        val dir = Files.createTempDirectory(temporaryDirectory.toPath(), "fixture-").toFile()
        val chars = (32..126).joinToString(",") { "\"" + (if (it == 34 || it == 92) "\\" else "") + it.toChar() + "\"" }
        val js = File(dir, "sample.js")
        val reserve = if (adequateFrame) "function reserve() { if (arguments.length !== 24 || arguments[0] !== 1 || arguments[23] !== 24) throw new Error('call ABI'); } reserve(" + (1..24).joinToString(",") + ");" else ""
        val properties = if (identifierProperties) "Array.prototype.join, this.eval" else "'join', 'eval'"
        js.writeText("$reserve\nvar chars = [$chars]; var names = [$properties, '', 'print'];\n$body\n")
        val out = File(dir, "sample.hbc")
        run(hermesc.path, if (compact) "-g0" else "-g", "-emit-binary", "-out", out.path, js.path)
        return out
    }

    private fun pinFor(file: File): HbcInjector.Pin {
        val hbc = HbcFile(ByteBuffer.wrap(file.readBytes()))
        fun id(text: String) = (0 until hbc.stringCount).first { hbc.asciiString(it) == text }
        val global = hbc.function(hbc.globalCodeIndex)
        val sha = MessageDigest.getInstance("SHA-256").digest(hbc.body(global)).joinToString("") { "%02x".format(it) }
        return HbcInjector.Pin(hbc.functionCount, sha, MessageDigest.getInstance("SHA-256").digest(hbc.largeHeader(global)).joinToString("") { "%02x".format(it) }, id("join"), id("eval"), id(""))
    }

    private fun execute(vararg command: String): Pair<Int, String> {
        val log = Files.createTempFile(temporaryDirectory.toPath(), "process-", ".log").toFile()
        val process = ProcessBuilder(*command).redirectErrorStream(true).redirectOutput(log).start()
        try {
            assertTrue(process.waitFor(60, TimeUnit.SECONDS), "timed out: ${command.joinToString(" ")}")
            return process.exitValue() to log.readText()
        } finally {
            if (process.isAlive) process.destroyForcibly()
        }
    }

    private fun run(vararg command: String): String {
        val (exit, output) = execute(*command)
        assertEquals(0, exit, "${command.joinToString(" ")} failed:\n$output")
        return output
    }

    @Test
    fun `runtime runs before the original global code`() {
        val bundle = sample("print('original', typeof marker);")
        val result = HbcInjector.inject(bundle, "var marker = 1; print('[cadence] loaded');", pinFor(bundle))
        assertTrue(result.pieces > 0)
        assertEquals("[cadence] loaded\noriginal number\n", run(hermes.path, bundle.path))
        assertTrue(HbcFile(ByteBuffer.wrap(bundle.readBytes())).footerValid())
    }

    @Test
    fun `a throwing runtime leaves the original code running`() {
        val bundle = sample("print('original');")
        HbcInjector.inject(bundle, "print('before'); throw new Error('boom');", pinFor(bundle))
        assertEquals("before\noriginal\n", run(hermes.path, bundle.path))
    }

    @Test
    fun `a runtime with a syntax error leaves the original code running`() {
        val bundle = sample("print('original');")
        HbcInjector.inject(bundle, "this is not javascript", pinFor(bundle))
        assertEquals("original\n", run(hermes.path, bundle.path))
    }

    @Test
    fun `switch jump tables in the original code still work`() {
        // A dense switch compiles to UIntSwitchImm, whose jump table is read at a 4-aligned address.
        val cases = (0..9).joinToString(" ") { "case $it: out.push('c$it'); break;" }
        val bundle = sample("var out = []; for (var i = 0; i < 10; i++) { switch (i) { $cases } } print(out.join(','));")
        val expected = run(hermes.path, bundle.path)
        val hbc = HbcFile(ByteBuffer.wrap(bundle.readBytes()))
        assertTrue(hbc.bodyWithTables(hbc.function(0)).size > hbc.function(0).bodySize, "fixture must contain a real switch table")
        for (pad in 0..7) {
            val copy = File(bundle.parentFile, "pad$pad.hbc").also { bundle.copyTo(it, overwrite = true) }
            HbcInjector.inject(copy, "var p = '" + "x".repeat(pad % 4) + "';" + if (pad >= 4) "throw 1;" else "", pinFor(copy))
            assertEquals(expected, run(hermes.path, copy.path))
        }
    }

    @Test
    fun `refuses to inject twice`() {
        val bundle = sample("print('original');")
        val pin = pinFor(bundle)
        HbcInjector.inject(bundle, "print(1);", pin)
        val error = runCatching { HbcInjector.inject(bundle, "print(2);", pin) }.exceptionOrNull()
        assertTrue(error is IllegalStateException, "second injection should fail, got $error")
    }

    @Test
    fun `compact global header is expanded without changing the calling frame`() {
        val bundle = sample("print('original');", compact = true)
        val before = HbcFile(ByteBuffer.wrap(bundle.readBytes())).function(0)
        assertTrue(!before.overflowed)
        HbcInjector.inject(bundle, "print('compact');", pinFor(bundle))
        val after = HbcFile(ByteBuffer.wrap(bundle.readBytes())).function(0)
        assertTrue(after.overflowed)
        assertEquals(before.frameSize, after.frameSize)
        assertEquals("compact\noriginal\n", run(hermes.path, bundle.path))
    }

    @Test
    fun `a frame with exactly nine locals and nine outgoing slots works`() {
        // Three explicit arguments force 7 metadata + this + 3 args = 11 outgoing slots; hermesc allocates 18.
        val bundle = sample("function add(a, b, c) { return a + b + c; } print('original', add(1, 2, 3));",
            adequateFrame = false)
        val before = HbcFile(ByteBuffer.wrap(bundle.readBytes())).function(0)
        assertEquals(18, before.frameSize, "fixture must exercise the minimum supported frame")
        HbcInjector.inject(bundle, "var marker = 1; print('[cadence] loaded');", pinFor(bundle))
        val after = HbcFile(ByteBuffer.wrap(bundle.readBytes())).function(0)
        assertEquals(18, after.frameSize)
        assertEquals("[cadence] loaded\noriginal 6\n", run(hermes.path, bundle.path))
    }

    @Test
    fun `insufficient frame is rejected without modifying the bundle`() {
        val bundle = sample("print('original');", adequateFrame = false)
        val original = bundle.readBytes()
        val error = runCatching { HbcInjector.inject(bundle, "print(1);", pinFor(bundle)) }.exceptionOrNull()
        assertTrue(error is IllegalStateException && error.message!!.contains("at least 18 registers"))
        assertTrue(original.contentEquals(bundle.readBytes()))
    }

    @Test
    fun `original exceptions are not swallowed by the prelude handler`() {
        for (runtime in listOf("print('runtime');", "throw new Error('runtime boom');")) {
            val bundle = sample("throw new Error('original boom');")
            HbcInjector.inject(bundle, runtime, pinFor(bundle))
            val (exit, output) = execute(hermes.path, bundle.path)
            assertTrue(exit != 0)
            assertTrue(output.contains("original boom"), output)
            assertTrue(!output.contains("runtime boom"), output)
        }
    }

    @Test
    fun `more than one array block is joined without clobbering registers`() {
        val bundle = sample("print('original');")
        // Each space is a one-character piece, so >65535 pieces force a second block. The trailing statement
        // only survives if the blocks are joined in order.
        val result = HbcInjector.inject(bundle, " ".repeat(65535) + "print('[cadence] blocks');", pinFor(bundle))
        assertTrue(result.pieces > 65535, "fixture must span more than one array block")
        assertEquals("[cadence] blocks\noriginal\n", run(hermes.path, bundle.path))
    }

    @Test
    fun `header mismatch and corrupt footer reject without writes`() {
        for (headerMismatch in listOf(true, false)) {
            val bundle = sample("print('original');")
            val pin = pinFor(bundle)
            if (!headerMismatch) {
                val bytes = bundle.readBytes()
                bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
                bundle.writeBytes(bytes)
            }
            val before = bundle.readBytes()
            val error = runCatching {
                HbcInjector.inject(bundle, "print(1);", if (headerMismatch) pin.copy(globalHeaderSha256 = "bad") else pin)
            }.exceptionOrNull()
            assertTrue(error is IllegalStateException)
            assertTrue(before.contentEquals(bundle.readBytes()))
        }
    }

    @Test
    fun `existing original exception handlers are explicitly unsupported`() {
        val bundle = sample("try { throw 1; } catch (e) { print(e); }")
        val before = bundle.readBytes()
        val error = runCatching { HbcInjector.inject(bundle, "print(1);", pinFor(bundle)) }.exceptionOrNull()
        assertTrue(error is IllegalStateException && error.message!!.contains("already has an exception handler"))
        assertTrue(before.contentEquals(bundle.readBytes()))
    }

    @Test
    fun `string switch tables are relocated with their original targets`() {
        val cases = (0..15).joinToString(" ") { "case 'case$it': out.push($it); break;" }
        val bundle = sample("var out = []; for (var i = 0; i < 16; i++) { switch ('case' + i) { $cases } } print(out.join(','));")
        val hbc = HbcFile(ByteBuffer.wrap(bundle.readBytes()))
        assertTrue(hbc.bodyWithTables(hbc.function(0)).size > hbc.function(0).bodySize)
        val expected = run(hermes.path, bundle.path)
        HbcInjector.inject(bundle, "print('runtime'); throw 1;", pinFor(bundle))
        assertEquals("runtime\n" + expected, run(hermes.path, bundle.path))
    }

    @Test
    fun `switch tables outside the code region are rejected without writes`() {
        val cases = (0..9).joinToString(" ") { "case $it: print($it); break;" }
        val bundle = sample("for (var i = 0; i < 10; i++) { switch (i) { $cases } }")
        val bytes = bundle.readBytes()
        val hbc = HbcFile(ByteBuffer.wrap(bytes))
        val global = hbc.function(0)
        var pc = global.bodyOffset.toInt()
        while ((bytes[pc].toInt() and 255) != HbcInstructions.UINT_SWITCH) {
            pc += HbcInstructions.sizes[bytes[pc].toInt() and 255]
            assertTrue(pc < global.bodyOffset + global.bodySize, "fixture must have UIntSwitchImm")
        }
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putInt(pc + 2, Int.MAX_VALUE)
        val digest = MessageDigest.getInstance("SHA-1").digest(bytes.copyOf(bytes.size - HbcFile.FOOTER_SIZE))
        digest.copyInto(bytes, bytes.size - HbcFile.FOOTER_SIZE)
        bundle.writeBytes(bytes)
        val error = runCatching { HbcInjector.inject(bundle, "print(1);", pinFor(bundle)) }.exceptionOrNull()
        assertTrue(error is IllegalStateException && error.message!!.contains("Switch table out of function bounds"))
        assertTrue(bytes.contentEquals(bundle.readBytes()))
    }

    @Test
    fun `plain string literals cannot be used as GetById identifiers`() {
        val bundle = sample("print('original');", identifierProperties = false)
        val before = bundle.readBytes()
        val pin = pinFor(bundle)
        val hbc = HbcFile(ByteBuffer.wrap(before))
        assertTrue(!hbc.isIdentifier(pin.joinId) && !hbc.isIdentifier(pin.evalId))
        val error = runCatching { HbcInjector.inject(bundle, "print(1);", pin) }.exceptionOrNull()
        assertTrue(error is IllegalStateException && error.message!!.contains("must be identifier strings"))
        assertTrue(before.contentEquals(bundle.readBytes()))
    }

    @Test
    fun `discord bundle`() {
        val original = File(root, "work/352.17/assets/index.android.bundle")
        assumeTrue(original.isFile, "Discord 352.17 bundle not extracted")
        val copy = Files.createTempFile(temporaryDirectory.toPath(), "discord-", ".bundle").toFile()
        original.copyTo(copy, overwrite = true)
        val runtime = File(root, "patches/build/generated/runtime/cadence/runtime.js").readText()
        val start = System.nanoTime()
        val result = HbcInjector.inject(copy, runtime)
        println("discord: ${result.pieces} pieces, prelude ${result.preludeSize} B, ${(System.nanoTime() - start) / 1_000_000} ms")
        val hbc = HbcFile(ByteBuffer.wrap(copy.readBytes()))
        assertTrue(hbc.footerValid())
        val global = hbc.function(hbc.globalCodeIndex)
        assertEquals(result.globalSize, global.bodySize)
        assertEquals(HbcTarget.GLOBAL_FRAME_SIZE, global.frameSize)
        // The prelude must stay inside a swallowed handler, and the old debug offsets now point at a dead body.
        assertTrue(global.flags and HbcFile.FLAG_HAS_EXCEPTION_HANDLER != 0)
        assertEquals(0, global.flags and HbcFile.FLAG_HAS_DEBUG_INFO)
        // The CLI has no RN native host. Verify prelude execution and the SAME original host error,
        // not a full Discord cold boot. Force bytecode mode for the .bundle extension.
        if (hermes.canExecute()) {
            val marked = Files.createTempFile(temporaryDirectory.toPath(), "discord-vm-", ".hbc").toFile()
            try {
                for (throws in listOf(false, true)) {
                    original.copyTo(marked, overwrite = true)
                    HbcInjector.inject(marked, runtime + ";print('[cadence] revision',globalThis.__cadence.revision);" + if (throws) "throw 1;" else "")
                    val (exit, output) = execute(hermes.path, "-b", marked.path)
                    assertEquals(1, exit)
                    assertTrue(output.startsWith("[cadence] loaded 0.2.0 (console)\n[cadence] observer installed (console)\n[cadence] revision 0.2.0\n"), output)
                    assertTrue(output.contains("__fbBatchedBridgeConfig is not set"), output)
                }
            } finally { marked.delete() }
        }
        copy.delete()
    }
}
