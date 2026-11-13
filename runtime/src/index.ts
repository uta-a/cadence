// Runs before Metro registration. Capabilities are connected only after their own natural dependencies are ready.
import { logInfo } from "./core/log";
import { parseBuildFeatures } from "./core/features";
import { createMetroObserver } from "./diagnostics/observer";
import { createCoreModules } from "./core/modules";
import { MODULE_PROBES } from "./diagnostics/probes";
import { REVISION } from "./core/version";

if (!globalThis.__cadence) {
    const features = parseBuildFeatures("/*__CADENCE_FEATURES__*/");
    globalThis.__cadence = Object.freeze({ revision: REVISION, features });
    logInfo(`[cadence] loaded ${REVISION}`);
    try {
        const core = createCoreModules(status => logInfo(`[cadence] ${status}`),
            typeof __CADENCE_UI_SMOKE__ !== "undefined" && __CADENCE_UI_SMOKE__, features);
        const observer = createMetroObserver(globalThis, MODULE_PROBES,
            report => logInfo(`[cadence] probe ${JSON.stringify(report)}`),
            () => logInfo("[cadence] observer error"), core.captures);
        logInfo(`[cadence] observer ${observer.install() ? "installed" : "unavailable"}`);
    } catch (_) { logInfo("[cadence] observer unavailable"); }
}
