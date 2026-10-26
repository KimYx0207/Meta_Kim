import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLocalFeedbackText, createLocalFeedbackDraftStore, liveDeliverablesForNode, normalizeLiveDeliverables, serializeLocalFeedbackResolvers } from "../../src/presentation/live/live-feedback-draft.mjs";

test("feedback handoff keeps the exact original and binds one run, node and artifact", () => {
  const original = "  这里的连线还错了\n不要把已确认的内容改掉。  ";
  const value = buildLocalFeedbackText({ projectId: "project-a", runId: "run-a", nodeId: "node-a", nodeLabel: "前端", deliverableId: "output-1", deliverableLabel: "页面", evidenceId: "proof-1", sourceRef: "host:1" }, original);
  assert.ok(value.endsWith(original));
  for (const valuePart of ["run-a", "node-a", "output-1", "页面", "proof-1", "host:1"]) assert.ok(value.includes(valuePart));
  assert.match(value, /项目：project-a/u);
  assert.match(value, /节点：前端 · node-a/u);
  assert.doesNotMatch(value, /已发送|已处理|已应用/u);
});

test("switching node, evidence, run or project never loses or mixes a draft", () => {
  const store = createLocalFeedbackDraftStore();
  const context = { projectId: "p", runId: "r", nodeId: "n", evidenceId: "e" };
  store.get(context).original = "原话";
  store.get(context).prepared = "编辑后的反馈文本";
  for (const variant of [{ nodeId: "other" }, { evidenceId: "other" }, { runId: "other" }, { projectId: "other" }, { deliverableId: "other" }]) {
    assert.deepEqual(store.get({ ...context, ...variant }), { original: "", prepared: "" });
  }
  assert.deepEqual(store.get(context), { original: "原话", prepared: "编辑后的反馈文本" });
  store.select(context, "evidence:e");
  assert.equal(store.selected({ ...context, evidenceId: "different" }), "evidence:e");
  assert.equal(store.selected({ ...context, nodeId: "different" }), "");
});

test("serialized browser helpers preserve original feedback exactly", () => {
  const browser = new Function(serializeLocalFeedbackResolvers() + "\nreturn { buildLocalFeedbackText, createLocalFeedbackDraftStore };")();
  const context = { runId: "r", nodeId: "n" };
  const original = " x\n\n y ";
  assert.equal(browser.buildLocalFeedbackText(context, original), buildLocalFeedbackText(context, original));
  assert.deepEqual(browser.createLocalFeedbackDraftStore().get(context), { original: "", prepared: "" });
});

