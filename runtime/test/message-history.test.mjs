import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const { outputFiles } = await build({ stdin: { contents: 'export * from "./features/venus/messageHistory"; export * from "./features/venus/historyUi";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", target: "es2019", platform: "neutral", write: false });
const host = { module: { exports: {} } }; vm.runInNewContext(outputFiles[0].text, host);
const { createMessageHistory, createHistoryPanel } = host.module.exports;
function setup(overrides = {}) {
    let enabled = false, owner = "1";
    const messages = new Map(), events = [];
    const feature = createMessageHistory({ enabled: () => enabled, owner: () => owner,
        message: (channelId, messageId) => messages.get(channelId + ":" + messageId), guild: () => "20", now: () => 123,
        onEvent: event => events.push(event), ...overrides });
    return { feature, messages, events, enable: value => { enabled = value; }, owner: value => { owner = value; } };
}
const record = (id, content) => Object.freeze({ id, content, author: { id: "2", username: "test" } });
const deletion = (channelId = "10", id = "100") => Object.freeze({ type: "MESSAGE_DELETE", channelId, id });

test("history starts off, captures cached deletion text before the action, and never consumes or mutates actions", () => {
    const { feature, enable, messages } = setup(); const original = record("100", "before"); messages.set("10:100", original);
    const event = deletion(); assert.equal(feature.capture(event), false); assert.equal(feature.list().length, 0);
    enable(true); assert.equal(feature.capture(event), false); messages.delete("10:100");
    assert.equal(feature.list()[0].before, "before"); assert.equal(feature.list()[0].kind, "deleted");
    assert.equal(original.content, "before"); assert.equal(event.type, "MESSAGE_DELETE");
    assert.ok(Object.isFrozen(feature.list())); assert.ok(Object.isFrozen(feature.list()[0]));
});

test("only real edits with changed text and an edit timestamp are retained", () => {
    const { feature, enable, messages } = setup(); enable(true); messages.set("10:100", record("100", "before"));
    for (const message of [{ id: "100", channel_id: "10", content: "after" },
        { id: "100", channel_id: "10", content: "before", edited_timestamp: "now" },
        { id: "100", channel_id: "10", pinned: true, edited_timestamp: "now" }]) feature.capture({ type: "MESSAGE_UPDATE", message });
    assert.equal(feature.list().length, 0);
    const message = Object.freeze({ id: "100", channel_id: "10", content: "after", edited_timestamp: "now" });
    feature.capture({ type: "MESSAGE_UPDATE", message }); feature.capture({ type: "MESSAGE_UPDATE", message });
    assert.equal(feature.list().length, 1); assert.equal(feature.list()[0].before, "before"); assert.equal(feature.list()[0].after, "after");
});

test("history is bounded by count and text units, truncates long messages and does not retain MessageRecords", () => {
    const { feature, enable } = setup({ message: (_, id) => record(id, "x".repeat(10000)) }); enable(true);
    for (let i = 0; i < 300; i++) feature.capture(deletion("10", String(100 + i)));
    const entries = feature.list(); assert.ok(entries.length <= 200);
    assert.ok(entries.reduce((sum, entry) => sum + entry.before.length, 0) <= 256 * 1024);
    assert.equal(entries[0].before.length, 4000); assert.equal(entries[0].truncated, true);
    assert.equal("message" in entries[0], false); assert.equal("attachments" in entries[0], false);
});

test("disable, logout, account change and missing account clear retained text", () => {
    const { feature, enable, owner, messages } = setup(); messages.set("10:100", record("100", "private"));
    enable(true); feature.capture(deletion()); assert.equal(feature.list().length, 1);
    enable(false); feature.capture({ type: "TYPING_START" }); assert.equal(feature.list().length, 0);
    enable(true); feature.capture(deletion()); feature.capture({ type: "LOGOUT" }); assert.equal(feature.list().length, 0);
    feature.capture(deletion()); owner("3"); feature.capture({ type: "PRESENCE_UPDATE" }); assert.equal(feature.list().length, 0);
    feature.capture(deletion()); owner(undefined); feature.capture({ type: "TYPING_START" }); assert.equal(feature.list().length, 0);
});

test("bulk deletes tolerate missing messages and clear events remove only relevant channels/guilds", () => {
    const { feature, enable, messages } = setup(); enable(true);
    messages.set("10:100", record("100", "one")); messages.set("11:101", record("101", "two"));
    assert.equal(feature.capture({ type: "MESSAGE_DELETE_BULK", channelId: "10", ids: ["100", "missing"] }), false);
    feature.capture(deletion("11", "101")); assert.equal(feature.list().length, 2);
    feature.capture({ type: "CHANNEL_DELETE", channel: { id: "10" } }); assert.equal(feature.list().length, 1);
    feature.capture({ type: "GUILD_DELETE", guild: { id: "20", unavailable: true } }); assert.equal(feature.list().length, 1);
    feature.capture({ type: "GUILD_DELETE", guild: { id: "20" } }); assert.equal(feature.list().length, 0);
});

test("interceptor installation is JS-only and idempotent, and every failure still allows the original dispatch", () => {
    const { feature, enable, messages } = setup(); enable(true); messages.set("10:100", record("100", "before"));
    const interceptors = [];
    const dispatcher = Object.create({ addInterceptor(callback) { assert.equal(this, dispatcher); interceptors.push(callback); } });
    assert.equal(feature.install({ default: dispatcher }), true); assert.equal(feature.install({ default: dispatcher }), true);
    assert.equal(interceptors.length, 1);
    let originalCalls = 0;
    const dispatch = event => { if (interceptors.some(fn => fn(event))) return "consumed"; originalCalls++; messages.delete("10:100"); return "original"; };
    assert.equal(dispatch(deletion()), "original"); assert.equal(originalCalls, 1); assert.equal(feature.list()[0].before, "before");
    const broken = setup({ message() { throw new Error("store"); }, onEvent() { throw new Error("log"); } }); broken.enable(true);
    assert.equal(broken.feature.capture(deletion()), false);
    assert.equal(broken.feature.install({ default: {} }), false);
});

test("subscriptions are isolated and a new runtime never restores old history", () => {
    const { feature, enable, messages } = setup(); enable(true); messages.set("10:100", record("100", "before"));
    let updates = 0; const stop = feature.subscribe(() => { updates++; }); feature.subscribe(() => { throw new Error("UI"); });
    feature.capture(deletion()); assert.equal(updates, 1); stop(); feature.clear(); assert.equal(updates, 1);
    assert.equal(feature.list().length, 0); assert.equal(setup().feature.list().length, 0);
});

test("history viewer shows plain text, clears through its own control and keeps a fixed hook count", () => {
    const { feature, enable, messages } = setup(); enable(true); messages.set("10:100", record("100", "<plain text>")); feature.capture(deletion());
    const states = []; let cursor = 0, subscribed = false, hooks = 0;
    const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState(initial) { const index = cursor++; hooks++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
            return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
        useEffect(fn) { hooks++; if (!subscribed) { subscribed = true; fn(); } } };
    const native = { View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", Switch: "Switch", Modal: "Modal" };
    const panel = createHistoryPanel(react, () => native, feature);
    function render() { cursor = 0; hooks = 0; const tree = panel({ onClose() {} }); assert.equal(hooks, 3); return tree; }
    function nodes(tree) { return tree && typeof tree === "object" ? [tree, ...(tree.children ?? []).flatMap(nodes)] : []; }
    let all = nodes(render()); assert.ok(all.some(node => node.children?.includes("<plain text>")));
    all.find(node => node.props.accessibilityLabel === "disk:history:clear").props.onPress();
    all = nodes(render()); assert.ok(all.some(node => node.props.accessibilityLabel === "disk:history:empty"));
});
