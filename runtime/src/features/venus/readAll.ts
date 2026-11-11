// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0), bootstrap.js "Read all" (a
// ReadAllNotificationsButton port for the mobile server bar), adapted to 352.17.
//
// useGuildsBarProps (17778; 17439 in 351.11) returns {listProps, listDataProps}. The button lives in the SEPARATOR row
// (GuildsBarConstants 17768 FastListRenderSections.SEPARATOR, 6), below the DM button and above the line, so the native
// list's sections and keys stay as they are; only that row grows, through the list's own itemSize. Two settings hooks
// run unconditionally after the original hook. A tap marks servers as read; holding it offers servers,
// DMs, or both. Stores are resolved only when the button is pressed.

export type ReadAllMode = "guilds" | "dms" | "both";
export type ReadAllEvent = "installed" | "cleared" | "nothing" | "failed" | "chooser" | "chooser-unavailable";

interface ReadAllReact {
    createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
    useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void];
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
interface ReadAllNative { View: unknown; Text: unknown; Pressable: unknown }
interface AlertButton { text: string; onPress?: () => void }

export interface ReadAllDeps {
    readonly enabled: () => boolean;
    readonly react: ReadAllReact;
    readonly native: () => ReadAllNative | null;
    /** Discord's Alert, resolved when the button is held. */
    readonly alert: () => { alert(title: string, message: string | undefined, buttons: AlertButton[], options?: { cancelable?: boolean }): void } | null;
    /** A module's exports, loaded on demand: only called from a press. */
    readonly module: (id: number) => unknown;
    /** FastListRenderSections.SEPARATOR, or undefined (6 is used). */
    readonly separator: () => unknown;
    /** Settings changes, so the server bar redraws when Read all is switched. */
    readonly subscribe?: (listener: () => void) => () => void;
    readonly onEvent?: (event: ReadAllEvent) => void;
}

const ROW_HEIGHT = 40;
const DONE_MS = 1400;
const OUTER_STYLE = { height: ROW_HEIGHT, alignItems: "center", justifyContent: "center" };
const WRAP_STYLE = { width: "100%" };
const PILL_STYLE = { minHeight: 26, minWidth: 48, maxWidth: 68, paddingHorizontal: 5, paddingVertical: 3, borderRadius: 13,
    alignItems: "center", justifyContent: "center", backgroundColor: "#4e505899" };
const PILL_PRESSED = { backgroundColor: "#4e5058", transform: [{ scale: 0.96 }] };
const TEXT_STYLE = { color: "#dbdee1", fontSize: 11, fontFamily: "ggsans-Bold, NotoSans-Bold", textAlign: "center", includeFontPadding: false };
const LABEL = "すべて既読";

type Fn = (...args: unknown[]) => unknown;

function own(value: unknown, key: string): unknown {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch (_) { return undefined; }
}
/** A method of a store instance (methods live on the prototype). */
function method(target: unknown, key: string): Fn | null {
    if (!target || typeof target !== "object") return null;
    try {
        const value = Reflect.get(target as object, key);
        return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value as Fn, target, args) : null;
    } catch (_) { return null; }
}
function call(fn: Fn | null, ...args: unknown[]): unknown {
    if (!fn) return undefined;
    try { return fn(...args); } catch (_) { return undefined; }
}
function strings(list: unknown, into: string[], seen: Set<string>): void {
    if (!Array.isArray(list)) return;
    for (const id of list) if (typeof id === "string" && !seen.has(id)) { seen.add(id); into.push(id); }
}

/** Unread server IDs, including muted servers with unread channels (as Discord's own Mark as read). */
export function unreadGuildIds(get: (id: number) => unknown): string[] | null {
    const guildReads = own(get(6846), "default");
    const hasUnread = method(guildReads, "hasUnread"), mentions = method(guildReads, "getMentionCount");
    if (!hasUnread || !mentions) return null;
    const ids: string[] = [], seen = new Set<string>();
    strings(call(method(own(get(6733), "default"), "getFlattenedGuildIds")), ids, seen);
    strings(call(method(own(get(4936), "default"), "lurkingGuildIds")), ids, seen);
    strings(call(method(own(get(4877), "default"), "getGuildIds")), ids, seen);
    const reads = own(get(6803), "default"), eventUnread = method(reads, "hasUnread");
    const eventType = own(get(6737), "GUILD_EVENT") ?? 1;
    const muted = method(guildReads, "getGuildHasUnreadIgnoreMuted");
    return ids.filter(id => call(hasUnread, id) === true || Number(call(mentions, id)) > 0
        || (eventUnread !== null && call(eventUnread, id, eventType) === true) || (muted !== null && call(muted, id) === true));
}

