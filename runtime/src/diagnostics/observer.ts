import { interceptMetroDefine } from "../core/metro";
import type { MetroDefine, MetroFactory, MetroHost } from "../core/metro";

export interface ModuleProbe { readonly name: string; readonly id: number; readonly paths: readonly string[]; }
export type ShapeKind = "undefined" | "boolean" | "number" | "string" | "symbol" | "bigint" | "function" |
    "object" | "null" | "accessor" | "missing" | "uninspectable" | "depth-limit";
export interface ModuleCapture {
    readonly id: number;
    /** Trusted, read-only consumer. Never log exports or invoke native methods synchronously here. */
    readonly onExports: (exports: unknown) => void;
}
export interface ModuleReport {
    readonly name: string;
    readonly id: number;
    readonly started: number;
    readonly completed: number;
    readonly shape: ReadonlyArray<Readonly<{ path: string; kind: ShapeKind }>>;
}

/** Metadata only. Never invoke an accessor, require, native method, or store method. Proxies may trap reflection. */
export function inspectPath(root: unknown, path: string): ShapeKind {
    let value: unknown = root;
    try {
        for (const key of path.split(".")) {
            if (!key || key === "__proto__" || key === "prototype" || key === "constructor") return "uninspectable";
            if (value === null || (typeof value !== "object" && typeof value !== "function")) return "missing";
            let owner: object | null = value;
            let descriptor: PropertyDescriptor | undefined;
            for (let depth = 0; owner && depth < 8; depth++) {
                descriptor = Object.getOwnPropertyDescriptor(owner, key);
                if (descriptor) break;
                owner = Object.getPrototypeOf(owner);
            }
            if (!descriptor) return owner ? "depth-limit" : "missing";
            if (!("value" in descriptor)) return "accessor";
            value = descriptor.value;
        }
        return value === null ? "null" : typeof value;
    } catch (_) { return "uninspectable"; }
}

/** Observe only successful natural factory executions. This is NOT a gate or a feature-hook loader. */
export function createMetroObserver(host: MetroHost, probes: readonly ModuleProbe[],
    onReport: (report: ModuleReport) => void, onError: () => void = () => {}, capture?: ModuleCapture) {
    const targets = new Map<number, ModuleProbe>();
    for (const probe of probes) {
        if (!Number.isInteger(probe.id) || probe.id < 0 || probe.id > 32767 || targets.has(probe.id) ||
            !/^[A-Za-z][A-Za-z0-9]*$/.test(probe.name) || probe.paths.length > 16 ||
            probe.paths.some(path => !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(path)))
            throw new TypeError("Invalid Metro diagnostic probe");
        targets.set(probe.id, Object.freeze({ name: probe.name, id: probe.id, paths: Object.freeze([...probe.paths]) }));
    }
    const capturedId = capture?.id;
    const onCapture = capture?.onExports;
    if (capture && (!targets.has(capture.id) || typeof onCapture !== "function"))
        throw new TypeError("Invalid Metro read-only capture");
    let installed = false;
    let clock = 0;
    const reported = new Set<number>();
    function error(): void { try { onError(); } catch (_) { /* Ignore diagnostic failures. */ } }
    function decorate(define: MetroDefine): MetroDefine {
        return function (this: unknown, ...args: unknown[]): unknown {
            const factory = args[0], id = args[1];
            const probe = typeof id === "number" ? targets.get(id) : undefined;
            if (typeof factory !== "function" || !probe) return Reflect.apply(define, this, args);
            args[0] = function (this: unknown, ...factoryArgs: unknown[]): unknown {
                const started = ++clock;
                // Original results, thrown objects and factory argument references must be preserved.
                const result = Reflect.apply(factory as MetroFactory, this, factoryArgs);
                const completed = ++clock;
                if (!reported.has(probe.id)) {
                    reported.add(probe.id);
                    try {
                        const module = factoryArgs[4];
                        if (!module || typeof module !== "object") throw new Error("Metro ABI missing");
                        const exports = Object.getOwnPropertyDescriptor(module, "exports");
                        if (!exports || !("value" in exports)) throw new Error("Metro ABI is not a data export");
                        const shape = probe.paths.map(path => Object.freeze({ path, kind: inspectPath(exports.value, path) }));
                        // Retain/log only fixed path labels and kinds, never any module value or factory arguments.
                        try { onReport(Object.freeze({ name: probe.name, id: probe.id, started, completed, shape: Object.freeze(shape) })); }
                        catch (_) { error(); }
                        if (probe.id === capturedId && onCapture) onCapture(exports.value);
                    } catch (_) { error(); }
                }
                return result;
            };
            return Reflect.apply(define, this, args);
        };
    }
    return {
        install(): boolean {
            if (!installed) installed = interceptMetroDefine(host, decorate, error);
            return installed;
        },
    };
}
