// In-memory settings and serialization only. The persistence adapter is supplied after the native FileModule
// contract and a disk-owned path have been verified. Nothing here reads Discord tokens or account storage.

export const FEATURE_KEYS = Object.freeze(["fakeNitro", "platformIndicator"] as const);
export type FeatureKey = typeof FEATURE_KEYS[number];
export type SettingsSnapshot = Readonly<Record<FeatureKey, boolean>>;
export const PREFERENCE_KEYS = Object.freeze(["compact"] as const);
export type PreferenceKey = typeof PREFERENCE_KEYS[number];
export type PreferencesSnapshot = Readonly<Record<PreferenceKey, boolean>>;
export const EMOJI_SIZES = Object.freeze([48, 64, 96, 128] as const);
export type EmojiSize = typeof EMOJI_SIZES[number];
/** Fake Nitro options. Optional in schema 2: older builds only read allowlisted keys and ignore this object. */
export interface NitroOptions { readonly emojiSize: EmojiSize; readonly maskedLinks: boolean; }
export const DEFAULT_NITRO: NitroOptions = Object.freeze({ emojiSize: 48, maskedLinks: false });
/**
 * Features ported from Venus Patches (docs/VENUS-PORT.md). Stored as the optional `extras` array of enabled IDs,
 * omitted while none is on, so older builds and older settings files are unaffected. Unknown IDs are ignored.
 */
export const EXTRA_KEYS = Object.freeze(["quickDelete", "noConfirmPin", "alwaysTrust", "jumpToTop", "gestures", "gestureTripleDelete", "fullImages", "readAll", "quietReplies"] as const);
export type ExtraKey = typeof EXTRA_KEYS[number];
export type ExtrasSnapshot = readonly ExtraKey[];

export interface SettingsStorage {
    read(): Promise<string | null>;
    write(text: string): Promise<void>;
}

