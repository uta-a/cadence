import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

const { outputFiles } = await build({ entryPoints: [new URL("../src/core/storage.ts", import.meta.url).pathname],
    bundle: true, format: "cjs", platform: "neutral", target: "es2019", write: false });
const root = "/data/user/0/com.discord/files";
const relative = "disk/settings-v1.json";
const target = `${root}/${relative}`;
function create(native) {
    const sandbox = { module: { exports: {} }, TypeError, Error };
    vm.runInNewContext(outputFiles[0].text, sandbox);
    return sandbox.module.exports.createNativeSettingsStorage(native);
}
function fixture(overrides = {}) {
    const calls = [];
    let stored = null;
    const native = {
        getConstants() { assert.equal(this, native); calls.push(["constants"]); return { DocumentsDirPath: root }; },
        async fileExists(path) { assert.equal(this, native); calls.push(["exists", path]); return stored !== null; },
        async readFile(path, encoding) { assert.equal(this, native); calls.push(["read", path, encoding]); return stored; },
        async writeFile(...args) { assert.equal(this, native); calls.push(["write", ...args]); stored = args[2]; return target; },
        ...overrides,
    };
    return { native, calls };
}

test("adapter does no I/O on creation; missing file reads as null", async () => {
    const { native, calls } = fixture();
    const storage = create(native);
    assert.deepEqual(calls, []);
    assert.equal(await storage.read(), null);
    assert.deepEqual(calls, [["constants"], ["exists", target]]);
});

test("write uses only the fixed Cadence path and verifies UTF-8 text with the original receiver", async () => {
    const { native, calls } = fixture();
    const storage = create(native);
    const content = '{"version":1,"メモ":"設定"}';
    await storage.write(content);
    assert.equal(await storage.read(), content);
    assert.deepEqual(calls, [
        ["constants"], ["write", "documents", relative, content, "utf8"],
        ["read", target, "utf8"], ["exists", target], ["read", target, "utf8"],
    ]);
});

test("shape guard rejects missing native methods", () => {
    for (const value of [null, false, {}, { readFile() {} }]) assert.throws(() => create(value), TypeError);
    for (const name of ["getConstants", "fileExists", "readFile", "writeFile"]) {
        const { native } = fixture({ [name]: null });
        assert.throws(() => create(native), TypeError);
    }
});

test("only validated app-private roots are accepted, before any file I/O", async () => {
    for (const bad of [null, {}, { DocumentsDirPath: "/sdcard" }, { DocumentsDirPath: "../files" },
        { DocumentsDirPath: "file:///data/user/0/com.discord/files" },
        { DocumentsDirPath: "/data/user/0/com.discord/files/../cache" },
        { DocumentsDirPath: "/data/user/0/com.discord/files\n" },
        { DocumentsDirPath: "/data/user/0/another.app/files" },
        Object.create({ DocumentsDirPath: root })]) {
        const { native, calls } = fixture({ getConstants: () => bad });
        const storage = create(native);
        await assert.rejects(storage.read());
        await assert.rejects(storage.write("{}"));
        assert.deepEqual(calls, []);
    }
    for (const allowed of ["/data/data/com.discord/files", "/data/user/10/com.discord/files"]) {
        let requested;
        const { native } = fixture({ getConstants: () => ({ DocumentsDirPath: allowed }),
            fileExists: async path => { requested = path; return false; } });
        assert.equal(await create(native).read(), null);
        assert.equal(requested, `${allowed}/${relative}`);
    }
});

test("resolved native write with stale data or an unexpected result is not a successful save", async () => {
    for (const result of [target, true, undefined, "/sdcard/settings.json"]) {
        let reads = 0;
        const { native } = fixture({ writeFile: async () => result,
            readFile: async () => { reads++; return "old"; } });
        await assert.rejects(create(native).write("new"));
        assert.equal(reads, result === target ? 1 : 0);
    }
});

test("matching final content is accepted but does not prove that rename succeeded", async () => {
    let writes = 0;
    const { native } = fixture({ writeFile: async () => { writes++; return target; },
        readFile: async () => "already stored" });
    // Simulates rename returning false with an identical old file. Only final content is established.
    await create(native).write("already stored");
    assert.equal(writes, 1);
});

test("native rejections and invalid result types are not converted to missing files", async () => {
    const failure = new Error("permission denied");
    for (const method of ["fileExists", "readFile", "writeFile"]) {
        const { native } = fixture({ fileExists: async () => true, [method]: async () => { throw failure; } });
        const storage = create(native);
        await assert.rejects(method === "writeFile" ? storage.write("{}") : storage.read(), error => error === failure);
    }
    for (const value of [null, 0, "false", undefined]) {
        const { native } = fixture({ fileExists: async () => value });
        await assert.rejects(create(native).read(), TypeError);
    }
    for (const value of [undefined, false, {}, "x".repeat(65537)]) {
        const { native } = fixture({ fileExists: async () => true, readFile: async () => value });
        await assert.rejects(create(native).read(), TypeError);
    }
});

test("oversized or non-string writes fail before native I/O", async () => {
    const { native, calls } = fixture();
    const storage = create(native);
    for (const value of [undefined, {}, "x".repeat(65537)]) await assert.rejects(storage.write(value), TypeError);
    assert.deepEqual(calls, []);
});
