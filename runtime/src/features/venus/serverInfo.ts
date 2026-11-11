// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0),
// bootstrap.js "Server info", commit 987b7a22d96d41a0ba80c060b485291e1c7bcc4b.
// The menu hook is ported; disk uses a compact native dialog with loaded metadata only.
import { wrapExport } from "./gestures";

export interface ServerInfoDeps {
    enabled(): boolean;
    guild(id: string): unknown;
    show(title: string, message: string): boolean;
    onEvent?(event: "installed" | "opened" | "unavailable"): void;
}
function text(value: unknown, limit = 200): string | null {
    return typeof value === "string" && value.length > 0 ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit) : null;
}
function count(value: unknown): string | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
export function serverSnapshot(id: string, guild: unknown): { title: string; message: string } | null {
    if (!/^\d{17,20}$/.test(id) || !guild || typeof guild !== "object") return null;
    try {
        const data = guild as Record<string, unknown>;
        if (data.id !== id) return null;
        const title = text(data.name) ?? "サーバー情報";
        const lines = ["サーバーID: " + id];
        const owner = text(data.ownerId ?? data.owner_id, 20);
        if (owner && /^\d{17,20}$/.test(owner)) lines.push("所有者ID: " + owner);
        const millis = Math.floor(Number(id) / 4194304) + 1420070400000;
        if (Number.isFinite(millis) && millis >= 1420070400000 && millis <= 8640000000000000)
            lines.push("作成日時: " + new Date(millis).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC"));
        const members = count(data.memberCount ?? data.member_count);
        if (members !== null) lines.push("メンバー数: " + members);
        const tier = count(data.premiumTier ?? data.premium_tier);
        if (tier !== null) lines.push("ブーストレベル: " + tier);
        const boosts = count(data.premiumSubscriberCount ?? data.premium_subscription_count);
        if (boosts !== null) lines.push("ブースト数: " + boosts);
        const locale = text(data.preferredLocale ?? data.preferred_locale, 30);
        if (locale) lines.push("言語: " + locale);
        const verification = count(data.verificationLevel ?? data.verification_level);
        if (verification !== null) lines.push("認証レベル: " + verification);
        lines.push("", "読み込み済みの情報です。未取得の項目は表示しません。");
        return { title, message: lines.join("\n") };
    } catch (_) { return null; }
}
export function installServerInfo(exports: unknown, deps: ServerInfoDeps): boolean {
    function report(event: "installed" | "opened" | "unavailable"): void { try { deps.onEvent?.(event); } catch (_) { /* Diagnostics only. */ } }
    try {
        const ok = wrapExport(exports, "default", original => function (this: unknown, ...args: unknown[]) {
            const items = Reflect.apply(original, this, args), id = args[0];
            try {
                if (!deps.enabled() || !Array.isArray(items) || typeof id !== "string" || !/^\d{17,20}$/.test(id)) return items;
                return items.concat([{ label: "サーバー情報", action: () => {
                    if (!deps.enabled()) return;
                    try {
                        const snapshot = serverSnapshot(id, deps.guild(id));
                        report(snapshot && deps.show(snapshot.title, snapshot.message) ? "opened" : "unavailable");
                    } catch (_) { report("unavailable"); }
                } }]);
            } catch (_) { return items; }
        });
        if (ok) report("installed");
        return ok;
    } catch (_) { return false; }
}
