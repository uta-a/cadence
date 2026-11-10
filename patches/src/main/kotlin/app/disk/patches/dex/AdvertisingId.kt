package app.disk.patches.dex

import app.disk.patches.DISCORD_VERSION
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.util.proxy.mutableTypes.MutableMethod
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction10x
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction35c
import com.android.tools.smali.dexlib2.iface.ClassDef
import com.android.tools.smali.dexlib2.iface.Method
import com.android.tools.smali.dexlib2.immutable.reference.ImmutableMethodReference

/**
 * Reports no Google advertising ID to Discord's JavaScript (docs/PHASE4-RESEARCH.md, 4c).
 *
 * `AdsModule.getGoogleAdvertisingId(Promise)` is the only JavaScript entry point. Discord 352.17 already has a
 * private fallback, `resolveWithNullId(Promise)`, which resolves `{googleAdvertisingId: null,
 * isLimitAdTrackingEnabled: true}`. The whole entry point body is replaced with a call to that fallback, so the
 * background lookup through Google Play services is never started.
 *
 * Both methods must match the measured 352.17 instructions exactly; anything else stops the patch untouched.
 */
internal object AdvertisingId {
    const val TARGET_CLASS = "Lcom/discord/ads/AdsModule;"
    private const val SPEC_CLASS = "Lcom/discord/codegen/NativeAdsModuleSpec;"
    private const val PROMISE = "Lcom/facebook/react/bridge/Promise;"
    private const val ENTRY = "getGoogleAdvertisingId"
    private const val FALLBACK = "resolveWithNullId"
    private const val REGISTERS = 6
    private const val PUBLIC = 0x1
    private const val PRIVATE_FINAL = 0x12

    enum class Result { DISABLED, ALREADY_DISABLED }
    internal enum class State { ORIGINAL, DISABLED }

    fun disable(context: BytecodePatchContext): Result {
        verify(context::classDefByOrNull)
        val method = context.mutableClassDefBy(TARGET_CLASS).methods.firstOrNull { it.isPromiseMethod(ENTRY) }
            ?: throw PatchException("$TARGET_CLASS->$ENTRY is missing from the mutable class")
        return when (classify(method)) {
            State.DISABLED -> Result.ALREADY_DISABLED
            State.ORIGINAL -> {
                rewrite(method)
                Result.DISABLED
            }
        }
    }

    /** Read-only guard over the entry point and the fallback it will call. */
    fun verify(classOf: (String) -> ClassDef?) {
        val owner = classOf(TARGET_CLASS)
            ?: throw PatchException("$TARGET_CLASS is missing; this is not Discord $DISCORD_VERSION")
        failUnless(owner.superclass == SPEC_CLASS, "$TARGET_CLASS no longer extends $SPEC_CLASS")

        val entry = owner.methods.firstOrNull { it.isPromiseMethod(ENTRY) }
            ?: throw PatchException("$TARGET_CLASS->$ENTRY is missing; this is not Discord $DISCORD_VERSION")
        failUnless(entry.accessFlags == PUBLIC, "$TARGET_CLASS->$ENTRY is no longer a plain public method")
        val entryCode = entry.implementation ?: throw PatchException("$TARGET_CLASS->$ENTRY has no code")
        failUnless(entryCode.registerCount == REGISTERS, "$TARGET_CLASS->$ENTRY uses ${entryCode.registerCount} registers")
        failUnless(entryCode.tryBlocks.none(), "$TARGET_CLASS->$ENTRY now has an exception handler")
        classify(entry)

        val fallback = owner.methods.firstOrNull { it.isPromiseMethod(FALLBACK) }
            ?: throw PatchException("$TARGET_CLASS->$FALLBACK is missing; this is not Discord $DISCORD_VERSION")
        failUnless(fallback.accessFlags == PRIVATE_FINAL, "$TARGET_CLASS->$FALLBACK is no longer private final")
        val fallbackCode = fallback.implementation ?: throw PatchException("$TARGET_CLASS->$FALLBACK has no code")
        failUnless(fallbackCode.tryBlocks.none(), "$TARGET_CLASS->$FALLBACK now has an exception handler")
        val actual = BundlePin.signatures(fallbackCode)
        failUnless(
            actual == RESOLVE_NULL,
            "$TARGET_CLASS->$FALLBACK does not match Discord $DISCORD_VERSION:\n" + actual.joinToString("\n"),
        )
    }

    fun classify(method: Method): State {
        val implementation = method.implementation ?: throw PatchException("${method.definingClass}->${method.name} has no code")
        return when (val actual = BundlePin.signatures(implementation)) {
            DISABLED -> State.DISABLED
            LOOKUP -> State.ORIGINAL
            else -> throw PatchException(
                "${method.definingClass}->${method.name} does not match Discord $DISCORD_VERSION:\n" + actual.joinToString("\n")
            )
        }
    }

