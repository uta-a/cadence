import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

const { outputFiles } = await build({ entryPoints: [new URL("../src/core/read-only-settings.ts", import.meta.url).pathname],
    bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
function bootstrap(onStatus, globals = {}) {
    const host = { module: { exports: {} }, ...globals };
    vm.runInNewContext(outputFiles[0].text, host);
    return host.module.exports.createReadOnlySettingsBootstrap(onStatus);
}
const plain = value => JSON.parse(JSON.stringify(value));
const off = { fakeNitro: false, platformIndicator: false };
function native(overrides = {}) {
    const calls = [];
    const module = {
        getConstants() { calls.push("constants"); return { DocumentsDirPath: "/data/user/0/com.discord/files" }; },
        async fileExists() { calls.push("exists"); return false; },
        async readFile() { calls.push("read"); return "{}"; },
        async writeFile() { calls.push("write"); assert.fail("must never write"); },
        ...overrides,
    };
    return { module, calls };
}

test("read-only attachment defers I/O until stack completion and never writes a missing file", async () => {
    const { module, calls } = native(), statuses = [], store = bootstrap(value => statuses.push(value));
    assert.deepEqual(calls, []);
    const pending = store.attach(module);
    assert.deepEqual(calls, []);
    await pending;
    assert.deepEqual(calls, ["constants", "exists"]);
    assert.deepEqual(statuses, ["ready"]);
    assert.deepEqual(plain(store.get()), off);
    assert.ok(Object.isFrozen(store.get()));
    assert.equal("set" in store, false);
});

test("existing cadence-only settings are allowlisted without retaining unknown fields", async () => {
    const { module } = native({ fileExists: async () => true,
        readFile: async () => JSON.stringify({ version: 1, features: { fakeNitro: true, platformIndicator: false }, accountToken: "not retained" }) });
    const statuses = [], store = bootstrap(value => statuses.push(value));
    await store.attach(module);
    assert.deepEqual(statuses, ["ready"]);
    assert.deepEqual(plain(store.get()), { fakeNitro: true, platformIndicator: false });
    assert.equal(JSON.stringify(store.get()).includes("not retained"), false);
});

test("read/shape/schema/root failures are reported with fixed status only and remain all off", async () => {
    for (const module of [null,
        native({ getConstants: () => ({ DocumentsDirPath: "/sdcard" }) }).module,
        native({ fileExists: async () => { throw new Error("private error"); } }).module,
        native({ fileExists: async () => true, readFile: async () => "bad JSON" }).module]) {
        const statuses = [], store = bootstrap(value => statuses.push(value));
        await assert.doesNotReject(store.attach(module));
        assert.deepEqual(statuses, ["unavailable"]);
        assert.deepEqual(plain(store.get()), off);
    }
});

test("a missing Promise scheduler disables I/O rather than running it synchronously", () => {
    const { module, calls } = native(), statuses = [];
    const store = bootstrap(value => statuses.push(value), { Promise: undefined });
    assert.equal(store.attach(module), undefined);
    assert.deepEqual(statuses, ["unavailable"]);
    assert.deepEqual(calls, []);
});

test("capture is one-shot and a failing status callback never escapes", async () => {
    const { module, calls } = native();
    const store = bootstrap(() => { throw new Error("logger failed"); });
    const first = store.attach(module);
    assert.equal(store.attach(null), first);
    await assert.doesNotReject(first);
    assert.deepEqual(calls, ["constants", "exists"]);
    await store.attach(module);
    assert.deepEqual(calls, ["constants", "exists"]);
});
