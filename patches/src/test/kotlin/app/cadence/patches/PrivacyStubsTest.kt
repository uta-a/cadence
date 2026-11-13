package app.cadence.patches

import app.cadence.patches.dex.BundlePin
import app.cadence.patches.dex.MethodStub
import app.cadence.patches.dex.PrivacyStubs
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.util.proxy.mutableTypes.MutableMethod
import com.android.tools.smali.dexlib2.DexFileFactory
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.Opcodes
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction10x
import com.android.tools.smali.dexlib2.iface.ClassDef
import com.android.tools.smali.dexlib2.immutable.ImmutableClassDef
import com.android.tools.smali.dexlib2.immutable.ImmutableDexFile
import com.android.tools.smali.dexlib2.immutable.ImmutableMethod
import com.android.tools.smali.dexlib2.writer.pool.DexPool
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue

/** Discord 352.17 checks for the Sentry, AppsFlyer and telemetry stubs. Skipped with a reason when the DEX is not extracted. */
class PrivacyStubsTest {
    private val root = File(System.getProperty("cadence.root") ?: ".")
    private val all = PrivacyStubs.sentry + PrivacyStubs.appsFlyer + PrivacyStubs.telemetry

    @Test
    fun `patches are default and Discord-only`() {
        for (patch in listOf(disableSentry, disableAppsFlyer, disableTelemetry)) {
            assertTrue(patch.default)
            assertEquals("com.discord", patch.compatibility!!.single().packageName)
        }
    }

    @Test
    fun `every target matches the measured Discord method`() = withDex { classOf ->
        for (target in all) println("${target.type}->${target.name}${target.parameters}: ${BundlePin.semanticDigest(target.find(classOf))}")
        for (target in all) assertEquals(MethodStub.State.ORIGINAL, target.classify(target.find(classOf)))
    }

    @Test
    fun `stub returns first, keeps the original body and is idempotent`() = withDex { classOf ->
        for (target in all) {
            assertEquals(MethodStub.State.ORIGINAL, target.verify(classOf))
            val method = MutableMethod(target.find(classOf))
            val before = method.implementation!!.instructions.count()
            assertTrue(target.stub(method))
            val implementation = method.implementation!!
            assertEquals(Opcode.RETURN_VOID, implementation.instructions.first().opcode)
            assertEquals(before + 1, implementation.instructions.count())
            assertEquals(MethodStub.State.STUBBED, target.classify(method))
            assertEquals(false, target.stub(method))
            assertEquals(before + 1, implementation.instructions.count())
        }
    }

    @Test
    fun `stubbed classes round-trip through a dex and still classify as stubbed`() = withDex { classOf ->
        for (target in all) {
            val method = MutableMethod(target.find(classOf))
            target.stub(method)
            val owner = classOf(target.type)!!
            fun replace(list: Iterable<com.android.tools.smali.dexlib2.iface.Method>) = list.map {
                if (it.name == method.name && it.parameterTypes == method.parameterTypes && it.returnType == method.returnType)
                    ImmutableMethod.of(method) else ImmutableMethod.of(it)
            }
            val rewritten = ImmutableClassDef(owner.type, owner.accessFlags, owner.superclass, owner.interfaces, owner.sourceFile,
                owner.annotations, owner.staticFields, owner.instanceFields, replace(owner.directMethods), replace(owner.virtualMethods))
            val file = Files.createTempFile("cadence-stub-", ".dex").toFile().apply { deleteOnExit() }
            DexPool.writeTo(file.path, ImmutableDexFile(Opcodes.getDefault(), listOf(rewritten)))
            val reloaded = DexFileFactory.loadDexFile(file, Opcodes.getDefault())
            val again = target.find { type -> reloaded.classes.firstOrNull { it.type == type } }
            assertEquals(Opcode.RETURN_VOID, again.implementation!!.instructions.first().opcode)
            assertEquals(MethodStub.State.STUBBED, target.classify(again))
        }
    }