    /** `invoke-direct {p0, p1}, resolveWithNullId(Promise)V` then `return-void`; the six-register frame is kept. */
    fun rewrite(method: MutableMethod) {
        if (classify(method) == State.DISABLED) return
        val implementation = method.implementation ?: throw PatchException("${method.definingClass}->${method.name} has no code")
        val count = implementation.instructions.count()
        for (index in 0..count) implementation.newLabelForIndex(index).location.debugItems.clear()
        val fallback = ImmutableMethodReference(TARGET_CLASS, FALLBACK, listOf(PROMISE), "V")
        implementation.replaceInstruction(0, BuilderInstruction35c(Opcode.INVOKE_DIRECT, 2, 4, 5, 0, 0, 0, fallback))
        implementation.replaceInstruction(1, BuilderInstruction10x(Opcode.RETURN_VOID))
        for (index in count - 1 downTo DISABLED.size) implementation.removeInstruction(index)
    }

    private fun Method.isPromiseMethod(name: String) =
        this.name == name && returnType == "V" && parameterTypes.map(CharSequence::toString) == listOf(PROMISE)

    private fun failUnless(condition: Boolean, message: String) {
        if (!condition) throw PatchException(message)
    }

    private val DISABLED = listOf(
        "invoke-direct count=2 {v4, v5, v0, v0, v0} Lcom/discord/ads/AdsModule;->resolveWithNullId(Lcom/facebook/react/bridge/Promise;)V",
        "return-void",
    )

    // Measured from the original Discord 352.17 APK.
    private val LOOKUP = listOf(
        "const-string v0 \"promise\"",
        "invoke-static count=2 {v5, v0, v0, v0, v0} Lkotlin/jvm/internal/k;->g(Ljava/lang/Object;, Ljava/lang/String;)V",
        "invoke-direct count=1 {v4, v0, v0, v0, v0} Lcom/discord/ads/AdsModule;->cleanupCurrentOperation()V",
        "invoke-direct count=1 {v4, v0, v0, v0, v0} Lcom/discord/ads/AdsModule;->getAdvertisingIdInfoAsync()Lwu/o;",
        "move-result-object v0",
        "iget-object v1, v4 Lcom/discord/ads/AdsModule;->currentOperation:Ljava/util/concurrent/atomic/AtomicReference;",
        "invoke-virtual count=2 {v1, v0, v0, v0, v0} Ljava/util/concurrent/atomic/AtomicReference;->set(Ljava/lang/Object;)V",
        "new-instance v1 Lrp/d0;",
        "invoke-direct count=3 {v1, v4, v5, v0, v0} Lrp/d0;-><init>(Ljava/lang/Object;, Ljava/lang/Object;)V",
        "iget-object v5, v4 Lcom/discord/ads/AdsModule;->adExecutor:Ljava/util/concurrent/ExecutorService;",
        "new-instance v2 Lwu/n;",
        "const/4 v3 #0",
        "invoke-direct count=4 {v2, v3, v0, v1, v0} Lwu/n;-><init>(I, Ljava/lang/Object;, Ljava/lang/Object;)V",
        "invoke-interface count=3 {v0, v2, v5, v0, v0} Lwu/o;->a(Ljava/lang/Runnable;, Ljava/util/concurrent/Executor;)V",
        "return-void",
    )

    private val RESOLVE_NULL = listOf(
        "new-instance v0 Lw00/j;",
        "const-string v1 \"googleAdvertisingId\"",
        "const/4 v2 #0",
        "invoke-direct count=3 {v0, v1, v2, v0, v0} Lw00/j;-><init>(Ljava/lang/Object;, Ljava/lang/Object;)V",
        "sget-object v1 Ljava/lang/Boolean;->TRUE:Ljava/lang/Boolean;",
        "new-instance v2 Lw00/j;",
        "const-string v3 \"isLimitAdTrackingEnabled\"",
        "invoke-direct count=3 {v2, v3, v1, v0, v0} Lw00/j;-><init>(Ljava/lang/Object;, Ljava/lang/Object;)V",
        "filled-new-array count=2 {v0, v2, v0, v0, v0} [Lw00/j;",
        "move-result-object v0",
        "invoke-static count=1 {v0, v0, v0, v0, v0} Lrf/f;->h([Lw00/j;)Lcom/facebook/react/bridge/WritableNativeMap;",
        "move-result-object v0",
        "invoke-interface count=2 {v5, v0, v0, v0, v0} Lcom/facebook/react/bridge/Promise;->resolve(Ljava/lang/Object;)V",
        "return-void",
    )
}
