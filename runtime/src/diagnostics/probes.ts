import type { ModuleProbe } from "./observer";

// Observation candidates only, kept in sync with the static evidence catalog by a test.
// IDs are NOT permission to replace exports or call these methods.
export const MODULE_PROBES: readonly ModuleProbe[] = [
    { name: "RootNavigation", id: 5183, paths: ["getRootNavigationRef"] },
    { name: "SettingsNavigation", id: 7522, paths: ["openUserSettings"] },
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
    { name: "Analytics", id: 1267, paths: ["default", "default.track"] },
    { name: "Avatar", id: 15449, paths: ["default"] },
    { name: "Flux", id: 504, paths: ["useStateFromStores", "useStateFromStoresObject"] },
    { name: "ScreenIcon", id: 9515, paths: ["ScreenIcon"] },
    { name: "MobilePhoneIcon", id: 7085, paths: ["MobilePhoneIcon"] },
    { name: "GlobeEarthIcon", id: 9524, paths: ["GlobeEarthIcon"] },
    { name: "VrHeadsetIcon", id: 16280, paths: ["VrHeadsetIcon"] },
];
