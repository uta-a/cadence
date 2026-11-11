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
    assert.deepEqual(calls, [["[disk] loaded 0.1.0 (native)", 1, true], ["[disk] observer installed (native)", 1, true]]);
    assert.equal(host.__disk.revision, "0.1.0");
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
    assert.deepEqual(calls, ["[disk] loaded 0.1.0 (console)", "[disk] observer installed (console)"]);
});

test("throwing native logging falls back to console without losing the marker", () => {
    const calls = [];
    const host = context({ nativeLoggingHook() { throw new Error("host unavailable"); },
        console: { log(message) { calls.push(message); } } });
    assert.doesNotThrow(() => run(host));
    assert.deepEqual(calls, ["[disk] loaded 0.1.0 (console)", "[disk] observer installed (console)"]);
    assert.equal(host.__disk.revision, "0.1.0");
});

test("missing loggers or failures in both diagnostics never abort the entry", () => {
    for (const host of [context(), context({ nativeLoggingHook: false, console: { log: null } }),
        context({ nativeLoggingHook() { throw new Error("native"); }, console: { log() { throw new Error("console"); } } })]) {
        assert.doesNotThrow(() => run(host));
        assert.equal(host.__disk.revision, "0.1.0");
    }
});

test("native logger is preferred without touching a potentially broken console getter", () => {
    let calls = 0;
    const host = context({ nativeLoggingHook() { calls++; } });
    Object.defineProperty(host, "console", { get() { throw new Error("console not initialized"); } });
    assert.doesNotThrow(() => run(host));
    assert.equal(calls, 2);
});

test("entry captures the natural FileModule and defers disk settings loading without boot writes", async () => {
    const logs = [], calls = [], registered = new Map();
    const host = context({ nativeLoggingHook(message) { logs.push(message); },
        __d(factory, id) { registered.set(id, factory); } });
    run(host);
    const native = {
        getConstants() { calls.push("constants"); return { DocumentsDirPath: "/data/user/0/com.discord/files" }; },
        async fileExists() { calls.push("exists"); return false; },
        async readFile() { assert.fail("missing file should not be read"); },
        async writeFile() { assert.fail("read-only bootstrap must not write"); },
    };
    const module = { exports: {} };
    host.__d((...args) => { args[4].exports = { default: native }; return 42; }, 1164, []);
    assert.deepEqual(calls, []);
    assert.equal(registered.get(1164)(null, null, null, null, module), 42);
    assert.deepEqual(calls, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["constants", "exists"]);
    assert.ok(logs.includes("[disk] settings ready (native)"));
    assert.equal(logs.some(line => line.includes("/data/")), false);
});

test("an accessor native export reports settings unavailable without evaluating it or changing factory return", async () => {
    const logs = [], registered = new Map();
    const host = context({ nativeLoggingHook(message) { logs.push(message); },
        __d(factory, id) { registered.set(id, factory); } });
    run(host);
    let getterCalls = 0;
    const exports = {};
    Object.defineProperty(exports, "default", { get() { getterCalls++; throw new Error("not safe to evaluate"); } });
    host.__d(() => 77, 1164, []);
    assert.equal(registered.get(1164)(null, null, null, null, { exports }), 77);
    assert.equal(getterCalls, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(logs.includes("[disk] settings load-error (native)"));
});

test("a throwing native getter is isolated and existing disk markers are preserved", () => {
    const calls = [];
    const host = context({ console: { log(message) { calls.push(message); } } });
    Object.defineProperty(host, "nativeLoggingHook", { get() { throw new Error("getter"); } });
    assert.doesNotThrow(() => run(host));
    assert.equal(calls.length, 2);
    const prior = Object.freeze({ revision: "existing" });
    const existing = context({ __disk: prior, nativeLoggingHook() { assert.fail("must not announce twice"); } });
    run(existing);
    assert.equal(existing.__disk, prior);
});
