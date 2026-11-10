// disk runtime entry. Runs inside Discord's Hermes before any Metro module is defined.
// Phase 0: only announces itself; core/ and features/ arrive in Phase 3.

const REVISION = "0.0.1";

function announceBoot(): void {
    const message = `[disk] loaded ${REVISION}`;
    // Metro/RN may not have installed console yet. Use the host logger without importing any RN module.
    try {
        const nativeLog = globalThis.nativeLoggingHook;
        if (typeof nativeLog === "function") {
            nativeLog.call(globalThis, `${message} (native)`, 1);
            return;
        }
    } catch (_) { /* Try console if the optional host logger is unavailable or throws. */ }
    try {
        const console = globalThis.console;
        if (console && typeof console.log === "function") console.log(`${message} (console)`);
    } catch (_) { /* Diagnostics must not stop Discord's startup. */ }
}

if (!globalThis.__disk) {
    globalThis.__disk = Object.freeze({ revision: REVISION });
    announceBoot();
}
