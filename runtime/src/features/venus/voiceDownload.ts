// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0),
// bootstrap.js "Download voice messages" (after VoiceDownload), commit
// 987b7a22d96d41a0ba80c060b485291e1c7bcc4b. Adapted to Discord 352.17.
// Uses Discord's native message CTA and Android DownloadManager; no re-encoding or background fetch.
import { wrapExport } from "./gestures";

export type VoiceDownloadEvent = "row-installed" | "handlers-installed" | "button" | "started" | "saved" | "failed";
const CALLBACK = "disk-voice-download";
const BUTTON = Object.freeze({ text: "音声を保存", textColor: -2367775, backgroundColor: 352321535, callback: CALLBACK });
interface Attachment { url: string; mime: string }
export interface VoiceDownloadDeps {
    enabled(): boolean;
    message(channelId: string, messageId: string): unknown;
    nativeData(event: unknown): unknown;
    download(url: string, mediaType: number, contentType: string): unknown;
    onEvent?(event: VoiceDownloadEvent): void;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
export function voiceAttachment(message: unknown): Attachment | null {
    try {
        if (!object(message) || typeof message.flags !== "number" || (message.flags & 8192) === 0
            || !Array.isArray(message.attachments)) return null;
        const file = message.attachments[0];
        if (!object(file) || typeof file.url !== "string" || file.url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(file.url)
            || !/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\//i.test(file.url)) return null;
        const mime = file.content_type ?? file.contentType ?? "audio/ogg";
        if (typeof mime !== "string" || !/^audio\/[a-z0-9.+-]+$/i.test(mime)) return null;
        return { url: file.url, mime };
    } catch (_) { return null; }
}
export function createVoiceDownload(deps: VoiceDownloadDeps) {
    const busy = new Set<string>();
    let buttonReported = false;
    function report(event: VoiceDownloadEvent): void { try { deps.onEvent?.(event); } catch (_) { /* Diagnostics only. */ } }
    function rowResult(result: unknown, row: unknown): unknown {
        try {
            if (!deps.enabled() || !object(row) || row.rowType !== 1 || !object(result) || !object(result.message)
                || result.message.ctaButton != null || !voiceAttachment(row.message)) return result;
            if (!buttonReported) { buttonReported = true; report("button"); }
            return { ...result, message: { ...result.message, ctaButton: BUTTON } };
        } catch (_) { return result; }
    }
    function tap(event: unknown): boolean {
        let data: unknown;
        let owned = false;
        try {
            data = object(event) ? event.nativeEvent : undefined;
            if (!object(data) || data.callback == null) data = deps.nativeData(event);
            if (!object(data) || data.callback !== CALLBACK) return false;
            owned = true;
            // A stale disk CTA after the setting is disabled must not reach Discord's unrelated CTA handler.
            if (!deps.enabled()) return true;
            if (typeof data.channelId !== "string" || typeof data.messageId !== "string"
                || !data.channelId || !data.messageId) { report("failed"); return true; }
            const key = data.channelId + ":" + data.messageId;
            if (busy.has(key)) return true;
            const file = voiceAttachment(deps.message(data.channelId, data.messageId));
            if (!file || busy.size >= 32) { report("failed"); return true; }
            busy.add(key);
            report("started");
            // Use a microtask so synchronous native errors and rejected downloads share the same cleanup path.
            void Promise.resolve().then(() => deps.download(file.url, 0, file.mime)).then(() => {
                busy.delete(key); report("saved");
            }, () => { busy.delete(key); report("failed"); });
            return true;
        } catch (_) { report("failed"); return owned; }
    }
    function installRows(exports: unknown): boolean {
        try {
            if (!object(exports)) return false;
            const type = Object.getOwnPropertyDescriptor(exports, "default")?.value;
            if (typeof type !== "function" || !object(type.prototype)) return false;
            const ok = wrapExport(type.prototype, "generate", original => function (this: unknown, ...args: unknown[]) {
                // Discord's generator executes once, with the original this and every argument.
                return rowResult(Reflect.apply(original, this, args), args[0]);
            });
            if (ok) report("row-installed");
            return ok;
        } catch (_) { return false; }
    }
    function installHandlers(exports: unknown): boolean {
        try {
            const ok = wrapExport(exports, "MessagesHandlers", Original => {
                // Validate constructability without executing Discord's constructor.
                Reflect.construct(String, [], Original as unknown as new () => unknown);
                function MessagesHandlers(this: unknown, ...args: unknown[]) {
                    const instance = Reflect.construct(Original, args, new.target || MessagesHandlers);
                    try {
                        const original = instance.handleTapCtaButton;
                        if (typeof original === "function") instance.handleTapCtaButton = function (this: unknown, ...tapArgs: unknown[]) {
                            if (tap(tapArgs[0])) return undefined;
                            return Reflect.apply(original, this, tapArgs);
                        };
                    } catch (_) { /* Read-only/unsupported handlers stay Discord's own. */ }
                    return instance;
                }
                MessagesHandlers.prototype = Original.prototype;
                Object.setPrototypeOf(MessagesHandlers, Original);
                return MessagesHandlers;
            });
            if (ok) report("handlers-installed");
            return ok;
        } catch (_) { return false; }
    }
    return { installRows, installHandlers, rowResult, tap };
}
