import { createSettingsController } from "./settings-controller";
import type { BuildFeature } from "./features";
import { createSettingsOverview } from "./ui";
import type { NativeUi, ReactApi } from "./ui";
import type { ModuleCapture } from "../diagnostics/observer";
import { installAnalyticsBlock } from "../features/analytics";
import { installEmojiPickerUnlock, installSendMessageHook, installStickerHooks } from "../features/fakeNitro";
import { createPlatformAvatar } from "../features/platformIndicator";
import { installQuickConfirm } from "../features/venus/quickConfirm";
import { installAlwaysTrust } from "../features/venus/alwaysTrust";
import type { AvatarReact, Platform, PresenceSource } from "../features/platformIndicator";

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

// Platform icon components (docs/PHASE4-RESEARCH.md, 4b): one module per icon, a single named export each.
const ICON_MODULES: ReadonlyArray<{ id: number; name: string; platform: Platform }> = Object.freeze([
    { id: 9515, name: "ScreenIcon", platform: "desktop" },
    { id: 7085, name: "MobilePhoneIcon", platform: "mobile" },
    { id: 9524, name: "GlobeEarthIcon", platform: "web" },
    { id: 16280, name: "VrHeadsetIcon", platform: "vr" },
]);

/** Per-module readiness, not an invented global RN initializer. No scan and no eager boot require. */
export function createCoreModules(onStatus: (status: string) => void, smoke = false, features: readonly BuildFeature[] = []) {
    const modules = new Map<number, unknown>();
    const settings = createSettingsController(status => report(`settings ${status}`));
    const icons: Partial<Record<Platform, unknown>> = {};
    let requireModule: ((id: number) => unknown) | undefined;
    let smokeScheduled = false;
    let uiInstalled = false;
    let stickersInstalled = false;
    let pickerInstalled = false;
    let confirmInstalled = false;
    let trustInstalled = false;
    let native: NativeUi | null | undefined;
    function report(value: string): void { try { onStatus(value); } catch (_) { /* Fixed diagnostics only. */ } }
    function navigationReady(): boolean {
        try {
            const exports = modules.get(5183), getter = dataProperty(exports, "getRootNavigationRef");
            if (typeof getter !== "function") return false;
            const ref = Reflect.apply(getter, exports, []), isReady = dataProperty(ref, "isReady");
            return typeof isReady === "function" && Reflect.apply(isReady, ref, []) === true;
        } catch (_) { return false; }
    }
    /** RN lazy getters are only read once root navigation is ready; the result (or failure) is cached. */
    function resolveNative(): NativeUi | null {
        if (native !== undefined) return native;
        const rn = modules.get(17);
        if (!rn || typeof rn !== "object" || !navigationReady()) return null;
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
    }
    function reactApi(keys: readonly string[]): unknown {
        const react = modules.get(19);
        for (const key of keys) if (typeof dataProperty(react, key) !== "function") return undefined;
        return dataProperty(react, "Fragment") === undefined ? undefined : react;
    }
    function replaceDefault(exports: unknown, wrap: (original: unknown) => unknown): boolean {
        if (!exports || typeof exports !== "object") return false;
        const descriptor = Object.getOwnPropertyDescriptor(exports, "default");
        if (!descriptor || !("value" in descriptor) || descriptor.value === undefined || descriptor.value === null ||
            (!descriptor.configurable && !descriptor.writable)) return false;
        Object.defineProperty(exports, "default", { ...descriptor, value: wrap(descriptor.value) });
        return true;
    }
    function installUi(exports: unknown): void {
        if (uiInstalled) return;
        try {
            const react = reactApi(["createElement", "useState", "useEffect"]);
            if (!react || !modules.get(17)) throw new Error("UI unavailable");
            const descriptor = exports && typeof exports === "object" ? Object.getOwnPropertyDescriptor(exports, "default") : undefined;
            if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") throw new Error("Overview export immutable");
            if (!replaceDefault(exports, original => createSettingsOverview(react as ReactApi, resolveNative, original, settings,
                value => report(`ui ${value}`), navigationReady, features))) throw new Error("Overview export immutable");
            uiInstalled = true;
            report("ui installed");
        } catch (_) { report("ui unavailable"); }
    }
    function presenceSource(): PresenceSource | null {
        const store = dataProperty(modules.get(5744), "default");
        const getClientStatus = dataProperty(store, "getClientStatus");
        const useStateFromStores = dataProperty(modules.get(504), "useStateFromStores");
        if (!store || typeof store !== "object" || typeof getClientStatus !== "function" || typeof useStateFromStores !== "function") return null;
        return { store, getClientStatus: getClientStatus as PresenceSource["getClientStatus"],
            useStateFromStores: useStateFromStores as PresenceSource["useStateFromStores"] };
    }
    function installPlatformIndicator(exports: unknown): void {
        try {
            const react = reactApi(["createElement", "useState", "useEffect", "useRef"]);
            if (!react) throw new Error("React unavailable");
            const ok = replaceDefault(exports, original => createPlatformAvatar({
                react: react as AvatarReact, original,
                native: () => { const ui = resolveNative(); return ui ? { View: ui.View, Text: ui.Text } : null; },
                presence: presenceSource,
                icons: () => icons,
                enabled: () => settings.isEnabled("platformIndicator"),
                subscribe: listener => settings.subscribe(listener),
                onEvent: event => report(`platform-indicator ${event}`),
            }));
            report(ok ? "platform-indicator installed" : "platform-indicator unavailable");
        } catch (_) { report("platform-indicator unavailable"); }
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
    const ids = [19, 17, 5183, 7522, 1164, 18400];
    // Ported Venus features (docs/VENUS-PORT.md): 5941 AlertActionCreators and 1128 intl.
    if (features.includes("quickDelete") || features.includes("noConfirmPin")) ids.push(5941, 1128);
    if (features.includes("alwaysTrust")) ids.push(8894, 8642);
    if (features.includes("disableAnalytics")) ids.push(1267);
    if (features.includes("fakeNitro")) ids.push(7598, 7475, 4953, 1395);
    if (features.includes("platformIndicator")) ids.push(5744, 504, 15449, ...ICON_MODULES.map(icon => icon.id));
    const captures: ModuleCapture[] = ids.map(id => ({ id,
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
            if (id === 1267) report(installAnalyticsBlock(exports) ? "analytics blocked" : "analytics unavailable");
            if (id === 7598) report(installSendMessageHook(exports, () => settings.isEnabled("fakeNitro"),
                () => report("fake-nitro converted"), () => settings.get().nitro)
                ? "fake-nitro installed" : "fake-nitro unavailable");
            if ((id === 7598 || id === 7475) && modules.has(7598) && modules.has(7475) && !stickersInstalled) {
                stickersInstalled = true;
                report(installStickerHooks(modules.get(7475), modules.get(7598), () => settings.isEnabled("fakeNitro"),
                    () => settings.get().nitro, () => report("fake-nitro sticker-linked")) ? "fake-nitro stickers installed" : "fake-nitro stickers unavailable");
            }
            if ((id === 4953 || id === 1395) && modules.has(4953) && modules.has(1395) && !pickerInstalled) {
                pickerInstalled = true;
                report(installEmojiPickerUnlock(modules.get(4953), modules.get(1395), () => settings.isEnabled("fakeNitro"))
                    ? "fake-nitro picker installed" : "fake-nitro picker unavailable");
            }
            if ((id === 5941 || id === 1128) && modules.has(5941) && modules.has(1128) && !confirmInstalled) {
                confirmInstalled = true;
                report(installQuickConfirm(modules.get(5941), modules.get(1128), {
                    quickDelete: () => features.includes("quickDelete") && settings.isExtraEnabled("quickDelete"),
                    noConfirmPin: () => features.includes("noConfirmPin") && settings.isExtraEnabled("noConfirmPin"),
                }, () => report("quick-confirm skipped")) ? "quick-confirm installed" : "quick-confirm unavailable");
            }
            if ((id === 8894 || id === 8642) && modules.has(8894) && modules.has(8642) && !trustInstalled) {
                trustInstalled = true;
                report(installAlwaysTrust(modules.get(8894), modules.get(8642), () => settings.isExtraEnabled("alwaysTrust"))
                    ? "always-trust installed" : "always-trust unavailable");
            }
            if (id === 15449) installPlatformIndicator(exports);
            const icon = ICON_MODULES.find(item => item.id === id);
            if (icon) {
                const component = dataProperty(exports, icon.name);
                if (component && (typeof component === "function" || typeof component === "object")) icons[icon.platform] = component;
            }
            scheduleSmoke();
        },
    }));
    return { captures, settings, openSettings, get uiInstalled() { return uiInstalled; } };
}
