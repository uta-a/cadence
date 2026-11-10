import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

const { outputFiles } = await build({ entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
    bundle: true, format: "iife", platform: "neutral", target: "es2019", supported: { class: false }, write: false });
const compiled = outputFiles[0].text;
function context(values = {}) { return vm.createContext({ console: undefined, ...values }); }
function run(host) { return vm.runInContext(compiled, host); }

test("entry logs through the native host before console exists and keeps the receiver", () => {
    const calls = [];
    const host = context({ nativeLoggingHook(message, level) {
        calls.push([message, level, this.__disk === host.__disk]);
    } });
    run(host);
    assert.deepEqual(calls, [["[disk] loaded 0.0.1 (native)", 1, true]]);
    assert.equal(host.__disk.revision, "0.0.1");
    assert.ok(Object.isFrozen(host.__disk));
});

test("entry uses console only as fallback and does not announce twice", () => {
    const calls = [];
    const console = { log(message) { assert.equal(this, console); calls.push(message); } };
    const host = context({ console });
    run(host);
    const marker = host.__disk;
    run(host);
    assert.equal(host.__disk, marker);
    assert.deepEqual(calls, ["[disk] loaded 0.0.1 (console)"]);
});

test("throwing native logging falls back to console without losing the marker", () => {
    const calls = [];
    const host = context({ nativeLoggingHook() { throw new Error("host unavailable"); },
        console: { log(message) { calls.push(message); } } });
    assert.doesNotThrow(() => run(host));
    assert.deepEqual(calls, ["[disk] loaded 0.0.1 (console)"]);
    assert.equal(host.__disk.revision, "0.0.1");
});

test("missing loggers or failures in both diagnostics never abort the entry", () => {
    for (const host of [context(), context({ nativeLoggingHook: false, console: { log: null } }),
        context({ nativeLoggingHook() { throw new Error("native"); }, console: { log() { throw new Error("console"); } } })]) {
        assert.doesNotThrow(() => run(host));
        assert.equal(host.__disk.revision, "0.0.1");
    }
});

test("native logger is preferred without touching a potentially broken console getter", () => {
    let calls = 0;
    const host = context({ nativeLoggingHook() { calls++; } });
    Object.defineProperty(host, "console", { get() { throw new Error("console not initialized"); } });
    assert.doesNotThrow(() => run(host));
    assert.equal(calls, 1);
});

test("a throwing native getter is isolated and existing disk markers are preserved", () => {
    const calls = [];
    const host = context({ console: { log(message) { calls.push(message); } } });
    Object.defineProperty(host, "nativeLoggingHook", { get() { throw new Error("getter"); } });
    assert.doesNotThrow(() => run(host));
    assert.equal(calls.length, 1);
    const prior = Object.freeze({ revision: "existing" });
    const existing = context({ __disk: prior, nativeLoggingHook() { assert.fail("must not announce twice"); } });
    run(existing);
    assert.equal(existing.__disk, prior);
});