test("feedback handoff copy is centralized, bilingual and included in the serialized browser helpers", async () => {
  const { LIVE_FEEDBACK_COPY } = await import("../../src/presentation/live/live-feedback-copy.mjs");
  assert.deepEqual(Object.keys(LIVE_FEEDBACK_COPY.zh).sort(), Object.keys(LIVE_FEEDBACK_COPY.en).sort());
  assert.equal(LIVE_FEEDBACK_COPY.zh.original, "用户反馈原话：");
  assert.equal(LIVE_FEEDBACK_COPY.en.original, "User feedback, verbatim:");
  const source = readFileSync(new URL("../../src/presentation/live/live-feedback-draft.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\p{Script=Han}/u, "foreground Chinese text belongs in the copy resource, not business logic");
  assert.match(source, /from "\.\/live-feedback-copy\.mjs"/u);
  const browser = new Function(serializeLocalFeedbackResolvers() + "\nreturn { buildLocalFeedbackText }; ")();
  const context = { projectId: "p", runId: "r", taskPacketId: "task:abc", deliverableId: "d" };
  for (const language of ["zh", "en", "other"]) {
    const copy = LIVE_FEEDBACK_COPY[language === "zh" ? "zh" : "en"];
    const output = browser.buildLocalFeedbackText(context, "  keep\n原话  ", language);
    assert.equal(output, buildLocalFeedbackText(context, "  keep\n原话  ", language));
    assert.ok(output.startsWith(copy.instruction + "\n"));
    assert.ok(output.includes(copy.version + copy.unknownVersion));
    assert.ok(output.includes(copy.taskReference + context.taskPacketId));
    assert.ok(output.endsWith(copy.original + "\n  keep\n原话  "));
  }
});

test("a content-version change preserves raw feedback but invalidates the prepared handoff and receipt key", () => {
  const store = createLocalFeedbackDraftStore();
  const context = { projectId: "p", runId: "r", deliverableId: "d", contentVersion: "sha256:" + "a".repeat(64) };
  store.get(context).original = "  我的原话\n保留空白。  ";
  store.get(context).prepared = "旧版本整理文本";
  const next = { ...context, contentVersion: "sha256:" + "b".repeat(64) };
  assert.notEqual(store.key(context), store.key(next));
  assert.deepEqual(store.get(next), { original: "  我的原话\n保留空白。  ", prepared: "" });
  assert.match(buildLocalFeedbackText(next, "原话"), /本次读取版本：sha256:b{64}/u);
  assert.match(buildLocalFeedbackText({ runId: "r", deliverableId: "d", contentVersion: "caller-claimed" }, "原话"), /本次读取版本：未知/u);
});

test("deliverable descriptors retain only same-run safe references and exact task bindings", () => {
  const rows = normalizeLiveDeliverables([
    { id: "result-a", runId: "run-a", taskPacketId: "task-a", label: "页面", kind: "html", availability: "declared", url: "javascript:bad()", path: "private" },
    { id: "run-result", runId: "run-a", taskPacketId: null, label: "运行说明", kind: "text", availability: "available" },
    { id: "wrong-run", runId: "run-b", kind: "text", availability: "available" },
    { id: "invalid", runId: "run-a", kind: "binary", availability: "available" },
  ], "run-a");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, undefined);
  assert.equal(rows[0].path, undefined);
  assert.equal(liveDeliverablesForNode(rows, { id: "agent:task-a", taskPacketId: "task-a" })[0].id, "result-a");
  assert.deepEqual(liveDeliverablesForNode(rows, { id: "task-a", label: "页面" }), [], "node ids and labels are not task bindings");
  assert.equal(liveDeliverablesForNode(rows, null).length, 2, "run-level results remain reachable before node selection");
});

function memoryStorage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("feedback survives a new page store with stable identity and exact whitespace, isolated per target", () => {
  const storage = memoryStorage();
  const context = { projectId: "p", runId: "r", nodeId: "n", deliverableId: "d", contentVersion: `sha256:${"a".repeat(64)}` };
  const first = createLocalFeedbackDraftStore({ storage });
  first.update(context, { original: "  原话\n\n保留空白  ", prepared: "可编辑交接" });
  first.select(context, "deliverable:d");
  const identity = first.binding(context);
  const reopened = createLocalFeedbackDraftStore({ storage });
  assert.deepEqual(reopened.get(context), first.get(context));
  assert.deepEqual(reopened.binding(context), identity);
  assert.match(identity.feedbackId, /^feedback:/u);
  assert.match(identity.findingId, /^finding:/u);
  assert.equal(reopened.selected(context), "deliverable:d");
  assert.equal(reopened.persistence(context).state, "saved");
  for (const change of [{ projectId: "other" }, { runId: "other" }, { nodeId: "other" }, { deliverableId: "other" }, { evidenceId: "other" }]) {
    assert.equal(reopened.get({ ...context, ...change }).original, "");
  }
  const next = { ...context, contentVersion: `sha256:${"b".repeat(64)}` };
  assert.equal(reopened.get(next).prepared, "");
  assert.equal(reopened.get(next).original, first.get(context).original);
  assert.deepEqual(reopened.binding(next), identity);
  assert.equal(createLocalFeedbackDraftStore({ storage }).get(next).prepared, "");
  const handoff = buildLocalFeedbackText({ ...next, ...identity, taskPacketId: "task:visible" }, reopened.get(next).original);
  assert.ok(handoff.includes(identity.feedbackId));
  assert.ok(handoff.includes(identity.findingId));
  assert.ok(handoff.endsWith(first.get(context).original));
});

test("quota errors and corrupt saved drafts preserve memory and disclose that changes are unsaved", () => {
  const context = { projectId: "p", runId: "r", nodeId: "n" };
  const quota = createLocalFeedbackDraftStore({ storage: { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } } });
  quota.update(context, { original: "不能丢失" });
  assert.equal(quota.get(context).original, "不能丢失");
  assert.equal(quota.persistence(context).state, "memory_only");
  const writes = [];
  const corrupt = createLocalFeedbackDraftStore({ storage: { getItem: () => "{malformed", setItem: (...args) => writes.push(args) } });
  corrupt.update(context, { original: "保留新输入" });
  assert.equal(corrupt.get(context).original, "保留新输入");
  assert.equal(corrupt.persistence(context).reason, "corrupt_storage");
  assert.equal(writes.length, 0, "malformed stored data must not be silently overwritten");
});

test("revision matching follows the original target version and rejects another run, task, target or feedback", () => {
  const store = createLocalFeedbackDraftStore();
  const context = { projectId: "p", runId: "r", nodeId: "n", taskPacketId: "task-old", deliverableId: "output-old", contentVersion: `sha256:${"a".repeat(64)}` };
  store.update(context, { original: "原结果要修订" });
  const binding = store.binding(context);
  const item = { runId: "r", taskPacketId: "task-new", sourceTaskPacketId: "task-old", deliverableId: "output-new", sourceDeliverableId: "output-old",
    contentVersion: `sha256:${"b".repeat(64)}`, sourceContentVersion: context.contentVersion, feedbackId: binding.feedbackId, findingRef: binding.findingId, state: "verification_unconfirmed" };
  assert.deepEqual(store.matching(context, [item]), [item]);
  for (const change of [{ runId: "other" }, { sourceTaskPacketId: "other" }, { sourceDeliverableId: "other" }, { sourceContentVersion: item.contentVersion }, { feedbackId: "other" }, { findingRef: "other" }]) {
    assert.deepEqual(store.matching(context, [{ ...item, ...change }]), []);
  }
  assert.deepEqual(store.matching({ ...context, contentVersion: item.contentVersion }, [item]), [], "a later version of the original target does not inherit the old report");
  assert.equal(store.get(context).original, "原结果要修订");
});
