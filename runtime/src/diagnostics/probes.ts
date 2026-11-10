import type { ModuleProbe } from "./observer";

// Observation candidates only, kept in sync with the static evidence catalog by a test.
// IDs are NOT permission to replace exports or call these methods.
export const MODULE_PROBES: readonly ModuleProbe[] = [
    { name: "React", id: 19, paths: ["createElement", "useState", "useMemo", "version"] },
    { name: "ReactNative", id: 17, paths: ["View", "StyleSheet", "AppRegistry", "TurboModuleRegistry"] },
    { name: "RNInit", id: 244, paths: ["AppRegistry", "AppRegistry.registerComponent", "AppRegistry.runApplication"] },
    { name: "SettingsRegistry", id: 15865, paths: ["SETTING_RENDERER_CONFIG"] },
    { name: "SettingsScreens", id: 16016, paths: ["getSettingScreens", "toSettingListItems"] },
    { name: "SettingsOverview", id: 18400, paths: ["default"] },
    { name: "SettingsListRenderer", id: 16013, paths: ["SearchableSettingsList", "SettingsList"] },
    { name: "FileModule", id: 1164, paths: ["default", "default.getConstants", "default.fileExists", "default.readFile", "default.writeFile"] },
    { name: "FileStorageUtils", id: 8728, paths: ["readFile", "writeFile"] },
    { name: "PresenceStore", id: 5744, paths: ["default", "default.getClientStatus", "default.getStatus"] },
    { name: "EmojiStore", id: 6757, paths: ["default", "default.getCustomEmojiById", "default.getUsableGuildEmoji"] },
    { name: "MessageActions", id: 7598, paths: ["default", "default.sendMessage"] },
];
