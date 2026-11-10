// Runs before Metro registration. Capabilities are connected only after their own natural dependencies are ready.
import { logInfo } from "./core/log";
import { parseBuildFeatures } from "./core/features";
import { createMetroObserver } from "./diagnostics/observer";
import { createCoreModules } from "./core/modules";
import { MODULE_PROBES } from "./diagnostics/probes";

const REVISION = "0.0.1";
if (!globalThis.__disk) {
    const features = parseBuildFeatures("/*__DISK_FEATURES__*/");
    globalThis.__disk = Object.freeze({ revision: REVISION, features });
    logInfo(`[disk] loaded ${REVISION}`);
    try {
        const core = createCoreModules(status => logInfo(`[disk] ${status}`),
            typeof __DISK_UI_SMOKE__ !== "undefined" && __DISK_UI_SMOKE__, features);
        const observer = createMetroObserver(globalThis, MODULE_PROBES,
            report => logInfo(`[disk] probe ${JSON.stringify(report)}`),
            () => logInfo("[disk] observer error"), core.captures);
        logInfo(`[disk] observer ${observer.install() ? "installed" : "unavailable"}`);
    } catch (_) { logInfo("[disk] observer unavailable"); }
}
