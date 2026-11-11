// Adapted from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0),
// bootstrap.js hiddenMetadata/hiddenDirectory/hiddenDetails, commit
// 987b7a22d96d41a0ba80c060b485291e1c7bcc4b.
// disk deliberately does NOT patch PermissionStore or the native channel directory. Loaded metadata
// is shown in a read-only server-menu dialog, with no navigation or message/voice actions.
import { wrapExport } from "./gestures";

interface HiddenChannel { id: string; name: string; type: number; position: number }
export interface HiddenSnapshot { channels: HiddenChannel[]; checked: number; unknown: number; truncated: boolean }
export interface HiddenChannelsDeps {
    enabled(): boolean;
    tables(guildId: string): { full?: unknown; basic?: unknown } | null;
    canView(channel: unknown, basic: boolean): unknown;
    show(title: string, body: string): boolean;
    onEvent?(event: "installed" | "opened" | "unavailable"): void;
}
const TYPES = new Set([0, 2, 4, 5, 13, 15, 16]);
const TYPE_LABELS: Record<number, string> = { 0: "テキスト", 2: "ボイス", 4: "カテゴリ", 5: "アナウンス", 13: "ステージ", 15: "フォーラム", 16: "メディア" };
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function hiddenSnapshot(guildId: string, tables: { full?: unknown; basic?: unknown } | null,
    canView: (channel: unknown, basic: boolean) => unknown): HiddenSnapshot | null {
    if (!/^\d{17,20}$/.test(guildId) || !tables || (!object(tables.full) && !object(tables.basic))) return null;
    const records = new Map<string, { channel: unknown; basic: boolean }>();
    let truncated = false, unknown = 0;
    // Full records win over basic metadata. Inspect at most 2,000 entries per table, with no API requests.
    for (const [table, basic] of [[tables.basic, true], [tables.full, false]] as const) {
        if (!object(table)) continue;
        const keys = Object.keys(table);
        if (keys.length > 2000) truncated = true;
        for (const key of keys.slice(0, 2000)) {
            const descriptor = Object.getOwnPropertyDescriptor(table, key);
            if (!descriptor || !("value" in descriptor)) { unknown++; continue; }
            records.set(key, { channel: descriptor.value, basic });
        }
    }
    const channels: HiddenChannel[] = [];
    let checked = 0;
    for (const [id, { channel, basic }] of records) {
        try {
            if (!object(channel) || channel.guild_id !== guildId || channel.id !== id || !/^\d{17,20}$/.test(id)
                || typeof channel.type !== "number" || !TYPES.has(channel.type)) continue;
            const visible = canView(channel, basic);
            if (visible !== true && visible !== false) { unknown++; continue; }
            checked++;
            if (visible) continue;
            const name = typeof channel.name === "string" && channel.name.length ? channel.name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80) : "名前未取得";
            const position = typeof channel.position === "number" && Number.isFinite(channel.position) ? channel.position : 0;
            channels.push({ id, name, type: channel.type, position });
        } catch (_) { unknown++; }
    }
    channels.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    return { channels, checked, unknown, truncated };
}
export function hiddenDescription(snapshot: HiddenSnapshot): string {
    const lines = snapshot.channels.length ? snapshot.channels.slice(0, 40).map(channel =>
        "🔒 " + channel.name + " — " + TYPE_LABELS[channel.type] + "\nID: " + channel.id) : ["読み込み済みの範囲で非表示と判定されたチャンネルはありません。"];
    if (snapshot.channels.length > 40) lines.push("ほか " + (snapshot.channels.length - 40) + " 件。表示は40件までです。");
    if (snapshot.truncated) lines.push("件数が多いため一部だけを確認しています。");
    if (snapshot.unknown) lines.push("権限を判定できない項目: " + snapshot.unknown);
    lines.push("", "端末にある情報のみを表示しています。名前が未取得のこともあります。履歴の取得やチャンネルへの移動はしません。");
    return lines.join("\n\n");
}
export function installHiddenChannels(exports: unknown, deps: HiddenChannelsDeps): boolean {
    function report(event: "installed" | "opened" | "unavailable"): void { try { deps.onEvent?.(event); } catch (_) { /* Diagnostics only. */ } }
    try {
        const ok = wrapExport(exports, "default", original => function (this: unknown, ...args: unknown[]) {
            const items = Reflect.apply(original, this, args), guildId = args[0];
            try {
                if (!deps.enabled() || !Array.isArray(items) || typeof guildId !== "string" || !/^\d{17,20}$/.test(guildId)) return items;
                return items.concat([{ label: "非表示チャンネル", action: () => {
                    if (!deps.enabled()) return;
                    try {
                        const snapshot = hiddenSnapshot(guildId, deps.tables(guildId), deps.canView);
                        if (!snapshot) { report("unavailable"); return; }
                        report(deps.show("非表示チャンネル — 読み取り専用", hiddenDescription(snapshot)) ? "opened" : "unavailable");
                    } catch (_) { report("unavailable"); }
                } }]);
            } catch (_) { return items; }
        });
        if (ok) report("installed");
        return ok;
    } catch (_) { return false; }
}
