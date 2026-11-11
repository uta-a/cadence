export const FEATURE_IDS = Object.freeze(["fakeNitro", "platformIndicator", "disableAnalytics", "quickDelete", "noConfirmPin", "alwaysTrust"] as const);
export type BuildFeature = typeof FEATURE_IDS[number];

/** Kotlin replaces the quoted marker with an array literal. Unpatched local/test bundles fail closed to no features. */
export function parseBuildFeatures(value: unknown): readonly BuildFeature[] {
    if (!Array.isArray(value)) return Object.freeze([]);
    const result: BuildFeature[] = [];
    for (const id of value) {
        if (typeof id !== "string" || !FEATURE_IDS.includes(id as BuildFeature) || result.includes(id as BuildFeature))
            return Object.freeze([]);
        result.push(id as BuildFeature);
    }
    return Object.freeze(result);
}
