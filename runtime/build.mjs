// Builds src/ into one ASCII-only script that Discord's Hermes can eval, then proves it with the pinned hermesc.
//   node build.mjs [--out <file>]
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf("--out");
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : join(root, "dist", "runtime.js"));

// The bytecode version of Discord's index.android.bundle. hermesc 250829098.x emits it.
const HBC_VERSION = 98;

execFileSync(join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"), ["--noEmit", "-p", root], { stdio: "inherit" });

await build({
    entryPoints: [join(root, "src", "index.ts")],
    outfile: out,
    bundle: true,
    format: "iife",
    platform: "neutral",
    // Discord's Hermes evals this source on the phone. Classes are kept out: Hermes runs them through a slow path
    // or not at all depending on the build, and nothing here needs them.
    target: "es2019",
    supported: { class: false },
    charset: "ascii",
    legalComments: "none",
    minifySyntax: true,
    minifyWhitespace: true,
    // Identifiers stay readable in stack traces and debug logs.
    minifyIdentifiers: false,
    logLevel: "warning",
});

const hermesc = join(root, "node_modules", "hermes-compiler", "hermesc", {
    darwin: "osx-bin/hermesc", linux: "linux64-bin/hermesc", win32: "win64-bin/hermesc.exe",
}[process.platform] ?? "");
const scratch = mkdtempSync(join(tmpdir(), "disk-hbc-"));
try {
    const hbc = join(scratch, "runtime.hbc");
    execFileSync(hermesc, ["-emit-binary", "-out", hbc, out], { stdio: "inherit" });
    const header = Buffer.alloc(12);
    const fd = openSync(hbc, "r");
    readSync(fd, header, 0, 12, 0);
    closeSync(fd);
    const version = header.readUInt32LE(8);
    if (version !== HBC_VERSION) throw new Error(`hermesc emitted HBC${version}, expected HBC${HBC_VERSION}`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
console.log(`disk runtime -> ${out} (HBC${HBC_VERSION} ok)`);
