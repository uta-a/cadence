// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0), bootstrap.js `jumpButton`,
// adapted to Discord 352.17 and this runtime.
//
// JumpToPresentButton (351.11: 12920, 352.17: 13192) `default` is a plain function component. The wrapper calls it
// with the same arguments, so Discord's own hooks keep their order, then adds a flipped copy that jumps to the
// first message: next to Discord's "jump to present" button when it is shown, otherwise as Discord's floating pill
// (ChatFloatingNavButton, 352.17: 13193) with Discord's arrow asset (352.17: 13194), flipped upwards.

export interface JumpReact {
    createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
    cloneElement(element: unknown, props?: unknown, ...children: unknown[]): unknown;
}
export interface JumpDependencies {
    readonly react: JumpReact;
    readonly original: (...args: unknown[]) => unknown;
    readonly native: () => { View: unknown } | null;
    /** useChatBottomManagerUIStore (352.17: 9814); its hooks are called on every render, before the original. */
    readonly chatHeight: () => unknown;
    readonly messageStore: () => unknown;
    readonly messageActions: () => unknown;
    readonly pill: () => unknown;
    readonly icon: () => unknown;
    readonly enabled: () => boolean;
    readonly label?: string;
    readonly onEvent?: () => void;
}

const GROUP_STYLE = Object.freeze({ gap: 8 });
const FLIP_STYLE = Object.freeze({ transform: [{ scaleY: -1 }] });

function call(owner: unknown, key: string, args: unknown[]): unknown {
    const fn = owner && (typeof owner === "object" || typeof owner === "function") ? Reflect.get(owner as object, key) : undefined;
    return typeof fn === "function" ? Reflect.apply(fn, owner, args) : undefined;
}

export function createJumpToTop(deps: JumpDependencies): (...args: unknown[]) => unknown {
    const { react } = deps;
    const label = deps.label ?? "最初のメッセージへ移動";
    // Resolved once, at the first render (9814 may load after 13192): the same hooks run on every render, or none at all.
    let hooks: { input: (...a: unknown[]) => unknown; bar: (...a: unknown[]) => unknown } | null | undefined;
    function resolveHooks() {
        if (hooks !== undefined) return hooks;
        const height = deps.chatHeight() as Record<string, unknown> | null | undefined;
        hooks = height && typeof height.useChatInputContainerHeight === "function" && typeof height.useSmallSuggestionBarHeight === "function"
            ? { input: height.useChatInputContainerHeight as (...a: unknown[]) => unknown, bar: height.useSmallSuggestionBarHeight as (...a: unknown[]) => unknown }
            : null;
        return hooks;
    }
    let reported = false;

    return function JumpToPresentButton(this: unknown, ...args: unknown[]): unknown {
        const props = args[0] as Record<string, unknown> | null | undefined;
        const screenIndex = props && typeof props === "object" ? props.screenIndex : undefined;
        const resolved = resolveHooks();
        const inputHeight = resolved ? resolved.input(screenIndex) : undefined;
        const suggestionHeight = resolved ? resolved.bar(screenIndex) : undefined;
        const result = Reflect.apply(deps.original, this, args);
        try {
            const channelId = props && typeof props.channelId === "string" ? props.channelId : undefined;
            const actions = deps.messageActions();
            if (!channelId || !deps.enabled() || !actions) return result;
            let returnMessageId: unknown;
            const messages = call(deps.messageStore(), "getMessages", [channelId]) as Record<string, unknown> | undefined;
            if (messages && typeof messages === "object") {
                if (messages.ready === true && messages.hasMoreBefore === false && typeof messages.length === "number" && messages.length <= 1)
                    return result;
                const last = call(messages, "last", []) as Record<string, unknown> | undefined;
                if (last && typeof last.id === "string") returnMessageId = last.id;
            }
            const onPress = () => {
                // The channel ID as a message ID is the oldest possible position: Discord loads from the start.
                call(actions, "jumpToMessage", [{ channelId, messageId: channelId, flash: true, jumpType: "ANIMATED", returnMessageId }]);
                if (!reported) { reported = true; try { deps.onEvent?.(); } catch (_) { /* Diagnostics only. */ } }
            };
            const native = deps.native();
            if (!native) return result;
            const h = react.createElement.bind(react);
            const child = result && typeof result === "object" ? ((result as { props?: Record<string, unknown> }).props?.children as
                { props?: Record<string, unknown> } | undefined) : undefined;
            if (child && typeof child === "object" && child.props && typeof child.props.onPress === "function") {
                const top = react.cloneElement(child, { key: "disk-jump-top", onPress, accessibilityLabel: label });
                return react.cloneElement(result, { children: h(native.View, { style: GROUP_STYLE },
                    h(native.View, { key: "disk-jump-top-flip", style: FLIP_STYLE }, top), child) });
            }
            const pill = deps.pill(), icon = deps.icon();
            if (result || !pill || icon === undefined || icon === null) return result;
            const bottom = Math.max(0, typeof inputHeight === "number" && Number.isFinite(inputHeight) ? inputHeight : 64) +
                Math.max(0, Number(suggestionHeight) || 0) + 12;
            return h(native.View, { pointerEvents: "box-none", style: { position: "absolute", bottom, right: 16 } },
                h(native.View, { style: FLIP_STYLE }, h(pill, { icon, onPress, accessibilityLabel: label })));
        } catch (_) { return result; }
    };
}
