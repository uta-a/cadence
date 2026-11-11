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

export function installQuietReplies(exports: unknown, enabled: () => boolean, onChanged?: () => void): number {
    if (!exports || typeof exports !== "object") return 0;
    let installed = 0;
    for (const key of ["createPendingReply", "createShallowPendingReply"]) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(exports, key);
            if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function"
                || (!descriptor.writable && !descriptor.configurable)) continue;
            const original = descriptor.value as Fn;
            function createReply(this: unknown, ...args: unknown[]): unknown {
                let next = args;
                try {
                    if (enabled()) {
                        const params = quietParams(args[0]);
                        if (params !== args[0]) {
                            next = [params, ...args.slice(1)];
                            try { onChanged?.(); } catch (_) { /* Diagnostics only. */ }
                        }
                    }
                } catch (_) { /* Original arguments on unsupported settings/shape. */ }
                // Do not catch the original: it must run exactly once, even if Discord throws.
                return Reflect.apply(original, this, next);
            }
            Object.defineProperty(exports, key, { ...descriptor, value: createReply });
            installed++;
        } catch (_) { /* Unsupported export: leave it unchanged. */ }
    }
    return installed;
}
