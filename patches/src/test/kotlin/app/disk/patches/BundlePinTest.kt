package app.disk.patches

import app.disk.patches.dex.BundlePin
import app.morphe.patcher.patch.PatchException
import com.android.tools.smali.dexlib2.DexFileFactory
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.Opcodes
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction21t
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction35c
import com.android.tools.smali.dexlib2.iface.ClassDef
import com.android.tools.smali.dexlib2.iface.Method
import com.android.tools.smali.dexlib2.iface.MethodImplementation
import com.android.tools.smali.dexlib2.iface.instruction.SwitchPayload
import com.android.tools.smali.dexlib2.iface.instruction.formats.Instruction35c
import com.android.tools.smali.dexlib2.immutable.ImmutableClassDef
import com.android.tools.smali.dexlib2.immutable.ImmutableDexFile
import com.android.tools.smali.dexlib2.immutable.ImmutableMethod
import com.android.tools.smali.dexlib2.immutable.ImmutableMethodImplementation
import com.android.tools.smali.dexlib2.immutable.instruction.ImmutablePackedSwitchPayload
import com.android.tools.smali.dexlib2.immutable.instruction.ImmutableSwitchElement
import com.android.tools.smali.dexlib2.writer.pool.DexPool
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipFile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * Discord 352.17 layout checks for [bundlePin] and [BundlePin]. The DEX files come from `work/352.17/`;
 * the tests are skipped with an explicit reason when the APK is not extracted locally (it is never committed).
 */
class BundlePinTest {
    private val root = File(System.getProperty("disk.root") ?: ".")

    @Test
    fun `the runtime patch depends on the bundle pin`() {
        assertTrue(bundlePin.default)
        assertTrue(diskRuntime.dependencies.contains(bundlePin))
        assertEquals("com.discord", bundlePin.compatibility!!.single().packageName)
    }

    @Test
    fun `guards accept the packaged Discord layout`() = withDiscordDex { dex ->
        BundlePin.verify(dex::classOf)
        val method = dex.method(BundlePin.TARGET_CLASS, "i", "Lw6/v;")
        assertEquals(7, method.implementation!!.registerCount)
        assertEquals(BundlePin.State.ORIGINAL, BundlePin.classify(method))
        val callers = listOf(
            dex.method("Ld6/a;", "invoke", "Ljava/lang/Object;"),
            dex.method("Ldl/o;", "a", "V"),
            dex.method("Lu5/b;", "call", "Ljava/lang/Object;"),
            dex.method("Lw6/z;", "j", "Ljava/lang/String;"),
            dex.method(MANIFEST_OWNER, "getManifestInfo", "V", listOf("Lcom/facebook/react/bridge/Promise;")),
        )
        for (caller in callers) println("${caller.definingClass}->${caller.name}: ${BundlePin.semanticDigest(caller)}")
    }

    @Test
    fun `rewrite replaces the whole body with a null return`() = withDiscordDex { dex ->
        val method = mutableMethod(dex)
        BundlePin.rewrite(method)
        assertEquals(listOf("const/4 v0 #0", "return-object v0"), BundlePin.signatures(method.implementation!!))
        assertEquals(7, method.implementation!!.registerCount)
        assertEquals(BundlePin.State.PINNED, BundlePin.classify(method))
    }

    @Test
    fun `rewriting twice keeps the pinned body`() = withDiscordDex { dex ->
        val method = mutableMethod(dex)
        BundlePin.rewrite(method)
        val once = BundlePin.signatures(method.implementation!!)
        BundlePin.rewrite(method)
        assertEquals(once, BundlePin.signatures(method.implementation!!))
        assertEquals(2, method.implementation!!.instructions.count())
    }

