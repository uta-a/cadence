import { createSettingsController } from "./settings-controller";
import type { BuildFeature } from "./features";
import { createSettingsOverview } from "./ui";
import type { NativeUi, ReactApi } from "./ui";
import type { ModuleCapture } from "../diagnostics/observer";

/** Data descriptors only; trusted RN lazy component getters are evaluated separately after navigation readiness. */
export function dataProperty(value: unknown, key: string): unknown {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    let owner: object | null = value;
    for (let depth = 0; owner && depth < 8; depth++) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
        owner = Object.getPrototypeOf(owner);
    }
    return undefined;
}

/** Per-module readiness, not an invented global RN initializer. No scan and no eager boot require. */
export function createCoreModules(onStatus: (status: string) => void, smoke = false, features: readonly BuildFeature[] = []) {
    const modules = new Map<number, unknown>();
    const settings = createSettingsController(status => report(`settings ${status}`));
    let requireModule: ((id: number) => unknown) | undefined;
    let smokeScheduled = false;
    let uiInstalled = false;
    function report(value: string): void { try { onStatus(value); } catch (_) { /* Fixed diagnostics only. */ } }
    function navigationReady(): boolean {
        try {
            const exports = modules.get(5183), getter = dataProperty(exports, "getRootNavigationRef");
            if (typeof getter !== "function") return false;
            const ref = Reflect.apply(getter, exports, []), isReady = dataProperty(ref, "isReady");
            return typeof isReady === "function" && Reflect.apply(isReady, ref, []) === true;
        } catch (_) { return false; }
    }
    function installUi(exports: unknown): void {
        if (uiInstalled) return;
        try {
            const react = modules.get(19), rn = modules.get(17);
            for (const key of ["createElement", "useState", "useEffect"])
                if (typeof dataProperty(react, key) !== "function") throw new Error("React unavailable");
            if (dataProperty(react, "Fragment") === undefined || !rn || typeof rn !== "object" || !exports || typeof exports !== "object")
                throw new Error("UI unavailable");
            const descriptor = Object.getOwnPropertyDescriptor(exports, "default");
            if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" ||
                (!descriptor.configurable && !descriptor.writable)) throw new Error("Overview export immutable");
            let native: NativeUi | null | undefined;
            const resolveNative = (): NativeUi | null => {
                if (native !== undefined) return native;
                if (!navigationReady()) return null;
                try {
                    const parts: Record<string, unknown> = {};
                    for (const key of ["View", "Text", "Pressable", "ScrollView", "Switch", "Modal"]) {
                        const value = Reflect.get(rn, key);
                        if (!value || (typeof value !== "function" && typeof value !== "object")) throw new Error("Native UI unavailable");
                        parts[key] = value;
                    }
                    native = parts as unknown as NativeUi;
                } catch (_) { native = null; report("ui unavailable"); }
                return native;
            };
            const wrapper = createSettingsOverview(react as ReactApi, resolveNative, descriptor.value, settings,
                value => report(`ui ${value}`), navigationReady, features);
            Object.defineProperty(exports, "default", { ...descriptor, value: wrapper });
            uiInstalled = true;
            report("ui installed");
        } catch (_) { report("ui unavailable"); }
    }
    function openSettings(): boolean {
        if (!navigationReady()) return false;
        try {
            // The sole explicit import is this statically traced UI action, only AFTER root navigation reports ready.
            let exports = modules.get(7522);
            if (!exports && requireModule) exports = requireModule(7522);
            const open = dataProperty(exports, "openUserSettings");
            if (typeof open !== "function") return false;
            Reflect.apply(open, exports, [undefined, undefined, { pop: false }]);
            report("smoke requested-settings");
            return true;
        } catch (_) { report("smoke unavailable"); return false; }
    }
    function scheduleSmoke(): void {
        if (!smoke || smokeScheduled || typeof globalThis.setTimeout !== "function" || !modules.has(5183)) return;
        smokeScheduled = true;
        let attempts = 0;
        const attempt = () => {
            if (openSettings()) return;
            if (++attempts < 20) globalThis.setTimeout(attempt, 500);
            else report("smoke unavailable");
        };
        globalThis.setTimeout(attempt, 1000);
    }
    const captures: ModuleCapture[] = [19, 17, 5183, 7522, 1164, 18400].map(id => ({ id,
        onExports(exports, context) {
            modules.set(id, exports);
            if (context.requireModule && !requireModule) requireModule = context.requireModule;
            if (id === 1164) {
                const native = dataProperty(exports, "default");
                try {
                    for (const key of ["getConstants", "fileExists", "readFile", "writeFile"])
                        if (typeof dataProperty(native, key) !== "function") throw new Error("Native shape unavailable");
                    void settings.attach(native);
                } catch (_) { void settings.attach(undefined); }
            }
            if (id === 18400) installUi(exports);
            scheduleSmoke();
        },
    }));
    return { captures, settings, openSettings, get uiInstalled() { return uiInstalled; } };
}
