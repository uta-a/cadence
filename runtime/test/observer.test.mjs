import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { outputFiles } = await build({ stdin: {
    contents: 'export * from "./diagnostics/observer"; export * from "./core/metro"; export { MODULE_PROBES } from "./diagnostics/probes";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" },
    bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
const context = { module: { exports: {} }, TypeError };
vm.runInNewContext(outputFiles[0].text, context);
const { createMetroObserver, inspectPath, interceptMetroDefine, MODULE_PROBES } = context.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
function collector() {
    const definitions = new Map();
    const define = function (...args) { definitions.set(args[1], args); return this; };
    function load(id, exports = {}, receiver = {}) {
        const module = { exports };
        const args = [null, () => assert.fail("must not require"), null, null, module, module.exports, []];
        return { value: definitions.get(id)[0].apply(receiver, args), module };
    }
    return { definitions, define, load };
}
const probes = [{ name: "Probe", id: 3, paths: ["default", "default.method", "version"] }];

test("diagnostic candidates match the static catalog but do not authorize feature hooks", () => {
    const catalog = JSON.parse(readFileSync(new URL("../modules/352.17.json", import.meta.url)));
    assert.equal(MODULE_PROBES.length, Object.keys(catalog).filter(key => !key.startsWith("_")).length);
    assert.equal(createMetroObserver({}, MODULE_PROBES, () => {}).install(), true);
    for (const probe of MODULE_PROBES) {
        assert.equal(probe.id, catalog[probe.name].id);
        assert.deepEqual(plain(probe.paths), catalog[probe.name].shape);
        assert.equal(catalog[probe.name].verified, false);
    }
});

test("late registration is trapped through non-function assignments without requiring or running factories", () => {
    const c = collector(), host = {}, reports = [];
    let runs = 0;
    const observer = createMetroObserver(host, probes, report => reports.push(report));
    assert.equal(observer.install(), true);
    assert.equal(observer.install(), true);
    host.__d = null;
    host.__d = undefined;
    host.__d = c.define;
    const factory = function (...args) { runs++; args[4].exports = { default: { method() {} }, version: "secret-version" }; return this; };
    const untouched = () => {};
    assert.equal(host.__d(factory, 3, [], "extra"), host);
    host.__d(untouched, 5, []);
    assert.equal(c.definitions.get(5)[0], untouched);
    assert.equal(c.definitions.get(3)[3], "extra");
    assert.equal(Object.getOwnPropertyDescriptor(host, "__d").get, undefined);
    assert.equal(runs, 0);
    const receiver = {};
    const { value } = c.load(3, {}, receiver);
    assert.equal(value, receiver);
    assert.deepEqual(plain(reports), [{ name: "Probe", id: 3, started: 1, completed: 2,
        shape: [{ path: "default", kind: "object" }, { path: "default.method", kind: "function" }, { path: "version", kind: "string" }] }]);
    assert.equal(JSON.stringify(reports).includes("secret-version"), false);
});

test("original thrown objects escape unchanged; diagnostics never run before a successful return", () => {
    const c = collector(), host = { __d: c.define }, reports = [], thrown = {};
    createMetroObserver(host, probes, report => reports.push(report)).install();
    host.__d(() => { throw thrown; }, 3, []);
    assert.throws(() => c.load(3), error => error === thrown);
    assert.deepEqual(reports, []);
});

test("nested natural loads record order without queueing hooks or mutating exports", () => {
    const c = collector(), host = { __d: c.define }, reports = [];
    const observer = createMetroObserver(host, [...probes, { name: "Child", id: 4, paths: ["value"] }], report => reports.push(report));
    observer.install();
    const exports = Object.freeze({ default: Object.freeze({ method() {} }), version: "not logged" });
    host.__d(() => c.load(4), 3, []);
    host.__d(() => 40, 4, []);
    c.load(3, exports);
    assert.deepEqual(reports.map(r => [r.id, r.started, r.completed]), [[4, 2, 3], [3, 1, 4]]);
    assert.equal(Object.isFrozen(exports), true);
    c.load(3, exports);
    assert.equal(reports.length, 2);
});

test("shape reflection never invokes accessors or store methods and walks bounded prototypes", () => {
    let calls = 0;
    const inherited = { method() { calls++; } };
    const object = { default: Object.create(inherited) };
    Object.defineProperty(object, "lazy", { get() { calls++; throw new Error("getter called"); } });
    assert.equal(inspectPath(object, "default.method"), "function");
    assert.equal(inspectPath(object, "lazy"), "accessor");
    assert.equal(inspectPath(object, "lazy.method"), "accessor");
    assert.equal(inspectPath(object, "missing"), "missing");
    assert.equal(inspectPath({ value: null }, "value"), "null");
    assert.equal(calls, 0);
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("opaque host"); } });
    assert.equal(inspectPath(proxy, "method"), "uninspectable");
    let reads = 0, loop;
    loop = new Proxy({}, { getOwnPropertyDescriptor() { reads++; }, getPrototypeOf() { return loop; } });
    assert.equal(inspectPath(loop, "method"), "depth-limit");
    assert.equal(reads, 8);
});

