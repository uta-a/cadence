// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0), bootstrap.js "Load full-quality
// images" (based on Uncompressed Discord Images by Knewest and HighResProfileImages by Kawtious), adapted to 352.17.
//
// ImageUtils (1498, same ID in 351.11) getMobileOptimizedSrc(src, width, height) builds every picture's address; for an
// uploaded picture the original file's address is returned instead of Discord's resized copy. Pictures too big for a
// phone and GIFs keep Discord's copy. AvatarUtils (1417) avatar/banner URLs ask for at least 512 (avatars) or 1024
// (banners). Both modules expose these functions as named exports and on `default`; both are wrapped.

const FULL_IMAGE_URL = /^(https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net))(\/attachments\/[^?#\s]+)(?:\?([^#\s]*))?$/;
const FULL_IMAGE_RESIZE = /^(?:width|height|format|quality|animated)=/;
const FULL_IMAGE_SIDE = 4096, FULL_IMAGE_PIXELS = 16000000;
const AVATAR_CALLS = ["getUserAvatarURL", "getGuildMemberAvatarURL", "getGuildMemberAvatarURLSimple", "getUserAvatarSource",
    "getGuildMemberAvatarSource", "getUserBannerURL", "getGuildMemberBannerURL"];
const AVATAR_URL = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/(?:avatars|banners|guilds)\//;
const AVATAR_SIZE = /([?&])size=(\d+)/;

/** The uploaded file's address for a resized one, or null to leave the picture to Discord. */
export function fullImageUrl(src: unknown, width: unknown, height: unknown): string | null {
    if (typeof src !== "string" || src.length > 2048 || src.indexOf("/attachments/") < 0) return null;
    const match = FULL_IMAGE_URL.exec(src), ext = match && /\.(png|jpe?g|webp|gif)$/i.exec(match[2]);
    if (!match || !ext || ext[1].toLowerCase() === "gif") return null;
    const w = Number(width), h = Number(height);
    if (!(w > 0 && h > 0) || w > FULL_IMAGE_SIDE || h > FULL_IMAGE_SIDE || w * h > FULL_IMAGE_PIXELS) return null;
    const kept = match[3] ? match[3].split("&").filter(part => part && !FULL_IMAGE_RESIZE.test(part)) : [];
    return match[1] + match[2] + (kept.length ? "?" + kept.join("&") : "");
}

export function fullAvatarUrl(url: unknown, banner: boolean): unknown {
    if (typeof url !== "string" || url.length > 2048 || !AVATAR_URL.test(url)) return url;
    const want = banner ? 1024 : 512;
    return url.replace(AVATAR_SIZE, (all, sep, n) => Number(n) >= want ? all : `${sep}size=${want}`);
}

function wrap(target: unknown, key: string, make: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown): boolean {
    if (!target || typeof target !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || (!descriptor.writable && !descriptor.configurable))
        return false;
    Object.defineProperty(target, key, { ...descriptor, value: make(descriptor.value as (...args: unknown[]) => unknown) });
    return true;
}
function both(exports: unknown): unknown[] {
    const holder = exports && typeof exports === "object" ? Object.getOwnPropertyDescriptor(exports, "default") : undefined;
    const inner = holder && "value" in holder && holder.value && typeof holder.value === "object" ? holder.value : undefined;
    return inner ? [exports, inner] : [exports];
}

export function installFullImages(imageUtils: unknown, avatarUtils: unknown, enabled: () => boolean,
    onUpgraded: (kind: "image" | "avatar") => void = () => {}): number {
    let count = 0;
    const seen = new Set<string>();
    function once(kind: "image" | "avatar"): void {
        if (seen.has(kind)) return;
        seen.add(kind);
        try { onUpgraded(kind); } catch (_) { /* Diagnostics only. */ }
    }
    for (const target of both(imageUtils)) {
        if (wrap(target, "getMobileOptimizedSrc", original => function (this: unknown, ...args: unknown[]) {
            try { if (enabled()) { const full = fullImageUrl(args[0], args[1], args[2]); if (full) { once("image"); return full; } } } catch (_) { /* Discord's copy. */ }
            return Reflect.apply(original, this, args);
        })) count++;
    }
    for (const target of both(avatarUtils)) {
        for (const name of AVATAR_CALLS) {
            const banner = name.indexOf("Banner") >= 0;
            if (wrap(target, name, original => function (this: unknown, ...args: unknown[]) {
                const out = Reflect.apply(original, this, args);
                try {
                    if (!enabled()) return out;
                    if (typeof out === "string") { const url = fullAvatarUrl(out, banner); if (url !== out) once("avatar"); return url; }
                    if (out && typeof out === "object" && !Array.isArray(out) && typeof (out as { uri?: unknown }).uri === "string") {
                        const uri = fullAvatarUrl((out as { uri: string }).uri, banner);
                        if (uri === (out as { uri: string }).uri) return out;
                        once("avatar");
                        return { ...(out as object), uri };
                    }
                } catch (_) { /* Discord's address. */ }
                return out;
            })) count++;
        }
    }
    return count;
}
