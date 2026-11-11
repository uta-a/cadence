import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const { outputFiles } = await build({ stdin: { contents: 'export * from "./features/venus/voiceDownload";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
const host = { module: { exports: {} }, Promise }; vm.runInNewContext(outputFiles[0].text, host);
const { voiceAttachment, createVoiceDownload } = host.module.exports;
const url = "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=signature";
const message = { flags: 8192, attachments: [{ url, content_type: "audio/ogg" }] };
const row = { rowType: 1, message };
const event = { nativeEvent: { callback: "disk-voice-download", channelId: "c", messageId: "m" } };
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}) {
    let enabled = false;
    const events = [], downloads = [];
    const feature = createVoiceDownload({ enabled: () => enabled, message: () => message,
        nativeData: e => e.decoded, download: (...args) => { downloads.push(args); }, onEvent: e => events.push(e), ...overrides });
    return { feature, events, downloads, enable: value => { enabled = value; } };
}
test("voice downloads accept only voice-flagged Discord attachment audio URLs", () => {
    assert.equal(voiceAttachment(message).url, url);
    for (const m of [null, {}, { ...message, flags: 0 }, { ...message, attachments: [] },
        ...["http://cdn.discordapp.com/attachments/a", "https://example.org/attachments/a", "https://cdn.discordapp.com.evil/attachments/a", "https://cdn.discordapp.com/avatars/a", url + "\n"].map(u => ({ flags: 8192, attachments: [{ url: u }] })),
        { flags: 8192, attachments: [{ url, content_type: "text/html" }] }]) assert.equal(voiceAttachment(m), null);
});
test("row wrapper preserves existing CTA, unrelated rows and original generator behavior", () => {
    const { feature, enable } = setup();
    const result = { message: { id: "m" }, other: 1 };
    assert.equal(feature.rowResult(result, row), result);
    enable(true);
    const changed = feature.rowResult(result, row);
    assert.notEqual(changed, result); assert.equal(result.message.ctaButton, undefined);
    assert.equal(changed.message.ctaButton.callback, "disk-voice-download");
    assert.equal(changed.other, 1);
    const existing = { message: { ctaButton: { callback: "discord" } } };
    assert.equal(feature.rowResult(existing, row), existing);
    assert.equal(feature.rowResult(result, { ...row, rowType: 2 }), result);
    let calls = 0;
    class Generator { generate(input, tail) { assert.equal(this.marker, 7); assert.equal(input, row); assert.equal(tail, "tail"); calls++; return result; } }
    assert.equal(feature.installRows({ default: Generator }), true);
    const generator = new Generator(); generator.marker = 7;
    assert.equal(generator.generate(row, "tail").message.ctaButton.callback, "disk-voice-download");
    assert.equal(calls, 1);
    assert.equal(feature.installRows({}), false);
    assert.equal(feature.installRows(Object.freeze({ default: () => {} })), false);
});
test("native CTA tap deduplicates downloads, preserves signed URLs and retries after failures", async () => {
    let reject;
    const pending = new Promise((_, r) => { reject = r; });
    let attempt = 0;
    const downloads = [];
    const { feature, enable, events } = setup({ download: (...args) => { downloads.push(args); return ++attempt === 1 ? pending : undefined; } });
    enable(true);
    assert.equal(feature.tap({ nativeEvent: { callback: "discord" } }), false);
    assert.equal(feature.tap(event), true); assert.equal(feature.tap(event), true);
    await flush(); assert.equal(downloads.length, 1);
    assert.deepEqual(downloads[0], [url, 0, "audio/ogg"]);
    reject(new Error("network")); await flush(); assert.deepEqual(events, ["started", "failed"]);
    feature.tap(event); await flush(); assert.deepEqual(events, ["started", "failed", "started", "saved"]);
    enable(false); assert.equal(feature.tap(event), true); await flush(); assert.equal(downloads.length, 2);
});
test("handlers retain constructor inheritance, original CTA fallback, and readonly instances", async () => {
    const { feature, enable, downloads } = setup(); enable(true);
    let calls = 0;
    class Handlers { constructor(value) { this.value = value; this.handleTapCtaButton = function (e, tail) { calls++; assert.equal(this.value, 5); return tail; }; } }
    const exports = { MessagesHandlers: Handlers };
    assert.equal(feature.installHandlers(exports), true);
    class Derived extends exports.MessagesHandlers {}
    const instance = new Derived(5);
    assert.ok(instance instanceof Handlers); assert.ok(instance instanceof Derived);
    assert.equal(instance.handleTapCtaButton({ nativeEvent: { callback: "discord" } }, "tail"), "tail");
    assert.equal(instance.handleTapCtaButton(event), undefined); await flush();
    assert.equal(calls, 1); assert.equal(downloads.length, 1);
    class Locked { constructor() { Object.defineProperty(this, "handleTapCtaButton", { value: () => "original" }); } }
    const locked = { MessagesHandlers: Locked }; assert.equal(feature.installHandlers(locked), true);
    assert.equal(new locked.MessagesHandlers().handleTapCtaButton(event), "original");
    assert.equal(feature.installHandlers({ MessagesHandlers: () => {} }), false);
    assert.equal(feature.tap({ decoded: event.nativeEvent }), true);
});
test("missing messages and synchronous native failures never leak to Discord or poison retry state", async () => {
    const missing = setup({ message: () => undefined }); missing.enable(true);
    assert.equal(missing.feature.tap(event), true); assert.deepEqual(missing.events, ["failed"]);
    const broken = setup({ download() { throw new Error("native"); }, onEvent() { throw new Error("log"); } }); broken.enable(true);
    assert.equal(broken.feature.tap(event), true); await flush();
    assert.equal(broken.feature.tap(event), true); await flush();
    const unsafe = { nativeEvent: { get callback() { throw new Error("accessor"); } } };
    assert.equal(broken.feature.tap(unsafe), false, "unknown malformed CTA falls through without re-reading its getter");
    const failingStore = setup({ message() { throw new Error("store"); } }); failingStore.enable(true);
    assert.equal(failingStore.feature.tap(event), true, "recognized disk CTA stays consumed even if its store fails");
});
