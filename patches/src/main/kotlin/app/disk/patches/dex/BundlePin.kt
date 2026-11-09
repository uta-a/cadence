package app.disk.patches.dex

import app.disk.patches.DISCORD_VERSION
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.util.proxy.mutableTypes.MutableMethod
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction11n
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction11x
import com.android.tools.smali.dexlib2.iface.ClassDef
import com.android.tools.smali.dexlib2.iface.Field
import com.android.tools.smali.dexlib2.iface.Method
import com.android.tools.smali.dexlib2.iface.MethodImplementation
import com.android.tools.smali.dexlib2.iface.instruction.DualReferenceInstruction
import com.android.tools.smali.dexlib2.iface.instruction.FiveRegisterInstruction
import com.android.tools.smali.dexlib2.iface.instruction.NarrowLiteralInstruction
import com.android.tools.smali.dexlib2.iface.instruction.OffsetInstruction
import com.android.tools.smali.dexlib2.iface.instruction.OneRegisterInstruction
import com.android.tools.smali.dexlib2.iface.instruction.ReferenceInstruction
import com.android.tools.smali.dexlib2.iface.instruction.RegisterRangeInstruction
import com.android.tools.smali.dexlib2.iface.instruction.SwitchPayload
import com.android.tools.smali.dexlib2.iface.instruction.ThreeRegisterInstruction
import com.android.tools.smali.dexlib2.iface.instruction.TwoRegisterInstruction
import com.android.tools.smali.dexlib2.iface.instruction.WideLiteralInstruction
import com.android.tools.smali.dexlib2.iface.instruction.formats.ArrayPayload
import com.android.tools.smali.dexlib2.iface.reference.FieldReference
import com.android.tools.smali.dexlib2.iface.reference.MethodReference
import com.android.tools.smali.dexlib2.iface.reference.Reference
import com.android.tools.smali.dexlib2.iface.reference.StringReference
import com.android.tools.smali.dexlib2.iface.reference.TypeReference
import java.security.MessageDigest

/**
 * Keeps React Native on the bundle packaged in the APK instead of a downloaded OTA bundle (DESIGN.md §4.4).
 *
 * Discord 352.17 reads its active OTA bundle from `Lw6/z;->i()Lw6/v;` in three places that matter: the
 * bridgeless host builder `Ld6/a;->invoke()`, the legacy instance-manager builder `Ldl/o;->a()`, and the
 * crash-reporter release name in `Lu5/b;->call()`. Every caller compares the result with null, so replacing
 * the body with `return null` is enough: both host builders then take their "no OTA bundle" branch, which
 * loads `assets://index.android.bundle` from the APK. `Lw6/z;->j()` also forwards null, and
 * `BundleUpdaterManager.getManifestInfo` then reads the packaged manifest instead.
 *
 * The rewrite is only allowed after [verify] accepts the exact method, the 7-register frame, the instruction
 * sequence and the complete semantic snapshots of all four callers plus the manifest null consumer.
 * Anything else stops the patch before the method is touched, so an unknown Discord build fails closed
 * instead of starting with an unpatched bundle.
 */
internal object BundlePin {
    const val TARGET_CLASS = "Lw6/z;"

    /** What [pin] did, so callers and tests can tell a first application from a repeated one. */
    enum class Result { PINNED, ALREADY_PINNED }

    /** The seam must be exactly one of these; anything else is a different build. */
    internal enum class State { ORIGINAL, PINNED }

    /**
     * A null-returning `i()`: `const/4 v0, 0` then `return-object v0`. Keep the measured seven-register
     * frame; changing the frame is unnecessary for this body replacement.
     */
    private val PINNED = listOf("const/4 v0 #0", "return-object v0")

    fun pin(context: BytecodePatchContext): Result {
        verify(context::classDefByOrNull)
        val method = context.mutableClassDefBy(TARGET_CLASS).methods.firstOrNull {
            it.name == METHOD_NAME && it.parameterTypes.isEmpty() && it.returnType == OTA_BUNDLE
        } ?: throw PatchException("$TARGET_CLASS->$METHOD_NAME is missing from the mutable class")
        return when (classify(method)) {
            State.PINNED -> Result.ALREADY_PINNED
            State.ORIGINAL -> {
                rewrite(method)
                Result.PINNED
            }
        }
    }

