package app.cadence.patches.hbc

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.security.MessageDigest

/**
 * Runs a JS source inside an HBC98 bundle, before any of the bundle's own code (DESIGN.md §4).
 *
 * The string table can't grow without shifting every offset after it, so the source is rebuilt at run time from
 * strings the bundle already has: an array of pieces, `join("")`, then an indirect `eval`. That prelude goes in
 * front of the global function's body, inside an exception handler, and the global function is moved to the end
 * of the file with a new large header. If the source throws, the handler swallows it and Discord starts as usual.
 */
internal object HbcInjector {
    /** The bundle an injection is allowed to touch. [HbcTarget] for Discord; tests pin their own samples. */
    data class Pin(
        val functionCount: Int,
        val globalSha256: String,
        val globalHeaderSha256: String,
        val joinId: Int,
        val evalId: Int,
        val emptyId: Int,
    ) {
        companion object {
            val discord = Pin(HbcTarget.FUNCTION_COUNT, HbcTarget.GLOBAL_SHA256,
                "3c3d94687e710cacb76b65e5e3fefd8c16d48f169a3be48fc493c5e60287df4c",
                HbcTarget.JOIN_ID, HbcTarget.EVAL_ID, HbcTarget.EMPTY_ID)
        }
    }

    data class Result(val pieces: Int, val preludeSize: Int, val globalSize: Int, val bodyOffset: Long)

    /** Longest existing string used as one piece. Longer ones barely cut the piece count. */
    private const val MAX_PIECE = 64
    /** r0..r8: the prelude's scratch locals. Never overlaps the outgoing slots when the frame is >= 18. */
    private const val PRELUDE_REGISTERS = 9
    /** StackFrameLayout: 7 caller metadata slots, this, and one explicit argument for Call2. */
    private const val OUTGOING_REGISTERS = 9
    /** Pieces per array: NewArray's size and DefineOwnInDenseArrayL's index are 16-bit. */
    private const val BLOCK = 65535

