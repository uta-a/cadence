package app.disk.patches.dex

import app.disk.patches.DISCORD_VERSION
import app.morphe.patcher.patch.BytecodePatchContext
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.util.proxy.mutableTypes.MutableMethod
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.builder.instruction.BuilderInstruction10x
import com.android.tools.smali.dexlib2.iface.ClassDef
import com.android.tools.smali.dexlib2.iface.Method
import com.android.tools.smali.dexlib2.iface.instruction.OffsetInstruction
import com.android.tools.smali.dexlib2.iface.instruction.SwitchPayload

/**
 * Makes a `void` method return immediately (docs/PHASE4.md, Privacy). The original body is kept as unreachable
 * code after a leading `return-void`, so its try blocks and debug information stay valid.
 *
 * Every target is pinned by the SHA-256 of its full semantic snapshot (instructions, registers, try blocks;
 * see [BundlePin.semanticSnapshot]) measured from Discord 352.17. Any difference stops the patch before writing.
 */
internal data class MethodStub(
    val type: String,
    val name: String,
    val parameters: List<String>,
    val accessFlags: Int,
    val digest: String,
    /** Instruction count of the original body; a stubbed body has exactly one more. */
    val instructions: Int,
) {
    enum class State { ORIGINAL, STUBBED }

    private fun matches(method: Method) = method.name == name && method.returnType == "V" &&
        method.parameterTypes.map(CharSequence::toString) == parameters

    fun find(classOf: (String) -> ClassDef?): Method {
        val owner = classOf(type) ?: throw PatchException("$type is missing; this is not Discord $DISCORD_VERSION")
        return owner.methods.firstOrNull(::matches)
            ?: throw PatchException("$type->$name is missing; this is not Discord $DISCORD_VERSION")
    }

    /** Reads the method as stored in the DEX. A mutable wrapper re-encodes try blocks, so its digest differs. */
    fun classify(method: Method): State {
        if (method.accessFlags != accessFlags) throw PatchException("$type->$name has unexpected modifiers")
        if (isStubbed(method)) return State.STUBBED
        val actual = BundlePin.semanticDigest(method)
        if (actual != digest) throw PatchException("$type->$name does not match Discord $DISCORD_VERSION: $actual")
        // The leading return-void is inserted at index 0: nothing may jump back there or start a try block there.
        if (entryIsTargeted(method)) throw PatchException("$type->$name branches to its first instruction")
        return State.ORIGINAL
    }

    fun verify(classOf: (String) -> ClassDef?): State = classify(find(classOf))

    /** Only call after [verify] accepted the same method; returns false when it already returns first. */
    fun stub(method: MutableMethod): Boolean {
        if (method.accessFlags != accessFlags) throw PatchException("$type->$name has unexpected modifiers")
        if (isStubbed(method)) return false
        val implementation = method.implementation ?: throw PatchException("$type->$name has no code")
        implementation.addInstruction(0, BuilderInstruction10x(Opcode.RETURN_VOID))
        return true
    }

    private fun isStubbed(method: Method): Boolean {
        val implementation = method.implementation ?: throw PatchException("$type->$name has no code")
        return implementation.instructions.firstOrNull()?.opcode == Opcode.RETURN_VOID &&
            implementation.instructions.count() == instructions + 1
    }

    internal fun entryIsTargeted(method: Method): Boolean {
        val implementation = method.implementation ?: return false
        if (implementation.tryBlocks.any { block -> block.startCodeAddress == 0 || block.exceptionHandlers.any { it.handlerCodeAddress == 0 } })
            return true
        var pc = 0
        val switches = mutableMapOf<Int, Int>()
        val payloads = mutableMapOf<Int, SwitchPayload>()
        val targets = mutableSetOf<Int>()
        for (instruction in implementation.instructions) {
            if (instruction is OffsetInstruction) {
                targets += pc + instruction.codeOffset
                if (instruction.opcode == Opcode.PACKED_SWITCH || instruction.opcode == Opcode.SPARSE_SWITCH)
                    switches[pc + instruction.codeOffset] = pc
            }
            if (instruction is SwitchPayload) payloads[pc] = instruction
            pc += instruction.codeUnits
        }
        for ((at, payload) in payloads) {
            val origin = switches[at] ?: continue
            payload.switchElements.forEach { targets += origin + it.offset }
        }
        return 0 in targets
    }

    companion object {
        /** All targets are verified before the first one is changed. */
        fun apply(context: BytecodePatchContext, stubs: List<MethodStub>) {
            stubs.forEach { it.verify(context::classDefByOrNull) }
            for (target in stubs) {
                val method = context.mutableClassDefBy(target.type).methods.firstOrNull(target::matches)
                    ?: throw PatchException("${target.type}->${target.name} is missing from the mutable class")
                target.stub(method)
            }
        }
    }
}

