import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
const NITRO_DEFAULT = { emojiSize: 48, maskedLinks: false };

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
    assert.deepEqual(written, [{ version: 2, features: { fakeNitro: true, platformIndicator: false }, preferences: { compact: false }, nitro: NITRO_DEFAULT }]);
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

test("schema1 migrates to schema2 on the next write with compact off", async () => {
    const saved = [];
    const s = store({ read: async () => JSON.stringify({ version: 1,
        features: { fakeNitro: true, platformIndicator: false }, preferences: { compact: true }, nitro: NITRO_DEFAULT }),
        write: async text => saved.push(JSON.parse(text)) });
    await s.load();
    assert.equal(s.get().fakeNitro, true);
    assert.deepEqual(JSON.parse(JSON.stringify(s.getPreferences())), { compact: false });
    assert.deepEqual(saved, []);
    await s.set("platformIndicator", true);
    assert.deepEqual(saved, [{ version: 2, features: { fakeNitro: true, platformIndicator: true }, preferences: { compact: false }, nitro: NITRO_DEFAULT }]);
});

test("compact defaults off, persists independently, and reloads from schema2", async () => {
    let text = null;
    const adapter = { read: async () => text, write: async value => { text = value; } };
    const s = store(adapter);
    assert.deepEqual(JSON.parse(JSON.stringify(s.getPreferences())), { compact: false });
    assert.throws(() => { s.getPreferences().compact = true; }, TypeError);
    await s.load();
    const notifications = [], featureNotifications = [];
    const unsubscribe = s.subscribePreferences(value => notifications.push(value.compact));
    s.subscribe(value => featureNotifications.push(value));
    await s.setPreference("compact", true);
    await s.setPreference("compact", true);
    assert.deepEqual(JSON.parse(text), { version: 2, features: allOff, preferences: { compact: true }, nitro: NITRO_DEFAULT });
    assert.deepEqual(notifications, [true]);
    assert.deepEqual(featureNotifications, []);
    const reloaded = store(adapter);
    const loaded = [];
    reloaded.subscribePreferences(value => loaded.push(value.compact));
    await reloaded.load();
    assert.equal(reloaded.getPreferences().compact, true);
    assert.deepEqual(JSON.parse(JSON.stringify(reloaded.get())), allOff);
    assert.deepEqual(loaded, [true]);
    unsubscribe();
    await s.setPreference("compact", false);
    assert.deepEqual(notifications, [true]);
});

test("schema2 reads only own allowlisted strict-boolean values", async () => {
    const s = store({ read: async () => JSON.stringify({ version: 2,
        features: { fakeNitro: true, platformIndicator: 1, compact: true },
        preferences: { compact: true, fakeNitro: true, accountToken: "secret" } }), write: async () => {} });
    await s.load();
    assert.deepEqual(JSON.parse(JSON.stringify(s.get())), { fakeNitro: true, platformIndicator: false });
    assert.deepEqual(JSON.parse(JSON.stringify(s.getPreferences())), { compact: true });
    for (const compact of ["true", 1, null, {}, [], false]) {
        const malformed = store({ read: async () => JSON.stringify({ version: 2, features: allOff, preferences: { compact }, nitro: NITRO_DEFAULT }),
            write: async () => {} });
        await malformed.load();
        assert.equal(malformed.getPreferences().compact, false);
    }
    const polluted = store({ read: async () => '{"version":2,"features":{},"preferences":{}}', write: async () => {} },
        () => {}, "Object.prototype.fakeNitro = true; Object.prototype.platformIndicator = true; Object.prototype.compact = true");
    await polluted.load();
    assert.deepEqual(JSON.parse(JSON.stringify(polluted.get())), allOff);
    assert.equal(polluted.getPreferences().compact, false);
});

test("schema2 requires own schema fields and a preferences object", async () => {
    for (const [text, setup] of [
        ['{"version":2,"features":{}}', 'Object.prototype.preferences = { compact: true }'],
        ['{"features":{},"preferences":{}}', 'Object.prototype.version = 2'],
        ['{"version":2,"preferences":{}}', 'Object.prototype.features = { fakeNitro: true }'],
        ['{"version":2,"features":{},"preferences":null}', ''],
        ['{"version":2,"features":{},"preferences":[]}', ''],
        ['{"version":3,"features":{},"preferences":{"compact":true}}', ''],
    ]) {
        const errors = [];
        const s = store({ read: async () => text, write: async () => {} }, error => errors.push(error), setup);
        await s.load();
        assert.equal(errors.length, 1);
        assert.equal(s.ready, true);
        assert.equal(s.getPreferences().compact, false);
        assert.deepEqual(JSON.parse(JSON.stringify(s.get())), allOff);
    }
});

test("unknown preferences and nonboolean values are rejected without writes or notifications", async () => {
    const saved = [], notified = [];
    const s = store({ read: async () => null, write: async text => saved.push(text) });
    await s.load();
    s.subscribePreferences(value => notified.push(value));
    for (const key of ["fakeNitro", "accountToken", "__proto__", "toString"]) {
        await assert.rejects(s.setPreference(key, true), TypeError);
    }
    for (const value of ["true", 1, null, undefined, {}]) {
        await assert.rejects(s.setPreference("compact", value), TypeError);
    }
    assert.deepEqual(saved, []);
    assert.deepEqual(notified, []);
    assert.equal(s.getPreferences().compact, false);
});

