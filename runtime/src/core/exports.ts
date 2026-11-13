/** Replace a plain-data function export with a wrapper; false (and nothing changed) when the shape is unexpected. */
export function wrapExport(exports: unknown, key: string, wrap: (original: (...args: unknown[]) => unknown) => unknown): boolean {
    if (!exports || typeof exports !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(exports, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || (!descriptor.writable && !descriptor.configurable))
        return false;
    Object.defineProperty(exports, key, { ...descriptor, value: wrap(descriptor.value as (...args: unknown[]) => unknown) });
    return true;
}