    fun inject(file: File, source: String, pin: Pin = Pin.discord): Result {
        require(source.isNotEmpty()) { "Empty runtime" }
        for (c in source) require(c.code in 1..127) { "Runtime must be ASCII without NUL" }

        val plan = FileChannel.open(file.toPath()).use { channel ->
            val mapped = channel.map(FileChannel.MapMode.READ_ONLY, 0, channel.size())
            val hbc = HbcFile(mapped)
            val global = hbc.function(hbc.globalCodeIndex)
            check(hbc.functionCount == pin.functionCount) { "Function count ${hbc.functionCount}, expected ${pin.functionCount}" }
            check(sha256(hbc.largeHeader(global)) == pin.globalHeaderSha256) { "Global header layout differs from the pin" }
            check(global.flags and HbcFile.FLAG_HAS_EXCEPTION_HANDLER == 0) { "The global function already has an exception handler" }
            check(global.readCacheSize + 2 < HbcFile.CACHE_DISABLED) { "No room for two more read cache slots" }
            // The original frame size must stay unchanged: Call instructions locate outgoing arguments at the
            // frame tail. The prelude uses r0..r8 and Call2 needs the top nine slots, so both must fit.
            check(global.frameSize >= PRELUDE_REGISTERS + OUTGOING_REGISTERS) {
                "Unsupported global frame: need at least ${PRELUDE_REGISTERS + OUTGOING_REGISTERS} registers, " +
                    "got ${global.frameSize}"
            }
            check(sha256(hbc.body(global)) == pin.globalSha256) { "The global function isn't the expected one (already patched or a different Discord build)" }
            check(hbc.asciiString(pin.joinId) == "join" && hbc.asciiString(pin.evalId) == "eval" && hbc.asciiString(pin.emptyId) == "") {
                "Pinned string IDs don't match"
            }
            check(hbc.isIdentifier(pin.joinId) && hbc.isIdentifier(pin.evalId)) { "join/eval must be identifier strings for GetById" }
            check(maxOf(pin.joinId, pin.evalId, pin.emptyId) < 65536) { "Pinned string IDs must be 16-bit" }
            check(hbc.footerValid()) { "The bundle's SHA-1 footer is wrong" }
            val original = hbc.bodyWithTables(global)
            val topLevel = hbc.smallHeaderOffset(hbc.globalCodeIndex)
            val pieces = choosePieces(hbc, source)
            Plan(
                prelude = Prelude(global.frameSize, global.readCacheSize, pin).build(pieces, global.bodyOffset),
                pieces = pieces.size,
                original = original,
                largeHeader = hbc.largeHeader(global),
                smallHeader = topLevel,
                globalSize = global.bodySize,
                readCacheSize = global.readCacheSize,
                // The old debug offsets point into the old body, so the moved function goes without.
                flags = (global.flags or HbcFile.FLAG_HAS_EXCEPTION_HANDLER) and HbcFile.FLAG_HAS_DEBUG_INFO.inv(),
            )
        }

        RandomAccessFile(file, "rw").use { raf ->
            val oldLength = raf.length()
            raf.setLength(oldLength - HbcFile.FOOTER_SIZE)
            var end = raf.length()
            // The new body starts 4-aligned; the prelude pads itself so the original body keeps its alignment,
            // which SwitchImm jump tables rely on.
            val bodyOffset = HbcFile.align(end)
            raf.seek(end)
            while (end < bodyOffset) { raf.write(0); end++ }
            raf.write(plan.prelude.code)
            raf.write(plan.original)
            end = raf.filePointer
            val headerOffset = HbcFile.align(end)
            while (end < headerOffset) { raf.write(0); end++ }
            check(headerOffset < (1L shl 32)) { "Bundle too large for a 32-bit large header offset" }

            // Large header: the original one with a new body, size, read cache size and flags.
            val header = ByteBuffer.wrap(plan.largeHeader.copyOf()).order(ByteOrder.LITTLE_ENDIAN)
            header.putInt(0, bodyOffset.toInt())
            header.putInt(12, plan.prelude.code.size + plan.globalSize)
            header.put(32, (plan.readCacheSize + 2).toByte())
            header.put(36, plan.flags.toByte())
            raf.write(header.array())
            // Exception table, 4-aligned after the header: one handler around the prelude's calls.
            val table = ByteBuffer.allocate(3 + 16).order(ByteOrder.LITTLE_ENDIAN)
            table.put(ByteArray(3)) // 37 -> 40
            table.putInt(1).putInt(0).putInt(plan.prelude.tryEnd).putInt(plan.prelude.handler)
            raf.write(table.array())

            // Point the small header at the new large header; it keeps only the offset and the flags.
            val word = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN)
            word.putInt((headerOffset and 0xffffff).toInt())
            word.putInt((((headerOffset ushr 24) and 0xff).toInt()) shl 14)
            raf.seek(plan.smallHeader)
            raf.write(word.array(), 0, 8)
            raf.seek(plan.smallHeader + 11)
            raf.write(plan.flags or HbcFile.FLAG_OVERFLOWED)

            val newLength = raf.length() + HbcFile.FOOTER_SIZE
            check(newLength < Int.MAX_VALUE) { "Bundle too large for HBC98" }
            raf.seek(32)
            raf.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(newLength.toInt()).array())
            raf.seek(raf.length())
            raf.write(sha1(raf))
            return Result(plan.pieces, plan.prelude.code.size, plan.prelude.code.size + plan.globalSize, bodyOffset)
        }
    }

    /**
     * Splits [source] into the fewest existing strings (preferring 16-bit IDs on ties) by dynamic programming.
     * Candidates are found with a trie of only the bundle strings that occur in the source.
     */
    internal fun choosePieces(hbc: HbcFile, source: String): IntArray {
        val src = source.toByteArray(Charsets.US_ASCII)
        val n = src.size
        // Source positions chained by their first four bytes, to test bundle strings for occurrence quickly.
        val heads = IntArray(1 shl 16) { -1 }
        val next = IntArray(n) { -1 }
        fun key(a: Int, b: Int, c: Int, d: Int) = (((a shl 21) or (b shl 14) or (c shl 7) or d) * -1640531527) ushr 16
        for (i in n - 4 downTo 0) {
            val k = key(src[i].toInt(), src[i + 1].toInt(), src[i + 2].toInt(), src[i + 3].toInt())
            next[i] = heads[k]
            heads[k] = i
        }
        val trie = Trie()
        hbc.forEachShortAscii(MAX_PIECE) { id, storage, start, length ->
            if (length < 4) { trie.add(storage, start, length, id); return@forEachShortAscii }
            var p = heads[key(storage[start].toInt(), storage[start + 1].toInt(), storage[start + 2].toInt(), storage[start + 3].toInt())]
            while (p != -1) {
                if (p + length <= n && regionEquals(src, p, storage, start, length)) { trie.add(storage, start, length, id); break }
                p = next[p]
            }
        }

        val cost = IntArray(n + 1)
        val pickLength = IntArray(n)
        val pickId = IntArray(n)
        for (i in n - 1 downTo 0) {
            var best = Int.MAX_VALUE
            var node = 0
            var length = 0
            while (length < MAX_PIECE && i + length < n) {
                node = trie.child(node, src[i + length]) ?: break
                length++
                val id = trie.id[node]
                if (id < 0) continue
                val c = (if (id < 65536) 4 else 6) + cost[i + length]
                if (c < best || c == best && id < pickId[i]) { best = c; pickLength[i] = length; pickId[i] = id }
            }
            check(best != Int.MAX_VALUE) { "No existing string for '${source[i]}' at $i" }
            cost[i] = best
        }
        val out = ArrayList<Int>()
        var i = 0
        while (i < n) { out.add(pickId[i]); i += pickLength[i] }
        return out.toIntArray()
    }

    private fun regionEquals(a: ByteArray, aStart: Int, b: ByteArray, bStart: Int, length: Int): Boolean {
        for (k in 0 until length) if (a[aStart + k] != b[bStart + k]) return false
        return true
    }

    /** Byte trie with first-child / next-sibling arrays; [id] is the smallest string ID ending at a node. */
    private class Trie {
        private var size = 1
        private var firstChild = IntArray(1024) { -1 }
        private var sibling = IntArray(1024) { -1 }
        private var char = ByteArray(1024)
        var id = IntArray(1024) { -1 }

        fun child(node: Int, c: Byte): Int? {
            var x = firstChild[node]
            while (x != -1) { if (char[x] == c) return x; x = sibling[x] }
            return null
        }

        fun add(storage: ByteArray, start: Int, length: Int, stringId: Int) {
            var node = 0
            for (k in start until start + length) {
                node = child(node, storage[k]) ?: newChild(node, storage[k])
            }
            if (id[node] == -1 || stringId < id[node]) id[node] = stringId
        }

        private fun newChild(parent: Int, c: Byte): Int {
            if (size == firstChild.size) {
                val cap = size * 2
                firstChild = firstChild.copyOf(cap).also { it.fill(-1, size, cap) }
                sibling = sibling.copyOf(cap).also { it.fill(-1, size, cap) }
                char = char.copyOf(cap)
                id = id.copyOf(cap).also { it.fill(-1, size, cap) }
            }
            val x = size++
            char[x] = c
            sibling[x] = firstChild[parent]
            firstChild[parent] = x
            return x
        }
    }

    /**
     * Builds the prelude without resizing the frame: original Call instructions address outgoing arguments
     * relative to the frame end, so a bigger frame would move every one of them. The prelude uses r0..r8 and
     * Call2 clobbers the frame's top nine slots. Both exits write those registers to +0 before the original
     * body starts (the body never reads a register before defining it, and +0 is GC-safe). The injected
     * function is rejected unless the frame holds nine scratch plus nine outgoing registers.
     * Opcode numbers and operand layouts are from hermes-v250829098.0.19 `BytecodeList.def`
     * (the order of DEFINE_OPCODE / DEFINE_JUMP entries).
     */
    private class Prelude(private val frameSize: Int, reads: Int, private val pin: Pin) {
        private val global = 0
        private val array = 1
        private val piece = 2
        private val join = 3
        private val separator = 4
        private val blocks = 5
        private val sourceReg = 6
        private val eval = 7
        private val result = 8
        private val joinCache = reads
        private val evalCache = reads + 1

        private val out = ByteArrayOutputStream()

        class Code(val code: ByteArray, val tryEnd: Int, val handler: Int)

        fun build(pieces: IntArray, originalOffset: Long): Code {
            val blockCount = (pieces.size + BLOCK - 1) / BLOCK
            check(blockCount in 1..65535) { "Runtime too large" }
            op(NEW_ARRAY, blocks); u16(blockCount)
            for (b in 0 until blockCount) {
                val first = b * BLOCK
                val size = minOf(BLOCK, pieces.size - first)
                op(NEW_ARRAY, array); u16(size)
                for (k in 0 until size) {
                    loadString(piece, pieces[first + k])
                    defineOwn(array, piece, k)
                }
                joinInto(piece, array)
                defineOwn(blocks, piece, b)
            }
            joinInto(sourceReg, blocks)
            op(GET_GLOBAL_OBJECT, global)
            op(GET_BY_ID, eval, global, evalCache); u16(pin.evalId)
            // Indirect eval: the runtime runs in global scope, not in the global function's.
            op(CALL2, result, eval, global, sourceReg)
            // Jump offsets count from the start of the jump instruction.
            val tryEnd = out.size()
            op(JMP_LONG); i32(5 + 2) // over itself and the 2-byte Catch
            val handler = out.size()
            op(CATCH, result)
            for (r in 0 until PRELUDE_REGISTERS) op(LOAD_CONST_ZERO, r)
            for (r in frameSize - OUTGOING_REGISTERS until frameSize) op(LOAD_CONST_ZERO, r)
            val exit = out.size()
            op(JMP_LONG); i32(0)
            // The new body starts 4-aligned, so padding the prelude to the original offset modulo 4 keeps the
            // original code at the same alignment. Unreachable is a 1-byte opcode, so the padding still disassembles.
            while (out.size() % 4 != (originalOffset % 4).toInt()) out.write(UNREACHABLE)
            patchI32(exit + 1, out.size() - exit)
            return Code(out.toByteArray(), tryEnd, handler)
        }

        private fun loadString(reg: Int, id: Int) {
            if (id < 65536) { op(LOAD_CONST_STRING, reg); u16(id) } else { op(LOAD_CONST_STRING_LONG, reg); i32(id) }
        }

        private fun defineOwn(arrayReg: Int, value: Int, index: Int) {
            if (index < 256) op(DEFINE_OWN_IN_DENSE_ARRAY, arrayReg, value, index)
            else { op(DEFINE_OWN_IN_DENSE_ARRAY_L, arrayReg, value); u16(index) }
        }

        private fun joinInto(dst: Int, arrayReg: Int) {
            op(GET_BY_ID, join, arrayReg, joinCache); u16(pin.joinId)
            loadString(separator, pin.emptyId)
            op(CALL2, dst, join, arrayReg, separator)
        }

        private fun op(vararg bytes: Int) { for (b in bytes) { require(b in 0..255); out.write(b) } }
        private fun u16(v: Int) { out.write(v and 0xff); out.write(v ushr 8) }
        private fun i32(v: Int) { for (s in 0..24 step 8) out.write(v ushr s) }
        private fun patchI32(at: Int, v: Int) {
            val bytes = out.toByteArray()
            for (k in 0..3) bytes[at + k] = (v ushr (8 * k)).toByte()
            out.reset(); out.write(bytes)
        }
    }

    private const val UNREACHABLE = 0
    private const val NEW_ARRAY = 8
    private const val GET_GLOBAL_OBJECT = 61
    private const val GET_BY_ID = 69
    private const val DEFINE_OWN_IN_DENSE_ARRAY = 90
    private const val DEFINE_OWN_IN_DENSE_ARRAY_L = 91
    private const val CALL2 = 110
    private const val CATCH = 119
    private const val LOAD_CONST_STRING = 144
    private const val LOAD_CONST_STRING_LONG = 145
    private const val LOAD_CONST_ZERO = 151
    private const val JMP_LONG = 175

    /** Everything the write pass needs, computed while the input mapping is still open. */
    private data class Plan(
        val prelude: Prelude.Code,
        val pieces: Int,
        val original: ByteArray,
        val largeHeader: ByteArray,
        val smallHeader: Long,
        val globalSize: Int,
        val readCacheSize: Int,
        val flags: Int,
    )

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun sha1(raf: RandomAccessFile): ByteArray {
        val digest = MessageDigest.getInstance("SHA-1")
        val buffer = ByteArray(1 shl 16)
        raf.seek(0)
        while (true) { val r = raf.read(buffer); if (r < 0) break; digest.update(buffer, 0, r) }
        return digest.digest()
    }
}
