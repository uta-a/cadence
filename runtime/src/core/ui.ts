import type { SettingsController, SettingsViewState } from "./settings-controller";
import type { BuildFeature } from "./features";
import { getLogs } from "./log";
import { REVISION } from "./version";
import { EMOJI_SIZES, PLATFORM_PLACES, DEFAULT_PLATFORM } from "./settings";
import type { FeatureKey, PlatformPlace } from "./settings";
const PLATFORM_LABELS: Readonly<Record<PlatformPlace, string>> = Object.freeze({ avatars: "その他のアバター", dmList: "DM一覧の行",
    dmHeader: "DMヘッダー", memberList: "メンバー一覧", profile: "プロフィール名", messages: "メッセージの名前" });
const FEATURES: Readonly<Record<FeatureKey, { title: string; description: string }>> = Object.freeze({
    fakeNitro: { title: "Fake Nitro", description: "使えない絵文字とスタンプを画像リンクとして送信します" },
    platformIndicator: { title: "Platform Indicator", description: "接続中のデバイスをアイコンで表示します" },
});

export interface ReactApi {
    Fragment: unknown;
    createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
    useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void];
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
}
export interface NativeUi {
    View: unknown; Text: unknown; Pressable: unknown; ScrollView: unknown; Switch: unknown; Modal: unknown;
    /** Android draws the Modal under the status bar; its height in dp, when React Native reports it. */
    statusBarHeight?: number;
}
/**
 * Discord's own settings components (design/components/TableRow and Button). Each may be missing; a missing one is drawn
 * with plain React Native views instead, so a changed Discord build degrades the look but never the settings themselves.
 */
export interface DiscordUi {
    TableRowGroup?: unknown; TableRow?: unknown; TableSwitchRow?: unknown; TableRadioGroup?: unknown; TableRadioRow?: unknown; Button?: unknown;
}

