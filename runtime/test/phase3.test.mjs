import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const { outputFiles } = await build({ stdin: { contents: 'export * from "./core/modules"; export * from "./core/ui"; export * from "./core/settings-controller";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
function api(globals = {}) {
    const host = { module: { exports: {} }, ...globals };
    vm.runInNewContext(outputFiles[0].text, host);
    return host.module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
function memory() {
    let text = null, failRead = false, failWrite = false;
    const writes = [];
    const storage = { read: async () => { if (failRead) throw new Error("read"); return text; },
        write: async value => { if (failWrite) throw new Error("write"); writes.push(JSON.parse(value)); text = value; } };
    return { storage, writes, setText: value => { text = value; }, readFail: value => { failRead = value; }, writeFail: value => { failWrite = value; } };
}

test("settings controller defers load, refuses premature writes, and persists schema2 compact", async () => {
    const m = memory(), events = [], { createSettingsController } = api();
    const c = createSettingsController(value => events.push(value), () => m.storage);
    await assert.rejects(c.setCompact(true));
    const pending = c.attach({});
    assert.equal(c.get().phase, "loading");
    assert.deepEqual(m.writes, []);
    await pending;
    assert.equal(c.get().phase, "ready");
    await c.setCompact(true);
    assert.equal(c.get().preferences.compact, true);
    assert.equal(c.get().save, "saved");
    assert.deepEqual(m.writes, [{ version: 2, features: { fakeNitro: false, platformIndicator: false }, preferences: { compact: true } }]);
    const reloaded = createSettingsController(() => {}, () => m.storage);
    await reloaded.attach({});
    assert.equal(reloaded.get().preferences.compact, true);
    assert.deepEqual(events, ["ready", "saved"]);
});

test("failed initial read disables writes; retry is explicit and succeeds without resetting disk", async () => {
    const m = memory(), { createSettingsController } = api();
    m.setText('{"version":2,"features":{},"preferences":{"compact":true}}');
    m.readFail(true);
    const c = createSettingsController(() => {}, () => m.storage);
    await c.attach({});
    assert.equal(c.get().phase, "error");
    await assert.rejects(c.setCompact(false));
    assert.deepEqual(m.writes, []);
    m.readFail(false);
    await c.retryLoad();
    assert.equal(c.get().phase, "ready");
    assert.equal(c.get().preferences.compact, true);
    assert.deepEqual(m.writes, []);
});

test("failed save is visible and can retry the same optimistic value; listener failures are isolated", async () => {
    const m = memory(), { createSettingsController } = api();
    const c = createSettingsController(() => { throw new Error("log"); }, () => m.storage);
    c.subscribe(() => { throw new Error("UI subscriber"); });
    await c.attach({});
    m.writeFail(true);
    await assert.rejects(c.setCompact(true));
    assert.equal(c.get().save, "error");
    assert.equal(c.get().preferences.compact, true);
    m.writeFail(false);
    await c.setCompact(true);
    assert.equal(c.get().save, "saved");
    assert.equal(m.writes.length, 1);
});

function moduleFixture(smoke = false, globals = {}) {
    const timers = [];
    const { createCoreModules } = api({ setTimeout(fn) { timers.push(fn); }, ...globals }), events = [], imports = [];
    const core = createCoreModules(value => events.push(value), smoke);
    const captures = new Map(core.captures.map(c => [c.id, c.onExports]));
    let ready = false, opens = 0, lazyReads = 0;
    const harness = reactHarness(), react = harness.react, rn = {};
    for (const key of ["View", "Text", "Pressable", "ScrollView", "Switch", "Modal"])
        Object.defineProperty(rn, key, { get() { lazyReads++; return () => {}; } });
    const context = { requireModule(id) { imports.push(id); assert.equal(id, 7522); return { openUserSettings() { opens++; } }; } };
    captures.get(19)(react, context);
    captures.get(17)(rn, context);
    captures.get(5183)({ getRootNavigationRef: () => ({ isReady: () => ready }) }, context);
    return { core, captures, context, events, imports, timers, harness, setReady: value => { ready = value; }, get opens() { return opens; }, get lazyReads() { return lazyReads; } };
}

test("per-module gate does not import anything before root navigation readiness", () => {
    const f = moduleFixture();
    assert.equal(f.core.openSettings(), false);
    assert.deepEqual(f.imports, []);
    assert.equal(f.lazyReads, 0);
    f.setReady(true);
    assert.equal(f.core.openSettings(), true);
    assert.deepEqual(f.imports, [7522]);
    assert.equal(f.opens, 1);
});

test("overview wraps before its first consumer but defers native lazy getters until navigation becomes ready", () => {
    const f = moduleFixture(), original = () => {}, exports = { default: original };
    f.captures.get(18400)(exports, f.context);
    assert.notEqual(exports.default, original);
    assert.equal(f.lazyReads, 0);
    const before = f.harness.render(exports.default);
    assert.ok(nodes(before).some(node => node.type === original));
    assert.equal(f.lazyReads, 0);
    f.setReady(true);
    f.timers.shift()();
    const after = f.harness.render(exports.default);
    assert.ok(nodes(after).some(node => node.type === original));
    assert.equal(f.lazyReads, 6);
    assert.equal(f.core.uiInstalled, true);
    const descriptor = Object.getOwnPropertyDescriptor(exports, "default");
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.enumerable, true);
});

test("late readiness after the fast polling window still enables UI without early native getters", () => {
    const f = moduleFixture(), original = () => {}, exports = { default: original };
    f.captures.get(18400)(exports, f.context);
    f.harness.render(exports.default);
    for (let i = 0; i < 45; i++) { assert.equal(f.timers.length, 1); f.timers.shift()(); }
    assert.equal(f.lazyReads, 0);
    f.setReady(true);
    f.timers.shift()();
    const tree = f.harness.render(exports.default);
    assert.equal(f.lazyReads, 6);
    assert.ok(nodes(tree).some(node => node.props.accessibilityLabel === "disk"));
    assert.equal(f.timers.length, 0);
    f.harness.unmount();
});

test("immutable overview exports remain unchanged and diagnostic smoke retry is bounded", () => {
    const timers = [], f = moduleFixture(true, { setTimeout(fn) { timers.push(fn); } });
    const original = () => {}, exports = Object.freeze({ default: original });
    f.setReady(true);
    f.captures.get(18400)(exports, f.context);
    assert.equal(exports.default, original);
    assert.equal(f.core.uiInstalled, false);
    f.setReady(false);
    let calls = 0;
    while (timers.length && calls < 30) { timers.shift()(); calls++; }
    assert.equal(calls, 20);
    assert.deepEqual(f.imports, []);
});

function reactHarness() {
    const states = [], effects = [], cleanups = [];
    let cursor = 0, nextEffects = [], hookCalls = 0;
    const react = {
        Fragment: "Fragment",
        createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
        useState(initial) {
            const id = cursor++; hookCalls++;
            if (!(id in states)) states[id] = typeof initial === "function" ? initial() : initial;
            return [states[id], value => { states[id] = typeof value === "function" ? value(states[id]) : value; }];
        },
        useEffect(fn, deps) {
            const id = cursor++; hookCalls++;
            if (!effects[id] || deps.some((v, i) => v !== effects[id][i])) { effects[id] = deps; nextEffects.push([id, fn]); }
        },
    };
    return { react, render(component, props = {}, beforeEffects = () => {}) {
        cursor = 0; hookCalls = 0;
        const tree = component(props);
        beforeEffects();
        for (const [id, fn] of nextEffects) { cleanups[id]?.(); cleanups[id] = fn(); }
        nextEffects = [];
        assert.equal(hookCalls, 7, "wrapper hook order stays fixed");
        return tree;
    }, unmount() { cleanups.forEach(fn => fn?.()); } };
}
function nodes(tree) {
    if (!tree || typeof tree !== "object") return [];
    return [tree, ...(tree.children ?? []).flatMap(nodes)];
}

test("UI resynchronizes changes between initial render and effect subscription", () => {
    const { createSettingsOverview } = api(), harness = reactHarness();
    let state = { phase: "loading", save: "idle", preferences: { compact: false } }, subscribed = false;
    const c = { get: () => state, subscribe() { subscribed = true; return () => {}; } };
    const native = { View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", Switch: "Switch", Modal: "Modal" };
    const component = createSettingsOverview(harness.react, () => native, () => {}, c);
    harness.render(component, {}, () => { assert.equal(subscribed, false); state = { phase: "ready", save: "idle", preferences: { compact: true } }; });
    const tree = harness.render(component);
    assert.equal(nodes(tree).find(node => node.type === "Switch").props.value, true);
    assert.equal(nodes(tree).find(node => node.type === "Switch").props.disabled, false);
    harness.unmount();
});

test("disk overview entry renders original as an element, opens settings, saves compact, and handles back", async () => {
    const { createSettingsOverview, createSettingsController } = api(), m = memory();
    const c = createSettingsController(() => {}, () => m.storage);
    await c.attach({});
    const harness = reactHarness();
    const native = { View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", Switch: "Switch", Modal: "Modal" };
    const original = () => assert.fail("original may only be rendered by React, never directly called");
    const component = createSettingsOverview(harness.react, () => native, original, c);
    const props = { original: "preserved" };
    let tree = harness.render(component, props);
    assert.equal(nodes(tree).find(node => node.type === original).props.original, props.original);
    nodes(tree).find(node => node.props.accessibilityLabel === "disk").props.onPress();
    tree = harness.render(component);
    assert.ok(nodes(tree).some(node => node.children?.includes("disk 設定")));
    let toggle = nodes(tree).find(node => node.type === "Switch");
    assert.equal(toggle.props.value, false);
    toggle.props.onValueChange(true);
    await new Promise(resolve => setImmediate(resolve));
    tree = harness.render(component);
    toggle = nodes(tree).find(node => node.type === "Switch");
    assert.equal(toggle.props.value, true);
    assert.ok(nodes(tree).some(node => node.props.accessibilityLabel === "disk:saved"));
    nodes(tree).find(node => node.props.accessibilityLabel === "disk:logs").props.onPress();
    tree = harness.render(component);
    assert.ok(nodes(tree).some(node => node.props.accessibilityLabel === "disk:log-content"));
    assert.ok(nodes(tree).some(node => node.props.accessibilityLabel === "disk:features"));
    assert.equal(m.writes.at(-1).preferences.compact, true);
    assert.ok(nodes(tree).some(node => node.type === original), "original stays mounted behind modal");
    nodes(tree).find(node => node.type === "Modal").props.onRequestClose();
    tree = harness.render(component);
    assert.ok(nodes(tree).some(node => node.type === original));
    assert.equal(nodes(tree).find(node => node.type === "Modal").props.visible, false);
    harness.unmount();
});
