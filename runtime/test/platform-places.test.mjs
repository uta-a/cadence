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

test("native message rows show each platform as an icon in a free tag chip, stay idempotent and keep other fields", () => {
    const { runtime, on } = setup();
    const source = { rowType: 1, message: { content: "unchanged" } }, cta = { callback: "voice" };
    const result = { message: { username: "name", authorId: "u", content: "original", ctaButton: cta }, rowType: 1 };
    const next = runtime.messageRow(result, source);
    assert.equal(next.message.username, "name", "the name itself is left as it is");
    assert.equal(next.message.ctaButton, cta);
    assert.equal(next.message.clanTag, "\u200b");
    assert.equal(next.message.clanTagGuildId, "0");
    assert.match(next.message.clanBadgeUrl, /^data:image\/png;base64,iVBORw0KGgo/);
    assert.match(next.message.lobbyTagIconUrl, /^data:image\/png;base64,/);
    assert.notEqual(next.message.clanBadgeUrl, next.message.lobbyTagIconUrl, "desktop and mobile are different icons");
    assert.equal(result.message.clanTag, undefined); assert.equal(source.message.content, "unchanged");
    assert.equal(runtime.messageRow(next, source), next);
    const tagged = { message: { ...result.message, clanTag: "CODE", clanBadgeUrl: "https://badge", clanTagGuildId: "9" }, rowType: 1 };
    const kept = runtime.messageRow(tagged, source).message;
    assert.deepEqual([kept.clanTag, kept.clanBadgeUrl, kept.clanTagGuildId], ["CODE", "https://badge", "9"], "a real server tag is kept");
    assert.equal(kept.lobbyTagIconUrl, next.message.clanBadgeUrl, "the first platform moves to the lobby chip");
    const lobby = { message: { ...tagged.message, lobbyAdditionalName: "game", lobbyTagIconUrl: "https://app" }, rowType: 1 };
    assert.equal(runtime.messageRow(lobby, source), lobby, "no free chip leaves the row unchanged");
    on(false); assert.equal(runtime.messageRow(result, source), result);
    assert.equal(runtime.messageRow(result, { rowType: 2 }), result);
});

test("generated chip icons are valid 48x48 PNGs in the presence color with a real shape", async () => {
    const { inflateSync } = await import("node:zlib");
    const { runtime } = setup();
    const uri = runtime.messageRow({ message: { username: "n", authorId: "u" }, rowType: 1 }, { rowType: 1 }).message.clanBadgeUrl;
    const png = Buffer.from(uri.slice("data:image/png;base64,".length), "base64");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.equal(png.readUInt32BE(16), 48); assert.equal(png.readUInt32BE(20), 48);
    const idat = png.indexOf("IDAT"), length = png.readUInt32BE(idat - 4);
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
    assert.equal(raw.length, 48 * (1 + 48 * 4));
    const alphas = [];
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
        const at = y * (1 + 48 * 4) + 1 + x * 4;
        alphas.push(raw[at + 3]);
        if (raw[at + 3]) assert.deepEqual([...raw.subarray(at, at + 3)], [0x23, 0xA5, 0x5A], "online desktop is green");
    }
    const opaque = alphas.filter(a => a > 128).length;
    assert.ok(opaque > 200 && opaque < 48 * 48 / 2, "an icon shape, neither empty nor a filled square");
});

test("taps on Cadence's icon chips do nothing, while real server tags and other handlers keep working", () => {
    const { runtime } = setup();
    const opened = [];
    function MessagesHandlers(name) {
        this.name = name;
        this.handleTapClanTagChiplet = event => { opened.push(event.guildId); return "opened"; };
        this.handleTapAvatar = () => "avatar";
    }
    MessagesHandlers.prototype.shared = function () { return this.name; };
    MessagesHandlers.staticValue = 7;
    const exports = { MessagesHandlers };
    assert.equal(runtime.installChipTaps(exports, () => event => event), true);
    const handlers = new exports.MessagesHandlers("chat");
    assert.ok(handlers instanceof MessagesHandlers);
    assert.equal(handlers.shared(), "chat");
    assert.equal(exports.MessagesHandlers.staticValue, 7);
    assert.equal(handlers.handleTapClanTagChiplet({ guildId: "0" }), undefined);
    assert.equal(handlers.handleTapClanTagChiplet({ guildId: 0 }), undefined);
    assert.equal(handlers.handleTapClanTagChiplet({ guildId: "123" }), "opened");
    assert.deepEqual(opened, ["123"]);
    assert.equal(handlers.handleTapAvatar(), "avatar");
    const broken = new (Object.assign({}, { MessagesHandlers }, (() => { const e = { MessagesHandlers }; runtime.installChipTaps(e, () => () => { throw new Error("x"); }); return e; })()).MessagesHandlers)("x");
    assert.equal(broken.handleTapClanTagChiplet({ guildId: "5" }), "opened", "an unreadable event falls back to Discord");
    assert.equal(runtime.installChipTaps({ MessagesHandlers: 1 }, () => undefined), false);
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
