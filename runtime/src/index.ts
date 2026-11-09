// disk runtime entry. Runs inside Discord's Hermes before any Metro module is defined.
// Phase 0: only announces itself; core/ and features/ arrive in Phase 3.

const REVISION = "0.0.1";

if (!globalThis.__disk) {
    globalThis.__disk = Object.freeze({ revision: REVISION });
    if (globalThis.console) globalThis.console.log("[disk] loaded", REVISION);
}
