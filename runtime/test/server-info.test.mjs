import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const { outputFiles } = await build({ stdin: { contents: 'export * from "./features/venus/serverInfo";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true,
    format: "cjs", platform: "neutral", target: "es2019", write: false });
const host = { module: { exports: {} } }; vm.runInNewContext(outputFiles[0].text, host);
const { serverSnapshot, installServerInfo } = host.module.exports;
const id = "175928847299117063";

test("server info shows only loaded metadata and derives creation time without network", () => {
    const snapshot = serverSnapshot(id, { id, name: "Test\nserver", ownerId: "175928847299117064", memberCount: 12,
        premiumTier: 1, premiumSubscriberCount: 2, preferredLocale: "ja", verificationLevel: 2 });
    assert.equal(snapshot.title, "Test server");
    assert.match(snapshot.message, /2016-04-30/);
    assert.match(snapshot.message, /メンバー数: 12/);
    assert.match(snapshot.message, /所有者ID:/);
    assert.doesNotMatch(serverSnapshot(id, { id, member_count: -1 }).message, /メンバー数:/);
    assert.equal(serverSnapshot("bad", {}), null);
    assert.equal(serverSnapshot(id, { id: "other" }), null);
    assert.equal(serverSnapshot(id, { get id() { throw new Error("unavailable"); } }), null);
});

test("server info appends one menu action, preserves originals, honors late disable and reads the store only on press", () => {
    let enabled = false, reads = 0, shown = [], events = [];
    const items = [{ label: "Discord" }];
    const actions = { default: function (...args) { assert.equal(this, actions); assert.equal(args[1], "tail"); return items; } };
    assert.equal(installServerInfo(actions, { enabled: () => enabled,
        guild: guildId => { reads++; assert.equal(guildId, id); return { id, name: "server" }; },
        show: (...args) => { shown.push(args); return true; }, onEvent: e => events.push(e) }), true);
    assert.equal(actions.default(id, "tail"), items);
    enabled = true;
    const menu = actions.default(id, "tail"); assert.equal(menu.length, 2); assert.equal(items.length, 1);
    assert.equal(menu[0], items[0]); assert.equal(reads, 0);
    menu[1].action(); assert.equal(reads, 1); assert.equal(shown[0][0], "server");
    enabled = false; menu[1].action(); assert.equal(reads, 1);
    assert.deepEqual(events, ["installed", "opened"]);
});

test("server info preserves original exceptions, unsupported shapes and reports unavailable data", () => {
    const failure = new Error("original"); let calls = 0;
    const actions = { default() { calls++; throw failure; } };
    const deps = { enabled: () => true, guild: () => undefined, show: () => false };
    assert.equal(installServerInfo(actions, deps), true);
    assert.throws(() => actions.default(id), e => e === failure); assert.equal(calls, 1);
    assert.equal(installServerInfo(Object.freeze({ default() {} }), deps), false);
    assert.equal(installServerInfo({ get default() { throw failure; } }, deps), false);
    const unsupported = { default: () => null }; installServerInfo(unsupported, deps);
    assert.equal(unsupported.default(id), null);
    const events = [], menu = { default: () => [] };
    installServerInfo(menu, { ...deps, onEvent: e => events.push(e) }); menu.default(id)[0].action();
    assert.deepEqual(events, ["installed", "unavailable"]);
});