/** Unread DM channel IDs without message requests and spam. */
export function unreadDmIds(get: (id: number) => unknown): string[] | null {
    const privateReads = own(get(15096), "default"), privateSort = own(get(7354), "default");
    const reads = own(get(6803), "default"), unread = method(reads, "hasUnreadOrMentions");
    if (!unread || (!privateReads && !privateSort)) return null;
    const ids: string[] = [], seen = new Set<string>();
    strings(call(method(privateReads, "getUnreadPrivateChannelIds")), ids, seen);
    // PrivateChannelReadStateStore keeps at most 20; PrivateChannelSortStore has every DM.
    strings(call(method(privateSort, "getPrivateChannelIds")), ids, seen);
    const result = ids.filter(id => call(unread, id) === true);
    const filter = own(get(6844), "filterOutMessageRequestsAndSpamById");
    // Never acknowledge requests/spam when the exclusion API is missing or incompatible.
    if (typeof filter !== "function") return null;
    try {
        const kept = filter(result);
        if (!Array.isArray(kept) || !kept.every(id => typeof id === "string" && result.includes(id))) return null;
        return Array.from(new Set(kept)) as string[];
    } catch (_) { return null; }
}

/** Submits Discord's read actions. Counts submitted entries, not confirmed server-side acknowledgements. */
export function markAsRead(mode: ReadAllMode, get: (id: number) => unknown): { guilds: number; dms: number; failed: boolean } {
    let guilds = 0, dms = 0, failed = false;
    if (mode !== "dms") {
        try {
            const ids = unreadGuildIds(get), mark = own(get(15243), "default");
            if (ids === null || (ids.length && typeof mark !== "function")) failed = true;
            else if (ids.length) {
                const section = own(own(get(1087), "AnalyticsSections"), "GUILD_LIST");
                (mark as Fn)(ids, section);
                guilds = ids.length;
            }
        } catch (_) { failed = true; }
    }
    if (mode !== "guilds") {
        try {
            const ids = unreadDmIds(get), bulkAck = own(get(7238), "bulkAck");
            const lastMessage = method(own(get(6803), "default"), "lastMessageId");
            if (ids === null || (ids.length && (typeof bulkAck !== "function" || !lastMessage))) failed = true;
            else if (ids.length) {
                const type = own(get(6737), "CHANNEL") ?? 0;
                const acks: { channelId: string; readStateType: unknown; messageId: unknown }[] = [];
                for (const channelId of ids) {
                    const messageId = call(lastMessage, channelId);
                    // A DM without a known last message can't be acknowledged; sending it fails the whole request.
                    if (messageId) acks.push({ channelId, readStateType: type, messageId });
                }
                if (acks.length) (bulkAck as Fn)(acks);
                dms = acks.length;
            }
        } catch (_) { failed = true; }
    }
    return { guilds, dms, failed };
}

