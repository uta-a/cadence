import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

const { outputFiles } = await build({ entryPoints: [new URL("../src/core/settings.ts", import.meta.url).pathname],
    bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
function store(adapter, report = () => {}, setup = "") {
    const sandbox = vm.createContext({ module: { exports: {} }, exports: {}, Promise, Set, Error, TypeError });
    vm.runInContext(outputFiles[0].text, sandbox);
    if (setup) vm.runInContext(setup, sandbox);
    return sandbox.module.exports.createSettingsStore(adapter, report);
}

const allOff = { fakeNitro: false, platformIndicator: false };

test("missing file starts with both features off; only supported keys and booleans save", async () => {
    const written = [];
    const s = store({ read: async () => null, write: async (value) => { written.push(JSON.parse(value)); } });
    assert.deepEqual(JSON.parse(JSON.stringify(s.get())), allOff);
    await s.load();
    assert.equal(s.ready, true);
    await assert.rejects(s.set("accountToken", true), TypeError);
    await assert.rejects(s.set("fakeNitro", "yes"), TypeError);
    await s.set("fakeNitro", true);
    assert.deepEqual(written, [{ version: 1, features: { fakeNitro: true, platformIndicator: false } }]);
    assert.throws(() => { s.get().fakeNitro = false; }, TypeError);
});

test("unknown or malformed saved keys cannot enable features", async () => {
    const errors = [];
    const s = store({ read: async () => JSON.stringify({ version: 1, features: {
        fakeNitro: "true", platformIndicator: true, accountToken: "secret" }, accountToken: "secret" }),
        write: async () => {} }, e => errors.push(e));
    await s.load();
    assert.deepEqual(JSON.parse(JSON.stringify(s.get())), { fakeNitro: false, platformIndicator: true });
    assert.equal(JSON.stringify(s.get()).includes("secret"), false);
    assert.equal(errors.length, 0);
    const bad = store({ read: async () => "{invalid", write: async () => {} }, e => errors.push(e));
    await bad.load();
    assert.deepEqual(JSON.parse(JSON.stringify(bad.get())), allOff);
    assert.equal(errors.length, 1);
});

test("a pre-load change survives a stale disk read and is persisted", async () => {
    const saved = [];
    const s = store({ read: async () => JSON.stringify({ version: 1, features: allOff }),
        write: async text => saved.push(JSON.parse(text)) });
    await s.set("fakeNitro", true);
    await s.load();
    assert.equal(s.get().fakeNitro, true);
    assert.equal(saved.at(-1).features.fakeNitro, true);
});

test("a pending pre-load write cannot be overwritten by an older disk read", async () => {
    let finishWrite;
    const s = store({ read: async () => JSON.stringify({ version: 1, features: allOff }),
        write: () => new Promise(resolve => { finishWrite = resolve; }) });
    const saving = s.set("fakeNitro", true);
    await Promise.resolve();
    assert.equal(typeof finishWrite, "function");
    await s.load();
    assert.equal(s.get().fakeNitro, true);
    finishWrite();
    await saving;
});

test("setting an unchanged default while loading persists the explicit off choice", async () => {
    let finish;
    const saved = [];
    const s = store({ read: () => new Promise(resolve => { finish = resolve; }),
        write: async text => saved.push(JSON.parse(text)) });
    const loading = s.load();
    await s.set("fakeNitro", false);
    finish(JSON.stringify({ version: 1, features: { fakeNitro: true, platformIndicator: false } }));
    await loading;
    assert.equal(s.get().fakeNitro, false);
    assert.equal(saved.at(-1).features.fakeNitro, false);
});

test("inherited schema fields are not accepted", async () => {
    const errors = [];
    const s = store({ read: async () => '{"accountToken":"secret"}', write: async () => {} },
        error => errors.push(error),
        "Object.prototype.version = 1; Object.prototype.features = {fakeNitro: true, platformIndicator: true}");
    await s.load();
    assert.deepEqual(JSON.parse(JSON.stringify(s.get())), allOff);
    assert.equal(errors.length, 1);
});

test("rapid toggles save snapshots in order; a rejected write does not block later writes", async () => {
    const saved = [], errors = [], listeners = [];
    let fail = true;
    const s = store({ read: async () => null, write: async text => {
        const snapshot = JSON.parse(text);
        saved.push(snapshot.features.fakeNitro);
        if (fail) { fail = false; throw new Error("disk full"); }
    } }, e => errors.push(e.message));
    await s.load();
    const unsubscribe = s.subscribe(value => { listeners.push(value.fakeNitro); throw new Error("bad listener"); });
    const first = s.set("fakeNitro", true);
    const second = s.set("fakeNitro", false);
    await assert.rejects(first, /disk full/);
    await second;
    unsubscribe();
    await s.set("fakeNitro", true);
    assert.deepEqual(saved, [true, false, true]);
    assert.deepEqual(listeners, [true, false]);
    assert.deepEqual(errors, ["bad listener", "bad listener", "disk full"]);
});

test("an unchanged value can retry a failed save", async () => {
    const saved = [];
    let fail = true;
    const s = store({ read: async () => null, write: async text => {
        if (fail) { fail = false; throw new Error("disk full"); }
        saved.push(JSON.parse(text));
    } });
    await s.load();
    await assert.rejects(s.set("fakeNitro", true), /disk full/);
    await s.set("fakeNitro", true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].features.fakeNitro, true);
});

test("a listener's reentrant update saves after the triggering update", async () => {
    const saved = [];
    const s = store({ read: async () => null, write: async text => saved.push(JSON.parse(text).features) });
    await s.load();
    let nested;
    const unsubscribe = s.subscribe(value => {
        if (value.fakeNitro && !value.platformIndicator) {
            unsubscribe();
            nested = s.set("platformIndicator", true);
        }
    });
    await s.set("fakeNitro", true);
    await nested;
    assert.deepEqual(saved, [
        { fakeNitro: true, platformIndicator: false },
        { fakeNitro: true, platformIndicator: true },
    ]);
});

test("a load racing with a local toggle never re-enables a stale disk value", async () => {
    let finish;
    const saved = [];
    const s = store({ read: () => new Promise(resolve => { finish = resolve; }), write: async text => saved.push(JSON.parse(text)) });
    const loading = s.load();
    const changed = s.set("fakeNitro", true);
    finish(JSON.stringify({ version: 1, features: allOff }));
    await Promise.all([loading, changed]);
    assert.equal(s.get().fakeNitro, true);
    assert.equal(saved.at(-1).features.fakeNitro, true);
});
