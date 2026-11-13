package app.cadence.patches.hbc

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * Read-only view of a Hermes bytecode (HBC) file, version 98.
 *
 * Layout from hermes-v250829098.0.19 `include/hermes/BCGen/HBC/BytecodeFileFormat.h`:
 * a 128-byte header, then 4-byte aligned tables in this order: small function headers (12 bytes each),
 * string kinds, identifier hashes, small string table, overflow string table, string storage, ...
 * The file ends with a SHA-1 of everything before it.
 */
internal class HbcFile(bytes: ByteBuffer) {
    private val buf: ByteBuffer = bytes.duplicate().order(ByteOrder.LITTLE_ENDIAN)

    val magic = buf.getLong(0)
    val version = buf.getInt(8)
    val fileLength = buf.getInt(32)
    val globalCodeIndex = buf.getInt(36)
    val functionCount = buf.getInt(40)
    private val stringKindCount = buf.getInt(44)
    private val identifierCount = buf.getInt(48)
    val stringCount = buf.getInt(52)
    private val overflowStringCount = buf.getInt(56)
    private val stringStorageSize = buf.getInt(60)

    private val functionHeaders = HEADER_SIZE
    private val stringTable = align(align(align(functionHeaders + functionCount.toLong() * 12) +
        stringKindCount.toLong() * 4) + identifierCount.toLong() * 4)
    private val overflowTable = align(stringTable + stringCount.toLong() * 4)
    private val stringStorage = align(overflowTable + overflowStringCount.toLong() * 8)

    init {
        if (magic != MAGIC) throw IllegalArgumentException("Not a Hermes bytecode file")
        if (version != VERSION) throw IllegalArgumentException("Expected HBC$VERSION, got HBC$version")
        if (fileLength.toLong() != buf.limit().toLong()) throw IllegalArgumentException("HBC length field doesn't match the file")
        if (stringStorage + stringStorageSize > buf.limit()) throw IllegalArgumentException("HBC string storage out of range")
    }

    /** Where a function's 12-byte small header lives. */
    fun smallHeaderOffset(index: Int): Long {
        require(index in 0 until functionCount) { "Function $index out of range" }
        return functionHeaders + index.toLong() * 12
    }

    fun function(index: Int): FunctionHeader {
        val small = smallHeaderOffset(index).toInt()
        val w1 = buf.getInt(small)
        val w2 = buf.getInt(small + 4)
        val flags = buf.get(small + 11).toInt() and 0xff
        if (flags and FLAG_OVERFLOWED == 0) {
            return FunctionHeader(
                index = index, largeHeaderOffset = -1,
                bodyOffset = (w1 and 0x1ffffff).toLong(), bodySize = w2 and 0x3fff,
                frameSize = buf.get(small + 8).toInt() and 0xff,
                readCacheSize = buf.get(small + 9).toInt() and 0xff,
                writeCacheSize = buf.get(small + 10).toInt() and 0x3f,
                flags = flags,
            )
        }
        // An overflowed small header keeps the large header's offset: low 24 bits in Offset, high 8 in FunctionName.
        val large = (((w2 ushr 14) and 0xff).toLong() shl 24) or (w1 and 0xffffff).toLong()
        val l = large.toInt()
        return FunctionHeader(
            index = index, largeHeaderOffset = large,
            bodyOffset = buf.getInt(l).toLong() and 0xffffffffL, bodySize = buf.getInt(l + 12),
            frameSize = buf.getInt(l + 28),
            readCacheSize = buf.get(l + 32).toInt() and 0xff,
            writeCacheSize = buf.get(l + 33).toInt() and 0xff,
            flags = buf.get(l + 36).toInt() and 0xff,
        )
    }

    /** The bytes of a function body. */
    fun body(function: FunctionHeader): ByteArray {
        val out = ByteArray(function.bodySize)
        buf.duplicate().position(function.bodyOffset.toInt()).get(out)
        return out
    }