    /**
     * Read-only guard: throws [PatchException] when this is not the Discord 352.17 layout the pin was written
     * against. [classOf] resolves a class descriptor across all dex files.
     */
    fun verify(classOf: (String) -> ClassDef?) {
        val owner = classOf(TARGET_CLASS)
            ?: throw PatchException("$TARGET_CLASS is missing; this is not Discord $DISCORD_VERSION")
        failUnless(owner.superclass == "Ljava/lang/Object;", "$TARGET_CLASS no longer extends Object")
        requireField(owner, "a", "Landroid/content/SharedPreferences;", FINAL_FIELD)
        requireField(owner, "c", "Landroid/content/res/AssetManager;", FINAL_FIELD)
        requireField(owner, "q", TARGET_CLASS, STATIC_FIELD)

        val method = methodOf(owner, METHOD_NAME, OTA_BUNDLE)
            ?: throw PatchException("$TARGET_CLASS->$METHOD_NAME()$OTA_BUNDLE is missing; this is not Discord $DISCORD_VERSION")
        failUnless(method.accessFlags == FINAL_METHOD, "$TARGET_CLASS->$METHOD_NAME is no longer a public final method")
        val implementation = method.implementation ?: throw PatchException("$TARGET_CLASS->$METHOD_NAME has no code")
        failUnless(
            implementation.registerCount == LOOKUP_REGISTERS,
            "$TARGET_CLASS->$METHOD_NAME uses ${implementation.registerCount} registers, expected $LOOKUP_REGISTERS",
        )
        failUnless(implementation.tryBlocks.none(), "$TARGET_CLASS->$METHOD_NAME now has an exception handler")
        // A pinned body is accepted, so re-running the patch on an already patched APK is a no-op.
        classify(method)
        requireLoaderChoice(classOf)
    }

    /** Which of the two accepted bodies [method] has. */
    fun classify(method: Method): State {
        val implementation = method.implementation ?: throw PatchException("${method.definingClass}->${method.name} has no code")
        val actual = signatures(implementation)
        return when (actual) {
            PINNED -> State.PINNED
            OTA_BUNDLE_LOOKUP -> State.ORIGINAL
            else -> throw PatchException(
                "${method.definingClass}->${method.name} does not match Discord $DISCORD_VERSION:\n" +
                    actual.joinToString("\n")
            )
        }
    }

    /** Replaces the whole body with [PINNED]. The frame keeps its registers; the observed count stays valid. */
    fun rewrite(method: MutableMethod) {
        if (classify(method) == State.PINNED) return
        val implementation = method.implementation ?: throw PatchException("${method.definingClass}->${method.name} has no code")
        val count = implementation.instructions.count()
        // Removing instructions merges their debug locations, retaining stale line/local events. The new
        // body has no relation to those source positions; clear every location, including the end sentinel.
        for (index in 0..count) implementation.newLabelForIndex(index).location.debugItems.clear()
        implementation.replaceInstruction(0, BuilderInstruction11n(Opcode.CONST_4, 0, 0))
        implementation.replaceInstruction(1, BuilderInstruction11x(Opcode.RETURN_OBJECT, 0))
        for (index in count - 1 downTo PINNED.size) implementation.removeInstruction(index)
    }

    /** Full caller bodies include asset-path producers/consumers outside the old selection windows. */
    private fun requireLoaderChoice(classOf: (String) -> ClassDef?) {
        for (snapshot in CALLERS) {
            val owner = classOf(snapshot.type)
                ?: throw PatchException("${snapshot.type} is missing; cannot confirm the bundle loader choice")
            val method = owner.methods.firstOrNull {
                it.name == snapshot.name && it.returnType == snapshot.returnType &&
                    it.parameterTypes.map(CharSequence::toString) == snapshot.parameters
            } ?: throw PatchException("${snapshot.type}->${snapshot.name} is missing; cannot confirm the bundle loader choice")
            val actual = semanticDigest(method)
            failUnless(
                actual == snapshot.digest,
                "${snapshot.type}->${snapshot.name} does not match Discord $DISCORD_VERSION caller snapshot: $actual",
            )
        }
    }

