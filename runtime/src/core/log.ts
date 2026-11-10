/** Fixed diagnostic messages only; callers must not pass account data, arguments, or arbitrary error text. */
export function logInfo(message: string): void {
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
