const CAPACITY = 80;
const entries: string[] = [];
export function getLogs(): readonly string[] { return Object.freeze([...entries]); }

/** Fixed diagnostic messages only; callers must not pass account data, arguments, or arbitrary error text. */
export function logInfo(message: string): void {
    if (typeof message !== "string") return;
    message = message.slice(0, 1024);
    entries.push(message);
    if (entries.length > CAPACITY) entries.shift();
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
