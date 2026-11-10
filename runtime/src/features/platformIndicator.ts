// Platform Indicator (docs/PHASE4-RESEARCH.md, 4b). The design-system Avatar (module 15449, default export =
// React.memo) receives `user`; PresenceStore.getClientStatus(userId) maps desktop/mobile/web/vr to a status.
// The wrapper always renders the original Avatar element; it only adds an overlay while the feature is on.

export const PLATFORMS = Object.freeze(["desktop", "mobile", "web", "vr"] as const);
export type Platform = typeof PLATFORMS[number];
const STATUS_COLORS: Readonly<Record<string, string>> = Object.freeze({
    online: "#23A55A", idle: "#F0B232", dnd: "#F23F43", streaming: "#593695",
});
const LABELS: Readonly<Record<Platform, string>> = Object.freeze({ desktop: "PC", mobile: "M", web: "W", vr: "VR" });

export interface PlatformState { readonly platform: Platform; readonly color: string; }

/** Known platforms with a visible status, in a fixed order. Unknown keys and offline/invisible are ignored. */
export function platformsOf(clientStatus: unknown): readonly PlatformState[] {
    if (!clientStatus || typeof clientStatus !== "object") return [];
    const result: PlatformState[] = [];
    for (const platform of PLATFORMS) {
        if (!Object.prototype.hasOwnProperty.call(clientStatus, platform)) continue;
        const status = (clientStatus as Record<string, unknown>)[platform];
        const color = typeof status === "string" ? STATUS_COLORS[status] : undefined;
        if (color) result.push(Object.freeze({ platform, color }));
    }
    return result;
}

export interface AvatarReact {
    createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
    useState<T>(initial: T | (() => T)): [T, (value: T) => void];
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
    useRef<T>(initial: T): { current: T };
    memo?: (component: unknown) => unknown;
}
export interface PresenceSource {
    readonly store: object;
    readonly getClientStatus: (...args: unknown[]) => unknown;
    readonly useStateFromStores: (stores: readonly unknown[], getter: () => unknown, deps?: readonly unknown[]) => unknown;
}
export interface AvatarDependencies {
    readonly react: AvatarReact;
    readonly original: unknown;
    /** RN primitives; null until they can be read safely. */
    readonly native: () => { View: unknown; Text: unknown } | null;
    readonly presence: () => PresenceSource | null;
    readonly icons: () => Partial<Record<Platform, unknown>>;
    readonly enabled: () => boolean;
    readonly subscribe: (listener: () => void) => () => void;
    /** Fixed diagnostic labels, each reported once: never user IDs or presence values. */
    readonly onEvent?: (event: "rendered" | "badge") => void;
}

export function createPlatformAvatar(deps: AvatarDependencies): unknown {
    const { react } = deps;
    const h = (type: unknown, props: unknown, ...children: unknown[]) => react.createElement(type, props, ...children);
    const reported = new Set<string>();
    function once(event: "rendered" | "badge"): void {
        if (reported.has(event)) return;
        reported.add(event);
        try { deps.onEvent?.(event); } catch (_) { /* Diagnostics only. */ }
    }
    function DiskPlatformAvatar(props: Record<string, unknown>) {
        const [enabled, setEnabled] = react.useState(() => deps.enabled());
        react.useEffect(() => {
            const unsubscribe = deps.subscribe(() => setEnabled(deps.enabled()));
            setEnabled(deps.enabled());
            return unsubscribe;
        }, []);
        // Only whether the store hook runs is fixed per instance (first render), so the hook count never changes.
        // RN primitives are not hooks and are looked up on every render, so early instances still gain a badge.
        const mode = react.useRef<PresenceSource | null | undefined>(undefined);
        if (mode.current === undefined) mode.current = deps.presence();
        const user = props.user, id = user && typeof user === "object" ? (user as Record<string, unknown>).id : undefined;
        const userId = typeof id === "string" ? id : undefined;
        let status: unknown;
        const presence = mode.current;
        if (presence) {
            const { store, getClientStatus } = presence;
            status = presence.useStateFromStores([store], () => {
                if (!userId) return undefined;
                try { return Reflect.apply(getClientStatus, store, [userId]); } catch (_) { return undefined; }
            }, [userId]);
        }
        const originalElement = h(deps.original, props);
        const native = presence && enabled ? deps.native() : null;
        if (!native) return originalElement;
        once("rendered");
        const platforms = platformsOf(status);
        if (platforms.length) once("badge");
        const { View, Text } = native;
        const icons = platforms.length ? deps.icons() : {};
        const badge = platforms.length === 0 ? null : h(View, {
            pointerEvents: "none", accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants",
            style: { position: "absolute", top: -4, right: -4, flexDirection: "row", alignItems: "center",
                backgroundColor: "#1E1F22", borderRadius: 7, paddingHorizontal: 2, paddingVertical: 1 },
        }, ...platforms.map(({ platform, color }) => {
            const Icon = icons[platform];
            return Icon ? h(Icon, { key: platform, color, style: { width: 10, height: 10, marginHorizontal: 1 } })
                : h(Text, { key: platform, style: { color, fontSize: 8, fontWeight: "700", marginHorizontal: 1 } }, LABELS[platform]);
        }));
        return h(View, { style: { position: "relative" }, pointerEvents: "box-none" }, originalElement, badge);
    }
    const component = typeof react.memo === "function" ? react.memo(DiskPlatformAvatar) : DiskPlatformAvatar;
    copyStatics(deps.original, component);
    return component;
}

/** Keep statics such as displayName on the replacement; never React's own memo fields. Failures are ignored. */
function copyStatics(from: unknown, to: unknown): void {
    if (!from || (typeof from !== "object" && typeof from !== "function") || !to || (typeof to !== "object" && typeof to !== "function")) return;
    for (const key of Object.getOwnPropertyNames(from)) {
        if (key === "$$typeof" || key === "type" || key === "compare" || key === "prototype" || key === "length" || key === "name" ||
            Object.prototype.hasOwnProperty.call(to, key)) continue;
        try {
            const descriptor = Object.getOwnPropertyDescriptor(from, key);
            if (descriptor && "value" in descriptor) Object.defineProperty(to, key, { ...descriptor, configurable: true });
        } catch (_) { /* A non-copyable static is left out. */ }
    }
}