    @Test
    fun `the pinned body round-trips through a dex`() = withDiscordDex { dex ->
        val method = mutableMethod(dex)
        val original = method.implementation!!
        assertEquals(0, original.debugItems.minOf { it.codeAddress })
        assertEquals(62, original.debugItems.maxOf { it.codeAddress })
        assertEquals(63, original.instructions.sumOf { it.codeUnits })
        println("i original: debug min=0 max=62 codeEnd=63")
        BundlePin.rewrite(method)
        assertCleanDebug(method.implementation!!, "rewritten")
        val file = Files.createTempFile("disk-pin-", ".dex").toFile().apply { deleteOnExit() }
        val classes = listOf("Ld6/a;", "Ldl/o;", "Lu5/b;", MANIFEST_OWNER)
            .map { ImmutableClassDef.of(dex.classOf(it)!!) } + rewrittenClass(dex, method)
        DexPool.writeTo(file.path, ImmutableDexFile(Opcodes.getDefault(), classes))
        val reloaded = DexFileFactory.loadDexFile(file, Opcodes.getDefault())
        val owner = reloaded.classes.first { it.type == BundlePin.TARGET_CLASS }
        val pinned = owner.methods.first { it.name == "i" && it.returnType == "Lw6/v;" }
        assertEquals(listOf("const/4 v0 #0", "return-object v0"), BundlePin.signatures(pinned.implementation!!))
        assertEquals(7, pinned.implementation!!.registerCount)
        assertEquals(BundlePin.State.PINNED, BundlePin.classify(pinned))
        assertCleanDebug(pinned.implementation!!, "DexPool reloaded")
        BundlePin.verify { type -> reloaded.classes.firstOrNull { it.type == type } }
    }

    @Test
    fun `rewrite also clears debug metadata at the end sentinel`() = withDiscordDex { dex ->
        val method = mutableMethod(dex)
        val implementation = method.implementation!!
        implementation.newLabelForIndex(implementation.instructions.count()).location.addLineNumber(123)
        BundlePin.rewrite(method)
        assertCleanDebug(implementation, "rewritten with end sentinel")
    }

    @Test
    fun `a changed lookup body is rejected without touching it`() = withDiscordDex { dex ->
        val method = mutableMethod(dex)
        with(InstructionExtensions) {
            method.replaceInstruction(method.implementation!!.instructions.count() - 1, "return-void")
        }
        val before = BundlePin.signatures(method.implementation!!)
        val error = assertFailsWith<PatchException> {
            BundlePin.verify(dex.forMethod(BundlePin.TARGET_CLASS, method))
        }
        assertTrue(error.message!!.contains("does not match Discord"), error.message)
        assertEquals(before, BundlePin.signatures(method.implementation!!))
    }

    @Test
    fun `a different frame size is rejected`() = withDiscordDex { dex ->
        val method = dex.method(BundlePin.TARGET_CLASS, "i", "Lw6/v;")
        val resized = object : Method by method {
            override fun getImplementation(): MethodImplementation =
                object : MethodImplementation by method.implementation!! {
                    override fun getRegisterCount() = 8
                }
        }
        val error = assertFailsWith<PatchException> { BundlePin.verify(dex.forMethod(BundlePin.TARGET_CLASS, resized)) }
        assertTrue(error.message!!.contains("uses 8 registers, expected 7"), error.message)
    }

    @Test
    fun `a missing bundle selection caller stops the patch`() = withDiscordDex { dex ->
        val error = assertFailsWith<PatchException> {
            BundlePin.verify { type -> if (type == "Ld6/a;") null else dex.classOf(type) }
        }
        assertTrue(error.message!!.contains("cannot confirm the bundle loader choice"), error.message)
    }

    @Test
    fun `a changed loader fallback stops the patch`() = withDiscordDex { dex ->
        val owner = dex.classOf("Ld6/a;")!!
        val method = mutableMethod(dex, "Ld6/a;", "invoke", "Ljava/lang/Object;")
        val call = BundlePin.signatures(method.implementation!!)
            .indexOfFirst { it.endsWith(" ${BundlePin.TARGET_CLASS}->i()Lw6/v;") }
        assertTrue(call >= 0)
        with(InstructionExtensions) { method.replaceInstruction(call + 1, "nop") }
        val wrapper = object : ClassDef by owner {
            override fun getMethods() = owner.methods.map { if (it.name == "invoke") method else it }
        }
        val error = assertFailsWith<PatchException> {
            BundlePin.verify { type -> if (type == "Ld6/a;") wrapper else dex.classOf(type) }
        }
        assertTrue(error.message!!.contains("caller snapshot"), error.message)
    }

