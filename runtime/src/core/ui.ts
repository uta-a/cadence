import type { SettingsController, SettingsViewState } from "./settings-controller";
import type { BuildFeature } from "./features";
import { getLogs } from "./log";
import { EMOJI_SIZES } from "./settings";
import type { FeatureKey } from "./settings";

const FEATURE_ROWS: ReadonlyArray<{ id: FeatureKey; title: string; description: string }> = Object.freeze([
    { id: "fakeNitro", title: "Fake Nitro", description: "使えない絵文字を画像リンクとして送信します" },
    { id: "platformIndicator", title: "Platform Indicator", description: "アバターに接続中のデバイスを表示します" },
]);

export interface ReactApi {
    Fragment: unknown;
    createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
    useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void];
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
}
export interface NativeUi { View: unknown; Text: unknown; Pressable: unknown; ScrollView: unknown; Switch: unknown; Modal: unknown; }

/** Wrap only Overview. Keep its element mounted; the disk page lives in an independent native Modal. */
export function createSettingsOverview(react: ReactApi, resolveNative: () => NativeUi | null, original: unknown,
    controller: SettingsController, onStatus: (status: string) => void = () => {}, navigationReady: () => boolean = () => true,
    features: readonly BuildFeature[] = []) {
    const colors = { background: "#1E1F22", surface: "#2B2D31", text: "#F2F3F5", secondary: "#B5BAC1", accent: "#5865F2", warning: "#F0B132" };
    const h = (type: unknown, props: unknown, ...children: unknown[]) => react.createElement(type, props, ...children);
    function report(value: string): void { try { onStatus(value); } catch (_) { /* Diagnostics only. */ } }
    return function DiskSettingsOverview(props: Record<string, unknown>) {
        const [open, setOpen] = react.useState(false);
        const [showLogs, setShowLogs] = react.useState(false);
        const [state, setState] = react.useState<SettingsViewState>(() => controller.get());
        const [ready, setReady] = react.useState(() => navigationReady());
        react.useEffect(() => {
            const unsubscribe = controller.subscribe(() => setState(controller.get()));
            // A load/save may complete between initial render and effect subscription.
            setState(controller.get());
            return unsubscribe;
        }, [controller]);
        react.useEffect(() => {
            if (ready) return;
            let disposed = false, attempts = 0, timer: unknown;
            const check = () => {
                if (disposed) return;
                if (navigationReady()) { setReady(true); return; }
                if (typeof globalThis.setTimeout === "function") {
                    // One outstanding timer while mounted; slow down after the initial window rather than losing late readiness.
                    timer = globalThis.setTimeout(check, ++attempts < 40 ? 250 : 2000);
                } else report("unavailable");
            };
            check();
            return () => { disposed = true; if (typeof globalThis.clearTimeout === "function") globalThis.clearTimeout(timer); };
        }, [ready]);
        react.useEffect(() => { if (open) report("visible"); }, [open]);
        // The wrapper was installed before its first consumer, but no RN lazy getter is evaluated before readiness.
        const native = ready ? resolveNative() : null;
        const originalElement = h(original, { ...props, key: "discord-overview" });
        if (!native) return h(react.Fragment, null, originalElement);
        const compact = state.preferences.compact;
        const spacing = compact ? 12 : 20;
        const text = (value: string, extra: Record<string, unknown> = {}) => h(native.Text,
            { style: { color: colors.text, fontSize: 16 }, ...extra }, value);
        const button = (label: string, onPress: () => void, accessibilityLabel = label) => h(native.Pressable,
            { accessibilityRole: "button", accessibilityLabel, onPress,
                style: { padding: spacing, minHeight: 48, justifyContent: "center" } }, text(label));
        const status = state.phase === "loading" ? "設定を読み込んでいます" : state.phase === "error" ? "設定を読み込めません。書き込みは停止しています。" :
            state.save === "saving" ? "保存中…" : state.save === "error" ? "保存できませんでした。再試行してください。" :
            state.save === "saved" ? "保存しました" : "設定はこの端末内に保存されます";
        const page = h(native.View, { style: { flex: 1, backgroundColor: colors.background } },
            h(native.View, { style: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface } },
                button("戻る", () => setOpen(false), "disk:back"), text("disk 設定", { accessibilityRole: "header", style: { color: colors.text, fontSize: 20, fontWeight: "600" } })),
            h(native.ScrollView, { contentContainerStyle: { padding: spacing }, style: { flex: 1 } },
                text("表示", { accessibilityRole: "header", style: { color: colors.text, fontSize: 18, fontWeight: "600", marginBottom: spacing } }),
                h(native.View, { style: { backgroundColor: colors.surface, padding: spacing, borderRadius: 12, flexDirection: "row", alignItems: "center" } },
                    h(native.View, { style: { flex: 1 } }, text("コンパクト表示"),
                        text(compact ? "オン" : "オフ", { accessibilityLabel: `disk:compact:${compact}`, style: { color: colors.secondary, fontSize: 14, marginTop: 4 } })),
                    h(native.Switch, { accessibilityLabel: "disk:compact", value: compact,
                        disabled: state.phase !== "ready" || state.save === "saving", trackColor: { false: "#4E5058", true: colors.accent },
                        onValueChange: (value: boolean) => { void controller.setCompact(value).catch(() => {}); } })),
                text(status, { accessibilityLabel: state.save === "saved" ? "disk:saved" : "disk:status", accessibilityLiveRegion: "polite",
                    style: { color: state.phase === "error" || state.save === "error" ? colors.warning : colors.secondary, fontSize: 14, marginTop: spacing } }),
                state.phase === "error" ? button("読み込みを再試行", () => { void controller.retryLoad(); }) : null,
                state.save === "error" ? button("保存を再試行", () => { void controller.setCompact(compact).catch(() => {}); }) : null,
                text("機能", { accessibilityRole: "header", style: { color: colors.text, fontSize: 18, fontWeight: "600", marginTop: spacing * 2 } }),
                ...FEATURE_ROWS.map(row => {
                    const built = features.includes(row.id);
                    const on = built && state.features[row.id] === true;
                    return h(native.View, { key: row.id, style: { backgroundColor: colors.surface, padding: spacing, borderRadius: 12,
                        flexDirection: "row", alignItems: "center", marginTop: spacing } },
                        h(native.View, { style: { flex: 1 } }, text(row.title),
                            text(built ? row.description : "このビルドには含まれていません",
                                { accessibilityLabel: `disk:feature:${row.id}:${on}`, style: { color: colors.secondary, fontSize: 14, marginTop: 4 } })),
                        built ? h(native.Switch, { accessibilityLabel: `disk:feature:${row.id}`, value: on,
                            disabled: state.phase !== "ready" || state.save === "saving", trackColor: { false: "#4E5058", true: colors.accent },
                            onValueChange: (value: boolean) => { void controller.setFeature(row.id, value).catch(() => {}); } }) : null);
                }),
                features.includes("fakeNitro") ? h(native.View, { key: "nitro-options", style: { backgroundColor: colors.surface,
                    padding: spacing, borderRadius: 12, marginTop: spacing } },
                    text("Fake Nitro の画像サイズ"),
                    h(native.View, { style: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 } },
                        ...EMOJI_SIZES.map(size => {
                            const selected = state.nitro.emojiSize === size;
                            return h(native.Pressable, { key: String(size), accessibilityRole: "button",
                                accessibilityLabel: `disk:nitro-size:${size}`, accessibilityState: { selected },
                                disabled: state.phase !== "ready" || state.save === "saving",
                                onPress: () => { void controller.setNitro({ emojiSize: size }).catch(() => {}); },
                                style: { paddingHorizontal: 14, minHeight: 40, justifyContent: "center", marginRight: 8, marginTop: 4,
                                    borderRadius: 8, backgroundColor: selected ? colors.accent : "#3F4147" } },
                                text(String(size), { style: { color: colors.text, fontSize: 14 } }));
                        })),
                    h(native.View, { style: { flexDirection: "row", alignItems: "center", marginTop: spacing } },
                        h(native.View, { style: { flex: 1 } }, text("名前付きリンク"),
                            text(state.nitro.maskedLinks ? "[name](URL) の形で送信" : "URL をそのまま送信",
                                { accessibilityLabel: `disk:nitro-masked:${state.nitro.maskedLinks}`, style: { color: colors.secondary, fontSize: 14, marginTop: 4 } })),
                        h(native.Switch, { accessibilityLabel: "disk:nitro-masked", value: state.nitro.maskedLinks,
                            disabled: state.phase !== "ready" || state.save === "saving", trackColor: { false: "#4E5058", true: colors.accent },
                            onValueChange: (value: boolean) => { void controller.setNitro({ maskedLinks: value }).catch(() => {}); } }))) : null,
                text(features.includes("disableAnalytics") ? "Analytics：JS の track 送信を停止しています（Morphe で選択）" : "Analytics：このビルドでは停止していません",
                    { accessibilityLabel: "disk:feature:disableAnalytics", style: { color: colors.secondary, fontSize: 14, marginTop: spacing } }),
                text("情報", { accessibilityRole: "header", style: { color: colors.text, fontSize: 18, fontWeight: "600", marginTop: spacing * 2 } }),
                text("disk 0.0.1 / Discord 352.17", { style: { color: colors.secondary, fontSize: 14, marginTop: spacing } }),
                text(`組み込み機能: ${features.length ? features.join(", ") : "なし"}`, { accessibilityLabel: "disk:features", style: { color: colors.secondary, fontSize: 14, marginTop: 8 } }),
                text("アカウント情報やメッセージは保存しません。", { style: { color: colors.secondary, fontSize: 14, marginTop: 8 } }),
                button(showLogs ? "診断ログを閉じる" : "診断ログを表示", () => setShowLogs(value => !value), "disk:logs"),
                showLogs ? text(getLogs().join("\n") || "ログはありません", { accessibilityLabel: "disk:log-content", selectable: true,
                    style: { color: colors.secondary, fontSize: 12, fontFamily: "monospace" } }) : null));
        return h(react.Fragment, null, originalElement,
            h(native.View, { key: "disk-entry", style: { display: open ? "none" : "flex", backgroundColor: colors.surface, borderTopWidth: 1, borderColor: "#3F4147" } },
                button("disk", () => setOpen(true))),
            h(native.Modal, { key: "disk-modal", visible: open, animationType: "slide", onRequestClose: () => setOpen(false) }, page));
    };
}