/** Wrap only Overview. Keep its element mounted; the Cadence page lives in an independent native Modal. */
export function createSettingsOverview(react: ReactApi, resolveNative: () => NativeUi | null, original: unknown,
    controller: SettingsController, onStatus: (status: string) => void = () => {}, navigationReady: () => boolean = () => true,
    features: readonly BuildFeature[] = [], discordUi: () => DiscordUi = () => ({})) {
    const colors = { background: "#1E1F22", surface: "#2B2D31", text: "#F2F3F5", secondary: "#B5BAC1", accent: "#5865F2", warning: "#F0B132" };
    const h = (type: unknown, props: unknown, ...children: unknown[]) => react.createElement(type, props, ...children);
    function report(value: string): void { try { onStatus(value); } catch (_) { /* Diagnostics only. */ } }
    return function CadenceSettingsOverview(props: Record<string, unknown>) {
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
        const ui = discordUi();
        const busy = state.phase !== "ready" || state.save === "saving";
        const text = (value: string, extra: Record<string, unknown> = {}) => h(native.Text,
            { style: { color: colors.text, fontSize: 16 }, ...extra }, value);
        const button = (key: string, label: string, onPress: () => void, variant = "secondary") => ui.Button
            ? h(native.View, { key, style: { marginTop: 12 } }, h(ui.Button, { text: label, onPress, variant, size: "md" }))
            : h(native.Pressable, { key, accessibilityRole: "button", accessibilityLabel: label, onPress,
                style: { padding: 16, minHeight: 48, justifyContent: "center", marginTop: 12, borderRadius: 8, backgroundColor: colors.surface } },
                text(label));
        const group = (key: string, title: string, ...rows: unknown[]) => ui.TableRowGroup
            ? h(native.View, { key, style: { marginTop: 24 } }, h(ui.TableRowGroup, { title }, ...rows))
            : h(native.View, { key, style: { marginTop: 24 } },
                text(title, { accessibilityRole: "header", style: { color: colors.secondary, fontSize: 13, fontWeight: "600", marginBottom: 8 } }),
                h(native.View, { style: { backgroundColor: colors.surface, borderRadius: 12, overflow: "hidden" } }, ...rows));
        const plainRow = (key: string, label: string, subLabel: string | undefined, trailing: unknown) => h(native.View,
            { key, style: { flexDirection: "row", alignItems: "center", padding: 16, minHeight: 56 } },
            h(native.View, { style: { flex: 1 } }, text(label),
                subLabel ? text(subLabel, { style: { color: colors.secondary, fontSize: 14, marginTop: 4 } }) : null), trailing);
        const switchRow = (key: string, label: string, subLabel: string | undefined, value: boolean, onChange: (value: boolean) => void) =>
            ui.TableSwitchRow ? h(ui.TableSwitchRow, { key, label, subLabel, value, disabled: busy, onValueChange: onChange })
                : plainRow(key, label, subLabel, h(native.Switch, { accessibilityLabel: label, value, disabled: busy,
                    trackColor: { false: "#4E5058", true: colors.accent }, onValueChange: onChange }));
        const infoRow = (key: string, label: string, subLabel?: string, onPress?: () => void) => ui.TableRow
            ? h(ui.TableRow, { key, label, subLabel, onPress, arrow: !!onPress })
            : onPress ? h(native.Pressable, { key, accessibilityRole: "button", accessibilityLabel: label, onPress },
                plainRow(key, label, subLabel, null)) : plainRow(key, label, subLabel, null);
        const status = state.phase === "loading" ? "設定を読み込んでいます" : state.phase === "error" ? "設定を読み込めません。書き込みは停止しています。" :
            state.save === "saving" ? "保存中…" : state.save === "error" ? "保存できませんでした。再試行してください。" :
            state.save === "saved" ? "保存しました" : "設定はこの端末内に保存されます";
        const feature = (id: FeatureKey) => features.includes(id)
            ? switchRow(id, FEATURES[id].title, FEATURES[id].description, state.features[id] === true,
                value => { void controller.setFeature(id, value).catch(() => {}); })
            : infoRow(id, FEATURES[id].title, "このビルドには含まれていません");
        const sizes = () => ui.TableRadioGroup && ui.TableRadioRow
            ? h(native.View, { key: "nitro-size", style: { marginTop: 24 } }, h(ui.TableRadioGroup, { title: "絵文字の画像サイズ", value: state.nitro.emojiSize,
                onChange: (size: unknown) => { void controller.setNitro({ emojiSize: size as typeof EMOJI_SIZES[number] }).catch(() => {}); } },
                ...EMOJI_SIZES.map(size => h(ui.TableRadioRow, { key: String(size), label: `${size}px`, value: size, disabled: busy }))))
            : group("nitro-size", "絵文字の画像サイズ", ...EMOJI_SIZES.map(size => switchRow(`size-${size}`, `${size}px`, undefined,
                state.nitro.emojiSize === size, on => { if (on) void controller.setNitro({ emojiSize: size }).catch(() => {}); })));
        const platformOn = features.includes("platformIndicator") && state.features.platformIndicator === true;
        const page = h(native.View, { style: { flex: 1, backgroundColor: colors.background } },
            h(native.View, { style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 12,
                paddingTop: 12 + (native.statusBarHeight ?? 0), gap: 12, backgroundColor: colors.surface } },
                ui.Button ? h(ui.Button, { text: "戻る", onPress: () => setOpen(false), variant: "secondary", size: "sm" })
                    : h(native.Pressable, { accessibilityRole: "button", accessibilityLabel: "戻る", onPress: () => setOpen(false),
                        style: { padding: 12, minHeight: 48, justifyContent: "center" } }, text("戻る")),
                text("Cadence", { accessibilityRole: "header", style: { color: colors.text, fontSize: 20, fontWeight: "600" } })),
            h(native.ScrollView, { contentContainerStyle: { padding: 16, paddingBottom: 48 }, style: { flex: 1 } },
                text(status, { accessibilityLiveRegion: "polite",
                    style: { color: state.phase === "error" || state.save === "error" ? colors.warning : colors.secondary, fontSize: 14 } }),
                state.phase === "error" ? button("retry-load", "読み込みを再試行", () => { void controller.retryLoad(); }, "primary") : null,
                state.save === "error" ? button("retry-save", "保存を再試行", () => { void controller.retrySave().catch(() => {}); }, "primary") : null,
                group("messages", "メッセージ", feature("fakeNitro")),
                features.includes("fakeNitro") ? sizes() : null,
                group("display", "表示", feature("platformIndicator")),
                platformOn ? group("platform-places", "端末アイコンを出す場所", ...PLATFORM_PLACES.map(place => switchRow(place, PLATFORM_LABELS[place],
                    place === "messages" ? "名前横のタグ枠にアイコンを2つまで表示します。変更後はチャンネルを開き直してください" : undefined, (state.platform ?? DEFAULT_PLATFORM)[place],
                    value => { void controller.setPlatform(place, value).catch(() => {}); }))) : null,
                group("privacy", "プライバシー", infoRow("analytics", "Analytics の送信停止",
                    features.includes("disableAnalytics") ? "JS の track 送信を止めています（Morphe で選択）" : "このビルドには含まれていません")),
                group("about", "情報",
                    infoRow("version", `Cadence ${REVISION}`, `Discord 352.17 / 組み込み機能: ${features.length ? features.join(", ") : "なし"}`),
                    infoRow("logs", showLogs ? "診断ログを閉じる" : "診断ログを表示", "アカウント情報やメッセージは含みません",
                        () => setShowLogs(value => !value))),
                showLogs ? text(getLogs().join("\n") || "ログはありません", { selectable: true,
                    style: { color: colors.secondary, fontSize: 12, fontFamily: "monospace", marginTop: 12 } }) : null));
        return h(react.Fragment, null, originalElement,
            h(native.View, { key: "cadence-entry", style: { display: open ? "none" : "flex", paddingHorizontal: 16, paddingBottom: 24 } },
                ui.TableRowGroup && ui.TableRow ? h(ui.TableRowGroup, {},
                    h(ui.TableRow, { label: "Cadence", subLabel: "Fake Nitro・端末表示", onPress: () => setOpen(true), arrow: true }))
                    : h(native.Pressable, { accessibilityRole: "button", accessibilityLabel: "Cadence", onPress: () => setOpen(true),
                        style: { padding: 16, minHeight: 48, justifyContent: "center", borderRadius: 12, backgroundColor: colors.surface } },
                        text("Cadence"))),
            h(native.Modal, { key: "cadence-modal", visible: open, animationType: "slide", onRequestClose: () => setOpen(false) }, page));
    };
}
