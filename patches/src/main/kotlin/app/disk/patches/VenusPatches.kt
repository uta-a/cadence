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
val doubleTapToReply = venusFeature(
    "gestures", "Double-tap to reply",
    "Double-tap to reply, or to edit your own message; optional triple-tap to delete (a port of Geastures+ by kmmiio99o). " +
        "Off until enabled in the disk settings.",
)

@Suppress("unused")
val loadFullQualityImages = venusFeature(
    "fullImages", "Load full-quality images",
    "Load uploaded pictures and profile pictures in full quality (based on Uncompressed Discord Images by Knewest and " +
        "HighResProfileImages by Kawtious). Off until enabled in the disk settings.",
)

@Suppress("unused")
val serverInformation = venusFeature(
    "serverInfo", "Server info",
    "Show loaded server metadata from the server icon's hold menu. No extra member requests. Off until enabled in the disk settings.",
)

@Suppress("unused")
val downloadVoiceMessages = venusFeature(
    "voiceDownload", "Download voice messages",
    "Add a save button to voice messages using Android's downloader (based on VoiceDownload). Off until enabled in the disk settings.",
)

@Suppress("unused")
val replyWithoutPinging = venusFeature(
    "quietReplies", "Reply without pinging",
    "Start server and group DM replies without a mention; Discord's per-reply toggle stays available. Off until enabled in the disk settings.",
)

@Suppress("unused")
val readAll = venusFeature(
    "readAll", "Read all",
    "Add a button to the server list that marks servers (or, when held, DMs) as read. Off until enabled in the disk settings.",
)

@Suppress("unused")
val skipPinConfirmation = venusFeature(
    "noConfirmPin", "Skip pin confirmation",
    "Pin and unpin without a confirmation (based on NoConfirmPin by Skamt). Off until enabled in the disk settings.",
)
