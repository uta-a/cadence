package app.cadence.patches

import app.cadence.patches.dex.AdvertisingId
import app.cadence.patches.dex.BundlePin
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.util.proxy.mutableTypes.MutableMethod
import com.android.tools.smali.dexlib2.DexFileFactory
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.Opcodes
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction11n
import com.android.tools.smali.dexlib2.iface.ClassDef
import com.android.tools.smali.dexlib2.iface.Method
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

/** Discord 352.17 layout checks for [disableAdvertisingId]. Skipped with a reason when the DEX is not extracted. */
class AdvertisingIdTest {
    private val root = File(System.getProperty("cadence.root") ?: ".")
    private val disabled = listOf(
        "invoke-direct count=2 {v4, v5, v0, v0, v0} Lcom/discord/ads/AdsModule;->resolveWithNullId(Lcom/facebook/react/bridge/Promise;)V",
        "return-void",
    )

    @Test
    fun `the patch is a default, Discord-only bytecode patch`() {
        assertTrue(disableAdvertisingId.default)
        assertEquals("com.discord", disableAdvertisingId.compatibility!!.single().packageName)
    }

    @Test
    fun `guards accept the packaged Discord layout`() = withDex { dex ->
        AdvertisingId.verify(dex::classOf)
        assertEquals(AdvertisingId.State.ORIGINAL, AdvertisingId.classify(dex.entry()))
    }

    @Test
    fun `rewrite calls the existing null fallback and keeps the frame`() = withDex { dex ->
        val method = MutableMethod(dex.entry())
        AdvertisingId.rewrite(method)
        assertEquals(disabled, BundlePin.signatures(method.implementation!!))
        assertEquals(6, method.implementation!!.registerCount)
        assertEquals(AdvertisingId.State.DISABLED, AdvertisingId.classify(method))
        AdvertisingId.rewrite(method)
        assertEquals(disabled, BundlePin.signatures(method.implementation!!))
    }

    @Test
    fun `the rewritten class round-trips through a dex and passes the guard again`() = withDex { dex ->
        val method = MutableMethod(dex.entry())
        AdvertisingId.rewrite(method)
        val owner = dex.classOf(AdvertisingId.TARGET_CLASS)!!
        val rewritten = ImmutableClassDef(
            owner.type, owner.accessFlags, owner.superclass, owner.interfaces, owner.sourceFile, owner.annotations,
            owner.staticFields, owner.instanceFields,
            owner.directMethods.map(ImmutableMethod::of),
            owner.virtualMethods.map { if (it.name == method.name && it.parameterTypes == method.parameterTypes) ImmutableMethod.of(method) else ImmutableMethod.of(it) },
        )
        val file = Files.createTempFile("cadence-adid-", ".dex").toFile().apply { deleteOnExit() }
        val spec = ImmutableClassDef.of(dex.classOf("Lcom/discord/codegen/NativeAdsModuleSpec;")!!)
        DexPool.writeTo(file.path, ImmutableDexFile(Opcodes.getDefault(), listOf(spec, rewritten)))
        val reloaded = DexFileFactory.loadDexFile(file, Opcodes.getDefault())
        val classOf = { type: String -> reloaded.classes.firstOrNull { it.type == type } }
        AdvertisingId.verify(classOf)
        val entry = classOf(AdvertisingId.TARGET_CLASS)!!.methods.first { it.name == "getGoogleAdvertisingId" }
        assertEquals(disabled, BundlePin.signatures(entry.implementation!!))
        assertTrue(entry.implementation!!.debugItems.none())
    }

    @Test
    fun `a changed entry point or fallback is rejected before any write`() = withDex { dex ->
        val entry = MutableMethod(dex.entry())
        entry.implementation!!.replaceInstruction(11, BuilderInstruction11n(Opcode.CONST_4, 3, 1))
        assertFailsWith<PatchException> { AdvertisingId.classify(entry) }
        assertFailsWith<PatchException> { AdvertisingId.rewrite(entry) }

        val fallback = MutableMethod(dex.method("resolveWithNullId"))
        fallback.implementation!!.replaceInstruction(2, BuilderInstruction11n(Opcode.CONST_4, 2, 1))
        val owner = dex.classOf(AdvertisingId.TARGET_CLASS)!!
        val patched = object : ClassDef by owner {
            override fun getMethods() = owner.methods.map { if (it.name == "resolveWithNullId") fallback else it }
        }
        assertFailsWith<PatchException> { AdvertisingId.verify { if (it == AdvertisingId.TARGET_CLASS) patched else dex.classOf(it) } }
    }

    private fun withDex(block: (Dex) -> Unit) {
        val files = File(root, "work/352.17/dex").listFiles { file -> file.name.matches(Regex("classes\\d*\\.dex")) }.orEmpty()
        assumeTrue(files.isNotEmpty(), "Discord 352.17 dex is not available; expected work/352.17/dex/classes*.dex")
        block(Dex(files.sortedBy { it.name }))
    }

    private class Dex(files: List<File>) {
        private val dexFiles = files.map { DexFileFactory.loadDexFile(it, Opcodes.getDefault()) }
        fun classOf(type: String): ClassDef? = dexFiles.firstNotNullOfOrNull { dex -> dex.classes.firstOrNull { it.type == type } }
        fun method(name: String): Method = classOf(AdvertisingId.TARGET_CLASS)!!.methods.first {
            it.name == name && it.parameterTypes.map(CharSequence::toString) == listOf("Lcom/facebook/react/bridge/Promise;")
        }
        fun entry() = method("getGoogleAdvertisingId")
    }
}
