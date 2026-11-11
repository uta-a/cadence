// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0),
// bootstrap.js "Reply without pinging", commit 987b7a22d96d41a0ba80c060b485291e1c7bcc4b.
// Adapted to Discord 352.17 PendingReplyActionCreators 10119. Only the initial mention is changed;
// setPendingReplyShouldMention remains untouched so Discord's per-reply toggle still works.

type Fn = (...args: unknown[]) => unknown;

/** Quiet server/group-DM replies; unknown channels and one-to-one DMs keep Discord's behavior. */
function quietParams(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    try {
        const params = Object.getOwnPropertyDescriptors(value);
        if (!params.channel || !("value" in params.channel) || !params.channel.value
            || (params.shouldMention && (!("value" in params.shouldMention) || params.shouldMention.value === false))) return value;
        const channel = params.channel.value;
        if (typeof channel !== "object") return value;
        const guild = Reflect.get(channel, "guild_id"), type = Reflect.get(channel, "type");
        if (!(typeof guild === "string" && guild.length > 0) && type !== 3) return value;
        // Preserve other properties without invoking accessors or mutating the caller's params.
        params.shouldMention = { value: false, writable: true, enumerable: true, configurable: true };
        return Object.create(Object.getPrototypeOf(value), params);
    } catch (_) { return value; }
}

export type PendingReplyState = "quiet" | "mention" | "missing" | "unavailable";

/** User-action diagnostic only: reads the already-loaded store without importing it or logging account data. */
export function pendingReplyState(exports: unknown, params: unknown): PendingReplyState {
    try {
        if (!exports || typeof exports !== "object" || !params || typeof params !== "object") return "unavailable";
        const storeDescriptor = Object.getOwnPropertyDescriptor(exports, "default");
        const channelDescriptor = Object.getOwnPropertyDescriptor(params, "channel");
        if (!storeDescriptor || !("value" in storeDescriptor) || !channelDescriptor || !("value" in channelDescriptor))
            return "unavailable";
        const store = storeDescriptor.value, channel = channelDescriptor.value;
        if (!store || typeof store !== "object" || !channel || typeof channel !== "object") return "unavailable";
        const id = Reflect.get(channel, "id"), getReply = Reflect.get(store, "getPendingReply");
        if (typeof id !== "string" || !id || typeof getReply !== "function") return "unavailable";
        const reply = Reflect.apply(getReply, store, [id]);
        if (reply == null) return "missing";
        if (typeof reply !== "object") return "unavailable";
        const mention = Object.getOwnPropertyDescriptor(reply, "shouldMention");
        if (!mention || !("value" in mention)) return "unavailable";
        return mention.value === false ? "quiet" : mention.value === true ? "mention" : "unavailable";
    } catch (_) { return "unavailable"; }
}

export function installQuietReplies(exports: unknown, enabled: () => boolean, onChanged?: () => void,
    onCreated?: (params: unknown) => void): number {
    if (!exports || typeof exports !== "object") return 0;
    let installed = 0;
    // Isolate each original in a function invocation, not a loop-scoped binding. On Android's eval path,
    // this fixes missing normal replies observed with the loop-created wrappers (docs/VENUS-PORT.md).
    function wrap(original: Fn): Fn {
        return function createReply(this: unknown, ...args: unknown[]): unknown {
            let next = args;
            try {
                if (enabled()) {
                    const params = quietParams(args[0]);
                    if (params !== args[0]) next = [params, ...args.slice(1)];
                }
            } catch (_) { /* Original arguments on unsupported settings/shape. */ }
            const result = Reflect.apply(original, this, next);
            if (next !== args) { try { onChanged?.(); } catch (_) { /* Diagnostics only. */ } }
            try { onCreated?.(next[0]); } catch (_) { /* Diagnostics cannot change Discord's return value. */ }
            return result;
        };
    }
    for (const key of ["createPendingReply", "createShallowPendingReply"]) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(exports, key);
            if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function"
                || (!descriptor.writable && !descriptor.configurable)) continue;
            Object.defineProperty(exports, key, { ...descriptor, value: wrap(descriptor.value as Fn) });
            installed++;
        } catch (_) { /* Unsupported export: leave it unchanged. */ }
    }
    return installed;
}
