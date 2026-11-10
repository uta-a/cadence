// Fake Nitro (docs/PHASE4-RESEARCH.md, 4a). Discord's own parser already classifies custom emojis the user
// cannot send as `message.invalidEmojis`, while leaving `<:name:id>` in `message.content`. Only those emojis
// are rewritten into CDN image links; emojis the user can send are left exactly as typed.

export const MAX_CONTENT_LENGTH = 2000;
export const EMOJI_SIZE = 48;
const TOKEN = /<(a?):([A-Za-z0-9_~]{1,64}):([0-9]{1,25})>/;

interface Locked { readonly animated: boolean; readonly name: string; }

export function emojiUrl(id: string, animated: boolean, name: string, size = EMOJI_SIZE): string {
    return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=${size}&name=${encodeURIComponent(name)}`;
}

function lockedEmojis(list: readonly unknown[]): Map<string, Locked> {
    const result = new Map<string, Locked>();
    for (const emoji of list) {
        if (!emoji || typeof emoji !== "object") continue;
        const record = emoji as Record<string, unknown>;
        const id = record.id, name = typeof record.originalName === "string" ? record.originalName : record.name;
        if (typeof id !== "string" || !/^[0-9]{1,25}$/.test(id) || typeof name !== "string") continue;
        result.set(id, { animated: record.animated === true, name });
    }
    return result;
}

/**
 * A new message with the locked custom emojis linked, or null to send the original unchanged: nothing to do,
 * an unexpected shape, or a result over Discord's length limit (Discord then shows its usual notice).
 * Emojis that were not rewritten stay in `invalidEmojis`, so Discord still reports them.
 */
export function convertMessage(message: unknown, size = EMOJI_SIZE): Record<string, unknown> | null {
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const original = message as Record<string, unknown>;
    const content = original.content, invalid = original.invalidEmojis;
    if (typeof content !== "string" || !Array.isArray(invalid) || invalid.length === 0) return null;
    const locked = lockedEmojis(invalid);
    if (locked.size === 0) return null;
    const replaced = new Set<string>();
    let out = "", last = 0;
    // A fresh global copy per call: no shared lastIndex state between messages.
    const pattern = new RegExp(TOKEN.source, "g");
    for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
        const id = match[3], emoji = locked.get(id), start = match.index;
        if (!emoji) continue;
        out += content.slice(last, start);
        const before = out.length > 0 && !/\s$/.test(out) ? " " : "";
        const next = content.charAt(start + match[0].length);
        const after = next && !/\s/.test(next) ? " " : "";
        out += before + emojiUrl(id, match[1] === "a" || emoji.animated, emoji.name, size) + after;
        last = start + match[0].length;
        replaced.add(id);
    }
    if (replaced.size === 0) return null;
    out += content.slice(last);
    if (out.length > MAX_CONTENT_LENGTH) return null;
    const remaining = invalid.filter(emoji => {
        const id = emoji && typeof emoji === "object" ? (emoji as Record<string, unknown>).id : undefined;
        return !(typeof id === "string" && replaced.has(id));
    });
    return { ...original, content: out, invalidEmojis: remaining };
}

/**
 * Wrap `exports.default.sendMessage` (module 7598). The original is always called, with the converted message
 * only while the feature is enabled; any conversion failure falls back to the original arguments.
 */
export function installSendMessageHook(exports: unknown, enabled: () => boolean, onConverted: () => void = () => {}): boolean {
    if (!exports || typeof exports !== "object") return false;
    const holder = Object.getOwnPropertyDescriptor(exports, "default");
    const target = holder && "value" in holder ? holder.value : undefined;
    if (!target || typeof target !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(target, "sendMessage");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return false;
    if (!descriptor.writable && !descriptor.configurable) return false;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    let reported = false;
    function sendMessage(this: unknown, ...args: unknown[]): unknown {
        let call = args;
        try {
            if (enabled()) {
                const converted = convertMessage(args[1]);
                if (converted) {
                    call = args.slice();
                    call[1] = converted;
                    if (!reported) { reported = true; try { onConverted(); } catch (_) { /* Diagnostics only. */ } }
                }
            }
        } catch (_) { call = args; }
        return Reflect.apply(original, this, call);
    }
    Object.defineProperty(target, "sendMessage", { ...descriptor, value: sendMessage });
    return true;
}