    @Test
    fun `a changed method or modifier is rejected`() = withDex { classOf ->
        val target = PrivacyStubs.sentry.single()
        val original = target.find(classOf)
        val changed = MutableMethod(original)
        changed.implementation!!.addInstruction(changed.implementation!!.instructions.count() - 1, BuilderInstruction10x(Opcode.NOP))
        // Write the changed method into a dex so the guard reads it the way the patcher's immutable view does.
        val owner = classOf(target.type)!!
        fun replace(list: Iterable<com.android.tools.smali.dexlib2.iface.Method>) = list.map {
            if (it.name == original.name && it.parameterTypes == original.parameterTypes) ImmutableMethod.of(changed) else ImmutableMethod.of(it)
        }
        val file = Files.createTempFile("cadence-stub-bad-", ".dex").toFile().apply { deleteOnExit() }
        DexPool.writeTo(file.path, ImmutableDexFile(Opcodes.getDefault(), listOf(ImmutableClassDef(owner.type, owner.accessFlags,
            owner.superclass, owner.interfaces, owner.sourceFile, owner.annotations, owner.staticFields, owner.instanceFields,
            replace(owner.directMethods), replace(owner.virtualMethods)))))
        val reloaded = DexFileFactory.loadDexFile(file, Opcodes.getDefault())
        assertFailsWith<PatchException> { target.verify { type -> reloaded.classes.firstOrNull { it.type == type } } }
        val wrongFlags = target.copy(accessFlags = 0x1)
        assertFailsWith<PatchException> { wrongFlags.classify(target.find(classOf)) }
        assertFailsWith<PatchException> { target.copy(name = "missing").find(classOf) }
    }

    @Test
    fun `no target is entered by a branch or try block at its first instruction`() = withDex { classOf ->
        for (target in all) {
            val method = target.find(classOf)
            assertEquals(false, target.entryIsTargeted(method), "${target.type}->${target.name}")
            assertEquals(target.instructions, method.implementation!!.instructions.count())
        }
    }

    @Test
    fun `a body that only starts with return-void but has another length is not treated as stubbed`() = withDex { classOf ->
        val target = PrivacyStubs.appsFlyer[1]
        val method = MutableMethod(target.find(classOf))
        method.implementation!!.addInstruction(0, BuilderInstruction10x(Opcode.RETURN_VOID))
        method.implementation!!.addInstruction(1, BuilderInstruction10x(Opcode.NOP))
        assertFailsWith<PatchException> { target.classify(method) }
    }

    @Test
    fun `the stubs do not touch methods pinned by the bundle pin`() {
        val pinned = setOf("Ld6/a;", "Ldl/o;", "Lu5/b;", "Lw6/z;", "Lcom/discord/bundle_updater/BundleUpdaterManager;")
        assertTrue(all.none { it.type in pinned })
    }

    @Test
    fun `telemetry stubs leave Promise-returning and snapshot methods alone`() {
        val names = PrivacyStubs.telemetry.map { it.name }.toSet()
        assertTrue(PrivacyStubs.telemetry.none { it.parameters.any { p -> p.endsWith("/Promise;") } })
        assertTrue("snapshot" !in names && "requestReport" !in names && "getPendingReports" !in names)
        // Native onResume enables jank tracking on its own, so a JS-side stub would only claim coverage it lacks.
        assertTrue(PrivacyStubs.telemetry.none { it.type.startsWith("Lcom/discord/jank_stats/") })
        assertEquals(PrivacyStubs.telemetry.size, PrivacyStubs.telemetry.map { it.type to it.name }.toSet().size)
    }

    private fun withDex(block: ((String) -> ClassDef?) -> Unit) {
        val files = File(root, "work/352.17/dex").listFiles { file -> file.name.matches(Regex("classes\\d*\\.dex")) }.orEmpty()
        assumeTrue(files.isNotEmpty(), "Discord 352.17 dex is not available; expected work/352.17/dex/classes*.dex")
        val dexFiles = files.sortedBy { it.name }.map { DexFileFactory.loadDexFile(it, Opcodes.getDefault()) }
        block { type -> dexFiles.firstNotNullOfOrNull { dex -> dex.classes.firstOrNull { it.type == type } } }
    }
}
