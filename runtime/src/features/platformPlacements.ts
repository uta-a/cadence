// Ported from Venus Patches (https://github.com/VenusIsJaded/Venus-Patches, GPL-3.0),
// bootstrap.js platformName/platformHeader/platformDmRow/placePlatformTree, commit
// 987b7a22d96d41a0ba80c060b485291e1c7bcc4b. Adapted to 352.17 and Cadence's badges/settings.
import type { AvatarReact } from "./platformIndicator";
import { platformsOf } from "./platformIndicator";
import { platformIcon } from "./platformImage";
import type { PlatformPlace } from "../core/settings";
import { wrapExport } from "../core/exports";

type Fn = (...args: unknown[]) => unknown;
type Place = Exclude<PlatformPlace, "avatars" | "messages">;
interface TreeReact extends AvatarReact { cloneElement(node: unknown, props: unknown): unknown }
export interface PlatformPlacementDeps {
    react: TreeReact;
    native(): { View: unknown; Text: unknown } | null;
    enabled(place: PlatformPlace): boolean;
    subscribe(listener: () => void): () => void;
    channel(id: string): unknown;
    status(userId: string): unknown;
    badge(place: Place): unknown;
    provider: unknown;
    onEvent?(place: PlatformPlace): void;
}
/** A zero-width space: the chip needs some text to be drawn, but only the icon should show. */
const CHIP_TEXT = "\u200b";
/** The server tag chip is drawn only with a guild ID; tapping it opens nothing for an unknown guild. */
const CHIP_GUILD = "0";
const ROW_STYLE = { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 };
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
function data(value: unknown, key: string): unknown {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
}
export function createPlatformPlacements(deps: PlatformPlacementDeps) {
    const h = (type: unknown, props: unknown, ...children: unknown[]) => deps.react.createElement(type, props, ...children);
    const reports = new Set<string>();
    const transformed = new WeakSet<object>();
    function report(place: PlatformPlace): void {
        if (reports.has(place)) return;
        reports.add(place);
        try { deps.onEvent?.(place); } catch (_) { /* Diagnostics only. */ }
    }
    function userId(props: Record<string, unknown>): string | undefined {
        const user = props.user;
        if (object(user) && typeof user.id === "string") return user.id;
        if (typeof props.userId === "string") return props.userId;
        const channel = props.channel ?? (typeof props.channelId === "string" ? deps.channel(props.channelId) : undefined);
        if (object(channel) && channel.type === 1 && Array.isArray(channel.recipients) && channel.recipients.length === 1
            && typeof channel.recipients[0] === "string") return channel.recipients[0];
        return undefined;
    }
    function badgeRow(node: unknown, id: string, place: Place, View: unknown): unknown {
        return h(View, { key: "cadence-platform-name", style: ROW_STYLE }, node, h(deps.badge(place), { userId: id }));
    }
    /** Bounded immutable traversal. Never calls a child component or inserts a View inside an RN Text. */
    function placeTree(tree: unknown, props: Record<string, unknown>, place: Place, direct: boolean): unknown {
        if (!deps.enabled(place)) return tree;
        const ui = deps.native(), id = userId(props);
        if (!ui || !id || !tree) return tree;
        if (direct) { report(place); return badgeRow(tree, id, place, ui.View); }
        let added = false, budget = 200;
        function visit(node: unknown, depth: number): unknown {
            if (!node || depth > 18 || --budget < 0 || added) return node;
            if (Array.isArray(node)) {
                if (node.length > 200) return node;
                const next = node.map(child => visit(child, depth + 1));
                return next.some((child, i) => child !== node[i]) ? next : node;
            }
            if (!object(node) || !object(node.props)) return node;
            const p = node.props;
            if (node.type === ui!.Text) return node;
            // The DM header owns a private ChannelTitle function; transform it only when React renders it.
            if (place === "dmHeader" && typeof node.type === "function" && typeof p.userId === "string"
                && "accessibleTitle" in p && "title" in p) {
                added = true;
                return h(cachedHeader(node.type as Fn), { ...p, key: node.key });
            }
            if (p.label != null && typeof p.label !== "string" && typeof p.label !== "number") {
                added = true;
                return deps.react.cloneElement(node, { label: badgeRow(p.label, id!, place, ui!.View) });
            }
            const children = Array.isArray(p.children) ? p.children : [p.children];
            const title = children.find(child => object(child) && object(child.props) &&
                ((child.type === ui!.Text && typeof child.props.children === "string")
                || (typeof child.props.variant === "string" && /(?:channel-title|heading|semibold)/.test(child.props.variant))
                || (typeof child.props.userName === "string" && "userId" in child.props)));
            if (title) {
                added = true;
                return deps.react.cloneElement(node, { children: children.map(child => child === title ? badgeRow(child, id!, place, ui!.View) : child) });
            }
            const next = visit(p.children, depth + 1);
            return next === p.children ? node : deps.react.cloneElement(node, { children: next });
        }
        const result = visit(tree, 0);
        if (added) report(place);
        return result;
    }
    const headers = new WeakMap<Fn, Fn>();
    function cachedHeader(original: Fn): Fn {
        let wrapped = headers.get(original);
        if (!wrapped) { wrapped = renderer(original, "dmHeader", true); headers.set(original, wrapped); }
        return wrapped;
    }
    function renderer(original: Fn, place: Place, direct = false): Fn {
        return function CadencePlatformPlacement(this: unknown, ...args: unknown[]): unknown {
            // Always run the original with all of its hooks, receiver and arguments.
            const tree = Reflect.apply(original, this, args);
            const [, redraw] = deps.react.useState(0);
            deps.react.useEffect(() => {
                let revision = 0;
                return deps.subscribe(() => redraw(++revision));
            }, []);
            try {
                const props = object(args[0]) ? args[0] : {};
                const result = placeTree(tree, props, place, direct);
                // Location off must also hide generic avatars inside it; an unrecognized enabled tree keeps the fallback.
                return h(deps.provider, { value: !deps.enabled(place) || result !== tree }, result);
            } catch (_) { return tree; }
        };
    }
    function component(original: unknown, place: Place): unknown {
        if (typeof original === "function") {
            if (object(original.prototype) && typeof original.prototype.render === "function") return null;
            return renderer(original as Fn, place);
        }
        if (!object(original)) return null;
        for (const key of ["type", "render"]) {
            const fn = data(original, key);
            if (typeof fn !== "function" || (object(fn.prototype) && typeof fn.prototype.render === "function")) continue;
            const descriptors = Object.getOwnPropertyDescriptors(original);
            descriptors[key] = { ...descriptors[key], value: renderer(fn as Fn, place) };
            return Object.defineProperties({}, descriptors);
        }
        return null;
    }
    function install(exports: unknown, place: Place, key = "default"): boolean {
        if (!object(exports)) return false;
        try {
            const descriptor = Object.getOwnPropertyDescriptor(exports, key);
            if (!descriptor || !("value" in descriptor) || (!descriptor.writable && !descriptor.configurable)) return false;
            const replacement = component(descriptor.value, place);
            if (!replacement) return false;
            Object.defineProperty(exports, key, { ...descriptor, value: replacement });
            return true;
        } catch (_) { return false; }
    }
    /** Layout-free scope around sibling avatars and name content in a known placement. */
    function installScope(exports: unknown, key = "default"): boolean {
        try {
            if (!object(exports)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(exports, key);
            if (!descriptor || !("value" in descriptor) || (!descriptor.writable && !descriptor.configurable)) return false;
            const original = descriptor.value;
            if (typeof original !== "function" && (!object(original) || (!data(original, "type") && !data(original, "render")))) return false;
            function CadencePlatformScope(props: unknown): unknown { return h(deps.provider, { value: true }, h(original, props)); }
            Object.defineProperty(exports, key, { ...descriptor, value: CadencePlatformScope });
            return true;
        } catch (_) { return false; }
    }
    /** ProfilePrimaryInfo captures DisplayName locally, so also replace its specific child element type. */
    function installProfile(exports: unknown): boolean {
        try {
            const original = data(exports, "DisplayName");
            if (typeof original !== "function") return false;
            const wrapped = renderer(original as Fn, "profile", true);
            if (!wrapExport(exports, "DisplayName", () => wrapped)) return false;
            return wrapExport(exports, "default", base => function (this: unknown, ...args: unknown[]) {
                const tree = Reflect.apply(base, this, args);
                let budget = 200;
                function visit(node: unknown, depth: number): unknown {
                    if (!node || depth > 18 || --budget < 0) return node;
                    if (Array.isArray(node)) {
                        if (node.length > 200) return node;
                        const next = node.map(child => visit(child, depth + 1));
                        return next.some((child, i) => child !== node[i]) ? next : node;
                    }
                    if (!object(node) || !object(node.props)) return node;
                    if (node.type === original) return h(wrapped, { ...node.props, key: node.key });
                    const children = visit(node.props.children, depth + 1);
                    return children === node.props.children ? node : deps.react.cloneElement(node, { children });
                }
                try { return visit(tree, 0); } catch (_) { return tree; }
            });
        } catch (_) { return false; }
    }
    function messageRow(result: unknown, row: unknown): unknown {
        try {
            if (!deps.enabled("messages") || !object(result) || transformed.has(result) || !object(result.message)
                || !object(row) || row.rowType !== 1) return result;
            const message = result.message;
            if (typeof message.username !== "string" || message.username.length > 256 || typeof message.authorId !== "string") return result;
            const states = platformsOf(deps.status(message.authorId));
            if (!states.length) return result;
            // The native row only draws images in its two tag chips: the server tag (clan) and the lobby tag. Each free chip
            // shows one platform icon with no text; a chip the author really uses keeps their own tag.
            const icons: Record<string, unknown> = {};
            let index = 0;
            if (!(typeof message.clanTag === "string" && message.clanTag)) {
                const icon = platformIcon(states[index++]);
                if (icon) Object.assign(icons, { clanTag: CHIP_TEXT, clanBadgeUrl: icon, clanTagGuildId: CHIP_GUILD });
            }
            if (states[index] && !(typeof message.lobbyAdditionalName === "string" && message.lobbyAdditionalName)) {
                const icon = platformIcon(states[index]);
                if (icon) Object.assign(icons, { lobbyAdditionalName: CHIP_TEXT, lobbyTagIconUrl: icon });
            }
            if (!Object.keys(icons).length) return result;
            const next = { ...result, message: { ...message, ...icons } };
            transformed.add(next); report("messages");
            return next;
        } catch (_) { return result; }
    }
    /**
     * The server tag chip opens the guild's profile on tap. Discord builds MessagesHandlers per chat and defines the
     * handler on each instance, so wrap the constructor and let only taps on Cadence's own chips (guild "0") do nothing.
     */
    function installChipTaps(exports: unknown, eventData: () => unknown): boolean {
        try {
            return wrapExport(exports, "MessagesHandlers", original => {
                const Original = original as unknown as new (...args: unknown[]) => Record<string, unknown>;
                function CadenceMessagesHandlers(this: unknown, ...args: unknown[]): unknown {
                    const instance = Reflect.construct(Original, args, new.target ?? CadenceMessagesHandlers) as Record<string, unknown>;
                    const tap = instance && instance.handleTapClanTagChiplet;
                    if (typeof tap === "function") instance.handleTapClanTagChiplet = function (this: unknown, ...tapArgs: unknown[]) {
                        try {
                            const read = eventData();
                            const data = typeof read === "function" ? read(tapArgs[0]) : undefined;
                            if (object(data) && String(data.guildId) === CHIP_GUILD) return undefined;
                        } catch (_) { /* Unknown event shape: Discord's own handler decides. */ }
                        return Reflect.apply(tap, this, tapArgs);
                    };
                    return instance;
                }
                CadenceMessagesHandlers.prototype = Original.prototype;
                for (const key of Object.getOwnPropertyNames(Original)) {
                    if (key === "prototype" || key === "length" || key === "name" || key in CadenceMessagesHandlers) continue;
                    try { Object.defineProperty(CadenceMessagesHandlers, key, Object.getOwnPropertyDescriptor(Original, key)!); } catch (_) { /* Optional static. */ }
                }
                return CadenceMessagesHandlers;
            });
        } catch (_) { return false; }
    }
    function installMessages(exports: unknown): boolean {
        try {
            const type = data(exports, "default");
            if (typeof type !== "function" || !object(type.prototype)) return false;
            return wrapExport(type.prototype, "generate", original => function (this: unknown, ...args: unknown[]) {
                return messageRow(Reflect.apply(original, this, args), args[0]);
            });
        } catch (_) { return false; }
    }
    return { install, installScope, installProfile, installMessages, installChipTaps, messageRow, placeTree };
}
