package app.disk.patches

import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.Opcodes
import com.android.tools.smali.dexlib2.dexbacked.DexBackedDexFile
import com.android.tools.smali.dexlib2.iface.ClassDef
import com.android.tools.smali.dexlib2.iface.Method
import com.android.tools.smali.dexlib2.iface.instruction.Instruction
import com.android.tools.smali.dexlib2.iface.instruction.ReferenceInstruction
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.zip.ZipFile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue

/** Static evidence only. No native module, file method, or Discord factory is executed. */
class FileStorageContractTest {
    private val root = File(System.getProperty("disk.root") ?: ".")

    @Test
    fun `35217 native spec exposes the expected promise methods`() = withDex { classes ->
        val spec = classes.getValue("Lcom/discord/codegen/NativeFileModuleSpec;")
        for ((name, count) in listOf("readFile" to 2, "writeFile" to 4, "readAsset" to 2, "fileExists" to 1)) {
            val method = spec.methods.single { it.name == name }
            assertEquals(List(count) { "Ljava/lang/String;" } + "Lcom/facebook/react/bridge/Promise;", method.parameterTypes.map { it.toString() })
            assertEquals("V", method.returnType)
            assertTrue(method.annotations.any { it.type == "Lcom/facebook/react/bridge/ReactMethod;" })
        }
    }

    @Test
    fun `documents root is exported from the app private files directory`() = withDex { classes ->
        val module = classes.getValue("Lcom/discord/file_manager/FileModule;")
        val init = module.methods.single { it.name == "<init>" }
        assertRef(init, 41, "Landroid/content/Context;->getFilesDir()Ljava/io/File;")
        assertRef(init, 51, "documents")
        val constants = module.methods.single { it.name == "getTypedExportedConstants" }
        assertRef(constants, 2, "documents")
        assertRef(constants, 13, "DocumentsDirPath")
    }

    @Test
    fun `write syncs temporary data but ignores the rename result`() = withDex { classes ->
        val method = classes.getValue("Lsb/o;").methods.single { it.name == "invokeSuspend" }
        assertRef(method, 86, ".tmp")
        assertRef(method, 121, "Ljava/io/File;->mkdirs()Z")
        assertRef(method, 184, "Lh40/a;->a:Ljava/nio/charset/Charset;")
        assertRef(method, 202, "Ljava/io/FileDescriptor;->sync()V")
        assertRef(method, 208, "Ljava/io/File;->renameTo(Ljava/io/File;)Z")
        // There is no move-result after renameTo. This is why the JS adapter requires read-back.
        assertEquals(Opcode.INVOKE_VIRTUAL, at(method, 211).opcode)
        assertRef(method, 211, "Ljava/io/File;->getAbsolutePath()Ljava/lang/String;")
        assertRef(method, 215, "Lcom/facebook/react/bridge/Promise;->resolve(Ljava/lang/Object;)V")
    }

    @Test
    fun `read accepts an absolute filename and rejects native read errors`() = withDex { classes ->
        val method = classes.getValue("Ley/j;").methods.single { it.name == "invokeSuspend" }
        assertRef(method, 910, "Ljava/io/File;-><init>(Ljava/lang/String;)V")
        assertRef(method, 913, "Ljava/io/FileInputStream;-><init>(Ljava/io/File;)V")
        assertRef(method, 927, "base64")
        assertRef(method, 945, "Lh40/w;->H0([B)Ljava/lang/String;")
        assertRef(method, 961, "Lcom/facebook/react/bridge/Promise;->reject(Ljava/lang/Throwable;)V")
        val charset = classes.getValue("Lh40/a;").methods.single { it.name == "<clinit>" }
        assertRef(charset, 0, "UTF-8")
        assertRef(charset, 11, "Lh40/a;->a:Ljava/nio/charset/Charset;")
        val decode = classes.getValue("Lh40/w;").methods.single { it.name == "H0" }
        assertRef(decode, 2, "Lh40/a;->a:Ljava/nio/charset/Charset;")
    }

    private fun at(method: Method, offset: Int): Instruction {
        var pc = 0
        for (instruction in method.implementation!!.instructions) {
            if (pc == offset) return instruction
            pc += instruction.codeUnits
        }
        error("No instruction at ${method.definingClass}->${method.name}:$offset")
    }

    private fun assertRef(method: Method, offset: Int, expected: String) {
        assertEquals(expected, (at(method, offset) as ReferenceInstruction).reference.toString())
    }

    private fun withDex(block: (Map<String, ClassDef>) -> Unit) {
        val apk = File(root, "work/352.17/apks/base.apk")
        assumeTrue(apk.isFile, "Discord 352.17 base.apk is unavailable; native storage contract is static and input-dependent")
        val classes = ZipFile(apk).use { zip ->
            listOf(
                "classes.dex" to "3efc30958ce4de776f1240448e3ee7c99061928b70b2ed158c8eb04f9b0458be",
                "classes3.dex" to "0bd095f296bf126d1196aa77373a5d5467f01e3ee65e01461f6137aee21d2edc",
            ).flatMap { (name, expected) ->
                val data = zip.getInputStream(zip.getEntry(name)).use { it.readBytes() }
                val hash = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
                assertEquals(expected, hash, "Wrong 352.17 input: $name")
                DexBackedDexFile(Opcodes.getDefault(), ByteBuffer.wrap(data)).classes.toList()
            }.associateBy { it.type }
        }
        block(classes)
    }
}
