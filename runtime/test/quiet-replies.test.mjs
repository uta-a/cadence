import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const { outputFiles } = await build({ stdin: { contents: 'export * from "./features/venus/quietReplies";',
    resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" }, bundle: true,
    format: "cjs", platform: "neutral", target: "es2019", write: false });
const host = { module: { exports: {} } };
vm.runInNewContext(outputFiles[0].text, host);
const { installQuietReplies, pendingReplyState } = host.module.exports;

test("quiet replies change only initial server/group mentions and preserve receiver, parameters and manual toggle", () => {
    let on = false, events = 0, calls = [];
    const original = function (...args) { calls.push({ self: this, args }); return "reply"; };
    const manual = () => "manual";
    const actions = { createPendingReply: original, createShallowPendingReply: original, setPendingReplyShouldMention: manual };
    assert.equal(installQuietReplies(actions, () => on, () => events++), 2);
    const params = Object.freeze({ channel: { guild_id: "g", type: 0 }, message: { id: "m" }, shouldMention: true });
    assert.equal(actions.createPendingReply(params, "tail"), "reply");
    assert.equal(calls.at(-1).args[0], params, "default off");
    on = true;
    for (const key of ["createPendingReply", "createShallowPendingReply"]) {
        assert.equal(actions[key](params, "tail"), "reply");
        const { self, args } = calls.at(-1);
        assert.equal(self, actions);
        assert.equal(args[1], "tail");
        assert.equal(args[0].shouldMention, false);
        assert.equal(args[0].message, params.message);
        assert.equal(args[0].channel, params.channel);
        assert.equal(params.shouldMention, true);
    }
    assert.equal(actions.setPendingReplyShouldMention, manual);
    const group = { channel: { type: 3 }, messageId: "m" };
    actions.createShallowPendingReply(group);
    assert.equal(calls.at(-1).args[0].shouldMention, false);
    for (const untouched of [null, {}, [], { channel: { type: 1 } }, { channel: { type: 2 } },
        { channel: { guild_id: "g" }, shouldMention: false }]) {
        actions.createPendingReply(untouched);
        assert.equal(calls.at(-1).args[0], untouched);
    }
    assert.equal(events, 3);
});

test("normal and shallow replies retain different originals after both exports are wrapped", () => {
    const calls = [];
    const actions = {
        createPendingReply(params) { calls.push(["normal", params.message]); return "normal-result"; },
        createShallowPendingReply(params) { calls.push(["shallow", params.messageId]); return "shallow-result"; },
    };
    let enabled = false;
    assert.equal(installQuietReplies(actions, () => enabled), 2);
    const message = { id: "m" }, channel = { guild_id: "g" };
    for (const on of [false, true]) {
        enabled = on;
        assert.equal(actions.createPendingReply({ channel, message }), "normal-result");
        assert.equal(actions.createShallowPendingReply({ channel, messageId: "s" }), "shallow-result");
    }
    assert.deepEqual(calls, [["normal", message], ["shallow", "s"], ["normal", message], ["shallow", "s"]]);
});

test("quiet replies fail open on unsafe shapes and never repeat an original that throws", () => {
    let calls = 0, accessors = 0;
    const failure = new Error("original");
    const actions = { createPendingReply(value) { calls++; throw failure; } };
    assert.equal(installQuietReplies(actions, () => true, () => { throw new Error("log"); }), 1);
    assert.throws(() => actions.createPendingReply({ channel: { guild_id: "g" } }), e => e === failure);
    assert.equal(calls, 1);
    const unsafe = { get channel() { accessors++; throw new Error("accessor"); } };
    assert.throws(() => actions.createPendingReply(unsafe), e => e === failure);
    assert.equal(accessors, 0);
    assert.equal(calls, 2);
    assert.equal(installQuietReplies(Object.freeze({ createPendingReply() {} }), () => true), 0);
    const getters = { get createPendingReply() { accessors++; return () => {}; } };
    assert.equal(installQuietReplies(getters, () => true), 0);
    assert.equal(accessors, 0);
});

test("reply diagnostics run after successful dispatch, keep original results and never report a failed action as changed", () => {
    let reply, on = true;
    const seen = [], channel = { id: "c", guild_id: "g" };
    const store = Object.create({ getPendingReply(id) {
        assert.equal(this, store);
        assert.equal(id, "c");
        return reply;
    } });
    const result = Promise.resolve("unchanged result");
    const actions = { createPendingReply(params) {
        reply = { shouldMention: params.shouldMention ?? true };
        return result;
    } };
    assert.equal(installQuietReplies(actions, () => on, () => seen.push("changed"), params => {
        seen.push(pendingReplyState({ default: store }, params));
        throw new Error("diagnostic failure");
    }), 1);
    assert.equal(actions.createPendingReply({ channel }), result);
    assert.deepEqual(seen, ["changed", "quiet"]);
    on = false;
    assert.equal(actions.createPendingReply({ channel }), result);
    assert.deepEqual(seen, ["changed", "quiet", "mention"]);
    const failing = { createPendingReply() { throw new Error("dispatch failure"); } };
    installQuietReplies(failing, () => true, () => seen.push("wrong"), () => seen.push("wrong"));
    assert.throws(() => failing.createPendingReply({ channel }), /dispatch failure/);
    assert.deepEqual(seen, ["changed", "quiet", "mention"]);
});

test("pending reply diagnostics distinguish missing state from unavailable APIs without evaluating accessors", () => {
    const params = { channel: { id: "c" } };
    for (const value of [undefined, null])
        assert.equal(pendingReplyState({ default: { getPendingReply: () => value } }, params), "missing");
    for (const value of [false, 1, {}, { shouldMention: "false" }])
        assert.equal(pendingReplyState({ default: { getPendingReply: () => value } }, params), "unavailable");
    assert.equal(pendingReplyState(undefined, params), "unavailable");
    assert.equal(pendingReplyState({ default: {} }, params), "unavailable");
    assert.equal(pendingReplyState({ default: { getPendingReply() { throw new Error("store"); } } }, params), "unavailable");
    let getters = 0;
    const unsafe = { get default() { getters++; throw new Error("accessor"); } };
    assert.equal(pendingReplyState(unsafe, params), "unavailable");
    const store = { default: { getPendingReply: () => ({ get shouldMention() { getters++; return true; } }) } };
    assert.equal(pendingReplyState(store, params), "unavailable");
    assert.equal(pendingReplyState(store, { get channel() { getters++; return {}; } }), "unavailable");
    assert.equal(getters, 0);
});
