import { createSettingsStore } from "./settings";
import type { SettingsSnapshot } from "./settings";
import { createNativeSettingsStorage } from "./storage";

/** One-shot, read-only bootstrap after natural NativeFileModule completion. No settings are written. */
export function createReadOnlySettingsBootstrap(onStatus: (status: "ready" | "unavailable") => void) {
    let pending: Promise<void> | null = null;
    let snapshot: SettingsSnapshot = Object.freeze({ fakeNitro: false, platformIndicator: false });
    function status(value: "ready" | "unavailable"): void {
        try { onStatus(value); } catch (_) { /* Reporting cannot affect client startup. */ }
    }
    return {
        get(): SettingsSnapshot { return snapshot; },
        attach(native: unknown): Promise<void> | undefined {
            if (pending) return pending;
            const scheduler = globalThis.Promise;
            if (typeof scheduler !== "function") { status("unavailable"); return; }
            // Do not run native I/O inside a Metro factory's completion wrapper. Wait for this JS stack to unwind.
            pending = scheduler.resolve().then(async () => {
                let failed = false;
                try {
                    const storage = createNativeSettingsStorage(native);
                    // Deliberately provide no write capability, even if the settings core changes later.
                    const store = createSettingsStore({ read: () => storage.read(), write: async () => { throw new Error("Read-only settings"); } },
                        () => { failed = true; });
                    await store.load();
                    if (!failed) snapshot = store.get();
                    status(failed ? "unavailable" : "ready");
                } catch (_) { status("unavailable"); }
            });
            return pending;
        },
    };
}