export function createSettingsStore(storage: SettingsStorage, onError: (error: unknown) => void = () => {}) {
    let values: SettingsSnapshot = Object.freeze({ fakeNitro: false, platformIndicator: false });
    let preferences: PreferencesSnapshot = Object.freeze({ compact: false });
    let nitro: NitroOptions = DEFAULT_NITRO;
    let extras: ExtrasSnapshot = Object.freeze([]);
    let initialized = false;
    let loading: Promise<void> | null = null;
    let revision = 0;
    let saveQueue = Promise.resolve();
    const listeners = new Set<(value: SettingsSnapshot) => void>();
    const preferenceListeners = new Set<(value: PreferencesSnapshot) => void>();
    const nitroListeners = new Set<(value: NitroOptions) => void>();
    const extrasListeners = new Set<(value: ExtrasSnapshot) => void>();

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
            maskedLinks: hasOwn(value, "maskedLinks") && value.maskedLinks === true,
        });
    }

    function parseExtras(value: unknown): ExtrasSnapshot {
        if (!Array.isArray(value)) return Object.freeze([]);
        return Object.freeze(EXTRA_KEYS.filter(key => value.includes(key)));
    }

    function parse(text: string): { features: SettingsSnapshot; preferences: PreferencesSnapshot; nitro: NitroOptions; extras: ExtrasSnapshot } {
        const data: unknown = JSON.parse(text);
        if (!isRecord(data)) throw new Error("Invalid disk settings");
        if (!hasOwn(data, "version") || !hasOwn(data, "features") ||
            (data.version !== 1 && data.version !== 2) || !isRecord(data.features))
            throw new Error("Unsupported disk settings schema");
        if (data.version === 2 && (!hasOwn(data, "preferences") || !isRecord(data.preferences)))
            throw new Error("Unsupported disk settings schema");
        const features = data.features;
        const savedPreferences = data.version === 2 ? data.preferences as Record<string, unknown> : {};
        return {
            features: Object.freeze({
                fakeNitro: hasOwn(features, "fakeNitro") && features.fakeNitro === true,
                platformIndicator: hasOwn(features, "platformIndicator") && features.platformIndicator === true,
            }),
            preferences: Object.freeze({ compact: hasOwn(savedPreferences, "compact") && savedPreferences.compact === true }),
            nitro: data.version === 2 && hasOwn(data, "nitro") ? parseNitro(data.nitro) : DEFAULT_NITRO,
            extras: data.version === 2 && hasOwn(data, "extras") ? parseExtras(data.extras) : Object.freeze([]),
        };
    }

    function save(): Promise<void> {
        revision++;
        // Persist even an unchanged choice: the previous write may have failed, or disk may still hold an old value.
        const snapshot = JSON.stringify(extras.length ? { version: 2, features: values, preferences, nitro, extras }
            : { version: 2, features: values, preferences, nitro });
        // Queue before notifying: a listener may synchronously change a feature or preference.
        const pending = saveQueue.then(() => storage.write(snapshot));
        saveQueue = pending.catch(report);
        return pending;
    }

    return {
        get ready() { return initialized; },
        get(): SettingsSnapshot { return values; },
        getPreferences(): PreferencesSnapshot { return preferences; },
        getNitro(): NitroOptions { return nitro; },
        getExtras(): ExtrasSnapshot { return extras; },
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
                        preferences = loaded.preferences;
                        nitro = loaded.nitro;
                        extras = loaded.extras;
                        notify(listeners, () => values);
                        notify(extrasListeners, () => extras);
                        notify(preferenceListeners, () => preferences);
                        notify(nitroListeners, () => nitro);
                    }
                } catch (error) { report(error); }
                finally { initialized = true; loading = null; }
            })();
            return loading;
        },
        /** Only known feature keys and booleans may be saved; every feature defaults to off. */
        set(key: FeatureKey, enabled: boolean): Promise<void> {
            if (!FEATURE_KEYS.includes(key) || typeof enabled !== "boolean")
                return Promise.reject(new TypeError("Invalid disk feature setting"));
            const changed = values[key] !== enabled;
            values = Object.freeze({ ...values, [key]: enabled });
            const pending = save();
            if (changed) notify(listeners, () => values);
            return pending;
        },
        setPreference(key: PreferenceKey, enabled: boolean): Promise<void> {
            if (!PREFERENCE_KEYS.includes(key) || typeof enabled !== "boolean")
                return Promise.reject(new TypeError("Invalid disk preference setting"));
            const changed = preferences[key] !== enabled;
            preferences = Object.freeze({ ...preferences, [key]: enabled });
            const pending = save();
            if (changed) notify(preferenceListeners, () => preferences);
            return pending;
        },
        /** Only a known size and a strict boolean are accepted; the other option keeps its value. */
        setNitro(change: Partial<NitroOptions>): Promise<void> {
            if (!change || typeof change !== "object") return Promise.reject(new TypeError("Invalid Fake Nitro option"));
            const keys = Object.keys(change);
            if (keys.length === 0 || keys.some(key => key !== "emojiSize" && key !== "maskedLinks") ||
                ("emojiSize" in change && !EMOJI_SIZES.includes(change.emojiSize as EmojiSize)) ||
                ("maskedLinks" in change && typeof change.maskedLinks !== "boolean"))
                return Promise.reject(new TypeError("Invalid Fake Nitro option"));
            const next = Object.freeze({ ...nitro, ...change }) as NitroOptions;
            const changed = next.emojiSize !== nitro.emojiSize || next.maskedLinks !== nitro.maskedLinks;
            nitro = next;
            const pending = save();
            if (changed) notify(nitroListeners, () => nitro);
            return pending;
        },
        setExtra(key: ExtraKey, enabled: boolean): Promise<void> {
            if (!EXTRA_KEYS.includes(key) || typeof enabled !== "boolean")
                return Promise.reject(new TypeError("Invalid disk extra feature"));
            const changed = extras.includes(key) !== enabled;
            const next = new Set<ExtraKey>(extras);
            if (enabled) next.add(key); else next.delete(key);
            extras = Object.freeze(EXTRA_KEYS.filter(item => next.has(item)));
            const pending = save();
            if (changed) notify(extrasListeners, () => extras);
            return pending;
        },
        subscribeExtras(listener: (value: ExtrasSnapshot) => void): () => void {
            extrasListeners.add(listener);
            return () => { extrasListeners.delete(listener); };
        },
        subscribeNitro(listener: (value: NitroOptions) => void): () => void {
            nitroListeners.add(listener);
            return () => { nitroListeners.delete(listener); };
        },
        subscribe(listener: (value: SettingsSnapshot) => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        subscribePreferences(listener: (value: PreferencesSnapshot) => void): () => void {
            preferenceListeners.add(listener);
            return () => { preferenceListeners.delete(listener); };
        },
    };
}
