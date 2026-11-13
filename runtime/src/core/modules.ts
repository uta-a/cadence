import { createSettingsController } from "./settings-controller";
import type { BuildFeature } from "./features";
import { createSettingsOverview } from "./ui";
import type { DiscordUi, NativeUi, ReactApi } from "./ui";
import type { ModuleCapture } from "../diagnostics/observer";
import { installAnalyticsBlock } from "../features/analytics";
import { installEmojiPickerUnlock, installSendMessageHook, installStickerHooks } from "../features/fakeNitro";
import { createPlatformAvatar } from "../features/platformIndicator";
import { createPlatformPlacements } from "../features/platformPlacements";
import type { PlatformPlace } from "./settings";
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

// Discord's settings components (design/components/TableRow/native and Button/native), loaded when the Cadence UI renders.
const DISCORD_UI_MODULES: ReadonlyArray<{ id: number; name: keyof DiscordUi }> = Object.freeze([
    { id: 7019, name: "TableRowGroup" }, { id: 6935, name: "TableRow" }, { id: 7327, name: "TableSwitchRow" },
    { id: 7017, name: "TableRadioGroup" }, { id: 7016, name: "TableRadioRow" }, { id: 5276, name: "Button" },
]);

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
            try {
                const height = Reflect.get(Reflect.get(rn, "StatusBar") as object, "currentHeight");
                if (typeof height === "number" && height >= 0 && height < 200) native.statusBarHeight = height;
            } catch (_) { /* The header then starts at the top edge. */ }
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
                value => report(`ui ${value}`), navigationReady, features, discordUi))) throw new Error("Overview export immutable");
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
    let platformContext: unknown;
    let placements: ReturnType<typeof createPlatformPlacements> | undefined;
    function getPlatformContext(): unknown {
        if (platformContext) return platformContext;
        const react = reactApi(["createContext", "useContext"]);
        const create = dataProperty(react, "createContext");
        if (typeof create === "function") platformContext = Reflect.apply(create, react, [false]);
        return platformContext;
    }
    function platformPlaceEnabled(place: PlatformPlace): boolean {
        return settings.isEnabled("platformIndicator") && settings.get().platform[place];
    }
    function platformPlacements(): ReturnType<typeof createPlatformPlacements> | undefined {
        if (placements) return placements;
        const react = reactApi(["createElement", "cloneElement", "useState", "useEffect", "useRef"]);
        const context = getPlatformContext(), provider = dataProperty(context, "Provider");
        if (!react || !provider) return undefined;
        const badges = new Map<string, unknown>();
        placements = createPlatformPlacements({
            react: react as Parameters<typeof createPlatformPlacements>[0]["react"], provider,
            native: () => { const ui = resolveNative(); return ui ? { View: ui.View, Text: ui.Text } : null; },
            enabled: platformPlaceEnabled, subscribe: listener => settings.subscribe(listener),
            channel: id => {
                const store = dataProperty(modules.get(4855), "default"), get = dataProperty(store, "getChannel");
                return typeof get === "function" ? Reflect.apply(get, store, [id]) : undefined;
            },
            status: id => {
                const source = presenceSource();
                return source ? Reflect.apply(source.getClientStatus, source.store, [id]) : undefined;
            },
            badge: place => {
                if (!badges.has(place)) badges.set(place, createPlatformAvatar({
                    react: react as AvatarReact, original: null, inline: true,
                    native: () => { const ui = resolveNative(); return ui ? { View: ui.View, Text: ui.Text } : null; },
                    presence: presenceSource, icons: platformIcons, enabled: () => platformPlaceEnabled(place),
                    userId: props => typeof props.userId === "string" ? props.userId : undefined,
                    subscribe: listener => settings.subscribe(listener),
                    onEvent: event => { if (event === "badge") report(`platform-indicator ${place} badge`); },
                }));
                return badges.get(place);
            },
            onEvent: place => report(`platform-indicator ${place} rendered`),
        });
        return placements;
    }
    function installPlatformIndicator(exports: unknown): void {
        try {
            const react = reactApi(["createElement", "useState", "useEffect", "useRef"]);
            if (!react) throw new Error("React unavailable");
            const ok = replaceDefault(exports, original => createPlatformAvatar({
                react: react as AvatarReact, original,
                native: () => { const ui = resolveNative(); return ui ? { View: ui.View, Text: ui.Text } : null; },
                presence: presenceSource,
                icons: platformIcons,
                enabled: () => platformPlaceEnabled("avatars"), suppressContext: getPlatformContext(),
                subscribe: listener => settings.subscribe(listener),
                onEvent: event => report(`platform-indicator ${event}`),
            }));
            report(ok ? "platform-indicator installed" : "platform-indicator unavailable");
        } catch (_) { report("platform-indicator unavailable"); }
    }
    /**
     * A module loaded on demand if it has not loaded naturally yet. Only called while rendering after root navigation
     * is ready, never during boot; failures read as missing.
     */
    function onDemand(id: number): unknown {
        if (modules.has(id)) return modules.get(id);
        if (!requireModule || !navigationReady()) return undefined;
        try { return requireModule(id); } catch (_) { return undefined; }
    }
    /** Discord's platform icons are separate lazy modules that may not have loaded yet; load the missing ones once needed. */
    function platformIcons(): Partial<Record<Platform, unknown>> {
        for (const icon of ICON_MODULES) {
            if (icons[icon.platform]) continue;
            const component = dataProperty(onDemand(icon.id), icon.name);
            if (component && (typeof component === "function" || typeof component === "object")) icons[icon.platform] = component;
        }
        return icons;
    }
    const discordComponents: DiscordUi = {};
    function discordUi(): DiscordUi {
        for (const item of DISCORD_UI_MODULES) {
            if (discordComponents[item.name]) continue;
            const component = dataProperty(onDemand(item.id), item.name);
            if (component && (typeof component === "function" || typeof component === "object")) discordComponents[item.name] = component;
        }
        return discordComponents;
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
    if (features.includes("disableAnalytics")) ids.push(1267);
    if (features.includes("fakeNitro")) ids.push(7598, 7475, 4953, 1395);
    if (features.includes("platformIndicator")) ids.push(5744, 504, 15449, 4855, 10659, 11110, 14049, 17499, 9196, 8165, 17494, 8778,
        ...ICON_MODULES.map(icon => icon.id));
    const captures: ModuleCapture[] = Array.from(new Set(ids)).map(id => ({ id,
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
            if (id === 7598 && features.includes("fakeNitro")) report(installSendMessageHook(exports, () => settings.isEnabled("fakeNitro"),
                () => report("fake-nitro converted"), () => settings.get().nitro)
                ? "fake-nitro installed" : "fake-nitro unavailable");
            if (features.includes("fakeNitro") && (id === 7598 || id === 7475) && modules.has(7598) && modules.has(7475) && !stickersInstalled) {
                stickersInstalled = true;
                report(installStickerHooks(modules.get(7475), modules.get(7598), () => settings.isEnabled("fakeNitro"),
                    () => report("fake-nitro sticker-linked")) ? "fake-nitro stickers installed" : "fake-nitro stickers unavailable");
            }
            if ((id === 4953 || id === 1395) && modules.has(4953) && modules.has(1395) && !pickerInstalled) {
                pickerInstalled = true;
                report(installEmojiPickerUnlock(modules.get(4953), modules.get(1395), () => settings.isEnabled("fakeNitro"))
                    ? "fake-nitro picker installed" : "fake-nitro picker unavailable");
            }
            if (id === 15449) installPlatformIndicator(exports);
            if (features.includes("platformIndicator") && [10659, 11110, 14049, 17499, 9196, 8165, 17494, 8778].includes(id)) {
                try {
                    const runtime = platformPlacements();
                    const ok = id === 17494 ? ["MessagesItemChannelFast", "MessagesItemChannelFlash", "MessagesItemChannelLegend"]
                        .map(key => runtime?.installScope(exports, key)).every(Boolean)
                        : id === 8778 ? runtime?.installScope(exports)
                        : id === 11110 ? runtime?.installProfile(exports) : id === 8165 ? runtime?.installMessages(exports)
                        : runtime?.install(exports, id === 14049 ? "dmHeader" : id === 17499 ? "dmList" : "memberList",
                            id === 9196 ? "MemberRowItem" : "default");
                    report(ok ? "platform-indicator placement installed" : "platform-indicator placement unavailable");
                } catch (_) { report("platform-indicator placement unavailable"); }
            }
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