test("preference changes before or during load beat stale disk features and preferences", async () => {
    for (const beforeLoad of [true, false]) {
        for (const compact of [true, false]) {
            let finish;
            const saved = [];
            const s = store({ read: () => new Promise(resolve => { finish = resolve; }),
                write: async text => saved.push(JSON.parse(text)) });
            if (beforeLoad) await s.setPreference("compact", compact);
            const loading = s.load();
            if (!beforeLoad) await s.setPreference("compact", compact);
            finish(JSON.stringify({ version: 2, features: { fakeNitro: true, platformIndicator: true },
                preferences: { compact: !compact }, nitro: NITRO_DEFAULT }));
            await loading;
            assert.equal(s.getPreferences().compact, compact);
            assert.deepEqual(JSON.parse(JSON.stringify(s.get())), allOff);
            assert.deepEqual(saved, [{ version: 2, features: allOff, preferences: { compact }, nitro: NITRO_DEFAULT }]);
        }
    }
});

test("a feature mutation during load also protects local preferences", async () => {
    let finish;
    const s = store({ read: () => new Promise(resolve => { finish = resolve; }), write: async () => {} });
    const loading = s.load();
    await s.set("fakeNitro", true);
    finish(JSON.stringify({ version: 2, features: allOff, preferences: { compact: true }, nitro: NITRO_DEFAULT }));
    await loading;
    assert.equal(s.get().fakeNitro, true);
    assert.equal(s.getPreferences().compact, false);
});

test("mixed concurrent feature and preference writes share one ordered snapshot queue", async () => {
    let finish;
    const saved = [];
    const s = store({ read: async () => null, write: text => {
        saved.push(JSON.parse(text));
        return saved.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
    } });
    const first = s.setPreference("compact", true);
    const second = s.set("fakeNitro", true);
    const third = s.setPreference("compact", false);
    const fourth = s.set("platformIndicator", true);
    await Promise.resolve();
    assert.equal(saved.length, 1);
    finish();
    await Promise.all([first, second, third, fourth]);
    assert.deepEqual(saved, [
        { version: 2, features: allOff, preferences: { compact: true }, nitro: NITRO_DEFAULT },
        { version: 2, features: { fakeNitro: true, platformIndicator: false }, preferences: { compact: true }, nitro: NITRO_DEFAULT },
        { version: 2, features: { fakeNitro: true, platformIndicator: false }, preferences: { compact: false }, nitro: NITRO_DEFAULT },
        { version: 2, features: { fakeNitro: true, platformIndicator: true }, preferences: { compact: false }, nitro: NITRO_DEFAULT },
    ]);
});

test("mixed reentrant listeners queue writes before notifying and isolate errors", async () => {
    const saved = [], errors = [], healthy = [], nested = [];
    const s = store({ read: async () => null, write: async text => saved.push(JSON.parse(text)) }, error => {
        errors.push(error.message);
        throw new Error("broken diagnostics");
    });
    s.subscribePreferences(value => {
        if (value.compact) nested.push(s.set("fakeNitro", true));
        throw new Error("bad preference listener");
    });
    s.subscribePreferences(value => healthy.push(value.compact));
    s.subscribe(value => {
        if (value.fakeNitro) nested.push(s.setPreference("compact", false));
    });
    await s.setPreference("compact", true);
    await Promise.all(nested);
    assert.deepEqual(saved, [
        { version: 2, features: allOff, preferences: { compact: true }, nitro: NITRO_DEFAULT },
        { version: 2, features: { fakeNitro: true, platformIndicator: false }, preferences: { compact: true }, nitro: NITRO_DEFAULT },
        { version: 2, features: { fakeNitro: true, platformIndicator: false }, preferences: { compact: false }, nitro: NITRO_DEFAULT },
    ]);
    assert.deepEqual(errors, ["bad preference listener", "bad preference listener"]);
    assert.deepEqual(healthy, [false, false]);
});

test("unchanged compact can retry a failed write without blocking later feature writes", async () => {
    const saved = [], errors = [];
    let fail = true;
    const s = store({ read: async () => null, write: async text => {
        saved.push(JSON.parse(text));
        if (fail) { fail = false; throw new Error("disk full"); }
    } }, error => { errors.push(error.message); throw new Error("broken diagnostics"); });
    const first = s.setPreference("compact", true);
    const retry = s.setPreference("compact", true);
    const feature = s.set("platformIndicator", true);
    await assert.rejects(first, /disk full/);
    await Promise.all([retry, feature]);
    assert.deepEqual(errors, ["disk full"]);
    assert.equal(saved.length, 3);
    assert.deepEqual(saved[0], saved[1]);
    assert.deepEqual(saved[2], { version: 2, features: { fakeNitro: false, platformIndicator: true }, preferences: { compact: true }, nitro: NITRO_DEFAULT });
});
