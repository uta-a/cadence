import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const NITRO_DEFAULT = { emojiSize: 48, maskedLinks: false };

const { outputFiles } = await build({ stdin: { contents: [
    'export * from "./features/fakeNitro";', 'export * from "./features/analytics";', 'export * from "./features/platformIndicator";',
    'export * from "./core/modules";', 'export * from "./core/ui";', 'export * from "./core/settings-controller";'].join(" "),
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
function api(globals = {}) {
    const host = { module: { exports: {} }, Promise, ...globals };
    vm.runInNewContext(outputFiles[0].text, host);
    return host.module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const locked = (id, name, animated = false) => ({ id, name, animated, guildId: "1" });

test("only Discord-classified locked emojis are linked; usable ones and text stay as typed", () => {
    const { convertMessage, emojiUrl } = api();
    const message = { content: "hi <:pog:111>! <:mine:222> <a:dance:333>", invalidEmojis: [locked("111", "pog"), locked("333", "dance", true)],
        validNonShortcutEmojis: [locked("222", "mine")], tts: false };
    const out = convertMessage(message);
    assert.equal(out.content, `hi ${emojiUrl("111", false, "pog")} ! <:mine:222> ${emojiUrl("333", true, "dance")}`);
    assert.match(out.content, /emojis\/111\.webp\?size=48&name=pog/);
    assert.match(out.content, /emojis\/333\.gif\?size=48&name=dance/);
    assert.deepEqual(plain(out.invalidEmojis), []);
    assert.deepEqual(plain(out.validNonShortcutEmojis), plain(message.validNonShortcutEmojis));
    assert.equal(out.tts, false);
    assert.equal(message.content, "hi <:pog:111>! <:mine:222> <a:dance:333>", "the caller's message is not mutated");
    assert.equal(convertMessage(out), null, "idempotent for Discord's recursive sendMessage call");
});

test("unconvertible locked emojis stay reported, and odd shapes or long results send the original", () => {
    const { convertMessage, MAX_CONTENT_LENGTH } = api();
    const partial = convertMessage({ content: "<:a:1> :b:", invalidEmojis: [locked("1", "a"), locked("2", "b")] });
    assert.equal(plain(partial.invalidEmojis).map(e => e.id).join(), "2");
    assert.equal(convertMessage({ content: ":b:", invalidEmojis: [locked("2", "b")] }), null);
    for (const value of [null, "text", [], {}, { content: 1, invalidEmojis: [locked("1", "a")] }, { content: "<:a:1>", invalidEmojis: [] },
        { content: "<:a:1>", invalidEmojis: [{ id: 1, name: "a" }] }, { content: "<:a:1>", invalidEmojis: [{ id: "1x", name: "a" }] }])
        assert.equal(convertMessage(value), null);
    const long = "x".repeat(MAX_CONTENT_LENGTH - 10) + " <:a:1>";
    assert.equal(convertMessage({ content: long, invalidEmojis: [locked("1", "a")] }), null);
    assert.ok(convertMessage({ content: "<:a:1>", invalidEmojis: [{ id: "1", name: "renamed", originalName: "a" }] }).content.includes("name=a"));
});

test("sendMessage hook converts only while enabled and always calls the original with this and every argument", () => {
    const { installSendMessageHook } = api();
    const calls = [], original = function (...args) { calls.push([this, args]); return "result"; };
    const target = { sendMessage: original, other: 1 }, exports = { default: target };
    let enabled = false, converted = 0;
    assert.equal(installSendMessageHook(exports, () => enabled, () => converted++), true);
    assert.notEqual(target.sendMessage, original);
    const message = { content: "<:a:1>", invalidEmojis: [locked("1", "a")] }, options = { nonce: "n" };
    assert.equal(target.sendMessage("c", message, undefined, options), "result");
    assert.equal(calls[0][0], target);
    assert.equal(calls[0][1][1], message, "disabled: the identical message object");
    assert.equal(calls[0][1].length, 4);
    enabled = true;
    target.sendMessage("c", message, undefined, options);
    assert.notEqual(calls[1][1][1], message);
    assert.match(calls[1][1][1].content, /cdn\.discordapp\.com\/emojis\/1\.webp/);
    assert.equal(calls[1][1][3], options);
    target.sendMessage("c", message, undefined, options);
    assert.equal(converted, 1, "the fixed diagnostic is reported once");
    const hostile = { get content() { throw new Error("boom"); }, invalidEmojis: [locked("1", "a")] };
    target.sendMessage("c", hostile);
    assert.equal(calls[3][1][1], hostile, "conversion failure falls back to the original arguments");
    const fresh = { sendMessage: original };
    installSendMessageHook({ default: fresh }, () => { throw new Error("settings"); });
    fresh.sendMessage("c", message);
    assert.equal(calls[4][1][1], message, "a settings failure sends the original message");
    assert.equal(installSendMessageHook({ default: Object.freeze({ sendMessage: original }) }, () => true), false);
    assert.equal(installSendMessageHook({ default: { get sendMessage() { return original; } } }, () => true), false);
    assert.equal(installSendMessageHook({}, () => true), false);
});

test("analytics track becomes a resolved no-op without calling the original; unexpected shapes are left alone", async () => {
    const { installAnalyticsBlock } = api();
    let called = 0;
    const target = { track() { called++; return new Promise(() => {}); }, expandEventProperties() {} };
    assert.equal(installAnalyticsBlock({ default: target }), true);
    assert.equal(await target.track("event", { secret: 1 }), undefined);
    assert.equal(called, 0);
    const frozen = Object.freeze({ track() {} });
    assert.equal(installAnalyticsBlock({ default: frozen }), false);
    assert.equal(installAnalyticsBlock({ default: { track: 1 } }), false);
    assert.equal(installAnalyticsBlock(null), false);
});

test("platform states keep a fixed order and ignore offline, invisible and unknown platforms", () => {
    const { platformsOf } = api();
    assert.deepEqual(plain(platformsOf({ web: "idle", desktop: "online", mobile: "offline", embedded: "online", vr: "dnd" })),
        [{ platform: "desktop", color: "#23A55A" }, { platform: "web", color: "#F0B232" }, { platform: "vr", color: "#F23F43" }]);
    for (const value of [undefined, null, "online", { desktop: "invisible" }]) assert.deepEqual(plain(platformsOf(value)), []);
});

function hookHarness() {
    const states = [], refs = [], effects = [], cleanups = [];
    let cursor = 0, hookCalls = 0, nextEffects = [];
    const react = {
        createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
        useState(initial) {
            const id = cursor++; hookCalls++;
            if (!(id in states)) states[id] = typeof initial === "function" ? initial() : initial;
            return [states[id], value => { states[id] = value; }];
        },
        useEffect(fn, deps) {
            const id = cursor++; hookCalls++;
            if (!effects[id] || deps.some((v, i) => v !== effects[id][i])) { effects[id] = deps; nextEffects.push([id, fn]); }
        },
        useRef(initial) { const id = cursor++; hookCalls++; if (!(id in refs)) refs[id] = { current: initial }; return refs[id]; },
        memo(component) { return { memo: component }; },
    };
    return { react, render(component, props) {
        cursor = 0; hookCalls = 0;
        const tree = component.memo(props);
        for (const [id, fn] of nextEffects) { cleanups[id]?.(); cleanups[id] = fn(); }
        nextEffects = [];
        return { tree, hookCalls };
    }, unmount() { cleanups.forEach(fn => fn?.()); } };
}
const flat = tree => !tree || typeof tree !== "object" ? [] : [tree, ...(tree.children ?? []).flatMap(flat)];

test("avatar wrapper keeps the original element, a fixed hook count, and only overlays while enabled", () => {
    const { createPlatformAvatar } = api(), harness = hookHarness();
    const original = { memo: "OriginalAvatar" }, store = { name: "PresenceStore" }, listeners = new Set();
    let enabled = false, subscribedStores, storeCalls = 0;
    const seenDeps = [];
    const status = { "10": { desktop: "online", mobile: "idle" } };
    const presence = { store, getClientStatus(id) { assert.equal(this, store); storeCalls++; return status[id]; },
        useStateFromStores(stores, getter, deps) { subscribedStores = stores; seenDeps.push(plain(deps)); return getter(); } };
    const component = createPlatformAvatar({ react: harness.react, original, native: () => ({ View: "View", Text: "Text" }),
        presence: () => presence, icons: () => ({ desktop: "ScreenIcon" }), enabled: () => enabled,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, onEvent: event => events.push(event) });
    const events = [];
    const props = { user: { id: "10" }, size: "SIZE_40" };
    let { tree, hookCalls } = harness.render(component, props);
    assert.equal(tree.type, original);
    assert.equal(tree.props, props);
    assert.equal(hookCalls, 3, "useState, useEffect, useRef (plus the store hook recorded below)");
    assert.equal(seenDeps.length, 1);
    assert.equal(subscribedStores.length, 1);
    assert.equal(subscribedStores[0], store);
    assert.deepEqual(seenDeps[0], ["10"]);
    enabled = true;
    listeners.forEach(fn => fn());
    ({ tree, hookCalls } = harness.render(component, props));
    assert.equal(hookCalls, 3);
    assert.equal(seenDeps.length, 2, "the store hook is called on every render, enabled or not");
    assert.equal(tree.type, "View");
    assert.equal(tree.children[0].type, original);
    const badge = tree.children[1];
    assert.equal(badge.props.pointerEvents, "none");
    assert.deepEqual(flat(badge).slice(1).map(node => node.type), ["ScreenIcon", "Text"]);
    assert.equal(flat(badge)[2].children[0], "M");
    assert.ok(storeCalls > 0);
    ({ tree } = harness.render(component, { user: { id: "missing" } }));
    assert.equal(tree.children[1], null, "no badge without a visible platform");
    assert.deepEqual(seenDeps.at(-1), ["missing"]);
    assert.deepEqual(events, ["rendered", "badge"], "each fixed diagnostic is reported once");
    harness.unmount();
    assert.equal(listeners.size, 0);
});

test("an avatar rendered before native UI is ready gains the badge later; one without presence never adds the store hook", () => {
    const { createPlatformAvatar } = api(), harness = hookHarness();
    let available = false, hookUsed = 0;
    const presence = { store: {}, getClientStatus: () => ({ desktop: "online" }), useStateFromStores() { hookUsed++; return { desktop: "online" }; } };
    const component = createPlatformAvatar({ react: harness.react, original: "Avatar",
        native: () => available ? { View: "View", Text: "Text" } : null, presence: () => presence, icons: () => ({}),
        enabled: () => true, subscribe: () => () => {} });
    let result = harness.render(component, { user: { id: "1" } });
    assert.equal(result.tree.type, "Avatar");
    available = true;
    result = harness.render(component, { user: { id: "1" } });
    assert.equal(result.tree.type, "View", "native UI looked up again on later renders");
    assert.equal(result.hookCalls, 3);
    assert.equal(hookUsed, 2, "the store hook runs on every render once presence was available at first render");

    const other = hookHarness();
    let presenceReady = false, used = 0;
    const late = createPlatformAvatar({ react: other.react, original: "Avatar", native: () => ({ View: "View", Text: "Text" }),
        presence: () => presenceReady ? { ...presence, useStateFromStores() { used++; return {}; } } : null, icons: () => ({}),
        enabled: () => true, subscribe: () => () => {} });
    assert.equal(other.render(late, { user: { id: "1" } }).tree.type, "Avatar");
    presenceReady = true;
    assert.equal(other.render(late, { user: { id: "1" } }).tree.type, "Avatar");
    assert.equal(used, 0, "no store hook is added after the first render");
});

test("replacement avatar keeps the original statics but not React's memo internals", () => {
    const { createPlatformAvatar } = api(), harness = hookHarness();
    const original = { $$typeof: "memo-symbol", type: () => {}, compare: null, displayName: "Avatar", Sizes: { SMALL: 1 } };
    const component = createPlatformAvatar({ react: harness.react, original, native: () => null, presence: () => null,
        icons: () => ({}), enabled: () => false, subscribe: () => () => {} });
    assert.equal(component.displayName, "Avatar");
    assert.equal(component.Sizes, original.Sizes);
    assert.equal(component.$$typeof, undefined);
    assert.equal(component.compare, undefined);
});

function memory() {
    let text = null;
    const writes = [];
    return { writes, storage: { read: async () => text, write: async value => { writes.push(JSON.parse(value)); text = value; } } };
}

test("feature switches persist schema2 features and isEnabled is off until ready", async () => {
    const { createSettingsController } = api(), m = memory();
    const c = createSettingsController(() => {}, () => m.storage);
    assert.equal(c.isEnabled("fakeNitro"), false);
    await assert.rejects(c.setFeature("fakeNitro", true));
    await c.attach({});
    await c.setFeature("fakeNitro", true);
    assert.equal(c.isEnabled("fakeNitro"), true);
    assert.equal(c.isEnabled("platformIndicator"), false);
    assert.deepEqual(m.writes.at(-1), { version: 2, features: { fakeNitro: true, platformIndicator: false }, preferences: { compact: false }, nitro: NITRO_DEFAULT });
    await assert.rejects(c.setFeature("unknown", true));
    await assert.rejects(c.setFeature("fakeNitro", "yes"));
    const reloaded = createSettingsController(() => {}, () => m.storage);
    await reloaded.attach({});
    assert.equal(reloaded.isEnabled("fakeNitro"), true);
});

test("feature captures exist only for built features, and install hooks on natural factory completion", () => {
    const { createCoreModules } = api({ setTimeout() {} });
    const ids = core => plain(core.captures.map(c => c.id).sort((a, b) => a - b));
    assert.deepEqual(ids(createCoreModules(() => {})), [17, 19, 1164, 5183, 7522, 18400]);
    assert.deepEqual(ids(createCoreModules(() => {}, false, ["noConfirmPin"])), [17, 19, 1128, 1164, 5183, 5941, 7522, 18400]);
    const events = [];
    const core = createCoreModules(value => events.push(value), false, ["fakeNitro", "platformIndicator", "disableAnalytics"]);
    assert.deepEqual(ids(core), [17, 19, 504, 1164, 1267, 1395, 4953, 5183, 5744, 7085, 7475, 7522, 7598, 9515, 9524, 15449, 16280, 18400]);
    const capture = new Map(core.captures.map(c => [c.id, c.onExports]));
    const analytics = { default: { track() { return new Promise(() => {}); } } };
    capture.get(1267)(analytics, {});
    const messages = { default: { sendMessage() {} } };
    const originalSend = messages.default.sendMessage;
    capture.get(7598)(messages, {});
    assert.notEqual(messages.default.sendMessage, originalSend);
    capture.get(19)({ Fragment: "F", createElement() {}, useState() {}, useEffect() {}, useRef() {}, memo: c => c }, {});
    const avatar = { default: { $$typeof: "memo" } }, originalAvatar = avatar.default;
    capture.get(15449)(avatar, {});
    assert.notEqual(avatar.default, originalAvatar);
    assert.deepEqual(events, ["analytics blocked", "fake-nitro installed", "platform-indicator installed"]);
    const other = createCoreModules(value => events.push(value), false, ["platformIndicator"]);
    const otherCapture = new Map(other.captures.map(c => [c.id, c.onExports]));
    otherCapture.get(19)({ Fragment: "F", createElement() {}, useState() {}, useEffect() {}, useRef() {} }, {});
    const frozenAvatar = Object.freeze({ default: originalAvatar });
    otherCapture.get(15449)(frozenAvatar, {});
    assert.equal(frozenAvatar.default, originalAvatar);
    assert.equal(events.at(-1), "platform-indicator unavailable");
});

test("settings page shows switches only for built features and states which are not included", () => {
    const { createSettingsOverview } = api();
    const native = { View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", Switch: "Switch", Modal: "Modal" };
    const state = { phase: "ready", save: "idle", preferences: { compact: false }, features: { fakeNitro: true, platformIndicator: false },
        nitro: { emojiSize: 64, maskedLinks: true } };
    const changes = [];
    const controller = { get: () => state, subscribe: () => () => {}, setFeature: async (key, value) => { changes.push([key, value]); },
        setNitro: async change => { changes.push(["nitro", change]); } };
    const react = { Fragment: "F", createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
        useState(initial) { const value = typeof initial === "function" ? initial() : initial; return [initial === false ? true : value, () => {}]; },
        useEffect() {} };
    const tree = createSettingsOverview(react, () => native, () => {}, controller, () => {}, () => true, ["fakeNitro", "disableAnalytics"])({});
    const all = flat(tree);
    const fake = all.find(node => node.props.accessibilityLabel === "disk:feature:fakeNitro");
    assert.equal(fake.type, "Switch");
    assert.equal(fake.props.value, true);
    fake.props.onValueChange(false);
    assert.deepEqual(changes, [["fakeNitro", false]]);
    assert.ok(all.some(node => node.props.accessibilityLabel === "disk:feature:platformIndicator:false"));
    assert.equal(all.find(node => node.props.accessibilityLabel === "disk:feature:platformIndicator"), undefined);
    assert.ok(all.some(node => node.children?.includes("このビルドには含まれていません")));
    assert.ok(all.some(node => String(node.children?.[0]).startsWith("Analytics：JS の track 送信を停止しています")));
    const size64 = all.find(node => node.props.accessibilityLabel === "disk:nitro-size:64");
    assert.equal(size64.props.accessibilityState.selected, true);
    all.find(node => node.props.accessibilityLabel === "disk:nitro-size:128").props.onPress();
    all.find(node => node.props.accessibilityLabel === "disk:nitro-masked").props.onValueChange(false);
    assert.deepEqual(plain(changes.slice(1)), [["nitro", { emojiSize: 128 }], ["nitro", { maskedLinks: false }]]);
    assert.ok(all.some(node => node.props.accessibilityLabel === "disk:nitro-masked:true"));
    const without = flat(createSettingsOverview(react, () => native, () => {}, controller, () => {}, () => true, ["platformIndicator"])({}));
    assert.equal(without.find(node => node.props.accessibilityLabel === "disk:nitro-size:48"), undefined, "no options unless Fake Nitro is built");
});

test("conversion follows the chosen size and masked-link option", () => {
    const { convertMessage, emojiUrl } = api();
    const message = { content: "a <a:dance:333> b", invalidEmojis: [locked("333", "dance", true)] };
    assert.equal(convertMessage(message, { emojiSize: 128, maskedLinks: false }).content, `a ${emojiUrl("333", true, "dance", 128)} b`);
    assert.equal(convertMessage(message, { emojiSize: 96, maskedLinks: true }).content, `a [dance](${emojiUrl("333", true, "dance", 96)}) b`);
    assert.match(convertMessage(message, { emojiSize: 1000, maskedLinks: false }).content, /size=48&/, "unknown sizes fall back to 48");
});

test("Fake Nitro options persist in schema 2, default safely, and reject invalid values without writing", async () => {
    const { createSettingsController } = api();
    let text = null;
    const writes = [];
    const storage = { read: async () => text, write: async value => { writes.push(JSON.parse(value)); text = value; } };
    const c = createSettingsController(() => {}, () => storage);
    await c.attach({});
    assert.deepEqual(plain(c.get().nitro), { emojiSize: 48, maskedLinks: false });
    await c.setNitro({ emojiSize: 96 });
    await c.setNitro({ maskedLinks: true });
    assert.deepEqual(writes.at(-1).nitro, { emojiSize: 96, maskedLinks: true });
    const count = writes.length;
    for (const bad of [{ emojiSize: 50 }, { maskedLinks: "yes" }, { other: 1 }, {}, null])
        await assert.rejects(c.setNitro(bad));
    assert.equal(writes.length, count);
    const reloaded = createSettingsController(() => {}, () => storage);
    await reloaded.attach({});
    assert.deepEqual(plain(reloaded.get().nitro), { emojiSize: 96, maskedLinks: true });
    for (const [stored, expected] of [
        ['{"version":2,"features":{},"preferences":{}}', { emojiSize: 48, maskedLinks: false }],
        ['{"version":2,"features":{},"preferences":{},"nitro":{"emojiSize":7,"maskedLinks":1}}', { emojiSize: 48, maskedLinks: false }],
        ['{"version":2,"features":{},"preferences":{},"nitro":[]}', { emojiSize: 48, maskedLinks: false }],
        ['{"version":1,"features":{},"nitro":{"emojiSize":128}}', { emojiSize: 48, maskedLinks: false }]]) {
        text = stored;
        const fresh = createSettingsController(() => {}, () => storage);
        await fresh.attach({});
        assert.equal(fresh.get().phase, "ready");
        assert.deepEqual(plain(fresh.get().nitro), expected);
    }
});

function stickerFixture() {
    const { installStickerHooks, stickerUrl } = api();
    const StickerSendability = { SENDABLE: 0, SENDABLE_WITH_PREMIUM: 1, NONSENDABLE: 2, SENDABLE_WITH_BOOSTED_GUILD: 3 };
    const results = new Map([["10", 1], ["11", 1], ["12", 2], ["13", 0], ["14", 1]]);
    const sendability = { StickerSendability, getStickerSendability(sticker) { return results.get(sticker.id); },
        isSendableSticker(sticker) { return results.get(sticker.id) === 0; } };
    const sends = [], stickerSends = [];
    const target = {
        sendMessage(...args) { sends.push([this, args]); return "message-result"; },
        sendStickers(...args) { stickerSends.push([this, args]); return "sticker-result"; },
    };
    let enabled = true, masked = false, converted = 0;
    const ok = installStickerHooks(sendability, { default: target }, () => enabled, () => ({ emojiSize: 48, maskedLinks: masked }), () => converted++);
    return { ok, sendability, target, sends, stickerSends, stickerUrl, results, setEnabled: v => { enabled = v; }, setMasked: v => { masked = v; },
        get converted() { return converted; } };
}
const sticker = (id, format_type = 1, name = "pog") => ({ id, format_type, name, guild_id: "1" });

test("only Nitro-only image stickers are reported sendable, and only while enabled", () => {
    const f = stickerFixture();
    assert.equal(f.ok, true);
    assert.equal(f.sendability.getStickerSendability(sticker("10")), 0, "premium PNG becomes SENDABLE");
    assert.equal(f.sendability.getStickerSendability(sticker("11", 3)), 1, "Lottie cannot be linked as an image");
    assert.equal(f.sendability.getStickerSendability(sticker("12")), 2, "NONSENDABLE stays");
    assert.equal(f.sendability.getStickerSendability(sticker("13")), 0);
    f.setEnabled(false);
    assert.equal(f.sendability.getStickerSendability(sticker("14")), 1, "disabled: Discord's own result");
});

test("remembered stickers are sent as links through sendMessage; anything else uses the original sendStickers", () => {
    const f = stickerFixture();
    f.sendability.getStickerSendability(sticker("10", 4, "dance"));
    assert.equal(f.target.sendStickers("ch", ["10"], "hi", { location: "STICKER_REPLY" }), "message-result");
    assert.equal(f.sends.length, 1);
    const [self, [channel, message, third, options]] = f.sends[0];
    assert.equal(self, f.target);
    assert.equal(channel, "ch");
    assert.equal(message.content, `hi\n${f.stickerUrl("10", "gif")}`);
    assert.equal(message.tts, false);
    assert.deepEqual(plain(message.invalidEmojis), []);
    assert.equal(third, undefined);
    assert.deepEqual(plain(options), { location: "STICKER_REPLY" });
    assert.equal(f.converted, 1);
    f.setMasked(true);
    f.target.sendStickers("ch", ["10"]);
    assert.equal(f.sends[1][1][1].content, `[dance](${f.stickerUrl("10", "gif")})`);
    assert.equal(f.target.sendStickers("ch", ["13"], ""), "sticker-result", "a sticker that was never upgraded");
    assert.equal(f.target.sendStickers("ch", ["10", "13"], ""), "sticker-result", "a mixed send is left to Discord");
    assert.equal(f.target.sendStickers("ch", ["10"], { other: 1 }), "sticker-result", "an object without text is left to Discord");
    assert.equal(f.target.sendStickers("ch", ["10"], 5), "sticker-result", "an unknown content type is left to Discord");
    f.setMasked(false);
    // The real picker passes the validation result (not the text) as the third argument.
    f.target.sendStickers("ch", ["10"], true, { location: "STICKER_REPLY" });
    assert.equal(f.sends.at(-1)[1][1].content, f.stickerUrl("10", "gif"));
    f.target.sendStickers("ch", ["10"], { content: "from object" });
    assert.equal(f.sends.at(-1)[1][1].content, `from object\n${f.stickerUrl("10", "gif")}`);
    f.setEnabled(false);
    assert.equal(f.target.sendStickers("ch", ["10"], ""), "sticker-result", "disabled");
    assert.equal(f.stickerSends.length, 5);
    assert.equal(f.stickerSends[0][0], f.target);
    assert.equal(f.converted, 1, "the fixed diagnostic is reported once");
});

test("sticker hooks refuse unexpected shapes without changing anything", () => {
    const { installStickerHooks } = api();
    const original = () => 1, send = () => {};
    const good = { StickerSendability: { SENDABLE: 0, SENDABLE_WITH_PREMIUM: 1 }, getStickerSendability: original, isSendableSticker: () => false };
    assert.equal(installStickerHooks({ getStickerSendability: original }, { default: { sendStickers: send } }, () => true), false);
    const frozen = Object.freeze({ sendStickers: send });
    assert.equal(installStickerHooks(good, { default: frozen }, () => true), false);
    assert.equal(good.getStickerSendability, original, "nothing is replaced when any target is unusable");
    assert.equal(installStickerHooks(good, null, () => true), false);
});

test("picker unlock bypasses only the Nitro check, only for CHAT, only while enabled", () => {
    const { installEmojiPickerUnlock } = api();
    const calls = [];
    const target = {
        getEmojiUnavailableReason(options) { calls.push(["one", this, options]); return options.bypassPremiumEmojiEntitlement ? null : "PREMIUM_LOCKED"; },
        getEmojiUnavailableReasons(options) { calls.push(["many", this, options]); return { locked: !options.bypassPremiumEmojiEntitlement }; },
        isEmojiPremiumLocked() { return true; },
    };
    const isLocked = target.isEmojiPremiumLocked;
    let enabled = true;
    assert.equal(installEmojiPickerUnlock({ default: target }, { EmojiIntention: { CHAT: 6, REACTION: 1 } }, () => enabled), true);
    const chat = { emoji: { id: "1" }, channel: {}, intention: 6 };
    assert.equal(target.getEmojiUnavailableReason(chat), null);
    assert.equal(calls[0][1], target);
    assert.notEqual(calls[0][2], chat, "the caller's object is not mutated");
    assert.equal(chat.bypassPremiumEmojiEntitlement, undefined);
    assert.deepEqual(plain(target.getEmojiUnavailableReasons({ categoryEmojis: [], intention: 6 })), { locked: false });
    assert.equal(target.getEmojiUnavailableReason({ ...chat, intention: 1 }), "PREMIUM_LOCKED", "reactions stay locked");
    enabled = false;
    assert.equal(target.getEmojiUnavailableReason(chat), "PREMIUM_LOCKED", "disabled");
    assert.equal(target.isEmojiPremiumLocked, isLocked, "the parser's check is never replaced");
    const throwing = { getEmojiUnavailableReason: o => o, getEmojiUnavailableReasons: o => o };
    installEmojiPickerUnlock({ default: throwing }, { EmojiIntention: { CHAT: 6 } }, () => { throw new Error("settings"); });
    assert.equal(throwing.getEmojiUnavailableReason(chat), chat, "a settings failure calls the original with the same argument");
    assert.equal(installEmojiPickerUnlock({ default: target }, { EmojiIntention: {} }, () => true), false);
    assert.equal(installEmojiPickerUnlock({ default: Object.freeze({ getEmojiUnavailableReason() {}, getEmojiUnavailableReasons() {} }) },
        { EmojiIntention: { CHAT: 6 } }, () => true), false);
});

test("a remembered sticker is forgotten once Discord itself no longer needs Nitro for it", () => {
    const f = stickerFixture();
    assert.equal(f.sendability.getStickerSendability(sticker("10")), 0);
    assert.equal(f.target.sendStickers("ch", ["10"]), "message-result", "linked while it needs Nitro");
    f.results.set("10", 0); // Discord now answers SENDABLE by itself, e.g. after subscribing
    assert.equal(f.sendability.getStickerSendability(sticker("10")), 0);
    assert.equal(f.target.sendStickers("ch", ["10"]), "sticker-result", "sent as a real sticker again");

    const g = stickerFixture();
    g.sendability.getStickerSendability(sticker("11"));
    g.setEnabled(false);
    assert.equal(g.sendability.getStickerSendability(sticker("11")), 1);
    g.setEnabled(true);
    assert.equal(g.target.sendStickers("ch", ["11"]), "sticker-result", "a check while the feature was off forgets it");
});

test("masked sticker labels keep only plain characters", () => {
    const f = stickerFixture();
    f.setMasked(true);
    f.sendability.getStickerSendability(sticker("10", 1, "@everyone `x` *b* <#1>"));
    f.target.sendStickers("ch", ["10"]);
    assert.equal(f.sends[0][1][1].content, `[everyone x b 1](${f.stickerUrl("10", "png")})`);
    f.sendability.getStickerSendability(sticker("11", 1, "【】!!"));
    f.target.sendStickers("ch", ["11"]);
    assert.equal(f.sends[1][1][1].content, `[sticker](${f.stickerUrl("11", "png")})`);
});

test("the picker list's lock follows the same answer, and the sticker is remembered from it", () => {
    const f = stickerFixture();
    assert.equal(f.sendability.isSendableSticker(sticker("10")), true, "premium image sticker shows unlocked");
    assert.equal(f.target.sendStickers("ch", ["10"]), "message-result", "and is linked when sent");
    assert.equal(f.sendability.isSendableSticker(sticker("11", 3)), false, "Lottie keeps the lock");
    assert.equal(f.sendability.isSendableSticker(sticker("12")), false, "NONSENDABLE keeps the lock");
    assert.equal(f.sendability.isSendableSticker(sticker("13")), true);
    f.setEnabled(false);
    assert.equal(f.sendability.isSendableSticker(sticker("14")), false, "disabled: Discord's own lock");
    const { installStickerHooks } = api();
    const noChecker = { StickerSendability: { SENDABLE: 0, SENDABLE_WITH_PREMIUM: 1 }, getStickerSendability: () => 1 };
    const original = noChecker.getStickerSendability;
    assert.equal(installStickerHooks(noChecker, { default: { sendStickers() {} } }, () => true), false);
    assert.equal(noChecker.getStickerSendability, original, "nothing replaced without isSendableSticker");
});

test("quick confirm skips only Discord's own delete and pin alerts, only while enabled", async () => {
    const { build } = await import("esbuild");
    const { outputFiles: out } = await build({ stdin: { contents: 'export * from "./features/venus/quickConfirm";',
        resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
    const host = { module: { exports: {} } };
    vm.runInNewContext(out[0].text, host);
    const { installQuickConfirm } = host.module.exports;
    const strings = { DEL: "Delete Message", DEL2: "Delete this message?", PIN: "Pin It. Pin It Good.", UNPIN: "Remove pinned message?" };
    const intl = { intl: { string: token => strings[token] }, t: { AMvpS4: "DEL", "vXZ+Fo": "DEL2", WG5dyo: "PIN", NjEPp7: "UNPIN" } };
    const shown = [];
    const target = { show(popup) { shown.push(popup); return "shown"; }, close() {} };
    let del = true, pin = false, skipped = 0;
    assert.equal(installQuickConfirm({ default: target }, intl, { quickDelete: () => del, noConfirmPin: () => pin }, () => skipped++), true);
    let confirmed = 0;
    const alert = (fields) => ({ onConfirm: () => { confirmed++; return "confirmed"; }, ...fields });
    assert.equal(target.show(alert({ body: "Delete this message?" })), "confirmed");
    assert.equal(target.show(alert({ children: { props: { title: "Delete Message" } } })), "confirmed");
    assert.equal(target.show(alert({ body: "Leave server?" })), "shown", "other alerts are untouched");
    assert.equal(target.show(alert({ body: "Delete Messag" })), "shown", "no partial matching");
    const pinAlert = alert({ children: { props: { children: [{ props: { children: "Pin It. Pin It Good." } }] } } });
    assert.equal(target.show(pinAlert), "shown", "pin is off");
    pin = true;
    assert.equal(target.show(pinAlert), "confirmed");
    assert.equal(target.show(alert({ body: "Remove pinned message?" })), "confirmed");
    del = false; pin = false;
    assert.equal(target.show(alert({ body: "Delete this message?" })), "shown", "disabled");
    assert.equal(target.show(null), "shown");
    assert.equal(confirmed, 4);
    assert.equal(skipped, 4);
    const failing = alert({ body: "Delete this message?", onConfirm: () => { throw new Error("x"); } });
    del = true;
    assert.equal(target.show(failing), undefined, "once confirming has started, Discord's alert is not shown on top of it");
    assert.equal(installQuickConfirm({ default: Object.freeze({ show() {} }) }, intl, { quickDelete: () => true, noConfirmPin: () => true }), false);
    assert.equal(installQuickConfirm({ default: target }, { intl: {}, t: {} }, { quickDelete: () => true, noConfirmPin: () => true }), false);
});

test("extras are stored as an optional list of known IDs and omitted while none is enabled", async () => {
    const { createSettingsController } = api();
    let text = null;
    const writes = [];
    const storage = { read: async () => text, write: async value => { writes.push(JSON.parse(value)); text = value; } };
    const c = createSettingsController(() => {}, () => storage);
    await c.attach({});
    assert.equal(c.isExtraEnabled("quickDelete"), false);
    await c.setExtra("noConfirmPin", true);
    await c.setExtra("quickDelete", true);
    assert.deepEqual(writes.at(-1).extras, ["quickDelete", "noConfirmPin"], "a stable order");
    await c.setExtra("quickDelete", false);
    await c.setExtra("noConfirmPin", false);
    assert.equal("extras" in writes.at(-1), false, "omitted when empty");
    await assert.rejects(c.setExtra("unknown", true));
    text = '{"version":2,"features":{},"preferences":{},"extras":["noConfirmPin","unknown","noConfirmPin",3]}';
    const loaded = createSettingsController(() => {}, () => storage);
    await loaded.attach({});
    assert.deepEqual(plain(loaded.get().extras), ["noConfirmPin"]);
    assert.equal(loaded.isExtraEnabled("noConfirmPin"), true);
});

test("ported feature switches appear only for the features built into this APK", () => {
    const { createSettingsOverview } = api();
    const native = { View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", Switch: "Switch", Modal: "Modal" };
    const state = { phase: "ready", save: "idle", preferences: { compact: false }, features: { fakeNitro: false, platformIndicator: false },
        nitro: { emojiSize: 48, maskedLinks: false }, extras: ["quickDelete"] };
    const controller = { get: () => state, subscribe: () => () => {}, setExtra: async () => {} };
    const react = { Fragment: "F", createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
        useState(initial) { const value = typeof initial === "function" ? initial() : initial; return [initial === false ? true : value, () => {}]; },
        useEffect() {} };
    const render = built => flat(createSettingsOverview(react, () => native, () => {}, controller, () => {}, () => true, built)({}));
    const none = render([]);
    assert.equal(none.find(node => node.props.accessibilityLabel === "disk:extra:quickDelete"), undefined);
    assert.ok(!none.some(node => node.children?.includes("Venus から移植した機能")));
    const one = render(["quickDelete"]);
    assert.equal(one.find(node => node.props.accessibilityLabel === "disk:extra:quickDelete").props.value, true);
    assert.equal(one.find(node => node.props.accessibilityLabel === "disk:extra:noConfirmPin"), undefined);
});

test("always trust answers trusted and not suspicious only while enabled, without touching the store class", async () => {
    const { build } = await import("esbuild");
    const { outputFiles: out } = await build({ stdin: { contents: 'export * from "./features/venus/alwaysTrust";',
        resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
    const host = { module: { exports: {} } };
    vm.runInNewContext(out[0].text, host);
    const { installAlwaysTrust } = host.module.exports;
    class Store { isTrustedDomain(url) { return url === "https://discord.com"; } }
    const store = new Store(), other = new Store();
    const downloads = { isSuspiciousDownload: name => name.endsWith(".exe") ? "exe" : null };
    let on = false;
    assert.equal(installAlwaysTrust({ default: store }, downloads, () => on), true);
    assert.equal(store.isTrustedDomain("https://example.com"), false, "off: Discord's answer");
    assert.equal(downloads.isSuspiciousDownload("a.exe"), "exe");
    on = true;
    assert.equal(store.isTrustedDomain("https://example.com"), true);
    assert.equal(downloads.isSuspiciousDownload("a.exe"), null);
    assert.equal(other.isTrustedDomain("https://example.com"), false, "the class itself is unchanged");
    assert.equal(Store.prototype.isTrustedDomain.call(store, "https://example.com"), false);
    assert.equal(installAlwaysTrust({ default: Object.freeze(new Store()) }, { isSuspiciousDownload() {} }, () => true), false);
    assert.equal(installAlwaysTrust({ default: new Store() }, {}, () => true), false);
});

test("jump to top keeps Discord's button and its hooks, and adds a flipped jump to the first message", async () => {
    const { build } = await import("esbuild");
    const { outputFiles: out } = await build({ stdin: { contents: 'export * from "./features/venus/jumpToTop";',
        resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
    const host = { module: { exports: {} } };
    vm.runInNewContext(out[0].text, host);
    const { createJumpToTop } = host.module.exports;
    const react = {
        createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }; },
        cloneElement(element, props) { return { ...element, props: { ...element.props, ...props } }; },
    };
    const hooks = [], jumps = [];
    let shown = true, on = true, events = 0;
    const original = props => shown ? { type: "Wrapper", props: { children: { type: "Button", props: { onPress: () => "present" } } } } : null;
    const component = createJumpToTop({ react, original, native: () => ({ View: "View" }),
        chatHeight: () => ({ useChatInputContainerHeight: i => { hooks.push(["input", i]); return 80; }, useSmallSuggestionBarHeight: i => { hooks.push(["bar", i]); return 10; } }),
        messageStore: () => ({ getMessages: () => ({ ready: true, hasMoreBefore: true, length: 50, last: () => ({ id: "999" }) }) }),
        messageActions: () => ({ jumpToMessage(options) { jumps.push(options); } }),
        pill: () => "Pill", icon: () => 42, enabled: () => on, onEvent: () => events++ });
    let tree = component({ channelId: "c1", screenIndex: 0 });
    assert.equal(tree.type, "Wrapper");
    const group = tree.props.children;
    assert.equal(group.type, "View");
    const [flip, present] = group.props.children;
    assert.deepEqual(plain(flip.props.style), { transform: [{ scaleY: -1 }] });
    assert.equal(present.type, "Button");
    flip.props.children.props.onPress();
    assert.deepEqual(plain(jumps[0]), { channelId: "c1", messageId: "c1", flash: true, jumpType: "ANIMATED", returnMessageId: "999" });
    assert.equal(events, 1);
    shown = false;
    tree = component({ channelId: "c1", screenIndex: 0 });
    assert.equal(tree.props.style.bottom, 80 + 10 + 12, "Discord's pill above the input and suggestion bar");
    assert.equal(tree.props.children.props.children.type, "Pill");
    assert.equal(tree.props.children.props.children.props.icon, 42);
    on = false;
    assert.equal(component({ channelId: "c1", screenIndex: 0 }), null, "disabled: Discord's own result");
    assert.equal(hooks.length, 6, "both hooks run on every render, enabled or not");
    const empty = createJumpToTop({ react, original: () => null, native: () => ({ View: "View" }), chatHeight: () => ({}),
        messageStore: () => ({ getMessages: () => ({ ready: true, hasMoreBefore: false, length: 1 }) }),
        messageActions: () => ({ jumpToMessage() {} }), pill: () => "Pill", icon: () => 1, enabled: () => true });
    assert.equal(empty({ channelId: "c2" }), null, "nothing to jump to in a one-message chat");
    const throwing = createJumpToTop({ react, original: () => "orig", native: () => { throw new Error("x"); }, chatHeight: () => null,
        messageStore: () => null, messageActions: () => ({}), pill: () => null, icon: () => null, enabled: () => true });
    assert.equal(throwing({ channelId: "c3" }), "orig", "a failure returns Discord's own element");
});

test("every module captured with all features built is an observation target, so the observer never rejects the set", async () => {
    const { build } = await import("esbuild");
    const { outputFiles: out } = await build({ stdin: { contents: 'export * from "./core/modules"; export { MODULE_PROBES } from "./diagnostics/probes"; export * from "./diagnostics/observer"; export { FEATURE_IDS } from "./core/features";',
        resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
    const host = { module: { exports: {} }, setTimeout() {} };
    vm.runInNewContext(out[0].text, host);
    const { createCoreModules, MODULE_PROBES, createMetroObserver, FEATURE_IDS } = host.module.exports;
    const core = createCoreModules(() => {}, false, [...FEATURE_IDS]);
    const probeIds = new Set(MODULE_PROBES.map(probe => probe.id));
    for (const capture of core.captures) assert.ok(probeIds.has(capture.id), `capture ${capture.id} has no probe`);
    assert.equal(new Set(core.captures.map(c => c.id)).size, core.captures.length, "no duplicate captures");
    assert.doesNotThrow(() => createMetroObserver({}, MODULE_PROBES, () => {}, () => {}, core.captures));
});

test("MessageActions captured for Venus features is not hooked for Fake Nitro unless Fake Nitro is built", async () => {
    const { build } = await import("esbuild");
    const { outputFiles: out } = await build({ stdin: { contents: 'export * from "./core/modules";',
        resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
    const host = { module: { exports: {} }, setTimeout() {} };
    vm.runInNewContext(out[0].text, host);
    const reports = [];
    const core = host.module.exports.createCoreModules(event => reports.push(event), false, ["jumpToTop", "gestures"]);
    const capture = core.captures.find(c => c.id === 7598);
    assert.ok(capture, "7598 is captured for the Venus features");
    const sendMessage = () => "sent";
    const target = { sendMessage, default: undefined };
    target.default = target;
    capture.onExports(target, {});
    assert.equal(target.sendMessage, sendMessage, "sendMessage is untouched without Fake Nitro");
    assert.ok(!reports.some(r => String(r).includes("fake-nitro")));
});

async function gesturesApi() {
    const { build } = await import("esbuild");
    const { outputFiles: out } = await build({ stdin: { contents: 'export * from "./features/venus/gestures";',
        resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
    const host = { module: { exports: {} } };
    vm.runInNewContext(out[0].text, host);
    return host.module.exports;
}
function gestureFixture(createGestures, options = {}) {
    let clock = 1000, timers = [], on = true, triple = options.triple ?? false;
    const calls = [];
    const g = createGestures({
        enabled: () => on, tripleDelete: () => triple, currentUser: () => ({ id: "me" }),
        canReply: () => (channel, message) => options.canReply ?? true, reply: () => o => calls.push(["reply", o.message.id, o.actionSource]),
        canEdit: () => (message, userId) => message.author.id === userId, edit: () => (m, c, ref, source) => calls.push(["edit", m.id, source]),
        undeletable: () => new Set([7]), deleteMessage: () => (channelId, id) => { calls.push(["delete", channelId, id]); return Promise.resolve(); },
        haptic: () => calls.push(["haptic"]), setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout: () => { timers = []; },
        now: () => clock, onEvent: e => calls.push(["event", e]) });
    return { g, calls, flush: () => { const t = timers; timers = []; t.forEach(fn => fn()); }, tick: ms => { clock += ms; },
        setOn: v => { on = v; }, setTriple: v => { triple = v; } };
}

test("double-tap replies to others, edits your own, and falls back to Discord's reaction", async () => {
    const { createGestures } = await gesturesApi();
    const f = gestureFixture(createGestures);
    let reacted = 0;
    const original = () => { reacted++; return "reacted"; };
    const other = { id: "1", author: { id: "you" }, state: "SENT" }, mine = { id: "2", author: { id: "me" }, state: "SENT" }, channel = { id: "c" };
    f.g.doubleTap(original, null, [other, channel]);
    f.g.doubleTap(original, null, [mine, channel]);
    assert.deepEqual(plain(f.calls.filter(c => c[0] === "reply" || c[0] === "edit")), [["reply", "1", "message_swipe"], ["edit", "2", "message_swipe"]]);
    assert.equal(reacted, 0);
    const blocked = gestureFixture(createGestures, { canReply: false });
    blocked.g.doubleTap(original, null, [other, channel]);
    assert.equal(reacted, 1, "where replying is not allowed, Discord's own reaction runs");
    f.setOn(false);
    assert.equal(f.g.doubleTap(original, null, [other, channel]), "reacted", "disabled: Discord's reaction");
});

test("triple-tap delete is opt-in, waits for a third tap, and only deletes your own deletable messages", async () => {
    const { createGestures } = await gesturesApi();
    const original = () => "reacted";
    const mine = { id: "2", author: { id: "me" }, state: "SENT", type: 0 }, channel = { id: "c" };
    const off = gestureFixture(createGestures);
    off.g.doubleTap(original, null, [mine, channel]);
    assert.ok(off.calls.some(c => c[0] === "edit"), "without triple delete the edit happens at once");
    const f = gestureFixture(createGestures, { triple: true });
    f.g.doubleTap(original, null, [mine, channel]);
    assert.ok(!f.calls.some(c => c[0] === "edit"), "waits for a possible third tap");
    f.tick(500);
    assert.equal(f.g.tap({ nativeEvent: { messageId: "2" } }), true);
    assert.deepEqual(plain(f.calls.filter(c => c[0] === "delete")), [["delete", "c", "2"]]);
    f.flush();
    assert.ok(!f.calls.some(c => c[0] === "edit"), "no edit after the delete");
    const late = gestureFixture(createGestures, { triple: true });
    late.g.doubleTap(original, null, [mine, channel]);
    late.flush();
    assert.ok(late.calls.some(c => c[0] === "edit"), "no third tap: edit after the wait");
    const other = gestureFixture(createGestures, { triple: true });
    other.g.doubleTap(original, null, [{ id: "1", author: { id: "you" }, state: "SENT" }, channel]);
    assert.ok(other.calls.some(c => c[0] === "reply"), "someone else's message never waits or deletes");
    const kept = gestureFixture(createGestures, { triple: true });
    kept.g.doubleTap(original, null, [{ ...mine, type: 7 }, channel]);
    assert.ok(!kept.calls.some(c => c[0] === "delete") && kept.calls.some(c => c[0] === "edit"), "undeletable types are edited, never deleted");
});

test("wrapped MessagesHandlers keeps instances, prototype and taps, and only real double-taps are taken over", async () => {
    const { createGestures } = await gesturesApi();
    const f = gestureFixture(createGestures);
    function Handlers(params) {
        this.params = params;
        this.handleTapMessage = () => "tap";
        this.handleDoubleTapMessage = event => event.run();
    }
    Handlers.prototype.kind = "handlers";
    Handlers.STATIC = 1;
    const Wrapped = f.g.wrapHandlers(Handlers);
    const instance = new Wrapped({ selectedChannelId: "c", chatInputRef: "ref" });
    assert.ok(instance instanceof Handlers);
    assert.equal(instance.kind, "handlers");
    assert.equal(Wrapped.STATIC, 1);
    assert.equal(instance.handleTapMessage({ nativeEvent: { messageId: "9" } }), "tap");
    let reacted = 0;
    const original = () => { reacted++; };
    const other = { id: "1", author: { id: "you" } }, channel = { id: "c" };
    f.g.doubleTap(original, null, [other, channel]);
    assert.equal(reacted, 0, "before the wrapped handler has been seen, every call is taken as a double-tap");
    instance.handleDoubleTapMessage({ run: () => f.g.doubleTap(original, null, [other, channel]) });
    assert.equal(reacted, 0);
    f.g.doubleTap(original, null, [other, channel]);
    assert.equal(reacted, 1, "once it has been seen, a call outside a real double-tap (TalkBack) keeps Discord's behaviour");
    assert.equal(f.calls.filter(c => c[0] === "reply").length, 2);
    assert.equal(f.g.wrapHandlers(() => ({})), null, "an arrow function can't be constructed: nothing is replaced");
    class Sub extends Wrapped {}
    assert.ok(new Sub({}) instanceof Sub, "new.target is kept for subclasses");
    function Locked() { Object.defineProperty(this, "handleTapMessage", { value: () => "locked", writable: false }); }
    const lockedInstance = new (f.g.wrapHandlers(Locked))();
    assert.equal(lockedInstance.handleTapMessage(), "locked", "a read-only handler keeps Discord's instance");
});

test("full-quality images return the uploaded file for normal pictures and larger avatars, only while enabled", async () => {
    const { build } = await import("esbuild");
    const { outputFiles: out } = await build({ stdin: { contents: 'export * from "./features/venus/fullImages";',
        resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
    const host = { module: { exports: {} } };
    vm.runInNewContext(out[0].text, host);
    const { installFullImages, fullImageUrl, fullAvatarUrl } = host.module.exports;
    const src = "https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=3&width=200&height=100&format=webp";
    assert.equal(fullImageUrl(src, 400, 200), "https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=3");
    assert.equal(fullImageUrl(src.replace("a.png", "a.gif"), 400, 200), null, "GIFs keep Discord's copy");
    assert.equal(fullImageUrl(src, 5000, 200), null, "too big for a phone");
    assert.equal(fullImageUrl("https://example.com/attachments/a.png", 1, 1), null);
    assert.equal(fullAvatarUrl("https://cdn.discordapp.com/avatars/1/a.webp?size=64", false), "https://cdn.discordapp.com/avatars/1/a.webp?size=512");
    assert.equal(fullAvatarUrl("https://cdn.discordapp.com/banners/1/a.webp?size=2048", true), "https://cdn.discordapp.com/banners/1/a.webp?size=2048");
    let on = false;
    const resized = (s, w, h) => `resized:${s}`;
    const images = { getMobileOptimizedSrc: resized, default: { getMobileOptimizedSrc: resized } };
    const avatar = () => "https://cdn.discordapp.com/avatars/1/a.webp?size=64";
    const avatars = { getUserAvatarURL: avatar, getUserAvatarSource: () => ({ uri: avatar() }), default: { getUserAvatarURL: avatar } };
    assert.ok(installFullImages(images, avatars, () => on) >= 4);
    assert.equal(images.getMobileOptimizedSrc(src, 400, 200), `resized:${src}`, "off: Discord's copy");
    on = true;
    assert.equal(images.default.getMobileOptimizedSrc(src, 400, 200), "https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=3");
    assert.equal(avatars.getUserAvatarURL(), "https://cdn.discordapp.com/avatars/1/a.webp?size=512");
    assert.equal(avatars.getUserAvatarSource().uri, "https://cdn.discordapp.com/avatars/1/a.webp?size=512");
    assert.equal(installFullImages(Object.freeze({ getMobileOptimizedSrc: resized }), {}, () => true), 0);
});

test("read all adds its row to the server bar's separator only, and marks servers and DMs read through Discord's actions", async () => {
    const { build } = await import("esbuild");
    const { outputFiles: out } = await build({ stdin: { contents: 'export * from "./features/venus/readAll";',
        resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
    const host = { module: { exports: {} } };
    vm.runInNewContext(out[0].text, host);
    const { createReadAll, markAsRead } = host.module.exports;
    const calls = [];
    const store = methods => Object.assign(Object.create({}), methods);
    const modules = {
        6846: { default: store({ hasUnread: id => id === "g1", getMentionCount: id => id === "g2" ? 1 : 0, getGuildHasUnreadIgnoreMuted: id => id === "g3" }) },
        6733: { default: store({ getFlattenedGuildIds: () => ["g1", "g2", "g3", "g4"] }) },
        4936: { default: store({ lurkingGuildIds: () => ["g1"] }) },
        4877: { default: store({ getGuildIds: () => ["g4"] }) },
        6803: { default: store({ hasUnread: () => false, hasUnreadOrMentions: id => id !== "d3", lastMessageId: id => id === "d2" ? null : `m-${id}` }) },
        6737: { CHANNEL: 0, GUILD_EVENT: 1 },
        15243: { default: (ids, section) => calls.push(["guilds", [...ids], section]) },
        1087: { AnalyticsSections: { GUILD_LIST: "guild list" } },
        15096: { default: store({ getUnreadPrivateChannelIds: () => ["d1", "d2"] }) },
        7354: { default: store({ getPrivateChannelIds: () => ["d1", "d3", "d4"] }) },
        6844: { filterOutMessageRequestsAndSpamById: ids => ids.filter(id => id !== "d4") },
        7238: { bulkAck: acks => calls.push(["dms", acks.map(a => `${a.channelId}:${a.messageId}:${a.readStateType}`)]) },
    };
    const get = id => modules[id];
    assert.deepEqual(plain(markAsRead("guilds", get)), { guilds: 3, dms: 0, failed: false });
    assert.deepEqual(plain(calls), [["guilds", ["g1", "g2", "g3"], "guild list"]], "muted servers with unread channels are included");
    calls.length = 0;
    assert.deepEqual(plain(markAsRead("dms", get)), { guilds: 0, dms: 1, failed: false });
    assert.deepEqual(plain(calls), [["dms", ["d1:m-d1:0"]]], "no last message, read, or request: not acknowledged");
    assert.equal(markAsRead("both", () => undefined).failed, true, "stores not loaded");
    for (const filter of [undefined, () => { throw new Error("unavailable"); }, () => null,
        () => ["request-channel"], () => [42]]) {
        calls.length = 0;
        const unavailableFilter = id => id === 6844 ? { filterOutMessageRequestsAndSpamById: filter } : get(id);
        assert.deepEqual(plain(markAsRead("dms", unavailableFilter)), { guilds: 0, dms: 0, failed: true });
        assert.equal(calls.length, 0, "an unavailable or incompatible filter must never acknowledge DMs");
    }

    let on = true, events = [];
    const react = { createElement: (type, props, ...children) => ({ type, props, children }), useState: v => [v, () => {}], useEffect() {} };
    const readAll = createReadAll({ enabled: () => on, react, native: () => ({ View: "View", Text: "Text", Pressable: "Pressable" }),
        alert: () => null, module: get, separator: () => 6, onEvent: e => events.push(e) });
    const listDataProps = { itemSize: section => section === 6 ? 10 : 48, renderItem: section => `row${section}`, sections: [1] };
    const result = { listProps: { a: 1 }, listDataProps };
    const exports = { default: () => result, OTHER: 1 };
    assert.equal(readAll.install(exports), true);
    const view = exports.default();
    assert.notEqual(view, result);
    assert.equal(view.listProps, result.listProps);
    assert.equal(exports.default(), view, "the same result gives the same props");
    assert.equal(view.listDataProps.itemSize(6), 50);
    assert.equal(view.listDataProps.itemSize(1), 48);
    assert.equal(view.listDataProps.renderItem(1), "row1");
    const row = view.listDataProps.renderItem(6);
    assert.equal(row.type, "View");
    assert.equal(row.children[1], "row6", "Discord's separator stays below the button");
    on = false;
    assert.equal(view.listDataProps.itemSize(6), 10, "off: Discord's size");
    assert.equal(exports.default(), result, "off: Discord's props");
    assert.equal(readAll.run("guilds"), false, "off: nothing is marked");
    on = true;
    assert.equal(readAll.run("guilds"), true);
    assert.deepEqual(events, ["installed", "cleared"]);
    assert.equal(readAll.install(Object.freeze({ default: () => result })), false);
    assert.equal(readAll.install({}), false);
});
