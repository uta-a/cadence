import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("runtime revision matches the Gradle bundle version", () => {
    const gradle = readFileSync(new URL("../../gradle.properties", import.meta.url), "utf8");
    const version = /^version\s*=\s*(\S+)\s*$/m.exec(gradle)?.[1];
    const source = readFileSync(new URL("../src/core/version.ts", import.meta.url), "utf8");
    const revision = /REVISION = "([^"]+)"/.exec(source)?.[1];
    assert.ok(version, "gradle.properties has no version");
    assert.equal(revision, version);
});
