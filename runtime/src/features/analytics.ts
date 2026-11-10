// Disable analytics (docs/PHASE4-RESEARCH.md, 4c). module 1267 exports `default = {..., track}` as plain data.
// `track` normally queues a TRACK dispatcher action and returns a Promise that is never settled; the replacement
// drops the event and returns a resolved Promise, matching the original throttled path's return type.

/** Replace `exports.default.track`. Returns false, leaving everything untouched, if the shape is unexpected. */
export function installAnalyticsBlock(exports: unknown): boolean {
    if (!exports || typeof exports !== "object") return false;
    const holder = Object.getOwnPropertyDescriptor(exports, "default");
    const target = holder && "value" in holder ? holder.value : undefined;
    if (!target || typeof target !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(target, "track");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return false;
    if (!descriptor.writable && !descriptor.configurable) return false;
    const resolved = globalThis.Promise;
    if (typeof resolved !== "function") return false;
    function track(): Promise<void> { return resolved.resolve(); }
    Object.defineProperty(target, "track", { ...descriptor, value: track });
    return true;
}
