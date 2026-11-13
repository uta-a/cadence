// In-memory settings and serialization only. The persistence adapter is supplied after the native FileModule
// contract and a cadence-owned path have been verified. Nothing here reads Discord tokens or account storage.

export const FEATURE_KEYS = Object.freeze(["fakeNitro", "platformIndicator"] as const);
export type FeatureKey = typeof FEATURE_KEYS[number];
export type SettingsSnapshot = Readonly<Record<FeatureKey, boolean>>;
export const EMOJI_SIZES = Object.freeze([48, 64, 96, 128] as const);
export type EmojiSize = typeof EMOJI_SIZES[number];
/** Fake Nitro options. Optional in schema 2: older builds only read allowlisted keys and ignore this object. */
export interface NitroOptions { readonly emojiSize: EmojiSize; }
export const DEFAULT_NITRO: NitroOptions = Object.freeze({ emojiSize: 48 });
export const PLATFORM_PLACES = Object.freeze(["avatars", "dmList", "dmHeader", "memberList", "profile", "messages"] as const);
export type PlatformPlace = typeof PLATFORM_PLACES[number];
export type PlatformOptions = Readonly<Record<PlatformPlace, boolean>>;
export const DEFAULT_PLATFORM: PlatformOptions = Object.freeze({ avatars: true, dmList: true, dmHeader: true,
    memberList: true, profile: true, messages: true });
export interface SettingsStorage {
    read(): Promise<string | null>;
    write(text: string): Promise<void>;
}

