// In-memory settings and serialization only. The persistence adapter is supplied after the native FileModule
// contract and a disk-owned path have been verified. Nothing here reads Discord tokens or account storage.

export const FEATURE_KEYS = Object.freeze(["fakeNitro", "platformIndicator"] as const);
export type FeatureKey = typeof FEATURE_KEYS[number];
export type SettingsSnapshot = Readonly<Record<FeatureKey, boolean>>;
export const PREFERENCE_KEYS = Object.freeze(["compact"] as const);
export type PreferenceKey = typeof PREFERENCE_KEYS[number];
export type PreferencesSnapshot = Readonly<Record<PreferenceKey, boolean>>;

export interface SettingsStorage {
    read(): Promise<string | null>;
    write(text: string): Promise<void>;
}

export function createSettingsStore(storage: SettingsStorage, onError: (error: unknown) => void = () => {}) {
    let values: SettingsSnapshot = Object.freeze({ fakeNitro: false, platformIndicator: false });
    let preferences: PreferencesSnapshot = Object.freeze({ compact: false });
    let initialized = false;
    let loading: Promise<void> | null = null;
    let revision = 0;
    let saveQueue = Promise.resolve();
    const listeners = new Set<(value: SettingsSnapshot) => void>();
    const preferenceListeners = new Set<(value: PreferencesSnapshot) => void>();

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

    function parse(text: string): { features: SettingsSnapshot; preferences: PreferencesSnapshot } {
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
        };
    }

    function save(): Promise<void> {
        revision++;
        // Persist even an unchanged choice: the previous write may have failed, or disk may still hold an old value.
        const snapshot = JSON.stringify({ version: 2, features: values, preferences });
        // Queue before notifying: a listener may synchronously change a feature or preference.
        const pending = saveQueue.then(() => storage.write(snapshot));
        saveQueue = pending.catch(report);
        return pending;
    }

    return {
        get ready() { return initialized; },
        get(): SettingsSnapshot { return values; },
        getPreferences(): PreferencesSnapshot { return preferences; },
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
                        notify(listeners, () => values);
                        notify(preferenceListeners, () => preferences);
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