    @Test
    fun `changing only invoke active register count is rejected without writes`() = withDiscordDex { dex ->
        val method = mutableMethod(dex)
        val implementation = method.implementation!!
        val index = implementation.instructions.indexOfFirst { it is Instruction35c }
        val original = implementation.instructions[index] as Instruction35c
        val changed = BuilderInstruction35c(
            original.opcode, original.registerCount + 1, original.registerC, original.registerD,
            original.registerE, original.registerF, original.registerG, original.reference,
        )
        // Same opcode, all five encoded register slots and reference: ONLY the active count changes.
        val before = BundlePin.signatures(implementation)
        implementation.replaceInstruction(index, changed)
        val after = BundlePin.signatures(implementation)
        assertEquals(before[index].replace("count=3", "count=4"), after[index])
        assertEquals(before.filterIndexed { i, _ -> i != index }, after.filterIndexed { i, _ -> i != index })
        assertRejectedWithoutWrites(dex, method)
    }

    @Test
    fun `Ld6 a invoke mutations before and after the old window are rejected`() = withDiscordDex { dex ->
        assertMutationRejected(dex, "Ld6/a;", "invoke", "Ljava/lang/Object;", 2, "const/4 v1, 1")
        // The delegate consumes the chosen loader after the old window ended at pc 233.
        assertMutationRejected(dex, "Ld6/a;", "invoke", "Ljava/lang/Object;", 243, "const-string v5, \"wrong.bundle\"")
    }

    @Test
    fun `Ldl o a mutations before and after the old window are rejected`() = withDiscordDex { dex ->
        assertMutationRejected(dex, "Ldl/o;", "a", "V", 18, "iput-object v1, v0, Ldl/n;->b:Ljava/lang/String;")
        // Accepted review reproducer: same opcode/registers/type, b changes to d at pc 246.
        assertMutationRejected(dex, "Ldl/o;", "a", "V", 246, "iget-object v5, v0, Ldl/n;->d:Ljava/lang/String;")
    }

    @Test
    fun `Lu5 b call null release fallback is guarded`() = withDiscordDex { dex ->
        assertNullBranchRejected(dex, "Lu5/b;", "call", "Ljava/lang/Object;", 24)
    }

    @Test
    fun `Lw6 z j null forwarding is guarded`() = withDiscordDex { dex ->
        assertNullBranchRejected(dex, "Lw6/z;", "j", "Ljava/lang/String;", 5)
        assertMutationRejected(dex, "Lw6/z;", "j", "Ljava/lang/String;", 222, "return-object v0")
    }

    @Test
    fun `getManifestInfo packaged manifest null path is guarded`() = withDiscordDex { dex ->
        val parameters = listOf("Lcom/facebook/react/bridge/Promise;")
        assertNullBranchRejected(dex, MANIFEST_OWNER, "getManifestInfo", "V", 16, parameters)
        assertMutationRejected(dex, MANIFEST_OWNER, "getManifestInfo", "V", 61,
            "iget-object v0, v0, Lw6/z;->a:Landroid/content/SharedPreferences;", parameters)
    }

    @Test
    fun `caller frame access and try structures are guarded`() = withDiscordDex { dex ->
        val method = dex.method("Ldl/o;", "a", "V")
        val implementation = method.implementation!!
        val access = object : Method by method { override fun getAccessFlags() = method.accessFlags xor 0x10 }
        val frame = object : Method by method {
            override fun getImplementation(): MethodImplementation = object : MethodImplementation by implementation {
                override fun getRegisterCount() = implementation.registerCount + 1
            }
        }
        val handlers = object : Method by method {
            override fun getImplementation() = ImmutableMethodImplementation(
                implementation.registerCount, implementation.instructions, emptyList(), implementation.debugItems,
            )
        }
        for (changed in listOf(access, frame, handlers)) assertRejectedWithoutWrites(dex, changed)
    }

