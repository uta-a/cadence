import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const { outputFiles } = await build({ stdin: { contents: [
    'export * from "./features/platformPlacements";', 'export * from "./core/settings";',
    'export * from "./core/settings-controller";'].join(" "),
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
const host = { module: { exports: {} }, Promise }; vm.runInNewContext(outputFiles[0].text, host);
const { createPlatformPlacements, createSettingsStore, DEFAULT_PLATFORM, createSettingsController } = host.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const h = (type, props, ...children) => ({ type, key: props?.key, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } });
function setup(overrides = {}) {
    let enabled = true, subscriptions = 0;
    const react = { createElement: h, cloneElement: (node, props) => ({ ...node, props: { ...node.props, ...props } }),
        useState: v => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {} };
    const runtime = createPlatformPlacements({ react, native: () => ({ View: "View", Text: "Text" }), provider: "Provider",
        enabled: () => enabled, subscribe: () => { subscriptions++; return () => {}; },
        channel: id => ({ id, type: 1, recipients: ["u"] }), status: () => ({ desktop: "online", mobile: "idle" }),
        badge: () => "Badge", ...overrides });
    return { runtime, on: value => { enabled = value; } };
}

test("platform location settings are backward-compatible, strict, persisted and notified", async () => {
    let saved;
    const store = createSettingsStore({ read: async () => JSON.stringify({ version: 2, features: {}, preferences: {} }),
        write: async text => { saved = text; } });
    await store.load(); assert.deepEqual(plain(store.getPlatform()), plain(DEFAULT_PLATFORM));
    assert.equal(store.get().platformIndicator, false, "place defaults never enable the feature");
    await store.set("platformIndicator", true); assert.equal("platform" in JSON.parse(saved), false, "default places need no schema change");
    let updates = 0; const unsubscribe = store.subscribePlatform(() => updates++);
    await store.setPlatform("messages", false); assert.equal(updates, 1);
    assert.equal(JSON.parse(saved).platform.messages, false);
    const loaded = createSettingsStore({ read: async () => saved, write: async () => {} }); await loaded.load();
    assert.equal(loaded.getPlatform().messages, false); assert.equal(loaded.getPlatform().dmHeader, true);
    await assert.rejects(store.setPlatform("unknown", false)); await assert.rejects(store.setPlatform("profile", 1));
    unsubscribe(); await store.setPlatform("profile", false); assert.equal(updates, 1);
    const malformed = createSettingsStore({ read: async () => JSON.stringify({ version: 2, features: {}, preferences: {},
        platform: { dmList: false, messages: "false", token: "ignored" } }), write: async () => {} });
    await malformed.load(); assert.equal(malformed.getPlatform().dmList, false); assert.equal(malformed.getPlatform().messages, true);
    assert.equal("token" in malformed.getPlatform(), false);
});

test("controller publishes place changes without changing the global feature flag", async () => {
    const controller = createSettingsController(() => {}, () => ({ read: async () => null, write: async () => {} }));
    await controller.attach({}); await controller.setPlatform("avatars", false);
    assert.equal(controller.get().platform.avatars, false); assert.equal(controller.isEnabled("platformIndicator"), false);
});

test("placement clones only the name subtree, leaves frozen siblings and handlers intact, and avoids Text nesting", () => {
    const { runtime, on } = setup();
    const press = () => {}, title = Object.freeze(h("Text", { children: "name" })), other = h("Action", {});
    const tree = Object.freeze(h("View", { onPress: press, children: Object.freeze([title, other]) }));
    const next = runtime.placeTree(tree, { user: { id: "u" } }, "memberList", false);
    assert.notEqual(next, tree); assert.equal(next.props.onPress, press); assert.equal(next.props.children[1], other);
    assert.equal(next.props.children[0].props.children[0], title);
    assert.equal(next.props.children[0].props.children[1].type, "Badge");
    assert.equal(tree.props.children[0], title);
    assert.equal(runtime.placeTree(title, { userId: "u" }, "memberList", false), title, "a Text never gains a View child");
    on(false); assert.equal(runtime.placeTree(tree, { userId: "u" }, "memberList", false), tree);
});

test("memo and forwardRef surfaces retain arguments, refs and original hooks with a live suppression provider", () => {
    const { runtime, on } = setup();
    const calls = [], tree = h("View", { children: h("Text", { children: "name" }) });
    const original = function (...args) { calls.push([this, args]); return tree; };
    const memo = { $$typeof: Symbol.for("react.memo"), type: original, compare: () => false };
    const exports = { default: memo }; assert.equal(runtime.install(exports, "dmList"), true);
    const receiver = {}, props = { channel: { type: 1, recipients: ["u"] } }, ref = {};
    const rendered = exports.default.type.call(receiver, props, ref);
    assert.equal(rendered.type, "Provider"); assert.equal(rendered.props.value, true);
    assert.equal(calls[0][0], receiver); assert.equal(calls[0][1][0], props); assert.equal(calls[0][1][1], ref);
    assert.equal(exports.default.compare, memo.compare);
    on(false); const disabled = exports.default.type(props, ref);
    assert.equal(disabled.props.children, tree); assert.equal(disabled.props.value, true, "location off also hides nested avatar badges");
    const forward = { default: { $$typeof: Symbol.for("react.forward_ref"), render: original } };
    assert.equal(runtime.install(forward, "dmHeader"), true); assert.equal(typeof forward.default.render, "function");
    const named = { MemberRowItem: original, untouched: 1 };
    assert.equal(runtime.install(named, "memberList", "MemberRowItem"), true);
    assert.equal(named.MemberRowItem({ userId: "u" }).type, "Provider");
    assert.equal(named.untouched, 1);
    assert.equal(runtime.install(Object.freeze({ default: original }), "dmList"), false);
    class ClassComponent { render() {} }
    assert.equal(runtime.install({ default: { type: ClassComponent } }, "dmList"), false);
});

test("scope wrappers isolate sibling avatars without invoking original components or sharing originals", () => {
    const { runtime } = setup(); let calls = 0;
    const first = () => { calls++; return "first"; }, second = () => { calls++; return "second"; };
    const exports = { fast: first, flash: second };
    assert.equal(runtime.installScope(exports, "fast"), true);
    assert.equal(runtime.installScope(exports, "flash"), true);
    const props = { ref: {}, child: "unchanged" };
    const a = exports.fast(props), b = exports.flash(props);
    assert.equal(calls, 0);
    assert.equal(a.type, "Provider"); assert.equal(a.props.value, true);
    assert.equal(a.props.children.type, first); assert.equal(b.props.children.type, second);
    assert.equal(a.props.children.props.ref, props.ref);
    assert.equal(runtime.installScope(Object.freeze({ default: first })), false);
});

test("profile transforms the captured DisplayName child without directly invoking that child", () => {
    const { runtime } = setup(); let childCalls = 0;
    function DisplayName() { childCalls++; return h("Text", { children: "name" }); }
    const tree = h("View", { children: h(DisplayName, { user: { id: "u" } }) });
    const exports = { DisplayName, default: () => tree };
    assert.equal(runtime.installProfile(exports), true);
    const next = exports.default(); assert.equal(childCalls, 0); assert.equal(next.props.children.type, exports.DisplayName);
    const name = next.props.children.type(next.props.children.props); assert.equal(childCalls, 1); assert.equal(name.type, "Provider");
});

test("native message labels affect rendered usernames only, stay idempotent and retain voice CTA", () => {
    const { runtime, on } = setup();
    const source = { rowType: 1, message: { content: "unchanged" } }, cta = { callback: "cadence-voice-download" };
    const result = { message: { username: "name", authorId: "u", content: "original", ctaButton: cta }, rowType: 1 };
    const next = runtime.messageRow(result, source);
    assert.equal(next.message.username, "name · PC/M"); assert.equal(next.message.ctaButton, cta);
    assert.equal(result.message.username, "name"); assert.equal(source.message.content, "unchanged");
    assert.equal(runtime.messageRow(next, source), next);
    on(false); assert.equal(runtime.messageRow(result, source), result);
    assert.equal(runtime.messageRow(result, { rowType: 2 }), result);
});

test("unknown, offline or throwing presence and unsupported message shapes are untouched", () => {
    const row = { rowType: 1 }, result = { message: { username: "name", authorId: "u" } };
    for (const status of [() => null, () => ({ desktop: "offline", unknown: "online" }), () => { throw new Error("store"); }]) {
        const { runtime } = setup({ status }); assert.equal(runtime.messageRow(result, row), result);
    }
    const { runtime } = setup();
    for (const value of [null, {}, { message: { authorId: "u" } }]) assert.equal(runtime.messageRow(value, row), value);
    const failure = new Error("Discord"); let calls = 0;
    const exports = { default: function () { calls++; throw failure; } }; runtime.install(exports, "memberList");
    assert.throws(() => exports.default({ userId: "u" }), e => e === failure); assert.equal(calls, 1);
});
