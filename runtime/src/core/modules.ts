import { createSettingsController } from "./settings-controller";
import type { BuildFeature } from "./features";
import { createSettingsOverview } from "./ui";
import type { NativeUi, ReactApi } from "./ui";
import type { ModuleCapture } from "../diagnostics/observer";
import { installAnalyticsBlock } from "../features/analytics";
import { installEmojiPickerUnlock, installSendMessageHook, installStickerHooks } from "../features/fakeNitro";
import { createPlatformAvatar } from "../features/platformIndicator";
import { createPlatformPlacements } from "../features/venus/platformPlacements";
import type { PlatformPlace } from "./settings";
import { installQuickConfirm } from "../features/venus/quickConfirm";
import { installAlwaysTrust } from "../features/venus/alwaysTrust";
import { createJumpToTop } from "../features/venus/jumpToTop";
import { createGestures, wrapExport } from "../features/venus/gestures";
import { installFullImages } from "../features/venus/fullImages";
import { createReadAll } from "../features/venus/readAll";
import { installQuietReplies, pendingReplyState } from "../features/venus/quietReplies";
import { createVoiceDownload } from "../features/venus/voiceDownload";
import { installServerInfo } from "../features/venus/serverInfo";
import type { JumpReact } from "../features/venus/jumpToTop";
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
    let fullImagesInstalled = false;
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
                    presence: presenceSource, icons: () => icons, enabled: () => platformPlaceEnabled(place),
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
                icons: () => icons,
                enabled: () => platformPlaceEnabled("avatars"), suppressContext: getPlatformContext(),
                subscribe: listener => settings.subscribe(listener),
                onEvent: event => report(`platform-indicator ${event}`),
            }));
            report(ok ? "platform-indicator installed" : "platform-indicator unavailable");
        } catch (_) { report("platform-indicator unavailable"); }
    }
    function installJumpToTop(exports: unknown): void {
        try {
            const react = reactApi(["createElement", "cloneElement"]);
            const descriptor = exports && typeof exports === "object" ? Object.getOwnPropertyDescriptor(exports, "default") : undefined;
            if (!react || !descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") throw new Error("unavailable");
            const ok = replaceDefault(exports, original => createJumpToTop({
                react: react as JumpReact, original: original as (...args: unknown[]) => unknown,
                native: () => { const ui = resolveNative(); return ui ? { View: ui.View } : null; },
                chatHeight: () => modules.get(9814),
                messageStore: () => dataProperty(modules.get(6042), "default"),
                messageActions: () => dataProperty(modules.get(7598), "default"),
                pill: () => dataProperty(modules.get(13193), "default"),
                icon: () => modules.get(13194),
                enabled: () => settings.isExtraEnabled("jumpToTop"),
                onEvent: () => report("jump-to-top pressed"),
            }));
            report(ok ? "jump-to-top installed" : "jump-to-top unavailable");
        } catch (_) { report("jump-to-top unavailable"); }
    }
    function installReadAll(exports: unknown): void {
        try {
            const react = reactApi(["createElement", "useState", "useEffect"]);
            if (!react) throw new Error("unavailable");
            const readAll = createReadAll({
                enabled: () => settings.isExtraEnabled("readAll"),
                react: react as Parameters<typeof createReadAll>[0]["react"],
                native: () => { const ui = resolveNative(); return ui ? { View: ui.View, Text: ui.Text, Pressable: ui.Pressable } : null; },
                alert: () => {
                    // react-native's index exports getters, so Alert is read with Reflect.get.
                    const rn = modules.get(17);
                    let alert: unknown;
                    try { alert = rn && typeof rn === "object" ? Reflect.get(rn, "Alert") : undefined; } catch (_) { alert = undefined; }
                    // Alert is a class with a static alert().
                    return alert && (typeof alert === "object" || typeof alert === "function") && typeof Reflect.get(alert, "alert") === "function"
                        ? alert as { alert(title: string, message: string | undefined, buttons: { text: string }[], options?: { cancelable?: boolean }): void } : null;
                },
                module: id => onDemand(id),
                subscribe: listener => settings.subscribe(listener),
                separator: () => dataProperty(dataProperty(modules.get(17768), "FastListRenderSections"), "SEPARATOR"),
                onEvent: name => report(`read-all ${name}`),
            });
            if (!readAll.install(exports)) report("read-all unavailable");
        } catch (_) { report("read-all unavailable"); }
    }
    /**
     * A module for a user action (a tap), loaded on demand if it has not loaded naturally yet. Only called from
     * handlers that run after the app is up, never during boot; failures read as missing.
     */
    function onDemand(id: number): unknown {
        if (modules.has(id)) return modules.get(id);
        if (!requireModule || !navigationReady()) return undefined;
        try { return requireModule(id); } catch (_) { return undefined; }
    }
    const voiceDownload = features.includes("voiceDownload") ? createVoiceDownload({
        enabled: () => settings.isExtraEnabled("voiceDownload"),
        message: (channelId, messageId) => {
            const store = dataProperty(onDemand(6042), "default"), get = dataProperty(store, "getMessage");
            return typeof get === "function" ? Reflect.apply(get, store, [channelId, messageId]) : undefined;
        },
        nativeData: event => {
            const read = dataProperty(onDemand(10105), "getNativeSyntheticEventData");
            return typeof read === "function" ? Reflect.apply(read, undefined, [event]) : undefined;
        },
        download: (url, type, mime) => {
            const media = dataProperty(onDemand(1447), "default");
            const download = media && Reflect.get(media as object, "downloadMediaAssetWithContentType");
            if (typeof download !== "function") throw new Error("unavailable");
            return Reflect.apply(download, media, [url, type, mime]);
        },
        onEvent: event => report(`voice-download ${event}`),
    }) : null;
    const gestureOn = () => settings.isExtraEnabled("gestures");
    const gestures = features.includes("gestures") ? createGestures({
        enabled: gestureOn,
        tripleDelete: () => settings.isExtraEnabled("gestureTripleDelete"),
        currentUser: () => {
            const store = dataProperty(onDemand(1392), "default"), get = store && Reflect.get(store as object, "getCurrentUser");
            return typeof get === "function" ? Reflect.apply(get, store, []) as { id?: unknown } : null;
        },
        canReply: () => dataProperty(onDemand(8365), "canReplyToMessage"),
        reply: () => dataProperty(onDemand(11370), "default"),
        canEdit: () => dataProperty(onDemand(11371), "default"),
        edit: () => dataProperty(onDemand(10117), "handleEdit"),
        undeletable: () => dataProperty(dataProperty(onDemand(1087), "MessageTypesSets"), "UNDELETABLE") as { has?(t: unknown): boolean },
        deleteMessage: () => {
            const actions = dataProperty(onDemand(7598), "default"), remove = actions && Reflect.get(actions as object, "deleteMessage");
            return typeof remove === "function" ? (...args: unknown[]) => Reflect.apply(remove, actions, args) : undefined;
        },
        haptic: () => {
            const haptics = onDemand(5244), trigger = dataProperty(haptics, "triggerHapticFeedback");
            const type = dataProperty(dataProperty(haptics, "HapticFeedbackTypes"), "IMPACT_LIGHT");
            if (typeof trigger === "function" && type !== undefined) Reflect.apply(trigger, undefined, [type]);
        },
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
        now: () => Date.now(),
        onEvent: name => report(`gestures ${name}`),
    }) : null;
    /** Discord's double-tap banners and nudges, rendered as their own element so toggling never changes hook order. */
    function hideWhileGestures(exports: unknown, key: string): boolean {
        const react = reactApi(["createElement"]) as { createElement(type: unknown, props: unknown): unknown } | undefined;
        if (!react) return false;
        return wrapExport(exports, key, original => function DiskHiddenWhileGestures(props: unknown) {
            return gestureOn() ? null : react.createElement(original, props);
        });
    }
    function installGesture(id: number, exports: unknown): void {
        if (!gestures) return;
        let ok: boolean | undefined;
        if (id === 8358) ok = wrapExport(exports, "handleAddDefaultDoubleTapReaction", original =>
            function (this: unknown, ...args: unknown[]) { return gestures.doubleTap(original, this, args); });
        if (id === 11269) {
            const original = dataProperty(exports, "MessagesHandlers");
            const wrapped = typeof original === "function" ? gestures.wrapHandlers(original as (...args: unknown[]) => unknown) : null;
            ok = !!wrapped && wrapExport(exports, "MessagesHandlers", () => wrapped);
        }
        if (id === 9868) ok = wrapExport(exports, "maybeShowDoubleTapReminderToast", original =>
            function (this: unknown, ...args: unknown[]) { return gestureOn() ? undefined : Reflect.apply(original, this, args); });
        if (id === 14023) ok = hideWhileGestures(exports, "DoubleTapEmojiEditNudge");
        if (id === 13207) ok = hideWhileGestures(exports, "DoubleTapToReactChatInputBanner");
        if (ok !== undefined) report(`gestures ${id} ${ok ? "installed" : "unavailable"}`);
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
    // Jump to first message: JumpToPresentButton 13192, its pill 13193 and arrow asset 13194, chat input heights 9814,
    // MessageStore 6042 and MessageActions 7598.
    if (features.includes("jumpToTop")) ids.push(13192, 13193, 13194, 9814, 6042, 7598);
    // Double-tap to reply: DoubleTapToReactUtils 8358, MessagesHandlers 11269, reminder toast 9868, edit nudge 14023,
    // chat input banner 13207, canReplyToMessage 8365, replyToMessage 11370, canEditMessage 11371,
    // LongPressMessageActionSheetUtils 10117, haptics 5244, constants 1087, UserStore 1392, MessageActions 7598.
    if (features.includes("gestures")) ids.push(8358, 11269, 9868, 14023, 13207, 8365, 11370, 11371, 10117, 5244, 1087, 1392, 7598);
    // Load full-quality images: ImageUtils 1498 and AvatarUtils 1417 (same IDs in 351.11).
    if (features.includes("fullImages")) ids.push(1498, 1417);
    // Read all: useGuildsBarProps 17778 and GuildsBarConstants 17768. The read-state stores and actions are loaded
    // when the button is pressed (onDemand).
    if (features.includes("readAll")) ids.push(17778, 17768);
    if (features.includes("quietReplies")) ids.push(10119, 7785);
    if (features.includes("voiceDownload")) ids.push(8165, 11269);
    if (features.includes("serverInfo")) ids.push(17772);
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
            if (id === 13192) installJumpToTop(exports);
            if (id === 17778 && features.includes("readAll")) installReadAll(exports);
            if (id === 10119 && features.includes("quietReplies")) {
                const count = installQuietReplies(exports, () => settings.isExtraEnabled("quietReplies"),
                    () => report("quiet-replies changed"),
                    params => {
                        report(`quiet-replies state-${pendingReplyState(modules.get(7785), params)}`);
                        if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(() => {
                            report(`quiet-replies delayed-${pendingReplyState(modules.get(7785), params)}`);
                        }, 250);
                    });
                report(count === 2 ? "quiet-replies installed" : "quiet-replies unavailable");
            }
            if ((id === 1498 || id === 1417) && modules.has(1498) && modules.has(1417) && !fullImagesInstalled) {
                fullImagesInstalled = true;
                const wrapped = installFullImages(modules.get(1498), modules.get(1417), () => settings.isExtraEnabled("fullImages"),
                    kind => report(`full-images ${kind}`));
                report(wrapped > 0 ? "full-images installed" : "full-images unavailable");
            }
            if (id === 17772 && features.includes("serverInfo")) {
                const ok = installServerInfo(exports, {
                    enabled: () => settings.isExtraEnabled("serverInfo"),
                    guild: id => {
                        const store = dataProperty(onDemand(4877), "default"), get = dataProperty(store, "getGuild");
                        return typeof get === "function" ? Reflect.apply(get, store, [id]) : undefined;
                    },
                    show: (title, message) => {
                        if (!navigationReady()) return false;
                        const rn = modules.get(17);
                        const alert = rn && typeof rn === "object" ? Reflect.get(rn, "Alert") : undefined;
                        if (!alert || (typeof alert !== "object" && typeof alert !== "function")) return false;
                        const show = Reflect.get(alert, "alert");
                        if (typeof show !== "function") return false;
                        Reflect.apply(show, alert, [title, message, [{ text: "閉じる" }], { cancelable: true }]);
                        return true;
                    },
                    onEvent: event => report(`server-info ${event}`),
                });
                if (!ok) report("server-info unavailable");
            }
            if (features.includes("gestures")) installGesture(id, exports);
            if (voiceDownload && id === 8165 && !voiceDownload.installRows(exports)) report("voice-download unavailable");
            if (voiceDownload && id === 11269 && !voiceDownload.installHandlers(exports)) report("voice-download unavailable");
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
