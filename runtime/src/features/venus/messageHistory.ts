// Adapted from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0),
// bootstrap.js rememberEdit/rememberDeleted/dispatchEvent, commit
// 987b7a22d96d41a0ba80c060b485291e1c7bcc4b. Cadence keeps bounded, session-only text snapshots
// in its own viewer. It never suppresses Discord's deletion/update actions or restores messages to its stores.
export interface HistoryEntry {
    readonly kind: "deleted" | "edited";
    readonly channelId: string; readonly messageId: string; readonly author: string;
    readonly before: string; readonly after?: string; readonly at: number; readonly truncated: boolean;
    readonly guildId?: string;
}
export interface HistorySource {
    list(): readonly HistoryEntry[];
    clear(): void;
    subscribe(listener: () => void): () => void;
}
interface HistoryDeps {
    enabled(): boolean;
    owner(): unknown;
    message(channelId: string, messageId: string): unknown;
    guild(channelId: string): unknown;
    now(): number;
    onEvent?(event: "installed" | "deleted" | "edited" | "cleared"): void;
}
const MAX_ENTRIES = 200, MAX_TEXT = 4000, MAX_TEXT_UNITS = 256 * 1024;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value); }
export function createMessageHistory(deps: HistoryDeps): HistorySource & { capture(event: unknown): false; install(exports: unknown): boolean } {
    let entries: HistoryEntry[] = [], units = 0, owner: string | undefined;
    const listeners = new Set<() => void>();
    function report(event: "installed" | "deleted" | "edited" | "cleared"): void { try { deps.onEvent?.(event); } catch (_) { /* Diagnostics only. */ } }
    function notify(): void { for (const listener of Array.from(listeners)) try { listener(); } catch (_) { /* UI only. */ } }
    function size(entry: HistoryEntry): number { return entry.before.length + (entry.after?.length ?? 0); }
    function clear(): void {
        if (!entries.length) return;
        entries = []; units = 0; notify(); report("cleared");
    }
    function forget(predicate: (entry: HistoryEntry) => boolean): void {
        const next = entries.filter(entry => !predicate(entry));
        if (next.length === entries.length) return;
        entries = next; units = entries.reduce((sum, entry) => sum + size(entry), 0); notify();
    }
    function remember(kind: "deleted" | "edited", channelId: string, messageId: string, update?: string): void {
        const current = deps.message(channelId, messageId);
        if (!object(current) || current.id !== messageId || typeof current.content !== "string" || !current.content.length) return;
        if (kind === "edited" && (update === undefined || current.content === update)) return;
        const before = current.content.slice(0, MAX_TEXT), after = update?.slice(0, MAX_TEXT);
        const last = entries[entries.length - 1];
        if (last && last.kind === kind && last.channelId === channelId && last.messageId === messageId
            && last.before === before && last.after === after) return;
        const author = object(current.author) ? current.author : {};
        const name = typeof author.globalName === "string" ? author.globalName : typeof author.username === "string" ? author.username : "名前未取得";
        let guild: unknown;
        try { guild = deps.guild(channelId); } catch (_) { /* Missing optional guild metadata must not lose the snapshot. */ }
        const at = deps.now();
        const entry: HistoryEntry = Object.freeze({ kind, channelId, messageId, author: name.slice(0, 100), before,
            ...(after !== undefined ? { after } : {}), at: Number.isFinite(at) ? at : Date.now(),
            truncated: current.content.length > MAX_TEXT || (update?.length ?? 0) > MAX_TEXT,
            ...(id(guild) ? { guildId: guild } : {}) });
        entries.push(entry); units += size(entry);
        while (entries.length > MAX_ENTRIES || units > MAX_TEXT_UNITS) units -= size(entries.shift()!);
        notify(); report(kind);
    }
    function capture(event: unknown): false {
        try {
            if (!object(event)) return false;
            if (event.type === "LOGOUT") { clear(); owner = undefined; return false; }
            if (event.type === "CONNECTION_OPEN" && object(event.user) && id(event.user.id)) {
                if (owner && owner !== event.user.id) clear();
                owner = event.user.id;
            }
            if (event.type === "CHANNEL_DELETE") {
                const channelId = object(event.channel) ? event.channel.id : event.channelId ?? event.id;
                if (id(channelId)) forget(entry => entry.channelId === channelId);
            }
            if (event.type === "GUILD_DELETE" && object(event.guild) && !event.guild.unavailable && id(event.guild.id)) {
                const guildId = event.guild.id; forget(entry => entry.guildId === guildId);
            }
            if (!deps.enabled()) { clear(); return false; }
            // No capture until an account is known. Clear immediately on a different account.
            let currentOwner: unknown;
            try { currentOwner = deps.owner(); } catch (_) { clear(); owner = undefined; return false; }
            if (!id(currentOwner)) { clear(); owner = undefined; return false; }
            if (owner && owner !== currentOwner) clear();
            owner = currentOwner;
            if (event.type === "MESSAGE_DELETE" && id(event.channelId) && id(event.id)) remember("deleted", event.channelId, event.id);
            else if (event.type === "MESSAGE_DELETE_BULK" && id(event.channelId) && Array.isArray(event.ids)) {
                for (const messageId of event.ids.slice(0, MAX_ENTRIES)) if (id(messageId)) {
                    try { remember("deleted", event.channelId, messageId); } catch (_) { /* Continue without blocking the bulk action. */ }
                }
            } else if (event.type === "MESSAGE_UPDATE" && object(event.message)) {
                const message = event.message;
                if (id(message.channel_id) && id(message.id) && typeof message.content === "string" && message.edited_timestamp)
                    remember("edited", message.channel_id, message.id, message.content);
            }
        } catch (_) { /* Never throw into Discord's dispatcher or consume an action. */ }
        return false;
    }
    let installed = false;
    function install(exports: unknown): boolean {
        if (installed) return true;
        try {
            if (!object(exports)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(exports, "default");
            const dispatcher = descriptor && "value" in descriptor ? descriptor.value : undefined;
            if (!object(dispatcher)) return false;
            const add = Reflect.get(dispatcher, "addInterceptor");
            if (typeof add !== "function") return false;
            Reflect.apply(add, dispatcher, [capture]);
            installed = true; report("installed"); return true;
        } catch (_) { return false; }
    }
    return { capture, install, clear, list: () => Object.freeze(entries.slice().reverse()),
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
