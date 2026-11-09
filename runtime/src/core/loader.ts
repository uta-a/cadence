// Metro's __d registers factories. All hooks run only after the original factory has returned.
// No module is required early, and an absent/moved module ID cannot make a different module execute.

export type MetroFactory = (...args: unknown[]) => unknown;
export type MetroDefine = (...args: unknown[]) => unknown;
export type MetroModule = { exports: unknown };
export type ModuleHook = (exports: unknown, module: MetroModule) => void;
export type HookError = (id: number, error: unknown) => void;

export interface MetroHost {
    __d?: MetroDefine;
}

const MAX_MODULE_ID = 32767;

/**
 * Configure hooks before Discord calls __d. The optional gate is a Metro module whose default export is RN's
 * initializer; hooks stay deferred until its outermost successful invocation. A gate that cannot be wrapped
 * deliberately leaves the hooks inactive. The gate's ID must be confirmed on the targeted Discord version.
 */
export function createMetroLoader(host: MetroHost, gateId: number | null, onError: HookError = () => {}): {
    register(id: number, hook: ModuleHook): void;
    install(): void;
    readonly ready: boolean;
} {
    const hooks: Array<ModuleHook[] | undefined> = new Array(MAX_MODULE_ID + 1);
    const targets = new Uint8Array(MAX_MODULE_ID + 1);
    const waiting = new Map<number, MetroModule>();
    let ready = gateId === null;
    let installed = false;
    let gateWrapped = false;
    let draining = false;
    if (gateId !== null) assertId(gateId);

    function report(id: number, error: unknown): void {
        try { onError(id, error); } catch (_) { /* Diagnostics must never break Discord. */ }
    }

    function assertId(id: number): void {
        if (!Number.isInteger(id) || id < 0 || id > MAX_MODULE_ID) throw new RangeError(`Invalid Metro module ID: ${id}`);
    }

    function apply(id: number, module: MetroModule): void {
        for (const hook of hooks[id] || []) {
            try { hook(module.exports, module); }
            catch (error) { report(id, error); }
        }
    }

    function flush(): void {
        if (draining || ready) return;
        draining = true;
        // Hooks can cause another Metro module to load. Enqueue it behind the existing deferred modules.
        while (waiting.size) {
            const first = waiting.entries().next().value as [number, MetroModule];
            waiting.delete(first[0]);
            apply(first[0], first[1]);
        }
        draining = false;
        ready = true;
    }

    function decorate(define: MetroDefine): MetroDefine {
        return function (this: unknown, ...args: unknown[]): unknown {
            const factory = args[0];
            const id = args[1];
            if (typeof factory !== "function" || typeof id !== "number" || !targets[id])
                return define.apply(this, args);
            args[0] = function (this: unknown, ...factoryArgs: unknown[]): unknown {
                const result = (factory as MetroFactory).apply(this, factoryArgs);
                // The module argument is part of the pinned Metro factory ABI; don't guess if it moves.
                const module = factoryArgs[4];
                if (!module || typeof module !== "object" || !("exports" in module)) {
                    report(id, new Error("Metro factory module argument missing"));
                    return result;
                }
                const record = module as MetroModule;
                if (gateId === id) {
                    try {
                        const exports = record.exports;
                        const gate = exports && typeof exports === "object" && (exports as { default?: unknown }).default;
                        if (typeof gate !== "function") throw new Error("RN initializer default export missing");
                        let depth = 0;
                        (exports as { default: MetroFactory }).default = function (this: unknown, ...callArgs: unknown[]): unknown {
                            depth++;
                            let value: unknown;
                            try { value = gate.apply(this, callArgs); }
                            catch (error) { depth--; throw error; }
                            if (--depth === 0 && !ready) flush();
                            return value;
                        };
                        gateWrapped = true;
                    } catch (error) { report(id, error); }
                }
                if (id !== gateId) {
                    if (ready) apply(id, record);
                    else waiting.set(id, record);
                }
                return result;
            };
            return define.apply(this, args);
        };
    }

    return {
        register(id, hook) {
            assertId(id);
            if (id === gateId) throw new RangeError("The RN initializer module cannot have a regular hook");
            if (typeof hook !== "function") throw new TypeError("Module hook must be a function");
            (hooks[id] ||= []).push(hook);
            targets[id] = 1;
        },
        install() {
            if (installed) return;
            try {
                const descriptor = Object.getOwnPropertyDescriptor(host, "__d");
                // An accessor that cannot be replaced may swallow or change our assignment. A read-only data
                // property cannot be wrapped. In either case, do not claim that the loader is installed.
                if (descriptor && !descriptor.configurable &&
                    (!("value" in descriptor) || !descriptor.writable || typeof descriptor.value !== "function"))
                    throw new Error("Cannot intercept a non-configurable Metro define");
                const current = host.__d;
                if (typeof current === "function") {
                    const wrapped = decorate(current);
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
                            // Metro reads __d thousands of times. Restore a plain value once a define arrives.
                            Object.defineProperty(host, "__d", {
                                enumerable: descriptor?.enumerable ?? true, configurable: true, writable: true,
                                value: decorate(next as MetroDefine),
                            });
                        },
                    });
                }
                if (gateId !== null) targets[gateId] = 1;
                installed = true;
            } catch (error) { report(-1, error); }
        },
        get ready() { return ready && (gateId === null || gateWrapped); },
    };
}