    @Test
    fun `Ld6 a invoke switch payload targets are guarded`() = withDiscordDex { dex ->
        val method = dex.method("Ld6/a;", "invoke", "Ljava/lang/Object;")
        val implementation = method.implementation!!
        val instructions = implementation.instructions.map { instruction ->
            if (instruction !is SwitchPayload) instruction else ImmutablePackedSwitchPayload(
                instruction.switchElements.mapIndexed { index, element ->
                    ImmutableSwitchElement(element.key, element.offset + if (index == 0) 1 else 0)
                },
            )
        }
        val changed = object : Method by method {
            override fun getImplementation() = ImmutableMethodImplementation(
                implementation.registerCount, instructions, implementation.tryBlocks, implementation.debugItems,
            )
        }
        assertRejectedWithoutWrites(dex, changed)
    }

    /** The shortened body must have neither source positions nor local-variable events from the old code. */
    private fun assertCleanDebug(implementation: MethodImplementation, stage: String) {
        val end = implementation.instructions.sumOf { it.codeUnits }
        val addresses = implementation.debugItems.map { it.codeAddress }
        println("i $stage: debug min=${addresses.minOrNull()} max=${addresses.maxOrNull()} codeEnd=$end count=${addresses.size}")
        assertEquals(2, end)
        assertTrue(addresses.all { it in 0 until end }, "$stage has an out-of-code debug address")
        assertTrue(addresses.isEmpty(), "$stage retains stale debug metadata")
    }

    private fun assertMutationRejected(
        dex: DiscordDex, owner: String, name: String, returnType: String, pc: Int, replacement: String,
        parameters: List<String> = emptyList(),
    ) {
        val method = app.morphe.patcher.util.proxy.mutableTypes.MutableMethod(dex.method(owner, name, returnType, parameters))
        val index = instructionIndexAt(method, pc)
        with(InstructionExtensions) { method.replaceInstruction(index, replacement) }
        assertRejectedWithoutWrites(dex, method)
    }

    private fun assertNullBranchRejected(
        dex: DiscordDex, owner: String, name: String, returnType: String, pc: Int,
        parameters: List<String> = emptyList(),
    ) {
        val method = app.morphe.patcher.util.proxy.mutableTypes.MutableMethod(dex.method(owner, name, returnType, parameters))
        val index = instructionIndexAt(method, pc)
        val implementation = method.implementation!!
        val old = implementation.instructions[index] as BuilderInstruction21t
        assertEquals(Opcode.IF_EQZ, old.opcode)
        implementation.replaceInstruction(index, BuilderInstruction21t(Opcode.IF_NEZ, old.registerA, old.target))
        assertRejectedWithoutWrites(dex, method)
    }

    private fun instructionIndexAt(method: Method, pc: Int): Int {
        var address = 0
        val index = method.implementation!!.instructions.indexOfFirst { instruction ->
            val matches = address == pc
            address += instruction.codeUnits
            matches
        }
        assertTrue(index >= 0, "${method.definingClass}->${method.name} has no instruction at $pc")
        return index
    }

    private fun assertRejectedWithoutWrites(dex: DiscordDex, method: Method) {
        val lookup = dex.method(BundlePin.TARGET_CLASS, "i", "Lw6/v;")
        val beforeLookup = BundlePin.semanticSnapshot(lookup)
        val before = BundlePin.semanticSnapshot(method)
        assertFailsWith<PatchException> { BundlePin.verify(dex.forMethod(method.definingClass, method)) }
        assertEquals(before, BundlePin.semanticSnapshot(method))
        assertEquals(beforeLookup, BundlePin.semanticSnapshot(lookup))
        assertEquals(BundlePin.State.ORIGINAL, BundlePin.classify(lookup))
    }

    @Test
    fun `an unknown build is rejected before any rewrite`() = withDiscordDex { dex ->
        val error = assertFailsWith<PatchException> {
            BundlePin.verify { type -> if (type == BundlePin.TARGET_CLASS) null else dex.classOf(type) }
        }
        assertTrue(error.message!!.contains("is missing"), error.message)
    }