export function createSettingsStore(storage: SettingsStorage, onError: (error: unknown) => void = () => {}) {
    let values: SettingsSnapshot = Object.freeze({ fakeNitro: false, platformIndicator: false });
    let nitro: NitroOptions = DEFAULT_NITRO;
    let platform: PlatformOptions = DEFAULT_PLATFORM;
    let initialized = false;
    let loading: Promise<void> | null = null;
    let revision = 0;
    let saveQueue = Promise.resolve();
    const listeners = new Set<(value: SettingsSnapshot) => void>();
    const nitroListeners = new Set<(value: NitroOptions) => void>();
    const platformListeners = new Set<(value: PlatformOptions) => void>();

    function report(error: unknown): void {
        try { onError(error); } catch (_) { /* Diagnostics cannot break the client. */ }
    }

    function notify<T>(subscribers: Set<(value: T) => void>, getValue: () => T): void {
        for (const listener of subscribers) {
            try { listener(getValue()); } catch (error) { report(error); }
        }
    }

    function hasOwn(value: object, key: string): boolean {
        return Object.prototype.hasOwnProperty.call(value, key);
    }

    function isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function parseNitro(value: unknown): NitroOptions {
        if (!isRecord(value)) return DEFAULT_NITRO;
        const size = hasOwn(value, "emojiSize") ? value.emojiSize : undefined;
        return Object.freeze({
            emojiSize: EMOJI_SIZES.includes(size as EmojiSize) ? size as EmojiSize : DEFAULT_NITRO.emojiSize,
        });
    }

    function parsePlatform(value: unknown): PlatformOptions {
        const result = { ...DEFAULT_PLATFORM };
        if (isRecord(value)) for (const key of PLATFORM_PLACES) {
            if (hasOwn(value, key) && typeof value[key] === "boolean") result[key] = value[key] as boolean;
        }
        return Object.freeze(result);
    }

    function parse(text: string): { features: SettingsSnapshot; nitro: NitroOptions; platform: PlatformOptions } {
        const data: unknown = JSON.parse(text);
        if (!isRecord(data)) throw new Error("Invalid Cadence settings");
        if (!hasOwn(data, "version") || !hasOwn(data, "features") ||
            (data.version !== 1 && data.version !== 2) || !isRecord(data.features))
            throw new Error("Unsupported Cadence settings schema");
        if (data.version === 2 && (!hasOwn(data, "preferences") || !isRecord(data.preferences)))
            throw new Error("Unsupported Cadence settings schema");
        const features = data.features;
        return {
            features: Object.freeze({
                fakeNitro: hasOwn(features, "fakeNitro") && features.fakeNitro === true,
                platformIndicator: hasOwn(features, "platformIndicator") && features.platformIndicator === true,
            }),
            nitro: data.version === 2 && hasOwn(data, "nitro") ? parseNitro(data.nitro) : DEFAULT_NITRO,
            platform: data.version === 2 && hasOwn(data, "platform") ? parsePlatform(data.platform) : DEFAULT_PLATFORM,
        };
    }

    function save(): Promise<void> {
        revision++;
        // Persist even an unchanged choice: the previous write may have failed, or disk may still hold an old value.
        // Schema 2 keeps an empty `preferences` object; older files may still carry compact or maskedLinks and are read leniently.
        const snapshot = JSON.stringify({ version: 2, features: values, preferences: {}, nitro,
            ...(PLATFORM_PLACES.some(key => platform[key] !== DEFAULT_PLATFORM[key]) ? { platform } : {}) });
        // Queue before notifying: a listener may synchronously change a feature or preference.
        const pending = saveQueue.then(() => storage.write(snapshot));
        saveQueue = pending.catch(report);
        return pending;
    }

    return {
        get ready() { return initialized; },
        get(): SettingsSnapshot { return values; },
        getNitro(): NitroOptions { return nitro; },
        getPlatform(): PlatformOptions { return platform; },
        /** Load once; failures keep the all-off defaults and are reported. A concurrent local change wins over disk. */
        load(): Promise<void> {
            if (initialized) return Promise.resolve();
            if (loading) return loading;
            loading = (async () => {
                try {
                    const text = await storage.read();
                    // A local change before *or during* the read wins over the possibly stale disk value.
                    if (text !== null && revision === 0) {
                        const loaded = parse(text);
                        values = loaded.features;
                        nitro = loaded.nitro;
                        platform = loaded.platform;
                        notify(listeners, () => values);
                        notify(nitroListeners, () => nitro);
                        notify(platformListeners, () => platform);
                    }
                } catch (error) { report(error); }
                finally { initialized = true; loading = null; }
            })();
            return loading;
        },
        /** Only known feature keys and booleans may be saved; every feature defaults to off. */
        set(key: FeatureKey, enabled: boolean): Promise<void> {
            if (!FEATURE_KEYS.includes(key) || typeof enabled !== "boolean")
                return Promise.reject(new TypeError("Invalid Cadence feature setting"));
            const changed = values[key] !== enabled;
            values = Object.freeze({ ...values, [key]: enabled });
            const pending = save();
            if (changed) notify(listeners, () => values);
            return pending;
        },
        /** Only a known emoji size is accepted. */
        setNitro(change: Partial<NitroOptions>): Promise<void> {
            if (!change || typeof change !== "object") return Promise.reject(new TypeError("Invalid Fake Nitro option"));
            const keys = Object.keys(change);
            if (keys.length === 0 || keys.some(key => key !== "emojiSize") ||
                ("emojiSize" in change && !EMOJI_SIZES.includes(change.emojiSize as EmojiSize)))
                return Promise.reject(new TypeError("Invalid Fake Nitro option"));
            const next = Object.freeze({ ...nitro, ...change }) as NitroOptions;
            const changed = next.emojiSize !== nitro.emojiSize;
            nitro = next;
            const pending = save();
            if (changed) notify(nitroListeners, () => nitro);
            return pending;
        },
        setPlatform(key: PlatformPlace, enabled: boolean): Promise<void> {
            if (!PLATFORM_PLACES.includes(key) || typeof enabled !== "boolean")
                return Promise.reject(new TypeError("Invalid platform location"));
            const changed = platform[key] !== enabled;
            platform = Object.freeze({ ...platform, [key]: enabled });
            const pending = save();
            if (changed) notify(platformListeners, () => platform);
            return pending;
        },
        subscribePlatform(listener: (value: PlatformOptions) => void): () => void {
            platformListeners.add(listener);
            return () => { platformListeners.delete(listener); };
        },
        subscribeNitro(listener: (value: NitroOptions) => void): () => void {
            nitroListeners.add(listener);
            return () => { nitroListeners.delete(listener); };
        },
        subscribe(listener: (value: SettingsSnapshot) => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
