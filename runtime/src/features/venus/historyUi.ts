// disk's session-only viewer for the Venus-derived message history feature (GPL-3.0).
import type { ReactApi, NativeUi } from "../../core/ui";
import type { HistorySource } from "./messageHistory";

export function createHistoryPanel(react: ReactApi, resolveNative: () => NativeUi | null, source: HistorySource) {
    const h = (type: unknown, props: unknown, ...children: unknown[]) => react.createElement(type, props, ...children);
    return function DiskHistoryPanel(props: { onClose(): void }): unknown {
        const [entries, setEntries] = react.useState(() => source.list());
        const [limit, setLimit] = react.useState(20);
        react.useEffect(() => {
            const unsubscribe = source.subscribe(() => setEntries(source.list()));
            setEntries(source.list()); return unsubscribe;
        }, []);
        const ui = resolveNative();
        if (!ui) return null;
        const text = (value: string, extra: Record<string, unknown> = {}) => h(ui.Text, {
            style: { color: "#f2f3f5", fontSize: 15 }, ...extra }, value);
        const button = (label: string, action: () => void, accessibilityLabel: string) => h(ui.Pressable, {
            accessibilityRole: "button", accessibilityLabel, onPress: action, style: { minHeight: 48, padding: 16, justifyContent: "center" } }, text(label));
        return h(ui.View, { style: { flex: 1, backgroundColor: "#1e1f22" } },
            h(ui.View, { style: { flexDirection: "row", alignItems: "center", backgroundColor: "#2b2d31" } },
                button("戻る", props.onClose, "disk:history:back"), text("メッセージ履歴", { accessibilityRole: "header" })),
            h(ui.ScrollView, { contentContainerStyle: { padding: 20 } },
                text("この起動中に読み込まれていた本文だけを保持します。再起動・ログアウト・機能オフで消去されます。画像や音声ファイルは保存しません。"),
                text("保持件数: " + entries.length, { accessibilityLabel: "disk:history:count", style: { color: "#b5bac1", marginVertical: 12 } }),
                button("履歴をすべて消去", () => source.clear(), "disk:history:clear"),
                !entries.length ? text("履歴はありません", { accessibilityLabel: "disk:history:empty" }) : null,
                ...entries.slice(0, limit).map((entry, index) => h(ui.View, { key: entry.channelId + ":" + entry.messageId + ":" + index,
                    style: { backgroundColor: "#2b2d31", padding: 16, borderRadius: 10, marginTop: 12 } },
                    text((entry.kind === "deleted" ? "削除" : "編集") + " — " + entry.author),
                    text(new Date(entry.at).toLocaleString(), { style: { color: "#b5bac1", fontSize: 12, marginVertical: 6 } }),
                    text("チャンネルID: " + entry.channelId + "\nメッセージID: " + entry.messageId, { style: { color: "#b5bac1", fontSize: 12 } }),
                    text(entry.kind === "edited" ? "編集前" : "削除前", { style: { color: "#f0b132", marginTop: 12 } }),
                    text(entry.before, { selectable: true }),
                    entry.after !== undefined ? h(ui.View, { style: { marginTop: 12 } }, text("編集後", { style: { color: "#b5bac1" } }), text(entry.after, { selectable: true })) : null,
                    entry.truncated ? text("長文のため一部だけを保持しています", { style: { color: "#b5bac1", marginTop: 8, fontSize: 12 } }) : null)),
                entries.length > limit ? button("さらに20件表示", () => setLimit(value => value + 20), "disk:history:more") : null));
    };
}
