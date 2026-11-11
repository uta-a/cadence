// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0), bootstrap.js
// `alwaysTrustDomain` / `alwaysTrustFile`, adapted to Discord 352.17. Based on AlwaysTrust by zt and Trwy.
//
// MaskedLinkStore (351.11: 8766, 352.17: 8894) `default.isTrustedDomain(url)` decides whether a link asks
// "Leaving Discord"; SuspiciousDownloadUtils (351.11: 8537, 352.17: 8642) `isSuspiciousDownload(name)` whether a
// file warns it may be dangerous. Both are read at call time. Domains Discord blocks outright are a separate check.

export function installAlwaysTrust(maskedLinks: unknown, downloads: unknown, enabled: () => boolean): boolean {
    if (!maskedLinks || typeof maskedLinks !== "object" || !downloads || typeof downloads !== "object") return false;
    const holder = Object.getOwnPropertyDescriptor(maskedLinks, "default");
    const store = holder && "value" in holder ? holder.value : undefined;
    if (!store || typeof store !== "object" || Object.isFrozen(store)) return false;
    const isTrusted = Reflect.get(store, "isTrustedDomain") as unknown;
    const download = Object.getOwnPropertyDescriptor(downloads, "isSuspiciousDownload");
    if (typeof isTrusted !== "function" || !download || !("value" in download) || typeof download.value !== "function" ||
        (!download.writable && !download.configurable)) return false;
    const own = Object.getOwnPropertyDescriptor(store, "isTrustedDomain");
    if (own && !own.configurable && !own.writable) return false;
    const originalTrusted = isTrusted as (...args: unknown[]) => unknown;
    const originalDownload = download.value as (...args: unknown[]) => unknown;

    function isTrustedDomain(this: unknown, ...args: unknown[]): unknown {
        try { if (enabled()) return true; } catch (_) { /* Discord's own answer. */ }
        return Reflect.apply(originalTrusted, this, args);
    }
    function isSuspiciousDownload(this: unknown, ...args: unknown[]): unknown {
        try { if (enabled()) return null; } catch (_) { /* Discord's own answer. */ }
        return Reflect.apply(originalDownload, this, args);
    }
    // An own property shadows the prototype method on this one store instance; the class itself is untouched.
    Object.defineProperty(store, "isTrustedDomain", own ? { ...own, value: isTrustedDomain }
        : { value: isTrustedDomain, writable: true, configurable: true, enumerable: false });
    Object.defineProperty(downloads, "isSuspiciousDownload", { ...download, value: isSuspiciousDownload });
    return true;
}