test("throwing reports, diagnostics, or module export getters cannot break a successful factory", () => {
    const c = collector(), host = { __d: c.define };
    createMetroObserver(host, probes, () => { throw new Error("report"); }, () => { throw new Error("diagnostics"); }).install();
    host.__d(() => 42, 3, []);
    assert.equal(c.load(3).value, 42);
    const c2 = collector(), host2 = { __d: c2.define };
    let errors = 0, getterCalls = 0;
    createMetroObserver(host2, probes, () => assert.fail("not a data export"), () => errors++).install();
    host2.__d(() => 77, 3, []);
    const module = {};
    Object.defineProperty(module, "exports", { get() { getterCalls++; } });
    assert.equal(c2.definitions.get(3)[0](null, null, null, null, module), 77);
    assert.equal(errors, 1);
    assert.equal(getterCalls, 0);
});

test("unsupported global descriptors fail without false success or changing existing accessors", () => {
    for (const descriptor of [{ value: () => {}, writable: false, configurable: false },
        { get: () => () => {}, configurable: false }]) {
        const host = {}, errors = [];
        Object.defineProperty(host, "__d", descriptor);
        const observer = createMetroObserver(host, probes, () => {}, () => errors.push(true));
        assert.equal(observer.install(), false);
        assert.equal(observer.install(), false);
        assert.equal(errors.length, 2);
    }
    const c = collector(), host = {};
    let gets = 0, sets = 0, stored = c.define;
    const get = () => { gets++; return stored; };
    const set = value => { sets++; stored = value; };
    Object.defineProperty(host, "__d", { get, set, configurable: true });
    assert.equal(createMetroObserver(host, probes, () => {}).install(), false);
    assert.equal(gets, 0);
    assert.equal(Object.getOwnPropertyDescriptor(host, "__d").get, get);
    assert.equal(Object.getOwnPropertyDescriptor(host, "__d").set, set);
    host.__d = c.define;
    assert.equal(sets, 1);
    assert.equal(host.__d, c.define);
});

test("own apply properties on a callable define or factory never prevent natural execution", () => {
    const c = collector(), host = { __d: c.define }, reports = [];
    c.define.apply = null;
    const factory = function () { return this; };
    factory.apply = null;
    createMetroObserver(host, probes, report => reports.push(report)).install();
    assert.equal(host.__d(factory, 3, []), host);
    const receiver = {};
    assert.equal(c.load(3, {}, receiver).value, receiver);
    assert.equal(reports.length, 1);
    const untouched = () => 77;
    untouched.apply = null;
    host.__d(untouched, 5, []);
    assert.equal(c.definitions.get(5)[0](), 77);
});

test("a delayed decorator failure leaves Metro's original define readable and exceptions isolated", () => {
    const host = {}, original = () => 42;
    let failures = 0;
    assert.equal(interceptMetroDefine(host, () => { throw new Error("decoration"); }, () => { failures++; }), true);
    assert.doesNotThrow(() => { host.__d = original; });
    assert.equal(host.__d, original);
    assert.equal(host.__d(), 42);
    assert.equal(failures, 1);
});

test("trusted read-only capture is limited to one selected ID and isolated from report errors", () => {
    const c = collector(), host = { __d: c.define }, captured = [], exports = { privateValue: "not logged" };
    const metadata = [];
    createMetroObserver(host, [...probes, { name: "Other", id: 4, paths: ["default"] }], report => {
        metadata.push(report);
        throw new Error("report failed");
    }, () => {}, { id: 3, onExports(value) { captured.push(value); throw new Error("consumer failed"); } }).install();
    host.__d(() => 42, 3, []);
    host.__d(() => 19, 4, []);
    assert.equal(c.load(4).value, 19);
    assert.equal(c.load(3, exports).value, 42);
    assert.equal(c.load(3, exports).value, 42);
    assert.deepEqual(captured, [exports]);
    assert.equal(JSON.stringify(metadata).includes("not logged"), false);
    assert.throws(() => createMetroObserver({}, probes, () => {}, () => {}, { id: 999, onExports() {} }), TypeError);
});

test("invalid candidate IDs, duplicate IDs and unbounded/invalid path names are rejected", () => {
    for (const invalid of [[{ ...probes[0], id: -1 }], [probes[0], probes[0]],
        [{ ...probes[0], name: "private data" }], [{ ...probes[0], paths: ["default..secret"] }]]) {
        assert.throws(() => createMetroObserver({}, invalid, () => {}), TypeError);
    }
});