    /** Canonical UTF-8/LF input to SHA-256; no pool indices or debug/source-line metadata. See DESIGN §4.4. */
    fun semanticSnapshot(method: Method): String {
        val implementation = method.implementation
            ?: throw PatchException("${method.definingClass}->${method.name} has no code")
        return buildString {
            appendLine("${method.definingClass}->${method.name}(${method.parameterTypes.joinToString(", ")})${method.returnType}")
            appendLine("access=${method.accessFlags} registers=${implementation.registerCount}")
            var pc = 0
            implementation.instructions.forEach {
                appendLine("$pc/${it.codeUnits} ${it.signature(pc)}")
                pc += it.codeUnits
            }
            appendLine("end=$pc")
            implementation.tryBlocks.forEach { block ->
                appendLine("try=${block.startCodeAddress}/${block.codeUnitCount}")
                block.exceptionHandlers.forEach { handler ->
                    appendLine("catch=${handler.exceptionType ?: "*"}->${handler.handlerCodeAddress}")
                }
            }
        }
    }

    fun semanticDigest(method: Method): String = MessageDigest.getInstance("SHA-256")
        .digest(semanticSnapshot(method).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun failUnless(condition: Boolean, message: String) {
        if (!condition) throw PatchException(message)
    }

    private fun methodOf(owner: ClassDef, name: String, returnType: String): Method? =
        owner.methods.firstOrNull { it.name == name && it.parameterTypes.isEmpty() && it.returnType == returnType }

    private fun requireField(owner: ClassDef, name: String, type: String, accessFlags: Int) {
        val field: Field = owner.fields.firstOrNull { it.name == name && it.type == type }
            ?: throw PatchException("$TARGET_CLASS->$name:$type is missing; this is not Discord $DISCORD_VERSION")
        failUnless(field.accessFlags == accessFlags, "$TARGET_CLASS->$name:$type has unexpected modifiers")
    }

    /** One line per instruction, with registers, literals, references and jump targets spelled out. */
    fun signatures(implementation: MethodImplementation): List<String> {
        var pc = 0
        return implementation.instructions.map { instruction ->
            instruction.signature(pc).also { pc += instruction.codeUnits }
        }
    }

    private fun com.android.tools.smali.dexlib2.iface.instruction.Instruction.signature(pc: Int): String {
        val out = StringBuilder(opcode.name.lowercase().replace('_', '-'))
        when {
            this is RegisterRangeInstruction ->
                out.append(" count=").append(registerCount).append(" {v").append(startRegister).append("..v").append(startRegister + registerCount - 1).append('}')
            this is FiveRegisterInstruction ->
                out.append(" count=").append(registerCount).append(" {v").append(registerC).append(", v").append(registerD).append(", v").append(registerE)
                    .append(", v").append(registerF).append(", v").append(registerG).append('}')
            this is ThreeRegisterInstruction -> out.append(" v").append(registerA).append(", v").append(registerB).append(", v").append(registerC)
            this is TwoRegisterInstruction -> out.append(" v").append(registerA).append(", v").append(registerB)
            this is OneRegisterInstruction -> out.append(" v").append(registerA)
        }
        when (this) {
            is NarrowLiteralInstruction -> out.append(" #").append(narrowLiteral)
            is WideLiteralInstruction -> out.append(" #").append(wideLiteral)
        }
        if (this is ReferenceInstruction) out.append(' ').append(reference.signature())
        if (this is DualReferenceInstruction) out.append(" second=").append(reference2.signature())
        if (this is SwitchPayload) out.append(" cases=").append(switchElements.joinToString(",") { "${it.key}:${it.offset}" })
        if (this is ArrayPayload) out.append(" width=").append(elementWidth).append(" data=").append(arrayElements.joinToString(","))
        if (this is OffsetInstruction) out.append(" ->").append(pc + codeOffset)
        return out.toString()
    }

    private fun Reference.signature(): String = when (this) {
        is StringReference -> "\"" + string + "\""
        is FieldReference -> definingClass + "->" + name + ":" + type
        is MethodReference -> definingClass + "->" + name + "(" + parameterTypes.joinToString(", ") + ")" + returnType
        is TypeReference -> type
        else -> toString()
    }

    private const val METHOD_NAME = "i"
    private const val OTA_BUNDLE = "Lw6/v;"
    private const val LOOKUP_REGISTERS = 7
    private const val FINAL_FIELD = 0x11
    private const val STATIC_FIELD = 0x9
    private const val FINAL_METHOD = 0x11

    // Generated from Discord 352.17 - Stable; see docs/DESIGN.md §4.4.
    private val OTA_BUNDLE_LOOKUP = listOf(
        "iget-object v0, v6 Lw6/z;->a:Landroid/content/SharedPreferences;",
        "const-string v1 \"key_android_js_bundle\"",
        "const/4 v2 #0",
        "invoke-interface count=3 {v0, v1, v2, v0, v0} Landroid/content/SharedPreferences;->getString(Ljava/lang/String;, Ljava/lang/String;)Ljava/lang/String;",
        "move-result-object v1",
        "const-string v3 \"key_android_js_bundle_release_name\"",
        "invoke-interface count=3 {v0, v3, v2, v0, v0} Landroid/content/SharedPreferences;->getString(Ljava/lang/String;, Ljava/lang/String;)Ljava/lang/String;",
        "move-result-object v3",
        "if-eqz v1 ->28",
        "new-instance v4 Lw6/v;",
        "new-instance v5 Ljava/io/File;",
        "invoke-direct count=2 {v5, v1, v0, v0, v0} Ljava/io/File;-><init>(Ljava/lang/String;)V",
        "invoke-direct count=3 {v4, v5, v3, v0, v0} Lw6/v;-><init>(Ljava/io/File;, Ljava/lang/String;)V",
        "goto ->29",
        "move-object v4, v2",
        "if-eqz v4 ->62",
        "iget-object v1, v4 Lw6/v;->a:Ljava/io/File;",
        "invoke-virtual count=1 {v1, v0, v0, v0, v0} Ljava/io/File;->exists()Z",
        "move-result v1",
        "if-eqz v1 ->62",
        "const-string v1 \"ota_version\"",
        "const-string v3 \"\"",
        "invoke-interface count=3 {v0, v1, v3, v0, v0} Landroid/content/SharedPreferences;->getString(Ljava/lang/String;, Ljava/lang/String;)Ljava/lang/String;",
        "move-result-object v0",
        "if-nez v0 ->50",
        "goto ->51",
        "move-object v3, v0",
        "invoke-static count=0 {v0, v0, v0, v0, v0} Loa/a;->b()Ljava/lang/String;",
        "move-result-object v0",
        "invoke-virtual count=2 {v3, v0, v0, v0, v0} Ljava/lang/Object;->equals(Ljava/lang/Object;)Z",
        "move-result v0",
        "if-eqz v0 ->62",
        "return-object v4",
        "return-object v2",
    )

    private data class CallerSnapshot(
        val type: String,
        val name: String,
        val returnType: String,
        val digest: String,
        val parameters: List<String> = emptyList(),
    )

    // Measured only from the original Discord 352.17 APK, not inferred from another patch. DESIGN §4.4.
    private val CALLERS = listOf(
        CallerSnapshot("Ld6/a;", "invoke", "Ljava/lang/Object;", "5edcb77dd3bb8af517a24b595f671dcb3fb98d2e17b85c7f5709230dda7fafc2"),
        CallerSnapshot("Ldl/o;", "a", "V", "5205f1722374917bc80c778970856f2fdeaa02a0e3c54c47eed317ad6cc97715"),
        CallerSnapshot("Lu5/b;", "call", "Ljava/lang/Object;", "f034e603d4e6d7a038f1a6b1b4e2179dc7b908f349875c4d1cc4e0e81be7b4c7"),
        CallerSnapshot("Lw6/z;", "j", "Ljava/lang/String;", "07613a503beeb4501a6317e7b4614c4a83fe09e8b22ea6c47e60bed06169fd29"),
        CallerSnapshot(
            "Lcom/discord/bundle_updater/BundleUpdaterManager;", "getManifestInfo", "V", "0b69d0e33bb209997a16794238a4e40e04d303ccb641ece749d8a419cfe3612c",
            listOf("Lcom/facebook/react/bridge/Promise;"),
        ),
    )
}
