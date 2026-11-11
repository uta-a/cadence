package app.disk.patches

import app.morphe.patcher.patch.rawResourcePatch

// Features ported from Venus Patches (GPL-3.0; docs/VENUS-PORT.md, NOTICE). Each one is only embedded in the
// runtime when selected here, and stays off until enabled in Discord's disk settings.

private fun venusFeature(id: String, name: String, description: String) = rawResourcePatch(
    name = name,
    description = description,
    default = true,
) {
    compatibleWith(discord)
    dependsOn(diskRuntime)
    execute { BuildFeatures.select(this, id) }
}

@Suppress("unused")
val skipDeleteConfirmation = venusFeature(
    "quickDelete", "Skip delete confirmation",
    "Delete messages without the \"Are you sure?\" alert. Off until enabled in the disk settings.",
)

@Suppress("unused")
val alwaysTrustLinksAndFiles = venusFeature(
    "alwaysTrust", "Always trust links and files",
    "Open links and files without Discord's warnings (based on AlwaysTrust by zt and Trwy). Off until enabled in the disk settings.",
)

@Suppress("unused")
val jumpToFirstMessage = venusFeature(
    "jumpToTop", "Jump to first message",
    "A button to jump to the start of any chat. Off until enabled in the disk settings.",
)

@Suppress("unused")
val skipPinConfirmation = venusFeature(
    "noConfirmPin", "Skip pin confirmation",
    "Pin and unpin without a confirmation (based on NoConfirmPin by Skamt). Off until enabled in the disk settings.",
)