    /** The 37 bytes of a function's large header, which the injector copies and edits. */
    fun largeHeader(function: FunctionHeader): ByteArray {
        val out = ByteArray(LARGE_HEADER_SIZE)
        if (function.overflowed) {
            buf.duplicate().position(function.largeHeaderOffset.toInt()).get(out)
        } else {
            val small = smallHeaderOffset(function.index).toInt()
            val w1 = buf.getInt(small)
            val w2 = buf.getInt(small + 4)
            ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN).apply {
                putInt(function.bodyOffset.toInt()).putInt((w1 ushr 25) and 31).putInt(w1 ushr 30)
                putInt(function.bodySize).putInt((w2 ushr 14) and 255)
                putInt((w2 ushr 22) and 31).putInt(w2 ushr 27).putInt(function.frameSize)
                put(function.readCacheSize.toByte()).put(function.writeCacheSize.toByte())
                put(((buf.get(small + 10).toInt() ushr 6) and 1).toByte())
                put(((buf.get(small + 10).toInt() ushr 7) and 1).toByte()).put(function.flags.toByte())
            }
        }
        return out
    }

    /**
     * The function's code plus everything up to the next verified object: the next body, the first function
     * info, debug info or the file end. Hermes appends SwitchImm jump tables after the code and excludes them
     * from bodySize, so copying bodySize alone drops them. The scan below only validates the tables; it never
     * widens the copy past a verified boundary.
     */
    fun bodyWithTables(function: FunctionHeader): ByteArray {
        val base = function.bodyOffset
        val codeEnd = base + function.bodySize
        var boundary = minOf(fileLength.toLong() - FOOTER_SIZE, buf.getInt(108).toLong())
        for (i in 0 until functionCount) {
            val other = function(i)
            if (other.bodyOffset > base) boundary = minOf(boundary, other.bodyOffset)
            if (other.largeHeaderOffset > base) boundary = minOf(boundary, other.largeHeaderOffset)
        }
        check(codeEnd <= boundary) { "Overlapping function layout" }
        val starts = HashSet<Int>()
        val targets = ArrayList<Long>()
        var pc = 0
        while (pc < function.bodySize) {
            starts.add(pc)
            val at = (base + pc).toInt()
            val opcode = buf.get(at).toInt() and 255
            val size = HbcInstructions.sizes.getOrNull(opcode) ?: error("Unknown HBC98 opcode $opcode")
            check(pc + size <= function.bodySize) { "Truncated instruction" }
            if (opcode == HbcInstructions.UINT_SWITCH || opcode == HbcInstructions.STRING_SWITCH) {
                val strings = opcode == HbcInstructions.STRING_SWITCH
                val table = align(base + pc + (buf.getInt(at + if (strings) 6 else 2).toLong() and 0xffffffffL))
                val count = if (strings) buf.getInt(at + 14).toLong() and 0xffffffffL
                    else (buf.getInt(at + 14).toLong() and 0xffffffffL) - (buf.getInt(at + 10).toLong() and 0xffffffffL) + 1
                val stride = if (strings) 8 else 4
                val end = table + count * stride
                check(count > 0 && table >= align(codeEnd) && end <= boundary) { "Switch table out of function bounds" }
                targets.add(pc.toLong() + buf.getInt(at + if (strings) 10 else 6))
                for (k in 0 until count.toInt()) {
                    val entry = (table + k.toLong() * stride).toInt()
                    if (strings) check(buf.getInt(entry) in 0 until stringCount) { "Switch string ID out of range" }
                    targets.add(pc.toLong() + buf.getInt(entry + if (strings) 4 else 0))
                }
            }
            pc += size
        }
        check(pc == function.bodySize) { "Instruction stream doesn't end at the function boundary" }
        check(targets.all { it in 0 until function.bodySize.toLong() && it.toInt() in starts }) { "Switch target is not an instruction" }
        val out = ByteArray((boundary - base).toInt())
        buf.duplicate().position(base.toInt()).get(out)
        return out
    }

    /** GetById requires an eagerly initialized identifier, not just a matching string literal. */
    fun isIdentifier(id: Int): Boolean {
        require(id in 0 until stringCount)
        var start = 0L
        val kinds = align(functionHeaders + functionCount.toLong() * 12)
        for (i in 0 until stringKindCount) {
            val entry = buf.getInt((kinds + i * 4).toInt())
            val end = start + (entry and Int.MAX_VALUE)
            if (id.toLong() in start until end) return entry < 0
            start = end
        }
        error("Incomplete string kind table")
    }

    /** A string's text, or null when it's stored as UTF-16 (never used for prelude pieces). */
    fun asciiString(id: Int): String? {
        val (utf16, offset, length) = stringEntry(id)
        if (utf16) return null
        val bytes = ByteArray(length)
        buf.duplicate().position((stringStorage + offset).toInt()).get(bytes)
        for (b in bytes) if (b < 0) return null
        return String(bytes, Charsets.US_ASCII)
    }

    /**
     * Calls [visit] with every ASCII string of 1..[maxLength] characters, without decoding the others.
     * The string storage is read once into [storage] so that the caller can compare bytes in place.
     */
    inline fun forEachShortAscii(maxLength: Int, visit: (id: Int, storage: ByteArray, start: Int, length: Int) -> Unit) {
        val storage = storageBytes()
        for (id in 0 until stringCount) {
            val entry = rawEntry(id)
            val length = entry ushr 24
            if (entry and 1 != 0 || length == 0 || length == 0xff || length > maxLength) continue
            val start = (entry ushr 1) and 0x7fffff
            if (start + length > storage.size) continue
            var ascii = true
            for (k in start until start + length) if (storage[k] < 0) { ascii = false; break }
            if (ascii) visit(id, storage, start, length)
        }
    }

    @PublishedApi internal fun rawEntry(id: Int): Int = buf.getInt((stringTable + id.toLong() * 4).toInt())

    @PublishedApi internal fun storageBytes(): ByteArray {
        val out = ByteArray(stringStorageSize)
        buf.duplicate().position(stringStorage.toInt()).get(out)
        return out
    }

    private fun stringEntry(id: Int): Triple<Boolean, Int, Int> {
        require(id in 0 until stringCount) { "String $id out of range" }
        val entry = rawEntry(id)
        val utf16 = entry and 1 != 0
        var offset = (entry ushr 1) and 0x7fffff
        var length = entry ushr 24
        if (length == 0xff) {
            val overflow = (overflowTable + offset.toLong() * 8).toInt()
            offset = buf.getInt(overflow)
            length = buf.getInt(overflow + 4)
        }
        return Triple(utf16, offset, if (utf16) length * 2 else length)
    }

    /** True when the trailing SHA-1 matches the rest of the file. */
    fun footerValid(): Boolean {
        val digest = MessageDigest.getInstance("SHA-1")
        val body = buf.duplicate().position(0).limit(buf.limit() - FOOTER_SIZE)
        digest.update(body)
        val footer = ByteArray(FOOTER_SIZE)
        buf.duplicate().position(buf.limit() - FOOTER_SIZE).get(footer)
        return digest.digest().contentEquals(footer)
    }

    data class FunctionHeader(
        val index: Int,
        /** -1 when the function only has a small header. */
        val largeHeaderOffset: Long,
        val bodyOffset: Long,
        val bodySize: Int,
        val frameSize: Int,
        val readCacheSize: Int,
        val writeCacheSize: Int,
        val flags: Int,
    ) {
        val overflowed get() = largeHeaderOffset >= 0
    }

    companion object {
        const val MAGIC = 0x1F1903C103BC1FC6L
        const val VERSION = 98
        const val HEADER_SIZE = 128L
        const val FOOTER_SIZE = 20
        /** `sizeof(hbc::FunctionHeader)`: eight u32 fields, four u8 cache sizes and the flags byte, packed. */
        const val LARGE_HEADER_SIZE = 37

        // FunctionHeaderFlag bits: ProhibitInvoke(2) StrictMode HasExceptionHandler HasDebugInfo Overflowed Kind(2).
        const val FLAG_HAS_EXCEPTION_HANDLER = 0x08
        const val FLAG_HAS_DEBUG_INFO = 0x10
        const val FLAG_OVERFLOWED = 0x20

        /** A cache size of 255 means "property caching disabled", so it can't be grown past 254. */
        const val CACHE_DISABLED = 255

        fun align(value: Long) = (value + 3) and 3L.inv()
    }
}
