import type { SettingsStorage } from "./settings";

// Static 352.17 contract: docs/STORAGE-RESEARCH.md. Not connected to index.ts or any Metro ID.
// The caller must provide the naturally initialized NativeFileModule, never eagerly require it here.
const RELATIVE_PATH = "disk/settings-v1.json";
const MAX_TEXT_LENGTH = 65536;
type NativeMethod = (...args: unknown[]) => unknown;

export function createNativeSettingsStorage(native: unknown): SettingsStorage {
    if (!native || (typeof native !== "object" && typeof native !== "function"))
        throw new TypeError("NativeFileModule object missing");
    const module = native as Record<string, unknown>;
    const methods: Record<string, NativeMethod> = Object.create(null);
    for (const key of ["getConstants", "fileExists", "readFile", "writeFile"]) {
        const method = module[key];
        if (typeof method !== "function") throw new TypeError(`NativeFileModule.${key} missing`);
        methods[key] = method as NativeMethod;
    }
    let absolutePath: string | undefined;

    function path(): string {
        if (absolutePath) return absolutePath;
        const constants = methods.getConstants.call(native);
        if (!constants || typeof constants !== "object" ||
            !Object.prototype.hasOwnProperty.call(constants, "DocumentsDirPath"))
            throw new TypeError("NativeFileModule documents root missing");
        const root = (constants as { DocumentsDirPath?: unknown }).DocumentsDirPath;
        // Fail closed for the pinned package and standard Android private roots; no external/URI/relative paths.
        // Other Android layouts or a renamed package need explicit validation before expanding this guard.
        if (typeof root !== "string" || /^\/data\/(?:user\/[0-9]+|data)\/com\.discord\/files$/.exec(root)?.[0] !== root)
            throw new Error("Unsupported NativeFileModule documents root");
        absolutePath = `${root}/${RELATIVE_PATH}`;
        return absolutePath;
    }

    function text(value: unknown): string {
        if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH)
            throw new TypeError("Invalid disk settings text");
        return value;
    }

    return {
        async read() {
            const target = path();
            const exists = await methods.fileExists.call(native, target);
            if (exists === false) return null;
            if (exists !== true) throw new TypeError("Invalid NativeFileModule fileExists result");
            return text(await methods.readFile.call(native, target, "utf8"));
        },
        async write(value: string) {
            const content = text(value);
            const target = path();
            const result = await methods.writeFile.call(native, "documents", RELATIVE_PATH, content, "utf8");
            if (result !== target) throw new Error("Unexpected NativeFileModule write path");
            // 352.17 syncs a .tmp file but discards renameTo's boolean. A resolved promise is not proof of a save.
            if (text(await methods.readFile.call(native, target, "utf8")) !== content)
                throw new Error("Disk settings read-back mismatch");
        },
    };
}
