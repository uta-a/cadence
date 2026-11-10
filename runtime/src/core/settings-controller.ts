import { createSettingsStore } from "./settings";
import { createNativeSettingsStorage } from "./storage";
import type { PreferencesSnapshot, SettingsStorage } from "./settings";

export interface SettingsViewState {
    readonly phase: "loading" | "ready" | "error";
    readonly save: "idle" | "saving" | "saved" | "error";
    readonly preferences: PreferencesSnapshot;
}
export function createSettingsController(onStatus: (status: string) => void = () => {},
    storageFactory: (native: unknown) => SettingsStorage = createNativeSettingsStorage) {
    let native: unknown;
    let attached = false;
    let pending: Promise<void> | null = null;
    let store: ReturnType<typeof createSettingsStore> | undefined;
    let saving = 0;
    let state: SettingsViewState = Object.freeze({ phase: "loading", save: "idle", preferences: Object.freeze({ compact: false }) });
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
                publish({ phase: "ready", preferences: store.getPreferences() });
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
    return {
        get(): SettingsViewState { return state; },
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
            if (!store || state.phase !== "ready" || typeof value !== "boolean") throw new Error("Settings not ready");
            saving++;
            publish({ save: "saving" });
            try {
                await store.setPreference("compact", value);
                if (--saving === 0) publish({ save: "saved" });
                report("saved");
            } catch (error) {
                saving--;
                publish({ save: "error" });
                report("save-error");
                throw error;
            }
        },
    };
}
export type SettingsController = ReturnType<typeof createSettingsController>;