    /** The real class with [method]'s rewritten body, in the immutable form the patcher writes out. */
    private fun rewrittenClass(dex: DiscordDex, method: Method): ClassDef {
        val owner = dex.classOf(BundlePin.TARGET_CLASS)!!
        val replacement = ImmutableMethod.of(method)
        fun isDirect(candidate: Method) = candidate.accessFlags and DIRECT_METHOD_FLAGS != 0
        fun isTarget(candidate: Method) = candidate.name == method.name &&
            candidate.returnType == method.returnType && candidate.parameterTypes == method.parameterTypes
        val directMethods = owner.methods.filter { isDirect(it) }
            .map { if (isTarget(it)) replacement else ImmutableMethod.of(it) }
        val virtualMethods = owner.methods.filterNot { isDirect(it) }
            .map { if (isTarget(it)) replacement else ImmutableMethod.of(it) }
        return ImmutableClassDef(
            owner.type, owner.accessFlags, owner.superclass, owner.interfaces, owner.sourceFile,
            owner.annotations, owner.staticFields, owner.instanceFields, directMethods, virtualMethods,
        )
    }

    private fun mutableMethod(
        dex: DiscordDex,
        owner: String = BundlePin.TARGET_CLASS,
        name: String = "i",
        returnType: String = "Lw6/v;",
    ) = app.morphe.patcher.util.proxy.mutableTypes.MutableMethod(dex.method(owner, name, returnType))

    /** Reads `work/352.17/dex/classes*.dex`, or the same entries out of the original APK, without writing either. */
    private fun withDiscordDex(block: (DiscordDex) -> Unit) {
        val dexFiles = workDexFiles()
        assumeTrue(
            dexFiles.isNotEmpty(),
            "Discord 352.17 dex is not available; expected work/352.17/dex/classes*.dex or work/352.17/apks/base.apk",
        )
        block(DiscordDex(dexFiles))
    }

    private fun workDexFiles(): List<File> {
        val extracted = File(root, "work/352.17/dex")
            .listFiles { file -> file.name.matches(CLASSES_DEX) }
            .orEmpty()
        if (extracted.isNotEmpty()) return extracted.sortedBy { it.name }
        val apk = File(root, "work/352.17/apks/base.apk")
        if (!apk.isFile) return emptyList()
        val directory = Files.createTempDirectory("disk-dex-").toFile().apply { deleteOnExit() }
        return ZipFile(apk).use { zip ->
            zip.entries().asSequence()
                .filter { it.name.matches(CLASSES_DEX) }
                .map { entry ->
                    File(directory, entry.name).also { out ->
                        zip.getInputStream(entry).use { input -> out.outputStream().use(input::copyTo) }
                    }
                }
                .sortedBy { it.name }
                .toList()
        }
    }

    private companion object {
        const val MANIFEST_OWNER = "Lcom/discord/bundle_updater/BundleUpdaterManager;"
        val CLASSES_DEX = Regex("classes\\d*\\.dex")
        /** ACC_STATIC, ACC_PRIVATE and ACC_CONSTRUCTOR; dexlib2 puts these in the direct method list. */
        const val DIRECT_METHOD_FLAGS = 0x2 or 0x8 or 0x10000
    }
}

/** The patcher's instruction helpers are member functions of this object, not extension functions. */
private val InstructionExtensions = app.morphe.patcher.extensions.InstructionExtensions

/** Class/method lookup across the dex files of one Discord build. */
private class DiscordDex(files: List<File>) {
    private val dexFiles = files.map { DexFileFactory.loadDexFile(it, Opcodes.getDefault()) }

    fun classOf(type: String): ClassDef? = dexFiles.firstNotNullOfOrNull { dex -> dex.classes.firstOrNull { it.type == type } }

    fun method(owner: String, name: String, returnType: String, parameters: List<String> = emptyList()): Method {
        val clazz = classOf(owner) ?: error("$owner is missing")
        return clazz.methods.first { it.name == name && it.parameterTypes.map(CharSequence::toString) == parameters && it.returnType == returnType }
    }

    /** The real classes, with [owner] serving [method] instead of its own method of the same name. */
    fun forMethod(owner: String, method: Method): (String) -> ClassDef? = { type ->
        val clazz = classOf(type)
        if (type != owner || clazz == null) clazz
        else object : ClassDef by clazz {
            override fun getMethods() = clazz.methods.map { if (it.name == method.name && it.returnType == method.returnType && it.parameterTypes == method.parameterTypes) method else it }
        }
    }
}
