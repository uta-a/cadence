import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Compile the core in isolation as well as checking the production entry. Do not invoke any module or native API.
test("isolated core modules compile together to HBC98 without executing them", async () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const scratch = mkdtempSync(join(tmpdir(), "cadence-core-hbc-"));
    try {
        const source = join(scratch, "core.js"), hbc = join(scratch, "core.hbc");
        await build({
            stdin: { contents: 'export { createMetroLoader } from "./core/loader"; export { createSettingsStore } from "./core/settings"; export { createNativeSettingsStorage } from "./core/storage";',
                resolveDir: join(root, "src"), loader: "ts" },
            bundle: true, outfile: source, format: "iife", globalName: "CadenceIsolatedCore",
            platform: "neutral", target: "es2019", supported: { class: false }, charset: "ascii", legalComments: "none",
        });
        const platform = { darwin: "osx-bin/hermesc", linux: "linux64-bin/hermesc", win32: "win64-bin/hermesc.exe" }[process.platform];
        assert.ok(platform, "hermes-compiler platform unavailable");
        const compiler = join(root, "node_modules/hermes-compiler/hermesc", platform);
        execFileSync(compiler, ["-emit-binary", "-out", hbc, source]);
        assert.equal(readFileSync(hbc).readUInt32LE(8), 98);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