export function createReadAll(deps: ReadAllDeps) {
    const views = new WeakMap<object, unknown>(), data = new WeakMap<object, unknown>();
    const h = (type: unknown, props: unknown, ...children: unknown[]) => deps.react.createElement(type, props, ...children);
    function event(name: ReadAllEvent): void { try { deps.onEvent?.(name); } catch (_) { /* Diagnostics only. */ } }

    function run(mode: ReadAllMode): boolean {
        if (!deps.enabled()) return false;
        const result = markAsRead(mode, deps.module);
        event(result.failed ? "failed" : result.guilds || result.dms ? "cleared" : "nothing");
        return result.guilds + result.dms > 0;
    }
    function choose(after: (cleared: boolean) => void): void {
        const alert = deps.alert();
        if (!alert) { event("chooser-unavailable"); return; }
        event("chooser");
        const option = (text: string, mode: ReadAllMode): AlertButton => ({ text, onPress: () => after(run(mode)) });
        try {
            // Android shows at most three buttons; tapping outside closes the dialog instead of a Cancel button.
            alert.alert("すべて既読にする", undefined, [option("サーバー", "guilds"), option("DM", "dms"),
                option("サーバーとDM", "both")], { cancelable: true });
        } catch (_) { event("chooser-unavailable"); }
    }

    function ReadAllButton(): unknown {
        const ui = deps.native();
        const [doneAt, setDoneAt] = deps.react.useState(0);
        deps.react.useEffect(() => {
            if (!doneAt || typeof globalThis.setTimeout !== "function") return undefined;
            const timer = globalThis.setTimeout(() => setDoneAt(0), DONE_MS);
            return () => { if (typeof globalThis.clearTimeout === "function") globalThis.clearTimeout(timer); };
        }, [doneAt]);
        if (!ui) return null;
        const after = (cleared: boolean) => { if (cleared) setDoneAt(Date.now()); };
        return h(ui.View, { style: OUTER_STYLE, collapsable: false },
            h(ui.Pressable, {
                accessibilityRole: "button", accessibilityLabel: "disk:read-all", accessibilityHint: "長押しで対象を選択",
                hitSlop: 6, delayLongPress: 350, collapsable: false,
                onPress: () => after(run("guilds")), onLongPress: () => choose(after),
                style: ({ pressed }: { pressed?: boolean }) => pressed ? [PILL_STYLE, PILL_PRESSED] : PILL_STYLE,
            }, h(ui.Text, { numberOfLines: 2, allowFontScaling: false, style: TEXT_STYLE }, doneAt ? "✓" : LABEL)));
    }

    /** Wraps the result of useGuildsBarProps; the original runs first with every argument, unchanged. */
    function barProps(result: unknown): unknown {
        if (!deps.enabled() || !result || typeof result !== "object") return result;
        const listDataProps = own(result, "listDataProps") as Record<string, unknown> | undefined;
        if (!listDataProps || typeof listDataProps !== "object" || typeof listDataProps.itemSize !== "function"
            || typeof listDataProps.renderItem !== "function") return result;
        const known = views.get(result);
        if (known) return known;
        let wrapped = data.get(listDataProps);
        if (!wrapped) {
            const separatorValue = deps.separator(), separator = typeof separatorValue === "number" ? separatorValue : 6;
            const itemSize = listDataProps.itemSize as Fn, renderItem = listDataProps.renderItem as Fn;
            wrapped = {
                ...listDataProps,
                itemSize(this: unknown, ...args: unknown[]): unknown {
                    const size = Reflect.apply(itemSize, this, args);
                    return args[0] === separator && typeof size === "number" && deps.enabled() ? size + ROW_HEIGHT : size;
                },
                renderItem(this: unknown, ...args: unknown[]): unknown {
                    const node = Reflect.apply(renderItem, this, args);
                    if (args[0] !== separator || !deps.enabled()) return node;
                    const ui = deps.native();
                    return ui ? h(ui.View, { key: "disk-read-all", style: WRAP_STYLE, collapsable: false }, h(ReadAllButton, null), node) : node;
                },
            };
            data.set(listDataProps, wrapped);
        }
        const view = { ...(result as object), listDataProps: wrapped };
        views.set(result, view);
        return view;
    }

    function useRedrawOnSwitch(): void {
        const [, setShown] = deps.react.useState(() => deps.enabled());
        deps.react.useEffect(() => {
            if (!deps.subscribe) return undefined;
            try { return deps.subscribe(() => { try { setShown(deps.enabled()); } catch (_) { /* Next render. */ } }); } catch (_) { return undefined; }
        }, []);
    }

    /** Replace useGuildsBarProps' `default` (a plain data property). */
    function install(exports: unknown): boolean {
        if (!exports || typeof exports !== "object") return false;
        const descriptor = Object.getOwnPropertyDescriptor(exports, "default");
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || (!descriptor.writable && !descriptor.configurable))
            return false;
        const original = descriptor.value as Fn;
        // The same two hooks run on every call, after Discord's own, so the hook order never changes.
        function useGuildsBarProps(this: unknown, ...args: unknown[]): unknown {
            const result = Reflect.apply(original, this, args);
            useRedrawOnSwitch();
            try { return barProps(result); } catch (_) { return result; }
        }
        try { Object.defineProperty(exports, "default", { ...descriptor, value: useGuildsBarProps }); } catch (_) { return false; }
        event("installed");
        return true;
    }

    return { install, barProps, run, ReadAllButton };
}