internal object PrivacyStubs {
    private const val PUBLIC = 0x1
    private const val PUBLIC_FINAL = 0x11
    private const val PUBLIC_STATIC = 0x9
    private const val CONTEXT = "Landroid/content/Context;"

    /** `SentryAndroid.init`: the Manifest provider, RNSentry.initNativeSdk and Discord's crash reporter all call it. */
    val sentry = listOf(
        MethodStub(
            "Lio/sentry/android/core/e1;", "b",
            listOf(CONTEXT, "Lio/sentry/android/core/k0;", "Lio/sentry/c4;"), PUBLIC_STATIC,
            "4df256255ab533d5d3bcc5184a23bb542a62a958f8be8ee11b386f7d82070181", 75,
        ),
    )

    /** Every `start` overload funnels into the three-argument one; `logEvent` sends events on its own. */
    val appsFlyer = listOf(
        MethodStub(
            "Lcom/appsflyer/internal/AFa1uSDK;", "start",
            listOf(CONTEXT, "Ljava/lang/String;", "Lcom/appsflyer/attribution/AppsFlyerRequestListener;"), PUBLIC_FINAL,
            "e74469792801ddb56819f0d545b0b8be4eb62052174e52fb9142f15929994c04", 200,
        ),
        MethodStub(
            "Lcom/appsflyer/internal/AFa1uSDK;", "logEvent",
            listOf(CONTEXT, "Ljava/lang/String;", "Ljava/util/Map;"), PUBLIC_FINAL,
            "761b4ecdc15342e11bc21dfdf55f3e288397ffe1fde0b686ee400eebb561edcd", 8,
        ),
        MethodStub(
            "Lcom/appsflyer/internal/AFa1uSDK;", "logEvent",
            listOf(CONTEXT, "Ljava/lang/String;", "Ljava/util/Map;", "Lcom/appsflyer/attribution/AppsFlyerRequestListener;"), PUBLIC_FINAL,
            "4a9aabd2bb28e6f84ec12396e2464049bee6b15814815c72ef62676b1bb562b7", 97,
        ),
    )

    /**
     * Touch logging and the on-device TelemetryRing. Target choice follows Venus Patches' "Disable telemetry and touch
     * logging" (GPL-3.0, VenusIsJaded/Venus-Patches); only void entry points are stubbed, so no Promise is left unresolved.
     * Jank, frame-metric and TTI timings are left alone: MainActivity.onResume starts jank tracking natively and the JS
     * module would throw without its aggregator. They leave the app only as JS analytics events (see Disable analytics).
     */
    val telemetry = listOf(
        // Never registers the touch listener, so taps, view hierarchies and memory figures are not recorded.
        MethodStub(
            "Lcom/discord/analytics/touch/TouchEventAnalyticsModule;", "enableTouchLogging", listOf(), PUBLIC,
            "73ec197d514a521a5c69151bd51978fbb4def39195d37a157e3fd6a5f106bc57", 54,
        ),
        MethodStub(
            "Lcom/discord/analytics/touch/TouchEventAnalyticsModule;", "onEventRecognized", listOf("Lz5/c;"), PUBLIC,
            "f4236401ba8ba190e15eeb752bdb8c35779ad5cd2d277d7e3c11c53627ea55a2", 145,
        ),
        // TelemetryRing.append: the single funnel for native and JS entries; snapshots then stay empty.
        MethodStub(
            "Lcom/discord/crash_reporting/u;", "a",
            listOf("Ljava/lang/String;", "J", "Ljava/lang/String;", "Ljava/util/Map;", "Ljava/util/List;"), PUBLIC_STATIC,
            "f046b9b7cd9fbf1df5fdccb02ebc84bb315a4e5dc4bcf3dc7c62279ced70c728", 71,
        ),
        MethodStub(
            "Lcom/discord/crash_reporting/TelemetryRingModule;", "append",
            listOf("Ljava/lang/String;", "D", "Ljava/lang/String;", "Lcom/facebook/react/bridge/ReadableMap;", "Lcom/facebook/react/bridge/ReadableArray;"), PUBLIC,
            "54a3eb9958a5495a9a9d268f23a6baea82f4c82831053f5e9036e2f409b5d226", 44,
        ),
    )
}
