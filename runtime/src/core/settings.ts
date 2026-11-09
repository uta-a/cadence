// In-memory settings and serialization only. The persistence adapter is supplied after the native FileModule
// contract and a disk-owned path have been verified. Nothing here reads Discord tokens or account storage.

export const FEATURE_KEYS = Object.freeze(["fakeNitro", "platformIndicator"] as const);
export type FeatureKey = typeof FEATURE_KEYS[number];
export type SettingsSnapshot = Readonly<Record<FeatureKey, boolean>>;

export interface SettingsStorage {
    read(): Promise<string | null>;
    write(text: string): Promise<void>;
}

export function createSettingsStore(storage: SettingsStorage, onError: (error: unknown) => void = () => {}) {
    let values: SettingsSnapshot = Object.freeze({ fakeNitro: false, platformIndicator: false });
    let initialized = false;
    let loading: Promise<void> | null = null;
    let revision = 0;
    let saveQueue = Promise.resolve();
    const listeners = new Set<(value: SettingsSnapshot) => void>();

    function report(error: unknown): void {
        try { onError(error); } catch (_) { /* Diagnostics cannot break the client. */ }
    }

    function notify(): void {
        for (const listener of listeners) {
            try { listener(values); } catch (error) { report(error); }
        }
    }

    function parse(text: string): SettingsSnapshot {
        const candidate: unknown = JSON.parse(text);
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid disk settings");
        const data = candidate as { version?: unknown; features?: unknown };
        if (!Object.prototype.hasOwnProperty.call(data, "version") ||
            !Object.prototype.hasOwnProperty.call(data, "features") ||
            data.version !== 1 || !data.features || typeof data.features !== "object" || Array.isArray(data.features))
            throw new Error("Unsupported disk settings schema");
        const features = data.features as Record<string, unknown>;
        return Object.freeze({
            fakeNitro: Object.prototype.hasOwnProperty.call(features, "fakeNitro") && features.fakeNitro === true,
            platformIndicator: Object.prototype.hasOwnProperty.call(features, "platformIndicator") && features.platformIndicator === true,
        });
    }

    return {
        get ready() { return initialized; },
        get(): SettingsSnapshot { return values; },
        /** Load once; failures keep the all-off defaults and are reported. A concurrent set wins over disk. */
        load(): Promise<void> {
            if (initialized) return Promise.resolve();
            if (loading) return loading;
            loading = (async () => {
                try {
                    const text = await storage.read();
                    // A local set before *or during* the read wins over the possibly stale disk value.
                    if (text !== null && revision === 0) { values = parse(text); notify(); }
                } catch (error) { report(error); }
                finally { initialized = true; loading = null; }
            })();
            return loading;
        },
        /** Only known feature keys and booleans may be saved; every feature defaults to off. */
        set(key: FeatureKey, enabled: boolean): Promise<void> {
            if (!FEATURE_KEYS.includes(key) || typeof enabled !== "boolean")
                return Promise.reject(new TypeError("Invalid disk feature setting"));
            revision++;
            // Persist even an unchanged choice: the previous write may have failed, or disk may still hold an old value.
            const changed = values[key] !== enabled;
            values = Object.freeze({ ...values, [key]: enabled });
            const snapshot = JSON.stringify({ version: 1, features: values });
            // Queue before notifying: a listener may synchronously set another feature.
            const pending = saveQueue.then(() => storage.write(snapshot));
            saveQueue = pending.catch(report);
            if (changed) notify();
            return pending;
        },
        subscribe(listener: (value: SettingsSnapshot) => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
