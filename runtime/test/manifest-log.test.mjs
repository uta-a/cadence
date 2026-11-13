import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const { outputFiles } = await build({ stdin: { contents: 'export * from "./core/log"; export * from "./core/features";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", write: false });
function api(globals = {}) {
    const host = { module: { exports: {} }, console: undefined, ...globals };
    vm.runInNewContext(outputFiles[0].text, host);
    return host.module.exports;
}

test("build feature manifest is immutable, allowlisted and fails closed on markers or malformed selections", () => {
    const { parseBuildFeatures } = api();
    for (const value of ["/*__CADENCE_FEATURES__*/", null, {}, ["unknown"], ["fakeNitro", "fakeNitro"], [true]])
        assert.equal(parseBuildFeatures(value).length, 0);
    const selected = parseBuildFeatures(["fakeNitro", "disableAnalytics"]);
    assert.equal(JSON.stringify(selected), '["fakeNitro","disableAnalytics"]');
    assert.ok(Object.isFrozen(selected));
});

test("diagnostic memory ring is bounded, truncates lines and returns immutable independent snapshots", () => {
    const { logInfo, getLogs } = api();
    for (let i = 0; i < 100; i++) logInfo(`[cadence] fixed ${i}`);
    const snapshot = getLogs();
    assert.equal(snapshot.length, 80);
    assert.equal(snapshot[0], "[cadence] fixed 20");
    assert.ok(Object.isFrozen(snapshot));
    logInfo("x".repeat(2000));
    assert.equal(getLogs().at(-1).length, 1024);
    assert.equal(snapshot.at(-1), "[cadence] fixed 99");
});

test("logger failures do not discard fixed memory diagnostics or retain arbitrary exception text", () => {
    const { logInfo, getLogs } = api({ nativeLoggingHook() { throw new Error("sensitive exception text"); },
        console: { log() { throw new Error("other error"); } } });
    assert.doesNotThrow(() => logInfo("[cadence] ready"));
    logInfo({ user: "not a message" });
    assert.equal(JSON.stringify(getLogs()), '["[cadence] ready"]');
});
