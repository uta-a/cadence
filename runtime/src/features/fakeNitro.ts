// Fake Nitro (docs/PHASE4-RESEARCH.md, 4a). Discord's own parser already classifies custom emojis the user
// cannot send as `message.invalidEmojis`, while leaving `<:name:id>` in `message.content`. Only those emojis
// are rewritten into CDN image links; emojis the user can send are left exactly as typed.

export const MAX_CONTENT_LENGTH = 2000;
export const EMOJI_SIZE = 48;
const TOKEN = /<(a?):([A-Za-z0-9_~]{1,64}):([0-9]{1,25})>/;

interface Locked { readonly animated: boolean; readonly name: string; }

export interface ConvertOptions { readonly emojiSize: number; readonly maskedLinks: boolean; }
const DEFAULT_OPTIONS: ConvertOptions = Object.freeze({ emojiSize: EMOJI_SIZE, maskedLinks: false });

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
export function convertMessage(message: unknown, options: ConvertOptions = DEFAULT_OPTIONS): Record<string, unknown> | null {
    const size = [48, 64, 96, 128].includes(options.emojiSize) ? options.emojiSize : EMOJI_SIZE;
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
        const url = emojiUrl(id, match[1] === "a" || emoji.animated, emoji.name, size);
        // A masked link shows the emoji name instead of the URL; the name is limited to [A-Za-z0-9_~] by TOKEN.
        out += before + (options.maskedLinks === true ? `[${match[2]}](${url})` : url) + after;
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
export function installSendMessageHook(exports: unknown, enabled: () => boolean, onConverted: () => void = () => {},
    options: () => ConvertOptions = () => DEFAULT_OPTIONS): boolean {
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
                const converted = convertMessage(args[1], options());
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

// Stickers (docs/PHASE4.md). The sticker picker (function 105918) passes a sticker on to sending only when
// `getStickerSendability` (module 7475, read from the export at call time) returns SENDABLE. While Fake Nitro is on,
// a Nitro-only sticker in an image format is reported as SENDABLE and remembered; `sendStickers` then sends a link
// for remembered stickers instead. Everything else keeps Discord's own result and the original send.

const STICKER_LINK_FORMATS: Readonly<Record<number, string>> = Object.freeze({ 1: "png", 2: "png", 4: "gif" });
const REMEMBERED_LIMIT = 64;

export function stickerUrl(id: string, extension: string): string {
    return `https://media.discordapp.net/stickers/${id}.${extension}?size=160`;
}

interface Remembered { readonly extension: string; readonly name: string; }

export function installStickerHooks(sendability: unknown, actions: unknown, enabled: () => boolean,
    options: () => ConvertOptions = () => DEFAULT_OPTIONS, onConverted: () => void = () => {}): boolean {
    if (!sendability || typeof sendability !== "object" || !actions || typeof actions !== "object") return false;
    const enumHolder = Object.getOwnPropertyDescriptor(sendability, "StickerSendability");
    const values = enumHolder && "value" in enumHolder ? enumHolder.value as Record<string, unknown> : undefined;
    const SENDABLE = values?.SENDABLE, PREMIUM = values?.SENDABLE_WITH_PREMIUM;
    if (typeof SENDABLE !== "number" || typeof PREMIUM !== "number") return false;
    const getter = Object.getOwnPropertyDescriptor(sendability, "getStickerSendability");
    const holder = Object.getOwnPropertyDescriptor(actions, "default");
    const target = holder && "value" in holder ? holder.value : undefined;
    const sender = target && typeof target === "object" ? Object.getOwnPropertyDescriptor(target, "sendStickers") : undefined;
    for (const descriptor of [getter, sender])
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || (!descriptor.writable && !descriptor.configurable))
            return false;
    const originalSendability = getter!.value as (...args: unknown[]) => unknown;
    const originalSend = sender!.value as (...args: unknown[]) => unknown;
    const remembered = new Map<string, Remembered>();
    let reported = false;

    function getStickerSendability(this: unknown, ...args: unknown[]): unknown {
        const result = Reflect.apply(originalSendability, this, args);
        try {
            if (result !== PREMIUM || !enabled()) return result;
            const sticker = args[0] as Record<string, unknown> | null;
            const id = sticker && typeof sticker === "object" ? sticker.id : undefined;
            const extension = sticker && typeof sticker.format_type === "number" ? STICKER_LINK_FORMATS[sticker.format_type] : undefined;
            if (typeof id !== "string" || !/^[0-9]{1,25}$/.test(id) || !extension) return result;
            remembered.delete(id);
            remembered.set(id, { extension, name: typeof sticker!.name === "string" ? sticker!.name : "sticker" });
            if (remembered.size > REMEMBERED_LIMIT) remembered.delete(remembered.keys().next().value as string);
            return SENDABLE;
        } catch (_) { return result; }
    }

    function sendStickers(this: unknown, ...args: unknown[]): unknown {
        try {
            const [channelId, stickerIds, content = "", options_, tts = false] = args;
            if (enabled() && Array.isArray(stickerIds) && stickerIds.length > 0 && typeof content === "string" &&
                stickerIds.every(id => typeof id === "string" && remembered.has(id))) {
                const masked = options().maskedLinks === true;
                const links = (stickerIds as string[]).map(id => {
                    const sticker = remembered.get(id)!, url = stickerUrl(id, sticker.extension);
                    return masked ? `[${sticker.name.replace(/[[\]()\\]/g, "")}](${url})` : url;
                }).join("\n");
                const text = content.trim() ? `${content}\n${links}` : links;
                const send = target && typeof target === "object" ? Reflect.get(target, "sendMessage") : undefined;
                if (text.length <= MAX_CONTENT_LENGTH && typeof send === "function") {
                    const message = { content: text, tts: tts === true, invalidEmojis: [], validNonShortcutEmojis: [] };
                    const result = Reflect.apply(send, target, [channelId, message, undefined, options_]);
                    if (!reported) { reported = true; try { onConverted(); } catch (_) { /* Diagnostics only. */ } }
                    return result;
                }
            }
        } catch (_) { /* Fall through to Discord's own send. */ }
        return Reflect.apply(originalSend, this, args);
    }

    Object.defineProperty(sendability, "getStickerSendability", { ...getter, value: getStickerSendability });
    Object.defineProperty(target, "sendStickers", { ...sender, value: sendStickers });
    return true;
}
