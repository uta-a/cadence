// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0), bootstrap.js `quickConfirm`,
// adapted to Discord 352.17 and this runtime. "Skip pin confirmation" is based on NoConfirmPin by Skamt.
//
// AlertActionCreators (351.11: 5400, 352.17: 5941) `default.show(popup)` opens Discord's confirmation alerts.
// Only alerts whose title, body or child text equals one of Discord's own localized strings below are confirmed
// directly; every other alert (leave server, ban, channel, account, ...) is shown exactly as before.

/** Localized message keys in Discord's intl table (module 1128 `t`), unchanged between 351.11 and 352.17. */
export const DELETE_KEYS = Object.freeze(["AMvpS4", "vXZ+Fo"]);
export const PIN_KEYS = Object.freeze(["WG5dyo", "NjEPp7"]);

interface Intl { readonly intl: { string(token: unknown): unknown }; readonly t: Record<string, unknown>; }

/** The plain strings inside an alert's children (a few levels of React elements). */
export function alertTexts(node: unknown, out: string[], depth = 0): string[] {
    if (node === null || node === undefined || depth > 5) return out;
    if (typeof node === "string") { out.push(node); return out; }
    if (Array.isArray(node)) { for (let i = 0; i < node.length && i < 20; i++) alertTexts(node[i], out, depth + 1); return out; }
    const props = typeof node === "object" ? (node as { props?: Record<string, unknown> }).props : undefined;
    if (props && typeof props === "object") {
        alertTexts(props.children, out, depth + 1);
        if (typeof props.title === "string") out.push(props.title);
    }
    return out;
}

export function installQuickConfirm(alerts: unknown, intlModule: unknown,
    enabled: { quickDelete(): boolean; noConfirmPin(): boolean }, onSkipped: () => void = () => {}): boolean {
    if (!alerts || typeof alerts !== "object" || !intlModule || typeof intlModule !== "object") return false;
    const holder = Object.getOwnPropertyDescriptor(alerts, "default");
    const target = holder && "value" in holder ? holder.value : undefined;
    const descriptor = target && typeof target === "object" ? Object.getOwnPropertyDescriptor(target, "show") : undefined;
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" ||
        (!descriptor.writable && !descriptor.configurable)) return false;
    const intl = intlModule as Partial<Intl>;
    if (!intl.intl || typeof intl.intl.string !== "function" || !intl.t || typeof intl.t !== "object") return false;
    const original = descriptor.value as (...args: unknown[]) => unknown;

    function label(key: string): string | null {
        try {
            const token = (intl.t as Record<string, unknown>)[key];
            const text = token === undefined ? undefined : intl.intl!.string(token);
            return typeof text === "string" && text.length > 3 ? text : null;
        } catch (_) { return null; }
    }

    function show(this: unknown, ...args: unknown[]): unknown {
        try {
            const popup = args[0] as Record<string, unknown> | null;
            if (popup && typeof popup === "object" && typeof popup.onConfirm === "function") {
                const children = popup.children as { props?: Record<string, unknown> } | undefined;
                const title = children && typeof children === "object" && children.props ? children.props.title : undefined;
                const texts = [title, popup.body].filter((text): text is string => typeof text === "string");
                const matches = (key: string) => { const text = label(key); return text !== null && texts.includes(text); };
                if (enabled.quickDelete() && DELETE_KEYS.some(matches)) {
                    onSkipped();
                    return (popup.onConfirm as () => unknown)();
                }
                if (enabled.noConfirmPin()) {
                    alertTexts(popup.children, texts);
                    if (PIN_KEYS.some(matches)) {
                        onSkipped();
                        return (popup.onConfirm as () => unknown)();
                    }
                }
            }
        } catch (_) { /* Show Discord's alert as usual. */ }
        return Reflect.apply(original, this, args);
    }
    Object.defineProperty(target, "show", { ...descriptor, value: show });
    return true;
}
