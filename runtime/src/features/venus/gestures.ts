// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0), bootstrap.js message tap
// gestures (Venus: "a port of Geastures+ by kmmiio99o"), adapted to Discord 352.17 and this runtime.
//
// Every double-tap on a message reaches DoubleTapToReactUtils (351.11: 8254, 352.17: 8358)
// `handleAddDefaultDoubleTapReaction(message, channel, ...)`. While enabled it replies instead, or edits your own
// message, through the same actions as swiping: replyToMessage (352.17: 11370) and
// LongPressMessageActionSheetUtils.handleEdit (352.17: 10117). Where neither is allowed, Discord's own reaction runs.
// With triple-tap delete on, a third tap on your own message deletes it through MessageActions.deleteMessage.
// MessagesHandlers (352.17: 11269) is wrapped so a single tap right after a double-tap can be recognised, and so
// only real double-taps (not TalkBack's quick reaction action) are taken over.

export const TRIPLE_MS = 650, PAIR_MS = 1500, DELETED_MS = 3000;

export interface GestureDependencies {
    readonly enabled: () => boolean;
    readonly tripleDelete: () => boolean;
    readonly currentUser: () => { id?: unknown } | null | undefined;
    readonly canReply: () => unknown;
    readonly reply: () => unknown;
    readonly canEdit: () => unknown;
    readonly edit: () => unknown;
    readonly undeletable: () => { has?(type: unknown): boolean } | null | undefined;
    readonly deleteMessage: () => unknown;
    readonly haptic: () => void;
    readonly setTimeout: (fn: () => void, ms: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
    readonly now: () => number;
    readonly onEvent?: (event: "reply" | "edit" | "delete" | "fallback") => void;
}

type Message = { id?: unknown; author?: { id?: unknown }; state?: unknown; type?: unknown; channel_id?: unknown } | null | undefined;
type Channel = { id?: unknown } | null | undefined;

export function createGestures(deps: GestureDependencies) {
    const state = {
        timer: undefined as unknown, pending: null as Message, channel: null as Channel, chatInputRef: null as unknown, pendingAt: 0,
        deleted: null as unknown, deletedAt: 0, handlers: null as Record<string, unknown> | null, tapping: 0, sawDoubleTap: false,
    };
    function event(name: "reply" | "edit" | "delete" | "fallback"): void { try { deps.onEvent?.(name); } catch (_) { /* Diagnostics only. */ } }
    function cancel(): void {
        if (state.timer !== undefined) { try { deps.clearTimeout(state.timer); } catch (_) { /* Already fired. */ } }
        state.timer = undefined; state.pending = null; state.channel = null; state.chatInputRef = null;
    }
    function own(message: Message): boolean {
        const user = deps.currentUser();
        return !!(user && message && message.author && message.author.id === user.id);
    }
    function chatInputRef(channel: Channel): unknown {
        const params = state.handlers && state.handlers.params as Record<string, unknown> | undefined;
        if (!params || typeof params !== "object") return null;
        if (channel && params.selectedChannelId && String(params.selectedChannelId) !== String(channel.id)) return null;
        return params.chatInputRef ?? null;
    }
    function stillInChat(channel: Channel): boolean {
        const params = state.handlers && state.handlers.params as Record<string, unknown> | undefined;
        const selected = params && params.selectedChannelId;
        return !selected || !channel || String(selected) === String(channel.id);
    }
    function doReply(message: Message, channel: Channel, ref: unknown): boolean {
        const canReply = deps.canReply();
        if (typeof canReply === "function") { try { if (!canReply(channel, message)) return false; } catch (_) { /* Allow. */ } }
        const reply = deps.reply();
        if (typeof reply !== "function") return false;
        try { deps.haptic(); reply({ message, channel, chatInputRef: ref, actionSource: "message_swipe", invertible: true }); event("reply"); return true; }
        catch (_) { return false; }
    }
    function doEdit(message: Message, channel: Channel, ref: unknown): boolean {
        const canEdit = deps.canEdit(), user = deps.currentUser();
        try { if (typeof canEdit === "function" && !canEdit(message, user && user.id)) return false; } catch (_) { return false; }
        const edit = deps.edit();
        if (typeof edit !== "function") return false;
        try { deps.haptic(); edit(message, channel, ref, "message_swipe", true); event("edit"); return true; } catch (_) { return false; }
    }
    /** Only what Discord's own hold menu offers Delete for: sent, yours, and not a type Discord keeps. */
    function canDelete(message: Message): boolean {
        if (!message || (message.state && message.state !== "SENT") || !own(message)) return false;
        try { const sets = deps.undeletable(); if (sets && typeof sets.has === "function" && sets.has(message.type)) return false; } catch (_) { /* Allow. */ }
        return true;
    }
    function doDelete(message: Message, channel: Channel): boolean {
        if (!canDelete(message)) return false;
        const remove = deps.deleteMessage();
        if (typeof remove !== "function") return false;
        try {
            deps.haptic();
            const result = remove((channel && channel.id) || message!.channel_id, message!.id, false) as { catch?: (f: () => void) => void } | undefined;
            if (result && typeof result.catch === "function") result.catch(() => {});
            event("delete");
            return true;
        } catch (_) { return false; }
    }
    function deletePending(now: number): void {
        const message = state.pending, channel = state.channel;
        cancel();
        state.deleted = message && message.id; state.deletedAt = now;
        doDelete(message, channel);
    }
    function act(message: Message, channel: Channel, ref: unknown, fallback: () => unknown): void {
        if (!message || !channel) return;
        if (own(message) && doEdit(message, channel, ref)) return;
        if (doReply(message, channel, ref)) return;
        event("fallback");
        try { fallback(); } catch (_) { /* Nothing else to do. */ }
    }

    /** Wrapper for handleAddDefaultDoubleTapReaction. */
    function doubleTap(original: (...args: unknown[]) => unknown, self: unknown, args: unknown[]): unknown {
        // Only real double-taps, once the wrapped handler has shown it sees them. In 352.17 the native double-tap can
        // reach this function without going through the wrapped handleDoubleTapMessage; then every call is a double-tap.
        if (!deps.enabled() || (state.sawDoubleTap && !state.tapping)) return Reflect.apply(original, self, args);
        const message = args[0] as Message, channel = args[1] as Channel, id = message && message.id;
        if (!id) return Reflect.apply(original, self, args);
        const now = deps.now(), ref = chatInputRef(channel), react = () => Reflect.apply(original, self, args);
        if (state.deleted === id && now - state.deletedAt < DELETED_MS) { cancel(); return undefined; }
        const triple = deps.tripleDelete();
        if (state.pending && state.pending.id === id && now - state.pendingAt < PAIR_MS) {
            if (triple && canDelete(message)) { state.channel = channel; deletePending(now); return undefined; }
            cancel(); act(message, channel, ref, react);
            return undefined;
        }
        cancel();
        if (!triple || !canDelete(message)) { act(message, channel, ref, react); return undefined; }
        state.pending = message; state.channel = channel; state.chatInputRef = ref; state.pendingAt = now;
        state.timer = deps.setTimeout(() => {
            state.timer = undefined;
            const waiting = state.pending, waitingChannel = state.channel, waitingRef = state.chatInputRef;
            state.pending = null; state.channel = null; state.chatInputRef = null;
            if (waiting === message && deps.enabled() && stillInChat(waitingChannel)) act(message, waitingChannel, waitingRef, react);
        }, TRIPLE_MS);
        return undefined;
    }

    /** A single tap on the message that was just double-tapped is the third tap. */
    function tap(eventArg: unknown): boolean {
        if (!deps.enabled() || !deps.tripleDelete() || !state.pending) return false;
        const data = eventArg && typeof eventArg === "object" ? (eventArg as { nativeEvent?: { messageId?: unknown } }).nativeEvent : undefined;
        const id = data && data.messageId, now = deps.now();
        if (id === null || id === undefined || String(id) !== String(state.pending.id) || now - state.pendingAt >= PAIR_MS) return false;
        deletePending(now);
        return true;
    }

    /** MessagesHandlers defines its handlers on each instance in its constructor; wrap the instance after construction. */
    function wrapHandlers(Handlers: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
        function MessagesHandlers(this: unknown, ...args: unknown[]): unknown {
            const handlers = Reflect.construct(Handlers, args, new.target || MessagesHandlers) as Record<string, unknown>;
            state.handlers = handlers;
            const single = handlers && handlers.handleTapMessage;
            if (typeof single === "function") handlers.handleTapMessage = function (this: unknown, ...tapArgs: unknown[]) {
                state.handlers = handlers;
                try { if (tap(tapArgs[0])) return undefined; } catch (_) { /* Discord's tap. */ }
                return Reflect.apply(single, this, tapArgs);
            };
            const double = handlers && handlers.handleDoubleTapMessage;
            if (typeof double === "function") handlers.handleDoubleTapMessage = function (this: unknown, ...tapArgs: unknown[]) {
                state.handlers = handlers;
                state.sawDoubleTap = true;
                state.tapping++;
                try { return Reflect.apply(double, this, tapArgs); } finally { state.tapping--; }
            };
            return handlers;
        }
        MessagesHandlers.prototype = (Handlers as { prototype?: unknown }).prototype;
        try { Object.setPrototypeOf(MessagesHandlers, Handlers); } catch (_) { /* Statics stay reachable through the prototype. */ }
        return MessagesHandlers as unknown as (...args: unknown[]) => unknown;
    }

    return { doubleTap, tap, wrapHandlers, cancel, state };
}

/** Replace a plain-data function export with a wrapper; false (and nothing changed) when the shape is unexpected. */
export function wrapExport(exports: unknown, key: string, wrap: (original: (...args: unknown[]) => unknown) => unknown): boolean {
    if (!exports || typeof exports !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(exports, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || (!descriptor.writable && !descriptor.configurable))
        return false;
    Object.defineProperty(exports, key, { ...descriptor, value: wrap(descriptor.value as (...args: unknown[]) => unknown) });
    return true;
}
