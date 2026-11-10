export type MetroFactory = (...args: unknown[]) => unknown;
export type MetroDefine = (...args: unknown[]) => unknown;
export interface MetroHost { __d?: MetroDefine; }

/** Replace only Metro's registration function. No factory, require, or export is executed here. */
export function interceptMetroDefine(host: MetroHost, wrap: (define: MetroDefine) => MetroDefine,
    onError: (error: unknown) => void = () => {}): boolean {
    function report(error: unknown): void {
        try { onError(error); } catch (_) { /* Diagnostics cannot interrupt startup. */ }
    }
    try {
        const descriptor = Object.getOwnPropertyDescriptor(host, "__d");
        if (descriptor && !descriptor.configurable &&
            (!("value" in descriptor) || !descriptor.writable || typeof descriptor.value !== "function"))
            throw new Error("Cannot intercept a non-configurable Metro define");
        // Existing accessors may synchronize private host state. Never bypass their getter/setter behavior.
        if (descriptor && !("value" in descriptor)) throw new Error("Cannot intercept an accessor Metro define");
        const current = host.__d;
        if (typeof current === "function") {
            const wrapped = wrap(current);
            if (descriptor && !descriptor.configurable) host.__d = wrapped;
            else Object.defineProperty(host, "__d", {
                enumerable: descriptor?.enumerable ?? true, configurable: true, writable: true, value: wrapped,
            });
        } else {
            let value: unknown = current;
            Object.defineProperty(host, "__d", {
                enumerable: descriptor?.enumerable ?? true, configurable: true,
                get() { return value as MetroDefine | undefined; },
                set(next: unknown) {
                    if (typeof next !== "function") { value = next; return; }
                    value = next;
                    try {
                        Object.defineProperty(host, "__d", {
                            enumerable: descriptor?.enumerable ?? true, configurable: true, writable: true,
                            value: wrap(next as MetroDefine),
                        });
                    } catch (error) { report(error); } // Keep the original define readable on failure.
                },
            });
        }
        return true;
    } catch (error) {
        report(error);
        return false;
    }
}
