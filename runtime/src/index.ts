// disk runtime entry. Runs inside Discord's Hermes before any Metro module is defined.
// Observe natural completion only. Feature hooks and the initializer gate stay disconnected; disk settings are read-only.
import { logInfo } from "./core/log";
import { createMetroObserver, inspectPath } from "./diagnostics/observer";
import { createReadOnlySettingsBootstrap } from "./core/read-only-settings";
import { MODULE_PROBES } from "./diagnostics/probes";

const REVISION = "0.0.1";

if (!globalThis.__disk) {
    globalThis.__disk = Object.freeze({ revision: REVISION });
    logInfo(`[disk] loaded ${REVISION}`);
    try {
        const fileProbe = MODULE_PROBES.find(probe => probe.name === "FileModule");
        if (!fileProbe) throw new Error("FileModule probe absent");
        const settings = createReadOnlySettingsBootstrap(status => logInfo(`[disk] settings read-only ${status}`));
        const observer = createMetroObserver(globalThis, MODULE_PROBES,
            report => logInfo(`[disk] probe ${JSON.stringify(report)}`),
            () => logInfo("[disk] observer error"), {
                id: fileProbe.id,
                onExports(exports) {
                    try {
                        for (const path of fileProbe.paths.filter(path => path !== "default"))
                            if (inspectPath(exports, path) !== "function") throw new Error("Native method shape mismatch");
                        if (!exports || typeof exports !== "object") throw new Error("Native export absent");
                        const descriptor = Object.getOwnPropertyDescriptor(exports, "default");
                        if (!descriptor || !("value" in descriptor)) throw new Error("Native data export absent");
                        void settings.attach(descriptor.value);
                    } catch (_) { logInfo("[disk] settings read-only unavailable"); }
                },
            });
        logInfo(`[disk] observer ${observer.install() ? "installed" : "unavailable"}`);
    } catch (_) { logInfo("[disk] observer unavailable"); }
}
