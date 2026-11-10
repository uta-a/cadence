import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

// Compile the actual TypeScript source rather than maintaining a second JS implementation for tests.
const { outputFiles } = await build({ entryPoints: [new URL("../src/core/loader.ts", import.meta.url).pathname],
    bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
const compiled = outputFiles[0].text;

function loader(host, gateId = null, onError = () => {}) {
    const sandbox = { module: { exports: {} }, exports: {}, Uint8Array, Map, Error, RangeError, TypeError };
    vm.runInNewContext(compiled, sandbox);
    return sandbox.module.exports.createMetroLoader(host, gateId, onError);
}

function defineCollector() {
    const recorded = new Map();
    const define = function (...args) { recorded.set(args[1], args); return args[3] || "defined"; };
    function load(id, exports = {}) {
        const call = recorded.get(id);
        assert.ok(call, `module ${id} registered`);
        const module = { exports };
        const outcome = call[0](null, null, null, null, module, module.exports, call[2]);
        return { module, outcome };
    }
    return { define, recorded, load };
}

test("late Metro __d assignment and unaffected modules", () => {
    const host = {};
    const c = defineCollector();
    const seen = [];
    const l = loader(host);
    l.register(42, (exports) => seen.push(exports));
    l.install();
    l.install();
    assert.equal(host.__d, undefined);
    host.__d = c.define;
    assert.equal(Object.getOwnPropertyDescriptor(host, "__d").get, undefined);
    assert.equal(host.__d(() => "original", 5, [], "extra"), "extra");
    assert.equal(c.load(5).outcome, "original");
    host.__d((...args) => { args[4].exports = { value: 42 }; return "ok"; }, 42, [], "extra");
    assert.equal(c.load(42).outcome, "ok");
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { value: 42 });
});

test("existing Metro __d is preserved, hooks are isolated from each other", () => {
    const c = defineCollector();
    const host = { __d: c.define };
    const seen = [], errors = [];
    const l = loader(host, null, (id, error) => errors.push([id, error.message]));
    l.register(7, () => { throw new Error("bad hook"); });
    l.register(7, (_, module) => { module.exports.ok = true; seen.push("good"); });
    l.install();
    assert.equal(host.__d((...args) => { args[4].exports = {}; }, 7, []), "defined");
    assert.equal(c.load(7).module.exports.ok, true);
    assert.deepEqual(seen, ["good"]);
    assert.deepEqual(errors, [[7, "bad hook"]]);
});

test("an original factory error is never swallowed", () => {
    const c = defineCollector(), host = { __d: c.define };
    const l = loader(host);
    l.register(7, () => assert.fail("hook should not run"));
    l.install();
    host.__d(() => { throw new TypeError("original failure"); }, 7, []);
    assert.throws(() => c.load(7), { message: "original failure" });
});

test("init gate defers hooks, drains once on outermost success and retains method receiver", () => {
    const c = defineCollector(), host = { __d: c.define };
    const seen = [];
    const l = loader(host, 9);
    l.register(3, (exports) => seen.push(exports.value));
    l.install();
    host.__d((...args) => { args[4].exports = { value: 3 }; }, 3, []);
    c.load(3);
    assert.deepEqual(seen, []);
    const gate = { default() { assert.equal(this, gate); return 15; } };
    host.__d((...args) => { args[4].exports = gate; }, 9, []);
    c.load(9);
    assert.equal(gate.default(), 15);
    assert.deepEqual(seen, [3]);
    assert.equal(l.ready, true);
    gate.default();
    assert.deepEqual(seen, [3]);
});

test("init gate exception never flushes and a missing gate leaves hooks inactive", () => {
    const c = defineCollector(), host = { __d: c.define };
    const seen = [], errors = [];
    const l = loader(host, 9, (id, err) => errors.push([id, err.message]));
    l.register(3, () => seen.push(3));
    l.install();
    host.__d((...args) => { args[4].exports = {}; }, 9, []);
    c.load(9);
    host.__d((...args) => { args[4].exports = { value: 3 }; }, 3, []);
    c.load(3);
    assert.equal(l.ready, false);
    assert.deepEqual(seen, []);
    assert.deepEqual(errors, [[9, "RN initializer default export missing"]]);

    const fresh = defineCollector(), other = { __d: fresh.define };
    const l2 = loader(other, 9);
    l2.register(3, () => seen.push(4));
    l2.install();
    const gate = { default() { throw new Error("init failed"); } };
    other.__d((...args) => { args[4].exports = gate; }, 9, []);
    fresh.load(9);
    other.__d((...args) => { args[4].exports = {}; }, 3, []);
    fresh.load(3);
    assert.throws(() => gate.default(), { message: "init failed" });
    assert.deepEqual(seen, []);
    assert.equal(l2.ready, false);
});

test("a broken error reporter or immutable gate export never breaks the original module", () => {
    const c = defineCollector(), host = { __d: c.define };
    const l = loader(host, 9, () => { throw new Error("logger broken"); });
    l.register(3, () => { throw new Error("hook broken"); });
    l.install();
    const exports = {};
    Object.defineProperty(exports, "default", { value: function () { return "untouched"; }, writable: false });
    host.__d((...args) => { args[4].exports = exports; return "factory ok"; }, 9, []);
    assert.equal(c.load(9).outcome, "factory ok");
    assert.equal(exports.default(), "untouched");
    assert.equal(l.ready, false);
});

test("descriptor guards fail open and do not falsely mark install as complete", () => {
    for (const descriptor of [
        { value: () => {}, writable: false, configurable: false },
        { get: () => () => {}, configurable: false },
    ]) {
        const host = {};
        Object.defineProperty(host, "__d", descriptor);
        const errors = [];
        const l = loader(host, null, (_, error) => errors.push(error.message));
        l.install();
        l.install();
        assert.deepEqual(errors, ["Cannot intercept a non-configurable Metro define", "Cannot intercept a non-configurable Metro define"]);
    }
    const c = defineCollector();
    const host = {};
    Object.defineProperty(host, "__d", { value: c.define, writable: false, configurable: true });
    const l = loader(host);
    const seen = [];
    l.register(7, () => seen.push(7));
    l.install();
    host.__d((...args) => { args[4].exports = {}; }, 7, []);
    c.load(7);
    assert.deepEqual(seen, [7]);

    const locked = {};
    Object.defineProperty(locked, "__d", { value: c.define, writable: true, configurable: false });
    const l2 = loader(locked);
    l2.register(8, () => seen.push(8));
    l2.install();
    locked.__d((...args) => { args[4].exports = {}; }, 8, []);
    c.load(8);
    assert.deepEqual(seen, [7, 8]);
});

test("non-function assignments do not remove the late Metro define trap", () => {
    const c = defineCollector(), host = {};
    const seen = [], l = loader(host);
    l.register(7, () => seen.push(7));
    l.install();
    host.__d = undefined;
    host.__d = null;
    assert.equal(host.__d, null);
    assert.equal(typeof Object.getOwnPropertyDescriptor(host, "__d").set, "function");
    host.__d = c.define;
    host.__d((...args) => { args[4].exports = {}; }, 7, []);
    c.load(7);
    assert.deepEqual(seen, [7]);
});

test("gate ID cannot be registered as a regular module hook", () => {
    const l = loader({}, 9);
    assert.throws(() => l.register(9, () => {}), RangeError);
});

test("modules loaded while draining join behind the previously waiting modules", () => {
    const c = defineCollector(), host = { __d: c.define }, seen = [];
    const l = loader(host, 9);
    l.register(3, () => {
        seen.push(3);
        host.__d((...args) => { args[4].exports = {}; }, 5, []);
        c.load(5);
    });
    l.register(4, () => seen.push(4));
    l.register(5, () => seen.push(5));
    l.install();
    for (const id of [3, 4]) {
        host.__d((...args) => { args[4].exports = {}; }, id, []);
        c.load(id);
    }
    host.__d((...args) => { args[4].exports = { default() { return true; } }; }, 9, []);
    const gate = c.load(9).module.exports;
    assert.equal(gate.default(), true);
    assert.deepEqual(seen, [3, 4, 5]);
    assert.equal(l.ready, true);
});

test("callable define, factory and initializer tolerate shadowed apply properties", () => {
    const c = defineCollector(), host = { __d: c.define }, seen = [];
    c.define.apply = null;
    const l = loader(host, 9);
    l.register(7, () => seen.push(7));
    l.install();
    const factory = (...args) => { args[4].exports = {}; return 42; };
    factory.apply = null;
    host.__d(factory, 7, []);
    assert.equal(c.load(7).outcome, 42);
    const gate = () => 19;
    gate.apply = null;
    host.__d((...args) => { args[4].exports = { default: gate }; }, 9, []);
    assert.equal(c.load(9).module.exports.default(), 19);
    assert.deepEqual(seen, [7]);
});

test("IDs outside the pinned table are rejected", () => {
    const l = loader({});
    for (const id of [-1, 32768, 1.5, NaN]) assert.throws(() => l.register(id, () => {}), RangeError);
});
