import { createSettingsStore, DEFAULT_NITRO, DEFAULT_PLATFORM } from "./settings";
import { createNativeSettingsStorage } from "./storage";
import type { ExtraKey, ExtrasSnapshot, FeatureKey, NitroOptions, PlatformPlace, PlatformOptions, PreferencesSnapshot, SettingsSnapshot, SettingsStorage } from "./settings";

export interface SettingsViewState {
    readonly phase: "loading" | "ready" | "error";
    readonly save: "idle" | "saving" | "saved" | "error";
    readonly preferences: PreferencesSnapshot;
    readonly features: SettingsSnapshot;
    readonly nitro: NitroOptions;
    readonly platform: PlatformOptions;
    readonly extras: ExtrasSnapshot;
}
export function createSettingsController(onStatus: (status: string) => void = () => {},
    storageFactory: (native: unknown) => SettingsStorage = createNativeSettingsStorage) {
    let native: unknown;
    let attached = false;
    let pending: Promise<void> | null = null;
    let store: ReturnType<typeof createSettingsStore> | undefined;
    let saving = 0;
    let state: SettingsViewState = Object.freeze({ phase: "loading", save: "idle",
        preferences: Object.freeze({ compact: false }), features: Object.freeze({ fakeNitro: false, platformIndicator: false }), nitro: DEFAULT_NITRO, platform: DEFAULT_PLATFORM, extras: Object.freeze([]) });
    const listeners = new Set<() => void>();
    function report(value: string): void { try { onStatus(value); } catch (_) { /* Ignore diagnostics. */ } }
    function publish(patch: Partial<SettingsViewState>): void {
        state = Object.freeze({ ...state, ...patch });
        for (const listener of Array.from(listeners)) { try { listener(); } catch (_) { /* UI failures are isolated. */ } }
    }
    function initialize(): Promise<void> {
        if (pending) return pending;
        pending = globalThis.Promise.resolve().then(async () => {
            let failed = false;
            try {
                const candidate = createSettingsStore(storageFactory(native), () => { failed = true; });
                await candidate.load();
                if (failed) throw new Error("Settings load failed");
                store = candidate;
                store.subscribePreferences(() => publish({ preferences: candidate.getPreferences() }));
                store.subscribe(() => publish({ features: candidate.get() }));
                store.subscribeNitro(() => publish({ nitro: candidate.getNitro() }));
                store.subscribeExtras(() => publish({ extras: candidate.getExtras() }));
                store.subscribePlatform(() => publish({ platform: candidate.getPlatform() }));
                publish({ phase: "ready", preferences: store.getPreferences(), features: store.get(), nitro: store.getNitro(),
                    extras: store.getExtras(), platform: store.getPlatform() });
                report("ready");
            } catch (_) {
                store = undefined;
                publish({ phase: "error" });
                report("load-error");
            } finally { pending = null; }
        });
        publish({ phase: "loading", save: "idle" });
        return pending;
    }
    async function persist(write: (ready: ReturnType<typeof createSettingsStore>) => Promise<void>): Promise<void> {
        if (!store || state.phase !== "ready") throw new Error("Settings not ready");
        saving++;
        publish({ save: "saving" });
        try {
            await write(store);
            if (--saving === 0) publish({ save: "saved" });
            report("saved");
        } catch (error) {
            saving--;
            publish({ save: "error" });
            report("save-error");
            throw error;
        }
    }
    return {
        get(): SettingsViewState { return state; },
        /** Feature hooks read this on every use: off while loading, after a load error, or when the user turned it off. */
        isEnabled(key: FeatureKey): boolean { return state.phase === "ready" && state.features[key] === true; },
        /** Ported Venus features: off while loading or after a load error. */
        isExtraEnabled(key: ExtraKey): boolean { return state.phase === "ready" && state.extras.includes(key); },
        subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
        attach(value: unknown): Promise<void> | undefined {
            if (attached) return pending ?? undefined;
            attached = true;
            native = value;
            if (typeof globalThis.Promise !== "function") { publish({ phase: "error" }); report("load-error"); return; }
            return initialize();
        },
        retryLoad(): Promise<void> | undefined {
            if (typeof globalThis.Promise !== "function") return;
            if (!attached || state.phase === "ready") return globalThis.Promise.resolve();
            return initialize();
        },
        async setCompact(value: boolean): Promise<void> {
            if (typeof value !== "boolean") throw new Error("Settings not ready");
            await persist(ready => ready.setPreference("compact", value));
        },
        async setExtra(key: ExtraKey, value: boolean): Promise<void> {
            if (typeof value !== "boolean") throw new Error("Settings not ready");
            await persist(ready => ready.setExtra(key, value));
        },
        async setPlatform(key: PlatformPlace, value: boolean): Promise<void> {
            await persist(ready => ready.setPlatform(key, value));
        },
        async setNitro(change: Partial<NitroOptions>): Promise<void> {
            await persist(ready => ready.setNitro(change));
        },
        async setFeature(key: FeatureKey, value: boolean): Promise<void> {
            if (typeof value !== "boolean") throw new Error("Settings not ready");
            await persist(ready => ready.set(key, value));
        },
    };
}
export type SettingsController = ReturnType<typeof createSettingsController>;
