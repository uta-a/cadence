import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const { outputFiles } = await build({ stdin: { contents: 'export * from "./features/venus/hiddenChannels";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", target: "es2019", platform: "neutral", write: false });
const host = { module: { exports: {} } }; vm.runInNewContext(outputFiles[0].text, host);
const { hiddenSnapshot, hiddenDescription, installHiddenChannels } = host.module.exports;
const guild = "175928847299117063", id = "175928847299117064", id2 = "175928847299117065";
const channel = (key, props = {}) => ({ id: key, guild_id: guild, type: 0, name: "loaded-name", position: 1, ...props });

test("hidden metadata requires an explicit real permission denial and does not mutate records or permissions", () => {
    const record = Object.freeze(channel(id)); const full = Object.freeze({ [id]: record });
    const canView = () => false, api = Object.freeze({ canView });
    const snapshot = hiddenSnapshot(guild, { full }, api.canView);
    assert.equal(snapshot.channels.length, 1); assert.equal(snapshot.channels[0].name, "loaded-name");
    assert.equal(full[id], record); assert.equal(api.canView, canView);
    for (const value of [true, undefined, null, 0, "false", Promise.resolve(false)]) {
        assert.equal(hiddenSnapshot(guild, { full }, () => value).channels.length, 0);
    }
    const failed = hiddenSnapshot(guild, { full }, () => { throw new Error("cache unavailable"); });
    assert.equal(failed.unknown, 1); assert.equal(failed.channels.length, 0);
});

test("full records override basic metadata, unsupported channels are skipped and table accessors are never evaluated", () => {
    let accessors = 0;
    const basic = { [id]: channel(id, { name: "basic" }), [id2]: channel(id2, { type: 2, name: "voice" }) };
    Object.defineProperty(basic, "accessor", { enumerable: true, get() { accessors++; throw new Error("getter"); } });
    const full = { [id]: channel(id, { name: "full", position: 0 }), thread: channel("thread", { type: 11 }),
        wrong: channel("wrong", { guild_id: "another" }) };
    const kinds = [];
    const snapshot = hiddenSnapshot(guild, { full, basic }, (value, isBasic) => { kinds.push([value.name, isBasic]); return false; });
    assert.deepEqual(kinds, [["full", false], ["voice", true]], "basic and full records must use their matching permission API");
    assert.deepEqual(Array.from(snapshot.channels, c => c.name), ["full", "voice"]);
    assert.equal(snapshot.unknown, 1); assert.equal(accessors, 0);
    assert.equal(hiddenSnapshot("bad", { full }, () => false), null);
    assert.equal(hiddenSnapshot(guild, null, () => false), null);
});

test("read-only output bounds visible entries, sanitizes control characters and explains incomplete metadata", () => {
    const full = {};
    for (let i = 0; i < 45; i++) { const key = String(BigInt(id) + BigInt(i)); full[key] = channel(key, { name: "name\n" + i }); }
    const snapshot = hiddenSnapshot(guild, { full }, () => false), body = hiddenDescription(snapshot);
    assert.equal((body.match(/ID:/g) ?? []).length, 40); assert.match(body, /ほか 5 件/);
    assert.match(body, /履歴の取得やチャンネルへの移動はしません/);
    assert.doesNotMatch(snapshot.channels[0].name, /\n/);
    assert.match(hiddenDescription(hiddenSnapshot(guild, { full: {} }, () => false)), /読み込み済みの範囲/);
});

test("menu reads caches only on user press and appends without changing normal server actions", () => {
    let enabled = false, reads = 0, shown = [], events = [];
    const stock = [{ label: "Discord", action: () => "stock" }];
    const exports = { default: function (...args) { assert.equal(this, exports); assert.equal(args[1], "tail"); return stock; } };
    assert.equal(installHiddenChannels(exports, { enabled: () => enabled,
        tables: key => { assert.equal(key, guild); reads++; return { full: { [id]: channel(id) } }; }, canView: () => false,
        show: (...args) => { shown.push(args); return true; }, onEvent: event => events.push(event) }), true);
    assert.equal(exports.default(guild, "tail"), stock); enabled = true;
    const menu = exports.default(guild, "tail"); assert.equal(menu.length, 2); assert.equal(reads, 0);
    assert.equal(menu[0], stock[0]); assert.equal(menu[0].action(), "stock");
    menu[1].action(); assert.equal(reads, 1); assert.match(shown[0][1], /loaded-name/);
    enabled = false; menu[1].action(); assert.equal(reads, 1);
    assert.deepEqual(events, ["installed", "opened"]);
});

test("unknown APIs, bad exports and original errors fail open without repeating Discord actions", () => {
    const deps = { enabled: () => true, tables: () => null, canView: () => undefined, show: () => true };
    const failure = new Error("original"); let calls = 0;
    const bad = { default() { calls++; throw failure; } }; installHiddenChannels(bad, deps);
    assert.throws(() => bad.default(guild), e => e === failure); assert.equal(calls, 1);
    assert.equal(installHiddenChannels(Object.freeze({ default() {} }), deps), false);
    const menu = { default: () => [] }, events = []; installHiddenChannels(menu, { ...deps, onEvent: e => events.push(e) });
    assert.doesNotThrow(() => menu.default(guild)[0].action()); assert.deepEqual(events, ["installed", "unavailable"]);
    const wrong = { default: () => 7 }; installHiddenChannels(wrong, deps); assert.equal(wrong.default(guild), 7);
});
