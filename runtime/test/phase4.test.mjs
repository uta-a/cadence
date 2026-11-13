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
    assert.deepEqual(ids(createCoreModules(() => {}, false, ["fakeNitro"])), [17, 19, 1164, 1395, 4953, 5183, 7475, 7522, 7598, 18400]);
    const events = [];
    const core = createCoreModules(value => events.push(value), false, ["fakeNitro", "platformIndicator", "disableAnalytics"]);
    assert.deepEqual(ids(core), [17, 19, 504, 1164, 1267, 1395, 4855, 4953, 5183, 5744, 7085, 7475, 7522, 7598, 8165, 8778, 9196, 9515, 9524, 10659, 11110, 14049, 15449, 16280, 17494, 17499, 18400]);
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
    const fake = all.find(node => node.props.accessibilityLabel === "cadence:feature:fakeNitro");
    assert.equal(fake.type, "Switch");
    assert.equal(fake.props.value, true);
    fake.props.onValueChange(false);
    assert.deepEqual(changes, [["fakeNitro", false]]);
    assert.ok(all.some(node => node.props.accessibilityLabel === "cadence:feature:platformIndicator:false"));
    assert.equal(all.find(node => node.props.accessibilityLabel === "cadence:feature:platformIndicator"), undefined);
    assert.ok(all.some(node => node.children?.includes("このビルドには含まれていません")));
    assert.ok(all.some(node => String(node.children?.[0]).startsWith("Analytics：JS の track 送信を停止しています")));
    const size64 = all.find(node => node.props.accessibilityLabel === "cadence:nitro-size:64");
    assert.equal(size64.props.accessibilityState.selected, true);
    all.find(node => node.props.accessibilityLabel === "cadence:nitro-size:128").props.onPress();
    all.find(node => node.props.accessibilityLabel === "cadence:nitro-masked").props.onValueChange(false);
    assert.deepEqual(plain(changes.slice(1)), [["nitro", { emojiSize: 128 }], ["nitro", { maskedLinks: false }]]);
    assert.ok(all.some(node => node.props.accessibilityLabel === "cadence:nitro-masked:true"));
    const without = flat(createSettingsOverview(react, () => native, () => {}, controller, () => {}, () => true, ["platformIndicator"])({}));
    assert.equal(without.find(node => node.props.accessibilityLabel === "cadence:nitro-size:48"), undefined, "no options unless Fake Nitro is built");
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

