import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const prdPath = path.join(REPO_ROOT, "docs", "ai-native-capability-gap-mvp-prd.zh-CN.md");
const prd = existsSync(prdPath) ? readFileSync(prdPath, "utf8") : "";

function markedBlock(startMarker, endMarker) {
  const start = prd.indexOf(startMarker);
  const end = prd.indexOf(endMarker);
  assert.notEqual(start, -1, `missing block start ${startMarker}`);
  assert.notEqual(end, -1, `missing block end ${endMarker}`);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return prd.slice(start + startMarker.length, end);
}

describe(
  "29 — Capability Gap complete product PRD",
  { skip: prd ? false : "local-private PRD is not attached in this workspace" },
  () => {
  test("preserves the historical M3-A12 architecture gate and completed M3-A11 lifecycle boundary", () => {
    const currentQueue = markedBlock(
      "<!-- HISTORICAL_CURRENT_QUEUE_START -->",
      "<!-- HISTORICAL_CURRENT_QUEUE_END -->",
    );
    const completedRows = currentQueue.match(/^\| COMPLETED \|.*$/gm) ?? [];
    const activeRows = currentQueue.match(/^\| ACTIVE \|.*$/gm) ?? [];
    const nextRows = currentQueue.match(/^\| NEXT \|.*$/gm) ?? [];
    const parkedRows = currentQueue.match(/^\| PARKED \|.*$/gm) ?? [];
    const deferredRows = currentQueue.match(/^\| DEFERRED \|.*$/gm) ?? [];

    assert.equal(activeRows.length, 1, "current queue must expose exactly one ACTIVE row");
    assert.equal(nextRows.length, 0, "the final active architecture phase must not invent a successor NEXT row");
    assert.equal(completedRows.length, 11, "current queue must preserve all locally verified architecture rows");
    assert.equal(parkedRows.length, 1, "current queue must expose exactly one PARKED row");
    assert.equal(deferredRows.length, 1, "current queue must expose exactly one DEFERRED row");

    const queueIdPattern = "(P-\\d+|M3-[AP]\\d+)";
    const activeId = activeRows[0].match(new RegExp(`^\\| ACTIVE \\| ${queueIdPattern} \\|`))?.[1];
    assert.ok(activeId, "ACTIVE row must expose a problem ID");
    assert.equal(activeId, "M3-A12", "M3-A12 must be the sole ACTIVE architecture item");
    assert.match(activeRows[0], /执行中/);
    assert.match(activeRows[0], /implementation_active/);
    assert.doesNotMatch(activeRows[0], /已发布|release_closed|acceptance_candidate/);

    const completedA01 = completedRows.find((line) => /^\| COMPLETED \| M3-A01 \|/.test(line)) ?? "";
    assert.ok(completedA01, "M3-A01 must leave ACTIVE only after local verification");
    assert.match(completedA01, /local_verified/);
    assert.match(completedA01, /聚焦主门 93\/93/);
    assert.match(completedA01, /Review ACCEPT/);
    assert.match(completedA01, /未运行 3\.0 最终全回归/);
    assert.match(completedA01, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA01, /release_closed|public_ready/);

    const completedA02 = completedRows.find((line) => /^\| COMPLETED \| M3-A02 \|/.test(line)) ?? "";
    assert.ok(completedA02, "M3-A02 must leave ACTIVE only after local verification");
    assert.match(completedA02, /local_verified/);
    assert.match(completedA02, /聚焦主门 100\/100/);
    assert.match(completedA02, /Review ACCEPT/);
    assert.match(completedA02, /未运行 3\.0 最终全回归/);
    assert.match(completedA02, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA02, /release_closed|public_ready/);

    const completedA03 = completedRows.find((line) => /^\| COMPLETED \| M3-A03 \|/.test(line)) ?? "";
    assert.ok(completedA03, "M3-A03 must leave ACTIVE only after local verification");
    assert.match(completedA03, /local_verified/);
    assert.match(completedA03, /聚焦主门 133\/133/);
    assert.match(completedA03, /Review ACCEPT/);
    assert.match(completedA03, /未运行 3\.0 最终全回归/);
    assert.match(completedA03, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA03, /release_closed|public_ready/);

    const completedA04 = completedRows.find((line) => /^\| COMPLETED \| M3-A04 \|/.test(line)) ?? "";
    assert.ok(completedA04, "M3-A04 must leave ACTIVE only after local verification");
    assert.match(completedA04, /local_verified/);
    assert.match(completedA04, /Root focused 102\/102/);
    assert.match(completedA04, /Review ACCEPT（P0-P3=0）/);
    assert.match(completedA04, /package closure 14\/14/);
    assert.match(completedA04, /真实 pack import/);
    assert.match(completedA04, /未运行 3\.0 最终全回归/);
    assert.match(completedA04, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA04, /release_closed|public_ready/);

    const completedA05 = completedRows.find((line) => /^\| COMPLETED \| M3-A05 \|/.test(line)) ?? "";
    assert.ok(completedA05, "M3-A05 must leave ACTIVE only after local verification");
    assert.match(completedA05, /local_verified/);
    assert.match(completedA05, /Root focused 117\/117/);
    assert.match(completedA05, /package closure 15\/15/);
    assert.match(completedA05, /真实 pack import/);
    assert.match(completedA05, /Review ACCEPT（P0-P3=0）/);
    assert.match(completedA05, /未运行 3\.0 最终全回归/);
    assert.match(completedA05, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA05, /release_closed|public_ready/);

    const completedA06 = completedRows.find((line) => /^\| COMPLETED \| M3-A06 \|/.test(line)) ?? "";
    assert.ok(completedA06, "M3-A06 must leave ACTIVE only after local verification");
    assert.match(completedA06, /local_verified/);
    assert.match(completedA06, /Root focused 133\/133/);
    assert.match(completedA06, /test75 16\/16/);
    assert.match(completedA06, /package closure 16\/16/);
    assert.match(completedA06, /真实 pack import/);
    assert.match(completedA06, /Review ACCEPT（P0-P3=0）/);
    assert.match(completedA06, /未运行 3\.0 最终全回归/);
    assert.match(completedA06, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA06, /release_closed|public_ready/);

    const completedA07 = completedRows.find((line) => /^\| COMPLETED \| M3-A07 \|/.test(line)) ?? "";
    assert.ok(completedA07, "M3-A07 must leave ACTIVE only after local verification");
    assert.match(completedA07, /local_verified/);
    assert.match(completedA07, /test76 12\/12/);
    assert.match(completedA07, /package\/source closure/);
    assert.match(completedA07, /真实 pack import/);
    assert.match(completedA07, /Review ACCEPT/);
    assert.match(completedA07, /未运行 3\.0 最终全回归/);
    assert.match(completedA07, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA07, /release_closed|public_ready/);

    const completedA08 = completedRows.find((line) => /^\| COMPLETED \| M3-A08 \|/.test(line)) ?? "";
    assert.ok(completedA08, "M3-A08 must leave ACTIVE only after local verification");
    assert.match(completedA08, /local_verified/);
    assert.match(completedA08, /test77 10\/10/);
    assert.match(completedA08, /157\/157/);
    assert.match(completedA08, /9 项真实 packed import/);
    assert.match(completedA08, /Review ACCEPT（P0-P3=0）/);
    assert.match(completedA08, /A335B9C710B9650ADF1F4CDA7494E4E12564E1D86C6F3311733FB88D30B037EE/);
    assert.match(completedA08, /未运行 3\.0 最终全回归/);
    assert.match(completedA08, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA08, /release_closed|public_ready/);

    const completedA09 = completedRows.find((line) => /^\| COMPLETED \| M3-A09 \|/.test(line)) ?? "";
    assert.ok(completedA09, "M3-A09 must leave ACTIVE only after local verification");
    assert.match(completedA09, /local_verified/);
    assert.match(completedA09, /A09 13\/13/);
    assert.match(completedA09, /106\/106/);
    assert.match(completedA09, /真实 packed 新旧 9 项 import/);
    assert.match(completedA09, /Review ACCEPT（P0-P3=0）/);
    assert.match(completedA09, /schema v5/);
    assert.match(completedA09, /event\/CAS\/transaction\/lease\/fence\/checkpoint/);
    assert.match(completedA09, /未运行 3\.0 最终全回归/);
    assert.match(completedA09, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA09, /release_closed|public_ready/);

    const completedA10 = completedRows.find((line) => /^\| COMPLETED \| M3-A10 \|/.test(line)) ?? "";
    assert.ok(completedA10, "M3-A10 must leave ACTIVE only after packed install verification");
    assert.match(completedA10, /local_verified/);
    assert.match(completedA10, /A10 targeted 52\/52/);
    assert.match(completedA10, /transient package root 6\/6/);
    assert.match(completedA10, /packed acceptance contract 32\/32/);
    assert.match(completedA10, /install scope matrix 1\/1/);
    assert.match(completedA10, /manifest receipt/);
    assert.match(completedA10, /immutable projection package root/);
    assert.match(completedA10, /Review ACCEPT（P0-P2=0）/);
    assert.match(completedA10, /未运行 3\.0 最终全回归/);
    assert.match(completedA10, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA10, /release_closed|public_ready/);

    const completedA11 = completedRows.find((line) => /^\| COMPLETED \| M3-A11 \|/.test(line)) ?? "";
    assert.ok(completedA11, "M3-A11 must leave ACTIVE only after exact lifecycle verification");
    assert.match(completedA11, /local_verified/);
    assert.match(completedA11, /lifecycle \+ Evolution Gate 25\/25/);
    assert.match(completedA11, /T-003\/T-003a\/T-003b/);
    assert.match(completedA11, /package\/source boundary 20\/20/);
    assert.match(completedA11, /Review ACCEPT（P0-P2=0）/);
    assert.match(completedA11, /真实 source drift/);
    assert.match(completedA11, /原字节批量回滚/);
    assert.match(completedA11, /未运行 3\.0 最终全回归/);
    assert.match(completedA11, /未提交、push、tag 或发布/);
    assert.doesNotMatch(completedA11, /release_closed|public_ready/);

    assert.match(activeRows[0], /Docs Truth & 3\.0 Release Gate/);
    assert.match(activeRows[0], /contracts\/runtime\/provider\/package/);
    assert.match(activeRows[0], /真实 packed 新装\/重装\/历史升级\/残留\/用户漂移/);
    assert.match(activeRows[0], /Claude\/Codex 回读/);
    assert.match(activeRows[0], /v3\.0\.0 发布和 exact audit/);
    assert.match(activeRows[0], /没有后续 NEXT/);

    const parkedP2 = parkedRows.find((line) => /^\| PARKED \| M3-P2 \|/.test(line)) ?? "";
    assert.ok(parkedP2, "M3-P2 must be parked instead of occupying ACTIVE or NEXT");
    assert.match(parkedP2, /parked_external_blocked/);
    assert.match(parkedP2, /不算完成/);
    assert.match(parkedP2, /官方可信 host receipt、Desktop\/真人身份或等价私有能力根出现时恢复/);
    assert.doesNotMatch(parkedP2, /implementation_active|acceptance_candidate|release_closed|已完成/);

    const deferredP3 = deferredRows.find((line) => /^\| DEFERRED \| M3-P3 \|/.test(line)) ?? "";
    assert.ok(deferredP3, "M3-P3 must remain deferred and must not become NEXT");
    assert.match(deferredP3, /deferred_not_started/);
    assert.match(deferredP3, /不得成为 NEXT/);
    assert.match(deferredP3, /不得伪造 parity、影响现有 gate 或启动 cutover/);
    assert.doesNotMatch(deferredP3, /implementation_active|acceptance_candidate|release_closed|已完成/);
    assert.doesNotMatch(activeRows.join("\n"), /\| M3-P[23] \|/);
    assert.doesNotMatch(nextRows.join("\n"), /\| M3-P[23] \|/);
    assert.doesNotMatch(completedRows.join("\n"), /\| M3-P[23] \|/);

    const serialQueue = prd.match(/### 串行执行队列([\s\S]*?)### v0\.79 历史对话证据吸收记录/)?.[1] ?? "";
    const queueRows = serialQueue.split(/\r?\n/).filter((line) => /^\| \d+ \| P-\d+ \|/.test(line));
    const inProgressRows = queueRows.filter((line) =>
      /\| (?:进行中|返工中|已验收待发布)/.test(line)
    );
    assert.equal(
      inProgressRows.length,
      0,
      "an M3 architecture ACTIVE item must not leave a legacy P-series item in progress",
    );

    const architectureReorder = prd.match(
      /#### 3\.0 架构重排与 Authority Matrix（2026-08-11）([\s\S]*?)(?=\n### )/,
    )?.[1] ?? "";
    assert.ok(architectureReorder, "the M3 architecture queue must have a bounded authority-matrix checkpoint");
    for (const marker of [
      "stageDagPacket` 只拥有拓扑权威",
      "durable kernel event 加 CAS/lease/fence/checkpoint/resume 只拥有执行真值",
      "Decision 始终是非授权输入",
      "UI、Kanban、Markdown、spine 摘要与 run index 都只是投影",
      "EvidenceClaim -> VerifiedEvidence -> TransitionProposal -> ShadowVerdict",
      "allowed / blocked / in_doubt",
      "不接生产 Gate",
      "不写 authoritative event",
      "不调用 `completeNode`",
      "不推进 durable cursor",
      "不建立 scheduler",
      "不启动 M3-P3",
    ]) {
      assert.match(architectureReorder, new RegExp(marker), `missing M3-A01 shadow boundary ${marker}`);
    }
    for (const marker of [
      "M3-A02",
      "continue / wait / stop / escalate",
      "只读取 durable projection",
      "resumeRun",
      "claim",
      "lease",
      "checkpoint",
      "event",
      "scheduler",
      "authoritative execution truth",
      "不得让 shadow 建议冒充执行控制",
    ]) {
      assert.match(architectureReorder, new RegExp(marker), `missing M3-A02 shadow boundary ${marker}`);
    }
    assert.match(architectureReorder, /不得调用[^\n]*resumeRun[^\n]*claim[^\n]*lease[^\n]*checkpoint[^\n]*event[^\n]*scheduler/);
    assert.match(architectureReorder, /COMPLETED \/ local_verified/);
    assert.match(architectureReorder, /不等于 3\.0 最终全回归、发布验证或 release-complete/);
    assert.match(architectureReorder, /只读取 durable projection/);
    for (const marker of [
      "M3-A03",
      "Todo/workItem 只能 1:1 映射 `stageDag` 中的 DAG node",
      "只是 projection",
      "依赖 ready 只能由 `stageDag \\+ durable projection` 推导",
      "safe_progress_candidate / wait_dependency / wait_decision / wait_evidence / blocked / in_doubt",
      "advisory",
      "claim",
      "lease",
      "schedule",
      "dispatch",
      "completeNode",
      "writeEvent",
      "推进 cursor",
      "第二 Todo authority",
    ]) {
      assert.match(architectureReorder, new RegExp(marker), `missing M3-A03 shadow boundary ${marker}`);
    }
    assert.match(
      architectureReorder,
      /只允许输出 `safe_progress_candidate \/ wait_dependency \/ wait_decision \/ wait_evidence \/ blocked \/ in_doubt` advisory/,
    );
    assert.match(
      architectureReorder,
      /不得 claim、lease、schedule、dispatch、调用 `completeNode`、`writeEvent`、推进 cursor 或写入 authoritative execution truth/,
    );
    assert.match(architectureReorder, /不能形成第二 Todo authority/);
    for (const marker of [
      "M3-A04",
      "selectMaximalSafeReadySet",
      "`stageDag` authority",
      "fresh durable head、graph、checkpoint、claims 与 effects",
      "M3-A03 产生的 candidates",
      "只能作为输入提示，不 authoritative",
      "shadow scheduling plan",
      "第二 scheduler",
      "自建 ready 算法",
      "dispatch",
      "claim",
      "lease",
      "event",
      "cursor",
      "completeNode",
    ]) {
      assert.match(architectureReorder, new RegExp(marker), `missing M3-A04 shadow boundary ${marker}`);
    }
    assert.match(architectureReorder, /必须直接复用现有 `selectMaximalSafeReadySet` 和 `stageDag` authority/);
    assert.match(architectureReorder, /生成 shadow scheduling plan 前，必须针对 fresh durable head、graph、checkpoint、claims 与 effects 重新校验/);
    assert.match(architectureReorder, /M3-A03 产生的 candidates 只能作为输入提示，不 authoritative/);
    assert.match(architectureReorder, /首期只输出 shadow scheduling plan/);
    assert.match(
      architectureReorder,
      /不得 dispatch、claim、lease、写 event、推进 cursor、调用 `completeNode` 或产生其他执行副作用/,
    );
    for (const marker of [
      "M3-A05",
      "lease/claim/fence authority",
      "受限 projection",
      "M3-A04 的 `plannedNodeIds`",
      "M3-A03 candidate",
      "Todo 状态",
      "worker 自报",
      "新账本",
      "non-authoritative availability / blocked / in_doubt",
      "第二 lease",
      "第二 claim",
      "平行 fence 权威",
      "dispatch",
      "heartbeatNode",
      "claimNode",
      "claim/takeover/heartbeat/release coordinator",
      "mutate durable state",
      "写 event",
      "推进 cursor",
      "expiry 铸造 takeover",
    ]) {
      assert.match(architectureReorder, new RegExp(marker), `missing M3-A05 shadow boundary ${marker}`);
    }
    assert.match(architectureReorder, /只能复用 durable kernel 现有的 lease\/claim\/fence authority/);
    assert.match(architectureReorder, /不得建立第二 lease、第二 claim 或平行 fence 权威/);
    assert.match(
      architectureReorder,
      /不得 dispatch，不得调用 `heartbeatNode`、`claimNode` 或 claim\/takeover\/heartbeat\/release coordinator，不得 mutate durable state、写 event、推进 cursor 或产生其他执行副作用，也不得仅据 expiry 铸造 takeover/,
    );
    assert.match(architectureReorder, /Architecture Phase 6 — Runtime Health Projection/);
    for (const marker of [
      "M3-A06",
      "Runtime Health",
      "point-in-time",
      "bridge-owned",
      "可重放",
      "非授权 projection",
      "不是 liveness authority",
      "OpenClaw heartbeat",
      "presence/install/persisted acceptance",
      "健康检查",
      "host 自报",
      "进程存活",
      "版本探测",
      "Claude/Codex",
      "observation_only",
      "responsive_at_observation",
      "Cursor/OpenClaw",
      "not_observed",
      "dispatch",
      "claim",
      "lease",
      "cursor",
      "checkpoint",
      "event",
      "completeNode",
    ]) {
      assert.match(architectureReorder, new RegExp(marker), `missing M3-A06 shadow boundary ${marker}`);
    }
    assert.match(
      architectureReorder,
      /lease、OpenClaw heartbeat、presence\/install\/persisted acceptance、健康检查、host 自报、进程存活、版本探测、transport ping 或普通 adapter return 都不能证明 health 或升级为 execution truth/,
    );
    assert.match(
      architectureReorder,
      /Claude\/Codex 也只能保持 `observation_only`，且只允许把已 settled 的 native invocation 记为 `responsive_at_observation`；Cursor\/OpenClaw 必须保持 `not_observed`/,
    );
    assert.match(architectureReorder, /全部 authorization \/ dispatch \/ claim \/ lease \/ event \/ cursor \/ checkpoint \/ completion \/ persistence 权限为 false/);
    assert.match(architectureReorder, /Architecture Phase 7 — Quota \/ Usage Projection/);
    assert.match(
      architectureReorder,
      /M3-A06 不得读取、消耗或预判 M3-A07 的 quota \/ usage \/ budget \/ rate-limit \/ context-window 权威/,
    );
    for (const marker of [
      "M3-A07",
      "Quota / Usage",
      "shadow",
      "maxRetries",
      "point-in-time wallclock",
      "validated transitions",
      "no-progress",
      "cost",
      "not_observed",
      "第二 quota authority",
      "自动 stop",
      "pause",
      "retry",
      "dispatch",
    ]) {
      assert.match(architectureReorder, new RegExp(marker), `missing M3-A07 shadow boundary ${marker}`);
    }
    assert.match(architectureReorder, /M3-A06 的 Runtime Health observation 不计入 quota/);
    assert.match(
      architectureReorder,
      /只有 `maxRetries` 与 point-in-time wallclock 可观察；validated transitions、no-progress 与 cost 必须保持 `not_observed`/,
    );
    assert.match(
      architectureReorder,
      /不得建立第二 quota authority，不得自动 stop、pause、retry 或 dispatch/,
    );
    const a08ToA12Route = prd.match(
      /## 2026-08-12 — 3\.0 完成目标锁定，A08–A12 路线冻结([\s\S]*?)(?=\n### |\n## 2026|<!-- META_KIM_CHATGPT_PRD_SOURCE_END -->|$)/,
    )?.[1] ?? "";
    assert.ok(a08ToA12Route, "A08-A12 dependency route must remain explicit");
    assert.match(a08ToA12Route, /先冻结读模型可防止 UI 在数据迁移期间形成第二事实源/);
    assert.match(a08ToA12Route, /Native Panel\/Kanban\/Markdown\/HTML/);
    assert.match(a08ToA12Route, /A09 Data\/Event\/Repository Unification/);
    assert.match(a08ToA12Route, /A10 Setup\/Runtime\/Installer Decomposition/);
    assert.match(a08ToA12Route, /A11 Knowledge Lifecycle Hygiene/);
    assert.match(a08ToA12Route, /A12 Docs Truth & 3\.0 Release Gate/);
    assert.match(
      prd,
      /最新公开版本：v3\.0\.3（commit `6fd74a6fb0295970100bcc82f09041dbedfa3876`；`origin\/main` 与 annotated tag `v3\.0\.3` 均指向该提交；Release：`https:\/\/github\.com\/KimYx0207\/Meta_Kim\/releases\/tag\/v3\.0\.3`）/,
      "the PRD must retain the exact current public-release baseline",
    );
    assert.match(
      prd,
      /\| P-122 \| 已发布闭合（v2\.9\.2） \|[\s\S]*?commit `e3475a2e84fddf69d15086a2c563bd175ade8fa0`/,
      "the M3 queue must not erase the exact P-122/v2.9.2 historical baseline",
    );
  });

  test("machine-enforces the v3.0.2 M3 architecture and live release truth boundary", () => {
    const currentQueue = markedBlock("<!-- CURRENT_QUEUE_START -->", "<!-- CURRENT_QUEUE_END -->");
    const completedRows = currentQueue.match(/^\| COMPLETED \|.*$/gm) ?? [];
    const activeRows = currentQueue.match(/^\| ACTIVE \|.*$/gm) ?? [];
    const nextRows = currentQueue.match(/^\| NEXT \|.*$/gm) ?? [];
    const parkedRows = currentQueue.match(/^\| PARKED \|.*$/gm) ?? [];
    const deferredRows = currentQueue.match(/^\| DEFERRED \|.*$/gm) ?? [];

    assert.equal(completedRows.length, 13, "M3-A01 through M3-A12 plus locally verified M3-P3 must be complete");
    for (const id of Array.from({ length: 12 }, (_, index) => `M3-A${String(index + 1).padStart(2, "0")}`)) {
      const row = completedRows.find((candidate) => candidate.includes(`| ${id} |`));
      assert.ok(row, `${id} must remain in the unique current queue`);
      assert.match(row, /release_complete/);
      assert.match(row, /v3\.0\.2/);
    }
    assert.equal(activeRows.length, 0, "M3-P3 completion must leave no fake ACTIVE work");
    assert.equal(nextRows.length, 0, "M3-P3 must not leave a competing NEXT row");
    assert.equal(parkedRows.length, 1, "external parked work remains explicitly parked");
    assert.equal(deferredRows.length, 0, "M3-P3 is complete rather than deferred");
    const completedP3 = completedRows.find((line) => /^\| COMPLETED \| M3-P3 \|/.test(line)) ?? "";
    assert.match(completedP3, /release_complete/);
    assert.match(completedP3, /legacy snapshot、exact parity、逐 Gate mixed rollout、CLI 消费、聚焦测试、package closure、packed 新装\/更新\/重复更新/);
    assert.doesNotMatch(currentQueue, /^\| (?:COMPLETED|NEXT|PARKED|DEFERRED) \|.*ACTIVE.*$/gm);

    for (const id of ["M3-L01", "M3-L02", "M3-L03", "M3-L04"]) {
      const row = prd.match(new RegExp(`^\\| (?:ACTIVE|NEXT|FUTURE|COMPLETED) \\| ${id} \\|.*$`, "m"))?.[0];
      assert.ok(row, `${id} live row must remain explicit`);
      assert.match(row, /released_complete/);
      assert.match(row, /v3\.0\.2/);
    }
    assert.match(
      prd,
      /最新公开版本：v3\.0\.3（commit `6fd74a6fb0295970100bcc82f09041dbedfa3876`；`origin\/main` 与 annotated tag `v3\.0\.3` 均指向该提交；Release：`https:\/\/github\.com\/KimYx0207\/Meta_Kim\/releases\/tag\/v3\.0\.3`）/,
    );
    assert.match(prd, /\| 26 \| P-142 \|[^\n]*local_verified/);
    assert.match(prd, /\| 33 \| P-149 \|[^\n]*local_verified_degraded_navigation/);
    assert.match(prd, /\| 40 \| P-156 \|[^\n]*local_verified/);
    assert.match(prd, /M3-P2[^\n]*parked_external_blocked/);
    assert.match(prd, /M3-P3[^\n]*release_complete/);
    assert.match(prd, /P-145[^\n]*paused_unreproduced/);
    assert.match(prd, /M3-P3 Governance Requirement 逐门切换发布闭合/);
    assert.match(prd, /clarification、humanDecision、permission 继续 `shadow_compare`/);
    assert.match(prd, /caller-supplied facts 仅用于诊断/);
    assert.match(prd, /execution、action、permission、host 或 durable mutation/);
    assert.match(prd, /v3\.0\.2→v3\.0\.3 历史升级/);
  });

  test("requires positive, falsification, and release evidence for completed claims", () => {
    const completed = markedBlock(
      "<!-- COMPLETED_EVIDENCE_CHAIN_START -->",
      "<!-- COMPLETED_EVIDENCE_CHAIN_END -->",
    );
    const rows = completed.split(/\r?\n/).filter((line) => /^\| P-\d+ \|/.test(line));

    const completedIds = rows.map((line) => line.match(/^\| (P-\d+) \|/)?.[1]);
    assert.deepEqual(completedIds.slice(0, 2), ["P-135", "P-117"]);
    assert.ok(
      completedIds.length === 2 ||
        (completedIds.length === 3 && completedIds[2] === "P-122"),
      "only a fully released P-122 may extend the completed evidence chain",
    );
    for (const row of rows) {
      assert.match(row, /\| P-\d+ \| .+ \| .+ \| .+ \| .+ \|/);
      assert.match(row, /commit `?[0-9a-f]{40}`?/);
      assert.match(row, /meta:verify:all/);
      assert.match(row, /GitHub Release/);
    }
    assert.doesNotMatch(completed, /pending/);
  });

  test("keeps archived unfinished outcomes distinct from completion", () => {
    const archived = markedBlock("<!-- ARCHIVED_UNFINISHED_START -->", "<!-- ARCHIVED_UNFINISHED_END -->");
    const rows = archived.split(/\r?\n/).filter((line) => /^\| P-\d+ \|/.test(line));

    assert.deepEqual(rows.map((line) => line.match(/^\| (P-\d+) \|/)?.[1]), ["P-121"]);
    assert.equal((archived.match(/historical_deferred_unfinished/g) ?? []).length, 0);
    assert.equal((archived.match(/historical_cancelled_unfinished/g) ?? []).length, 1);
    assert.doesNotMatch(archived, /\| (?:已完成|已验收|已发布|release_closed) \|/);
    assert.match(prd, /归档只表示“不占用当前 `ACTIVE`\/`NEXT` 队列头并保留历史理由”，不表示完成、验收或发布/);
  });

  test("keeps P-122 candidate slots honest and permits only complete release closure", () => {
    const acceptance = markedBlock("<!-- P122_ACCEPTANCE_SLOT_START -->", "<!-- P122_ACCEPTANCE_SLOT_END -->");
    const slotNames = [
      "正证链",
      "反证链",
      "fresh Verification",
      "用户目标验收",
      "发布文档与版本",
      "Git 与发布绑定",
      "全局 Claude Code/Codex 更新",
    ];
    const rows = acceptance
      .split(/\r?\n/)
      .filter((line) => slotNames.some((name) => line.startsWith(`| ${name} |`)));

    assert.equal(rows.length, 7, "P-122 must expose all seven final acceptance slots");
    for (const marker of slotNames) {
      assert.match(acceptance, new RegExp(marker), `missing P-122 acceptance slot ${marker}`);
    }
    const completed = markedBlock(
      "<!-- COMPLETED_EVIDENCE_CHAIN_START -->",
      "<!-- COMPLETED_EVIDENCE_CHAIN_END -->",
    );
    const releaseClosed = /^\| P-122 \| 已发布闭合/m.test(completed);
    if (releaseClosed) {
      assert.ok(rows.every((line) => /\| closed \|/.test(line)));
      assert.doesNotMatch(acceptance, /\| (?:pending|candidate_[^| ]*) \|/);
    } else {
      assert.match(
        rows.find((line) => line.startsWith("| Git 与发布绑定 |")) ?? "",
        /\| pending \|/,
      );
      assert.match(
        rows.find((line) => line.startsWith("| 全局 Claude Code\/Codex 更新 |")) ?? "",
        /\| pending \|/,
      );
    }
    assert.match(prd, /P-123 从 `NEXT` 提升为 `ACTIVE`/);
  });

    test("marks local complete-product state with live/native release boundary", () => {
    assert.match(prd, /## 当前完成状态/);
    assert.match(prd, /已测通/);
    assert.match(prd, /本地 planning\/orchestration MVP 已经证明/);
    assert.match(prd, /P-068 \/ P-069 \/ P-070 已在默认本地 governed run 证据层闭合/);
    assert.match(prd, /不等于 Cursor native live 或 all-runtime release-grade 完成/);
    assert.match(prd, /还不能宣称“发布级 live\/native 全 runtime 完成”/);
    assert.match(prd, /Cursor Agent CLI native live 是低优先级 compatibility 待验证项/);
    assert.match(prd, /Claude 和 OpenClaw 全九个 meta agents shard live evidence 已闭合/);
    assert.match(prd, /Codex \| orchestration live artifact pass/);
    assert.match(prd, /Cursor native live 记录为低优先级 compatibility 待验证/);
  });

  test("defines remaining complete-product scope with measurable acceptance", () => {
    for (const section of [
      "R-001 分支产物质量门",
      "R-002 用户纠错回放与进化门",
      "R-003 可执行 Graph Contract",
      "R-004 Run Analytics",
      "R-005 默认产品入口",
      "R-006 完整产品验收命令",
      "R-007 默认 meta-theory orchestration runtime path",
      "R-008 跨 runtime 真实投影验证",
      "R-009 Warden 审批后的真实长期 writeback 流程",
      "R-010 用户可读 UI / 报告层",
      "R-011 AI 可读产品标准",
      "完整产品 Definition of Done",
    ]) {
      assert.match(prd, new RegExp(section), `missing ${section}`);
    }

    for (const metric of [
      "真实输入至少 12 条",
      "每类至少 2 条",
      "branch coverage 100%",
      "database_as_planner_count = 0",
      "用户纠正 replay 后",
      "FR pass rate 100%",
      "Quantitative acceptance pass rate 100%",
      "fake owner 0",
      "自动写 canonical 0",
      "未授权外部写动作 0",
      "requiredEvidence",
    ]) {
      assert.match(prd, new RegExp(metric), `missing metric ${metric}`);
    }
  });

  test("requires PRD iteration status for every future product iteration", () => {
    for (const marker of [
      "## PRD 迭代与任务状态规则",
      "每次 Capability Gap / meta-theory 产品迭代都必须同步更新本 PRD",
      "每项任务的状态",
      "GitHub 差距",
      "未开始",
      "进行中",
      "部分完成",
      "已测通",
      "降级",
      "阻塞",
    ]) {
      assert.match(prd, new RegExp(marker), `missing iteration marker ${marker}`);
    }
  });

  test("records v0.54 runtime candidate compatibility framework without promotion", () => {
    for (const marker of [
      "版本：v0.54",
      "docs/runtime-candidate-compatibility-deep-research.zh-CN.md",
      "P-101 泛运行时候选兼容框架已测通",
      "泛运行时候选兼容框架",
      "Qoder CLI、Trae、Kiro、Windsurf / Devin Desktop Cascade、Cline、Roo Code、Continue",
      "surfaceTaxonomy",
      "noFormalClaimFromSurfaceMatch = true",
      "instruction_context",
      "skill_workflow",
      "agent_mode",
      "hook_automation",
      "mcp_tooling",
      "command_cli",
      "memory_context",
      "permission_safety",
      "不能宣称 install、projection、live pass 或 release-grade",
      "候选工具端在 adapter / sync / validation / live proof 前不能宣称正式支持",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.54 marker ${marker}`);
    }
  });

  test("records v0.63 P-111 global-first lazy project bootstrap acceptance", () => {
    for (const marker of [
      "版本：v0.63",
      "v0.63 全局优先项目懒初始化",
      "P-111",
      "lazyProjectBootstrap",
      "setup.mjs --project-bootstrap",
      "meta-kim project bootstrap",
      "dry-run 必须输出 `sourceChain`",
      "package root",
      "canonical roots",
      "`config/sync.json`",
      "runtime mirrors",
      "project target",
      "apply 前必须有 native choice 或 trusted-auto 依据",
      "`.meta-kim/state/default/project-bootstrap.json`",
      "`AGENTS.md` / `CLAUDE.md` 只写 Meta_Kim managed block",
      "`.claude/settings.json`、`.codex/hooks.json`、`.cursor/hooks.json`、`.mcp.json` 保护式 merge",
      "`.codex/config.toml`、credentials、project trust、本地 runtime state 永不作为项目级来源复制",
      "项目级来源链必须从 installed package root -> canonical/config/sync.json -> generated runtime mirrors -> `setup.mjs --project-bootstrap` -> project manifest 全程可 Fetch",
      "不能把 dry-run JSON 冒充 popup",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.63 P-111 marker ${marker}`);
    }
  });

  test("records v0.64 P-112 install scope and project projection acceptance", () => {
    for (const marker of [
      "版本：v0.64",
      "v0.64 安装体验范围合同",
      "P-112",
      "installExperienceModel",
      "全局通用能力 \\+ 当前项目完整投影",
      "`global-only` 不得询问或写项目目录",
      "`project-only` 不得询问或写用户 home",
      "no-skill 只表示跳过可选第三方 skill 套装",
      "不能跳过项目投影",
      "project bootstrap apply",
      "sourceChain、backup、manifest、rollbackPlan",
      "用户配置保护语义",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.64 P-112 marker ${marker}`);
    }
  });

  test("records v0.65 PRD source and target-conditional projection acceptance", () => {
    for (const marker of [
      "版本：v0.65",
      "v0.65 PRD 唯一源与平台条件投影纠偏",
      "对所选 `activeTargets` 的完整投影",
      "不是把 Claude Code / Codex / Cursor / OpenClaw 四端文件无条件铺进每个项目",
      "默认 `activeTargets = \\[\"claude\", \"codex\"\\]`",
      "Claude Code 使用 `CLAUDE.md`、`.claude/`、`.mcp.json`",
      "Codex 使用 `AGENTS.md`、`.codex/`、`.agents/skills/`",
      "Cursor 只有显式选择时生成 `AGENTS.md` 上下文、`.cursor/agents/`、`.cursor/rules/`、`.cursor/skills/`、`.cursor/hooks.json`、`.cursor/mcp.json`",
      "OpenClaw 只有显式选择时生成 `AGENTS.md` 团队/上下文材料、`openclaw/workspaces/`、`openclaw/skills/`、`openclaw/hooks/`、`openclaw/openclaw.template.json`",
      "`AGENTS.md` 不能被写成 Codex/Cursor/OpenClaw 的统一侧入口",
      "在 Codex 是项目上下文入口之一",
      "在 Cursor 是 repository context 的一部分",
      "在 OpenClaw 只是 workspace/team context 资产",
      "执行入口、agent 格式、hook schema、skill path 和 config surface 必须按平台特性分别描述",
      "npm run meta:install-scope:verify",
      "全局层/项目层分类结果",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.65 P-112 marker ${marker}`);
    }
  });

  test("records v0.66 full-platform compatibility tier correction", () => {
    for (const marker of [
      "版本：v0.66",
      "v0.66 全平台兼容分层纠偏",
      "platformSupportTiers",
      "正式投影目标、依赖项目自有目标、候选 probe 三类",
      "依赖项目自有目标只作为内部 promotion guard",
      "从依赖项目事实源、dependency registry 和 `config/runtime-compatibility-catalog.json` 取证",
      "不在公开 README / FAQ / 更新说明里重复写成 Meta_Kim 支持承诺",
      "候选 probe 目标 `qoder` / `trae` / `kiro` / `windsurf` / `cline` / `roo-code` / `continue`",
      "OpenClaw / Cursor 只表示“显式选择的正式投影兼容目标”",
      "不是全平台兼容的全部",
      "runtime profile",
      "projection layout",
      "generated target paths",
      "sync tests",
      "install policy",
      "live 或 official probe evidence",
      "不得被项目 bootstrap 投影",
      "不得宣称正式 runtime projection",
      "npm run meta:runtime:safety:validate",
      "npm run meta:install-scope:verify",
      "config/runtime-compatibility-catalog.json",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.66 marker ${marker}`);
    }
  });

  test("records v0.67 public platform wording and badge correction", () => {
    assert.match(prd, /- 版本：v0\.\d+/);
    for (const marker of [
      "v0.67 公开平台支持口径校准",
      "README / FAQ / 徽章 / 跨平台映射段",
      "`default formal projections = Claude Code \\+ Codex`",
      "`explicit formal compatibility projections = OpenClaw \\+ Cursor`",
      "`candidate compatibility probes = Qoder CLI / Trae / Kiro / Windsurf 或 Devin Desktop Cascade / Cline / Roo Code / Continue`",
      "徽章不能只露 OpenClaw/Cursor",
      "也不能把候选 probe 写成正式 runtime projection",
      "Qoder 官方证据源必须使用当前 docs 路径 `/en/cli/Skills`、`/subagent`、`/hooks`、`/mcp-servers`",
      "Cline 必须把官方 Skills primitive 纳入 catalog",
      "仍保持 candidate probe",
      "过宽“任意 agent-to-agent 平台即可映射”残留",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.67 marker ${marker}`);
    }
  });

  test("keeps human-readable natural-language entry work in the single PRD source", () => {
    for (const marker of [
      "版本：v0.37",
      "P-068/P-069/P-070 默认治理 \\+ 执行 evidence closure",
      "自然语言入口与用户体验提示",
      "普通自然语言 durable 任务",
      "没有真实 conversation notice emitted 证据时必须标 partial",
      "CLI adapter 发射后才可标 ready",
      "--emit-conversation-notice",
      "帮我做个小红书营销自动发布器",
      "P-061",
      "自然语言入口分类",
      "P-062",
      "用户体验 truth boundary",
      "P-063",
      "阶段执行说明",
      "P-064",
      "单一 PRD 源守卫",
      "P-065",
      "多语言阶段说明覆盖",
      "P-066",
      "真实 conversation notice 发射",
      "P-067",
      "顺滑能力发现守卫",
      "P-068",
      "治理 Agent live result packet",
      "P-069",
      "执行 owner / 多能力 live execution evidence",
      "P-070",
      "项目能力资产沉淀 validator",
      "不能新增第二份 backlog / PRD",
    ]) {
      assert.match(prd, new RegExp(marker), `missing natural-language PRD marker ${marker}`);
    }

    assert.equal(
      existsSync(
        path.join(REPO_ROOT, "config", "governance", "human-readable-ambiguity-remediation.json"),
      ),
      false,
      "human-readable remediation must not live as a second PRD/backlog source",
    );
  });

  test("keeps the PRD local-private and out of GitHub-visible paths", () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");

    assert.match(gitignore, /^docs\/\*\*$/m);
    assert.doesNotMatch(
      gitignore,
      /^!docs\/ai-native-capability-gap-mvp-prd\.zh-CN\.md$/m,
      "the local PRD must not be unignored for GitHub publication",
    );
  });

  test("tracks the four next product targets with status and done standards", () => {
    for (const marker of [
      "T-001",
      "默认 meta-theory orchestration runtime path",
      "T-002",
      "Claude / Codex / Cursor / OpenClaw 四端投影验证",
      "T-003",
      "Warden 审批后的真实长期 writeback 流程",
      "T-004",
      "用户可读 UI / 报告层",
      "T-005",
      "AI 可读产品标准",
      "Definition of Done",
      "orchestrationTaskBoardPacket",
      "workerTaskPackets",
      "approved-for-writeback",
      "按 runId 查看",
      "设计、执行、验收、反馈、交付内容",
      "Codex orchestration live artifact pass",
      "Cursor live harness",
      "全 meta agents shard live evidence",
    ]) {
      assert.match(prd, new RegExp(marker), `missing target marker ${marker}`);
    }
  });

  test("tracks a granular parallel work queue for unfinished runtime and product work", () => {
    for (const marker of [
      "### 可并行任务队列",
      "主窗口由 `meta-warden` / `meta-conductor` 保持总控",
      "可子窗口并行",
      "P-001",
      "Codex live prompt 最小化",
      "已测通",
      "P-002",
      "Codex session recovery",
      "codex_live_timeout",
      "sessionRecoveryHint",
      "META_KIM_CODEX_LIVE_TIMEOUT_FIXTURE=1",
      "recoveredFromTimeout = true",
      "P-003",
      "Codex 主窗口 / 子窗口隔离复测",
      "019e9163-31ec-7510-86f9-9fc645c95811",
      "019e916e-4782-7081-ae57-740b4c3bf1b2",
      "第二轮 PASS",
      "无新增文件改动",
      "P-004",
      "Cursor native live-turn harness 设计",
      "P-005",
      "Cursor native live-turn harness 兼容边界",
      "P-006",
      "Claude 全 meta agents shard",
      "P-007",
      "OpenClaw 全 meta agents shard",
      "P-008",
      "四端 evidence aggregator",
      "P-009",
      "runtime failure taxonomy",
      "P-010",
      "真实 Warden approval packet",
      "P-011",
      "当前 repo canonical writeback dry-run",
      "P-012",
      "Web/UI 产品面板原型",
      "P-013",
      "报告可读性 review",
      "P-014",
      "AI 可读评分表导出",
      "P-015",
      "多 gap 混合需求 fixture",
      "P-016",
      "orchestration board 并行/线性计划质量门",
      "P-017",
      "深度研究前置门",
      "P-018",
      "multi-type capability inventory 质量门",
      "P-019",
      "skill 触发入口边界",
      "P-020",
      "同类型多需求拆分",
      "P-021",
      "非 agent 能力候选站点质量门",
      "stationCoverage",
      "npm run meta:gap:validate-board",
      "npm run meta:gap:score-candidates",
      "P-022",
      "产品面板数据合同",
      "config/contracts/run-report-panel-contract.json",
      "runReportPanelContract",
      "P-023",
      "AI 可读案例包",
      "P-024",
      "Cursor compatibility native live 待验证",
      "当前主干闭合顺序",
      "当前可并行批次",
      "Runtime evidence",
      "Orchestration quality",
      "User deliverable",
      "Release closure",
    ]) {
      assert.match(prd, new RegExp(marker), `missing parallel queue marker ${marker}`);
    }
  });

  test("records orchestration quality completion and GitHub delta", () => {
    for (const marker of [
      "编排质量轨",
      "tests/meta-theory/33-capability-gap-orchestration-quality.test.mjs",
      "当前 GitHub 差距",
      "P-015 到 P-021 编排质量轨",
      "不能宣称 Claude/Codex/Cursor/OpenClaw 全工具端兼容完成",
      "P-012 / P-013 / P-014 / P-023",
      "P-024 Cursor native live pass 仍是低优先级 compatibility 待验证项",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.16 marker ${marker}`);
    }
  });

  test("keeps panel data contract completion without overclaiming runtime completion", () => {
    for (const marker of [
      "P-022 产品面板数据合同",
      "runReportPanelContract",
      "decision summary",
      "owner handoff",
      "blocked reason",
      "runtime evidence",
      "approval request",
      "readable rubric",
      "deliverables",
      "P-012 / P-013 / P-014 / P-023",
      "不能把某一类交付物冒充另一类",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.17 panel marker ${marker}`);
    }
  });

  test("records user deliverables completion while keeping Cursor compatibility pending", () => {
    for (const marker of [
      "npm run meta:theory:deliverables",
      "run-panel.html",
      "readability-review.zh-CN.md",
      "ai-readable-rubric.zh-CN.md",
      "ai-readable-rubric.json",
      "ai-readable-case-pack.zh-CN.md",
      "tests/meta-theory/34-run-deliverables.test.mjs",
      "P-012 / P-013 / P-014 / P-023 用户交付轨",
      "P-024 Cursor native live pass 仍是低优先级 compatibility 待验证项",
      "用户交付轨已有面板数据合同、静态 Web/UI、可读性 review、AI 可读评分表和案例包",
      "后续只能扩展真实 reviewer 样本，不能把某一类交付物冒充另一类",
    ]) {
      assert.match(prd, new RegExp(marker), `missing deliverable marker ${marker}`);
    }
  });

  test("records all meta agents shard evidence with Cursor compatibility still pending", () => {
    for (const marker of [
      "P-006 / P-007 全 meta agents shard live evidence",
      "P-024 Cursor native live pass 仍是低优先级 compatibility 待验证项",
      "Claude 和 OpenClaw 全九个 meta agents shard live evidence 已闭合",
      "P-006",
      "9/9 agentResults ok",
      "runtimeEvidencePacket.failureClasses.claude = \"pass\"",
      "P-007",
      "minimax-portal/MiniMax-M3",
      "hooks 4/4 ready",
      "批量模式出现过 timeout",
      "验收口径采用单 shard 证据而非虚报整批 pass",
      "all meta agents shard live pass",
      "无 OpenClaw shard 剩余动作；保留批量 timeout 作为稳定性改进信号",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.19 runtime shard marker ${marker}`);
    }
  });

  test("records v0.20 Cursor WSL candidate while keeping native-live compatibility pending", () => {
    for (const marker of [
      "P-024 官方 WSL candidate probe",
      "官方 Windows WSL `cursor-agent`",
      "cursor-agent-wsl",
      "WSL Ubuntu 存在但 `command -v cursor-agent` 为空",
      "Windows native、Cursor IDE subcommand、官方 Windows WSL `cursor-agent` 三个候选",
      "Windows WSL 可用 `cursor-agent --version` 验证",
      "failureClass = \"native_harness_missing\"",
      "P-024 Cursor native live pass 仍是低优先级 compatibility 待验证项",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.20 Cursor marker ${marker}`);
    }
  });

  test("records expanded unfinished parallel backlog instead of collapsing to one blocker", () => {
    for (const marker of [
      "版本：v0.37",
      "未完成但可并行推进的扩展 / 解阻队列",
      "P-025",
      "Cursor WSL live 只读验收候选",
      "P-026",
      "Cursor 官方文档 source-backed refresh",
      "P-027",
      "Cursor native success fixture",
      "P-028",
      "GitHub 差距自动报告",
      "P-029",
      "跨 run 趋势服务化面板",
      "P-030",
      "AI 可读 reviewer 样本回放",
      "P-031",
      "真实 Warden approved canonical writeback",
      "P-032",
      "OpenClaw batch live 稳定性改进",
      "P-033",
      "runtime live shard 自动化矩阵",
      "P-034",
      "子窗口验收包模板",
      "P-035",
      "真实复杂输入扩展集",
      "P-036",
      "PRD 状态完整性守卫",
      "P-037",
      "深度研究准备层产品化",
      "P-038",
      "多类型能力库存浏览器",
      "P-039",
      "编排 DAG 可视化与依赖模拟",
      "P-040",
      "workerTask 输出合同与返工策略",
      "P-041",
      "真实用户纠错 replay 池",
      "P-042",
      "反馈入口与状态闭环",
      "P-043",
      "Warden 审批体验面板",
      "P-044",
      "runtime 解阻安装/验收手册",
      "P-045",
      "产品交付包打包",
      "P-046",
      "reviewer 校准样本",
      "P-047",
      "真实联网研究执行层",
      "P-048",
      "研究证据缓存与新鲜度策略",
      "P-049",
      "能力创新候选沙箱",
      "P-050",
      "DAG 串行依赖样本扩展",
      "P-051",
      "DAG 调度仿真与关键路径",
      "P-052",
      "workerTask 输出 schema registry",
      "P-053",
      "workerTask 返工 runner",
      "P-054",
      "Review / Meta-Review 双层接收门",
      "P-055",
      "用户反馈动作合同",
      "P-056",
      "反馈 replay 指标面板",
      "P-057",
      "Warden 审批 diff 预览与回滚演练",
      "P-058",
      "runtime probe 变体矩阵",
      "P-059",
      "产品交付 bundle CLI",
      "P-060",
      "reviewer 评分校准与反例库",
      "这些任务不会让当前 MVP 重新变成未完成",
    ]) {
      assert.match(prd, new RegExp(marker), `missing expanded backlog marker ${marker}`);
    }
  });

  test("records v0.22 closure for non-blocked parallel backlog items", () => {
    for (const marker of [
      "P-026 \\| R-008 \\| Cursor 官方文档 source-backed refresh[\\s\\S]*?\\| 已测通 \\|",
      "2026-06-05 官方文档复核",
      "cursor-agent",
      "--output-format json",
      "P-027 \\| R-008 \\| Cursor native success fixture[\\s\\S]*?\\| 已测通 \\|",
      "\\$env:META_KIM_CURSOR_LIVE_SUCCESS_FIXTURE='1'; node scripts/eval-meta-agents.mjs --runtime=cursor --live",
      "strictReleasePass = true",
      "P-028 \\| Release closure \\| GitHub 差距自动报告[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:github:gap",
      ".meta-kim/state/default/github-gap-report/latest.json",
      "P-034 \\| Verification \\| 子窗口验收包模板[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:verification:subwindows",
      ".meta-kim/state/default/subwindow-verification-packets/latest.json",
      "P-036 \\| PRD governance \\| PRD 状态完整性守卫[\\s\\S]*?\\| 已测通 \\|",
      "tests/meta-theory/35-release-closure-deliverables.test.mjs",
      "P-024 仍保持低优先级 compatibility native live 待验证",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.22 closure marker ${marker}`);
    }
  });

  test("records v0.23 runtime matrix and complex input closure", () => {
    for (const marker of [
      "P-033 \\| R-008 \\| runtime live shard 自动化矩阵[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:runtime:shard-matrix",
      ".meta-kim/state/default/runtime-live-shard-matrix/latest.json",
      "Claude / Codex / OpenClaw / Cursor",
      "releaseGradeCandidate",
      "Cursor compatibility pending 与 fixture-only 边界",
      "P-035 \\| R-001/R-007/R-011 \\| 真实复杂输入扩展集[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:gap:complex-inputs",
      ".meta-kim/state/default/complex-capability-gap-inputs/latest.json",
      "10/10 pass",
      "research-first、multi-capability、approval-blocked、workerTask-only",
      "P-033 / P-035",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.23 marker ${marker}`);
    }
  });

  test("records v0.24 external product reviewer replay closure", () => {
    for (const marker of [
      "P-030 \\| R-011 \\| AI 可读 reviewer 样本回放[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:reviewer:replay",
      ".meta-kim/state/default/product-reviewer-replay/latest.json",
      "3 个 reviewer 样本",
      "五维评分",
      "6 条误解点与修订建议",
      "fixture pass、release-grade、GitHub complete、Warden approval",
      "P-026 / P-027 / P-028 / P-029 / P-030 / P-031 / P-032 / P-033 / P-034 / P-035 / P-036 / P-037 / P-038 / P-039 / P-040 / P-041 / P-042 / P-043 / P-044 / P-045 / P-046 / P-047 / P-048 / P-049 / P-050 / P-051 / P-052 / P-053 / P-054 / P-055 / P-056 / P-057 / P-058 / P-059 / P-060 / P-061 / P-062 / P-063 / P-064 / P-065 / P-066 已测通",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.24 marker ${marker}`);
    }
  });

  test("records v0.25 wider parallel product backlog", () => {
    for (const marker of [
      "P-025 到 P-060 并行扩展队列",
      "本 PRD v0.37 的状态更新",
      "P-025 到 P-070 队列",
      "researchPreparationPacket",
      "研究完才编排",
      "避免把 capability 简化成 skill",
      "fake parallelism 计数为 0",
      "schema 不合格",
      "至少 12 条 correction replay",
      "反馈是否影响下一轮 route",
      "未提供审批包时必须生成 `approvalRequest`",
      "runtime 解阻安装/验收手册",
      "一条命令生成 bundle manifest",
      "能力不等于 skill",
      "真实联网研究、反馈闭环、审批体验、runtime probe 变体、交付打包、reviewer 校准",
      "P-024 兼容验证前不能宣称全 runtime release-grade 完成",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.25 marker ${marker}`);
    }
  });

  test("records v0.26 research preparation closure", () => {
    for (const marker of [
      "P-037 \\| R-007/R-010 \\| 深度研究准备层产品化[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:research:prepare",
      ".meta-kim/state/default/research-preparation/latest.json",
      "4/4 case pass",
      "current-fact、official docs、external MCP provider、local-only、blocked paid/credential boundary",
      "searchAngles、sourceList、freshness、credibility、blockedReason、decisionImpactMap、thinkingHandoff",
      "研究完才编排",
      "已完成 P-037",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.26 marker ${marker}`);
    }
  });

  test("records v0.27 multi-type capability browser closure", () => {
    for (const marker of [
      "本 PRD v0.37 的状态更新",
      "P-038 \\| R-007/R-010 \\| 多类型能力库存浏览器[\\s\\S]*?\\| 已测通（旧十类浏览器） \\|",
      "npm run meta:capabilities:browser",
      ".meta-kim/state/default/multi-type-capability-browser/latest.json",
      "10/10 legacy capability types covered",
      "237 个候选",
      "skillOnly = false",
      "核心类别优先",
      "不把 MCP/tools 继续压成旧十类",
      "已完成 P-038",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.27 marker ${marker}`);
    }
  });

  test("records v0.37 smooth capability discovery without swallowing MCP or tools", () => {
    for (const marker of [
      "版本：v0.37",
      "核心能力类别",
      "默认发现粒度要顺滑",
      "MCP 和 tools 是足够重要的一等类别",
      "MCP",
      "tools",
      "no_expansion_needed",
      "permissionBoundary",
      "verificationOwner",
      "按需展开",
      "workerResult",
      "把未验证 MCP/tools 冒充已调用",
      "P-067",
      "顺滑能力发现守卫",
      "P-068",
      "治理 Agent live result packet",
      "P-069",
      "执行 owner / 多能力 live execution evidence",
      "P-070",
      "项目能力资产沉淀 validator",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.37 capability marker ${marker}`);
    }

    for (const marker of [
      "orchestration_artifact_pass",
      "projection_smoke",
      "live_governance_agent_pass",
      "live_execution_pass",
      "degradedFlag=true",
      "governanceAgentResultPackets",
      "workerResultPackets",
      "workerExecutionEvidence",
      "只有 board、workerTaskPackets、schema、中文报告、SQLite event 或 projection smoke",
    ]) {
      assert.match(prd, new RegExp(marker), `missing evidence layering marker ${marker}`);
    }

    assert.doesNotMatch(
      prd,
      /Codex \| live pass/,
      "Codex orchestration artifact must not be labeled as generic live pass",
    );
    assert.doesNotMatch(
      prd,
      /Complete product MVP 已经在本地证明/,
      "local orchestration MVP must not overclaim complete execution",
    );
  });

  test("records v0.38 research-to-native and framework prompt architecture direction", () => {
    for (const marker of [
      "版本：v0.38",
      "AI-native research-to-native content loop",
      "Framework prompt architecture",
      "v0.38 下一步迭代方向：Research-to-Native Content Loop",
      "清晰目标定义",
      "项目整理审计结论",
      "外部研究到原生落点",
      "框架型提示词最优写法",
      "ordinary task prompt",
      "framework prompt",
      "System / developer instruction",
      "AGENTS.md / project rules",
      "Canonical agent prompt / SOUL",
      "Skill prompt",
      "Workflow / contract prompt",
      "Runtime adapter prompt",
      "Eval / fixture prompt",
      "Research-to-native adoption coverage",
      "AI technology adoption matrix completeness",
      "Prompt asset layer coverage",
      "Prompt executability validator pass rate",
      "Prompt eval fixture coverage",
      "Prompt ambiguity repeat rate",
      "Long-context source attribution coverage",
      "Research-to-native",
      "Prompt architecture",
      "可观测",
      "性能预算",
      "P-071",
      "Research-to-native 内容准入合同",
      "P-072",
      "AI 技术采纳矩阵 validator",
      "P-073",
      "MCP provider maturity and conformance profile",
      "P-074",
      "Trace/eval control-plane",
      "P-075",
      "Structured output first-pass validity",
      "P-076",
      "Prompt-injection resilient execution boundary",
      "P-077",
      "AG-UI style user-visible stage events",
      "P-078",
      "A2A candidate interop probe",
      "P-079",
      "i18n native-content expansion",
      "P-080",
      "Performance/cost budget",
      "P-081",
      "Framework prompt architecture contract",
      "P-082",
      "Prompt asset review matrix",
      "P-083",
      "Prompt eval and regression suite",
      "P-084",
      "Context engineering and prompt sprawl budget",
      "P-071 到 P-084 队列",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.38 research/prompt marker ${marker}`);
    }

    for (const marker of [
      "OpenAI / Anthropic / Google / Microsoft prompt guidance",
      "MCP 2025-11-25 spec / roadmap",
      "OpenTelemetry GenAI",
      "OWASP Agentic 2026 / NIST AI 600-1 / MITRE ATLAS / CaMeL",
      "source、native insertion point、why、metric、conflict/compat、verification",
      "无落点只能 reference-only",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.38 source/native marker ${marker}`);
    }
  });

  test("records v0.39 Claude Code and Codex primary prompt-first full flow priority", () => {
    for (const marker of [
      "版本：v0.39",
      "v0.39 主优先级修正：Claude Code \\+ Codex Prompt-First Full Flow",
      "Claude Code \\+ Codex 是 P0 主链路",
      "Cursor / OpenClaw 降为兼容项目",
      "OpenClaw 和 Cursor 继续保留兼容验证价值",
      "Runtime Priority Tiers",
      "Tier 0 primary",
      "Tier 1 compatibility",
      "Tier 2 compatibility",
      "Prompt-First Stage Required Content",
      "frameworkPromptPacket",
      "Perfection Gate",
      "Claude Code primary full-flow pass rate",
      "Codex primary full-flow pass rate",
      "Prompt-first required-content completeness",
      "Claude/Codex parity gap documentation",
      "Compatibility-priority leak count",
      "OpenClaw/Cursor primary release leak count",
      "Full-flow evidence overclaim count",
      "T-011",
      "Claude Code \\+ Codex prompt-first full-flow perfection",
      "P-085",
      "Claude Code \\+ Codex primary runtime priority contract",
      "P-086",
      "Prompt-first full-flow stage requirement contract",
      "P-087",
      "Claude Code full-flow live run",
      "P-088",
      "Codex full-flow live run",
      "P-089",
      "Claude/Codex parity reviewer",
      "P-090",
      "Prompt perfection validator",
      "P-091",
      "Full-flow no-overclaim gate",
      "P-092",
      "OpenClaw / Cursor compatibility demotion",
      "Primary runtime perfection",
      "Primary release closure",
      "All-tool compatibility closure",
      "P-024 只影响 all-tool compatibility claim",
      "P-024 只影响 all-tool compatibility，不阻塞 Claude Code \\+ Codex 主链路",
      "Cursor / OpenClaw compatibility pending 项必须留 remainingAction，但不进入 primary release decision",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.39 Claude/Codex priority marker ${marker}`);
    }

    assert.match(
      prd,
      /\| Primary release closure \| P-087 \/ P-088 \/ P-089 \/ P-090 \/ P-091 已测通 \|/,
      "primary release closure must stay tied to Claude Code + Codex evidence",
    );
  });

  test("records v0.40 PRD major-category deep research gate", () => {
    for (const marker of [
      "版本：v0.40",
      "v0.40 PRD 大类型 Deep Research Gate",
      "PRD major category",
      "prdCategoryResearchPacket",
      "Product / requirements / discovery",
      "Prompt / context / agent runtime",
      "MCP / tools / providers",
      "Security / safety / red-team",
      "Eval / verification / observability",
      "Architecture / performance / i18n / release",
      "Atlassian PRD",
      "Nielsen Norman Group discovery",
      "ISO/IEC/IEEE 29148",
      "OpenAI prompt engineering",
      "Anthropic prompt engineering",
      "Google Gemini prompt design",
      "Anthropic context engineering",
      "OpenAI Agents SDK",
      "OpenTelemetry GenAI",
      "MCP specification",
      "MCP Release Candidate",
      "NSA MCP Security Design",
      "OWASP Top 10 for Agentic Applications 2026",
      "Google Cloud Well-Architected Framework",
      "PRD major-category research coverage",
      "Major-category source map completeness",
      "Model-knowledge-only PRD decision count",
      "Primary/official source coverage",
      "Counterevidence coverage",
      "Source freshness recorded",
      "Research-to-priority ordering violation",
      "PRD category research-backed",
      "No model-knowledge PRD decision gate",
      "T-012",
      "PRD major-category deep research gate",
      "P-093",
      "PRD category research packet contract",
      "P-094",
      "Major-category source map validator",
      "P-095",
      "Product / requirements / discovery research dossier",
      "P-096",
      "Prompt / context / agent runtime research dossier",
      "P-097",
      "MCP / tools / providers research dossier",
      "P-098",
      "Security / safety / red-team research dossier",
      "P-099",
      "Eval / verification / observability research dossier",
      "P-100",
      "Architecture / performance / i18n / release research dossier",
      "PRD category deep research",
      "P-093 到 P-100",
      "P-096 到 P-100 已测通",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.40 PRD category research marker ${marker}`);
    }

    assert.doesNotMatch(
      prd,
      /模型知识可以作为.*唯一依据/,
      "PRD category decisions must not allow model knowledge as the only evidence",
    );
  });

  test("records v0.41 local-private prompt acceptance research binding", () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");

    for (const marker of [
      "版本：v0.41",
      "v0.41 Prompt Acceptance Deep Research Binding",
      "docs/prompt-acceptance-deep-research.zh-CN.md",
      "local-private evidence artifact",
      "不是第二份 PRD",
      "promptAcceptanceResearchPacket",
      "prompt-acceptance-deep-research-2026-06-13",
      "Current Prompt Acceptance Baseline",
      "totalPromptLikeAssets",
      "27 pass",
      "2 partial",
      "7 research_required",
      "npm run meta:prompt:validate",
      "git check-ignore -v docs/prompt-acceptance-deep-research.zh-CN.md",
      "canonical governance prompt baseline 已通过",
      "不能宣称：所有 prompt 资产已完全验收通过",
      "Prompt acceptance deep research report",
      "local-private 且由 `.gitignore`",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.41 prompt acceptance marker ${marker}`);
    }

    assert.match(prd, /docs\/\*\*/);
    assert.match(gitignore, /^docs\/\*\*$/m);
    assert.doesNotMatch(
      gitignore,
      /^!docs\/prompt-acceptance-deep-research\.zh-CN\.md$/m,
      "prompt acceptance research report must stay local-private and ignored",
    );
  });

  test("records v0.42 abstract capability framework prompt acceptance closure", () => {
    for (const marker of [
      "版本：v0.42",
      "v0.42 Abstract Capability Framework Prompt Acceptance",
      "abstractCapabilityFrameworkPacket",
      "prompt-abstract-capability-contract",
      "scripts/validate-prompt-abstract-capabilities.mjs",
      "full project capability surface",
      "providerTypes",
      "modeledProviders",
      "runtimeCapabilityNames",
      "packageScripts",
      "localGlobalInventoryWhenPresent",
      "governance-orchestration",
      "capability-discovery-and-retrieval",
      "prompt-intake-optimization",
      "planning-continuity",
      "skill-agent-tool-creation",
      "runtime-native-surfaces",
      "execution-tools-and-commands",
      "mcp-external-provider-and-plugin",
      "memory-graph-and-observability",
      "safety-hooks-and-permissions",
      "verification-eval-and-release",
      "user-interaction-and-i18n",
      "planning-files-update-only",
      "hookprompt-no-route-override",
      "findskill-run-scoped",
      "creation-after-gap-proof",
      "native-ability-preservation",
      "provider-config-not-live-proof",
      "36 pass、0 partial、0 research_required",
      "36 pass, 0 partial, 0 research_required",
      "P-093 prompt acceptance scope 已测通",
      "P-094 已测通 source map validator",
      "P-095 已测通 Product / requirements / discovery dossier",
      "P-096 到 P-100 已测通",
      "不把 `findskill` / `hookprompt` / `planning-with-files` / `skill-creator` 当作全部通用能力",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.42 abstract capability marker ${marker}`);
    }

    assert.doesNotMatch(
      prd,
      /findskill.*hookprompt.*planning-with-files.*skill-creator[\s\S]{0,80}全部通用能力(?!，而是|，只是|例子)/,
      "PRD must not collapse the capability surface into four named examples",
    );
  });

  test("records v0.43 PRD major-category source map validator closure", () => {
    for (const marker of [
      "版本：v0.43",
      "v0.43 Major-Category Source Map Gate",
      "P-094 已测通",
      "prdCategorySourceMapPacket",
      "prd-category-source-map-contract",
      "scripts/validate-prd-category-source-map.mjs",
      "npm run meta:prd:source-map:validate",
      "source_map_ready_dossiers_pending",
      "P-095 到 P-100",
      "No model-knowledge PRD decision gate",
      "Category coverage",
      "Source evidence",
      "Freshness",
      "Counterevidence",
      "No model-knowledge PRD decision gate",
      "partial_dossiers_ready",
      "all_dossiers_ready",
      "P-096 到 P-100 已测通",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.43 source map marker ${marker}`);
    }
  });

  test("records v0.44 P-095 product requirements discovery dossier closure", () => {
    for (const marker of [
      "版本：v0.44",
      "v0.44 P-095 Product / Requirements / Discovery Dossier",
      "productRequirementsDiscoveryDossierPacket",
      "docs/prd-category-product-requirements-discovery-dossier.zh-CN.md",
      "scripts/validate-prd-product-requirements-discovery-dossier.mjs",
      "npm run meta:prd:product-discovery:validate",
      "dossier_ready",
      "partial_dossiers_ready",
      "Atlassian PRD",
      "Atlassian PRD template",
      "Nielsen Norman Group discovery",
      "ISO/IEC/IEEE 29148",
      "Jira Product Discovery ideas",
      "problemStatement",
      "targetUsersOrStakeholders",
      "sourceBackedEvidence",
      "successCriteria",
      "requirementTraceability",
      "definitionOfDone",
      "No model-knowledge PRD decision gate",
      "P-095 已测通",
      "v0.45 已继续闭合这些剩余大类",
      "Product / requirements / discovery 大类已有 source-backed dossier",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.44 P-095 dossier marker ${marker}`);
    }
  });

  test("records v0.45 P-096 to P-100 PRD category dossier closure", () => {
    for (const marker of [
      "版本：v0.45",
      "v0.45 P-096 到 P-100 PRD Category Dossiers",
      "allPrdCategoryDossiersPacket",
      "remainingPrdCategoryDossiersPacket",
      "all_dossiers_ready",
      "P-096 到 P-100 已测通",
      "scripts/validate-prd-remaining-category-dossiers.mjs",
      "tests/governance/prd-remaining-category-dossiers.test.mjs",
      "npm run meta:prd:all-dossiers:validate",
      "npm run meta:prd:remaining-dossiers:validate",
      "promptContextAgentRuntimeDossierPacket",
      "mcpToolsProvidersDossierPacket",
      "securitySafetyRedTeamDossierPacket",
      "evalVerificationObservabilityDossierPacket",
      "architecturePerformanceI18nReleaseDossierPacket",
      "docs/prd-category-prompt-context-agent-runtime-dossier.zh-CN.md",
      "docs/prd-category-mcp-tools-providers-dossier.zh-CN.md",
      "docs/prd-category-security-safety-red-team-dossier.zh-CN.md",
      "docs/prd-category-eval-verification-observability-dossier.zh-CN.md",
      "docs/prd-category-architecture-performance-i18n-release-dossier.zh-CN.md",
      "npm run meta:prd:prompt-runtime:validate",
      "npm run meta:prd:mcp-tools:validate",
      "npm run meta:prd:security-safety:validate",
      "npm run meta:prd:eval-observability:validate",
      "npm run meta:prd:architecture-release:validate",
      "P-096 已测通",
      "P-097 已测通",
      "P-098 已测通",
      "P-099 已测通",
      "P-100 已测通",
      "No model-knowledge PRD decision gate",
      "不能把这些 PRD dossier 当成治理 Agent \\+ 执行 Agent 实机闭环证据",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.45 P-096..P-100 dossier marker ${marker}`);
    }
  });

  test("records v0.46 P-086 prompt-first full-flow stage requirement contract closure", () => {
    for (const marker of [
      "版本：v0.46",
      "v0.46 P-086 Prompt-First Full-Flow Stage Requirement Contract",
      "promptFirstFullFlowStageRequirementPacket",
      "config/contracts/prompt-first-full-flow-stage-contract.json",
      "scripts/validate-prompt-first-full-flow-stage-contract.mjs",
      "tests/governance/prompt-first-full-flow-stage-contract.test.mjs",
      "npm run meta:prd:prompt-first-flow:validate",
      "P-086 已测通",
      "contract_ready",
      "Prompt intake",
      "frameworkPromptPacket",
      "intentPacket",
      "fetchPacket",
      "thinkingPacket",
      "workerTaskPackets",
      "workerResultPackets",
      "workerExecutionEvidence",
      "reviewPacket",
      "metaReviewPacket",
      "verificationResult",
      "evolutionWritebackPacket",
      "missingRequiredContentCount = 0",
      "sameFrameworkPromptRequired",
      "command pass is not userGoalDone",
      "P-087",
      "P-088",
      "仍不能宣称 Claude Code \\+ Codex prompt-first full-flow live execution 已 release-grade 完成",
      "P-087 / P-088 必须实际产出同一 framework prompt 下的 live artifacts",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.46 P-086 full-flow contract marker ${marker}`);
    }
  });

  test("records v0.47 P-087 to P-091 prompt-first live acceptance closure", () => {
    for (const marker of [
      "版本：v0.47",
      "v0.47 P-087 到 P-091 Prompt-First Live Acceptance Closure",
      "promptFirstLiveAcceptancePacket",
      "config/contracts/prompt-first-live-acceptance-contract.json",
      "scripts/run-prompt-first-full-flow-live-acceptance.mjs",
      "tests/governance/prompt-first-live-acceptance.test.mjs",
      "npm run meta:prd:prompt-first-live:validate",
      "npm run meta:prd:prompt-first-live:run",
      ".meta-kim/state/default/prompt-first-full-flow-live-acceptance/latest.json",
      "P-087 已测通",
      "P-088 已测通",
      "P-089 已测通",
      "P-090 已测通",
      "P-091 已测通",
      "primaryRuntimePerfection = true",
      "runtime_live_pass",
      "compatibility_smoke_pass",
      "Compatibility smoke 已测通",
      "compatibilitySmokePacket",
      "compatibilitySmokeRuntimes",
      "node scripts/eval-meta-agents.mjs --runtime=openclaw",
      "node scripts/eval-meta-agents.mjs --runtime=cursor",
      "smokeFailureBlocksAcceptanceRun",
      "cannotClaimPrimaryLivePass",
      "OpenClaw/Cursor smoke 不等于 primary live pass",
      "fixture_pass_not_live",
      "same frameworkPromptPacket",
      "Evidence overclaim count = 0",
      "prompt layering violation count = 0",
      "Claude Code \\+ Codex prompt-first full-flow perfection \\| 已测通",
      "仍不能宣称 Claude/Codex/Cursor/OpenClaw 全工具端兼容完成",
      "不能把 fixture pass 冒充 live pass",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.47 prompt-first live acceptance marker ${marker}`);
    }
  });

  test("records v0.68 strict live normalization correction for prompt-first acceptance", () => {
    for (const marker of [
      "v0.68 correction",
      "strict live normalization",
      "Codex P-088 live pass",
      "Claude Code P-087 blocked",
      "P-089 parity fail",
      "P-091 fail",
      "primaryRuntimePerfection = false",
      "prompt-first live normalization does not synthesize Review Meta-Review or Evolution pass packets",
      "harness fallback",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.68 strict live correction marker ${marker}`);
    }
  });

  test("records v0.48 P-068 to P-070 default governance and execution evidence closure", () => {
    for (const marker of [
      "版本：v0.48",
      "v0.48 P-068/P-069/P-070 默认治理 \\+ 执行 evidence closure",
      "npm run meta:prd:default-execution:validate",
      "npm run meta:prd:asset-sedimentation:validate",
      "config/contracts/capability-asset-sedimentation-contract.json",
      "scripts/validate-default-governed-execution-evidence.mjs",
      "scripts/validate-capability-asset-sedimentation.mjs",
      "9 个 `governanceAgentResultPackets\\[\\]`",
      "Conductor 消费 8 个治理包",
      "4 个 `workerResultPackets\\[\\]`",
      "4 个 `workerExecutionEvidence\\[\\]`",
      "execution agent、skill、script、MCP provider、runtime tool、hook、memory/graph、dependency provider、worker_task_only 九类能力",
      "canonicalWritesWithoutApproval = 0",
      "P-068 \\| T-006/R-007[\\s\\S]*?\\| 已测通 \\|",
      "P-069 \\| T-007/R-007[\\s\\S]*?\\| 已测通（默认 run-scoped local execution） \\|",
      "P-070 \\| T-008/R-009[\\s\\S]*?\\| 已测通 \\|",
      "不能把默认本地证据扩大成 Cursor native live",
      "不等于 Cursor native live 或 all-runtime release-grade",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.48 default evidence closure marker ${marker}`);
    }
  });

  test("records v0.49 P-071 to P-084 research-to-native and prompt architecture productization closure", () => {
    for (const marker of [
      "版本：v0.49",
      "v0.49 P-071 到 P-084 Research-to-native \\+ framework prompt architecture productization closure",
      "config/contracts/research-to-native-productization-contract.json",
      "config/contracts/framework-prompt-architecture-contract.json",
      "scripts/validate-research-to-native-productization.mjs",
      "scripts/validate-framework-prompt-architecture.mjs",
      "npm run meta:prd:research-native:validate",
      "npm run meta:prd:prompt-architecture:validate",
      "traceEvalControlPlane",
      "agUiStageEvents",
      "performanceCostBudget",
      "contextEngineeringBudget",
      "source、native insertion point、why、metric、conflict/compat、verification",
      "A2A remains candidate-only",
      "MCP provider maturity profiles separate trust/auth/runtime/conformance",
      "Prompt asset review matrix 已产品化",
      "Prompt eval and regression suite 已产品化",
      "Context engineering and prompt sprawl budget 已产品化",
      "P-071 到 P-080 已测通",
      "P-081 到 P-084 已测通",
      "P-071 到 P-084 已测通",
      "P-071 \\| T-009/R-007[\\s\\S]*?\\| 已测通 \\|",
      "P-072 \\| T-009/R-011[\\s\\S]*?\\| 已测通 \\|",
      "P-073 \\| T-009/R-008[\\s\\S]*?\\| 已测通 \\|",
      "P-074 \\| T-009/R-004[\\s\\S]*?\\| 已测通 \\|",
      "P-075 \\| T-009/R-001[\\s\\S]*?\\| 已测通 \\|",
      "P-076 \\| T-009/R-008[\\s\\S]*?\\| 已测通 \\|",
      "P-077 \\| T-004/T-009[\\s\\S]*?\\| 已测通 \\|",
      "P-078 \\| T-009/R-007[\\s\\S]*?\\| 已测通（candidate-only） \\|",
      "P-079 \\| T-004/T-011[\\s\\S]*?\\| 已测通 \\|",
      "P-080 \\| T-009/R-004[\\s\\S]*?\\| 已测通 \\|",
      "P-081 \\| T-010/R-007[\\s\\S]*?\\| 已测通 \\|",
      "P-082 \\| T-010/R-011[\\s\\S]*?\\| 已测通 \\|",
      "P-083 \\| T-010/R-001[\\s\\S]*?\\| 已测通 \\|",
      "P-084 \\| T-010/R-004[\\s\\S]*?\\| 已测通 \\|",
      "仍不能宣称 Cursor native live 或 all-runtime release-grade",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.49 research/native prompt architecture marker ${marker}`);
    }

    assert.doesNotMatch(
      prd,
      /P-072 到 P-080 \/ P-082 到 P-084 未完成前不能宣称 research-to-native 与 prompt architecture 已产品化/,
      "old current-unfinished phrase must be removed after v0.49 closure",
    );
  });

  test("records v0.50 P-067 P-085 and P-092 capability discovery and runtime priority closure", () => {
    for (const marker of [
      "版本：v0.50",
      "v0.50 P-067/P-085/P-092 Capability Discovery \\+ Runtime Priority Closure",
      "config/contracts/smooth-capability-discovery-contract.json",
      "config/contracts/runtime-priority-and-compatibility-contract.json",
      "scripts/validate-smooth-capability-discovery.mjs",
      "scripts/validate-runtime-priority-and-compatibility.mjs",
      "npm run meta:prd:smooth-capability:validate",
      "npm run meta:prd:runtime-priority:validate",
      "P-067 已测通",
      "P-085 已测通",
      "P-092 已测通",
      "agent、skill、script、MCP、tool、hook、runtime、OS、memory、graph、external",
      "workerTaskPackets",
      "no_expansion_needed",
      "skill-only",
      "MCP 与 tools 作为一等能力",
      "runtime-priority-and-compatibility-contract",
      "compatibility-priority leak count = 0",
      "P-024 只影响 all-tool compatibility claim",
      "OpenClaw / Cursor compatibility demotion",
      "Cursor native live pending 只影响 all-tool compatibility closure",
      "P-067/P-085/P-092 已测通，但边界保持不变",
      "P-067 到 P-085 与 P-092 已测通",
      "P-085 到 P-092 primary scope 已测通",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.50 closure marker ${marker}`);
    }

    for (const marker of [
      "P-067 \\| T-006/T-008[\\s\\S]*?\\| 已测通 \\|",
      "P-085 \\| T-011/R-007/R-008[\\s\\S]*?\\| 已测通 \\|",
      "P-092 \\| T-002/T-011/R-008[\\s\\S]*?\\| 已测通 \\|",
      "T-009 \\| Research-to-native content loop \\| 已测通 \\|",
      "T-010 \\| Framework prompt architecture \\| 已测通 \\|",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.50 status marker ${marker}`);
    }

    assert.doesNotMatch(prd, /P-067[\s\S]{0,180}\| 进行中 \|/);
    assert.doesNotMatch(prd, /P-085[\s\S]{0,180}\| 进行中 \|/);
    assert.doesNotMatch(prd, /P-092[\s\S]{0,180}\| 进行中 \|/);
    assert.doesNotMatch(prd, /P-067 \/ P-092 进行中/);
  });

  test("records v0.28 orchestration DAG closure and wider parallel product lanes", () => {
    for (const marker of [
      "版本：v0.37",
      "P-039 \\| R-003/R-007 \\| 编排 DAG 可视化与依赖模拟[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:orchestration:dag",
      ".meta-kim/state/default/orchestration-dag/latest.json",
      "3 个 DAG case pass",
      "fakeParallelismCount = 0",
      "blocked node 可见",
      "Mermaid preview 可读",
      "已完成 P-039",
      "P-047 \\| R-007 \\| 真实联网研究执行层[\\s\\S]*?\\| 已测通 \\|",
      "P-048 \\| R-007/R-010 \\| 研究证据缓存与新鲜度策略[\\s\\S]*?\\| 已测通 \\|",
      "P-049 \\| R-007/R-009 \\| 能力创新候选沙箱[\\s\\S]*?\\| 已测通 \\|",
      "P-050 \\| R-003/R-007 \\| DAG 串行依赖样本扩展[\\s\\S]*?\\| 已测通 \\|",
      "P-051 \\| R-003/R-007 \\| DAG 调度仿真与关键路径[\\s\\S]*?\\| 已测通 \\|",
      "P-052 \\| R-001/R-007 \\| workerTask 输出 schema registry[\\s\\S]*?\\| 已测通 \\|",
      "P-053 \\| R-001/R-007 \\| workerTask 返工 runner[\\s\\S]*?\\| 已测通 \\|",
      "P-054 \\| R-008/R-011 \\| Review / Meta-Review 双层接收门[\\s\\S]*?\\| 已测通 \\|",
      "P-055 \\| R-002/R-010 \\| 用户反馈动作合同[\\s\\S]*?\\| 已测通 \\|",
      "P-056 \\| R-002/R-010/R-011 \\| 反馈 replay 指标面板[\\s\\S]*?\\| 已测通 \\|",
      "P-057 \\| R-009/R-010 \\| Warden 审批 diff 预览与回滚演练[\\s\\S]*?\\| 已测通 \\|",
      "P-058 \\| R-008 \\| runtime probe 变体矩阵[\\s\\S]*?\\| 已测通 \\|",
      "P-059 \\| R-010/R-011 \\| 产品交付 bundle CLI[\\s\\S]*?\\| 已测通 \\|",
      "P-060 \\| R-011 \\| reviewer 评分校准与反例库[\\s\\S]*?\\| 已测通 \\|",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.28 marker ${marker}`);
    }
  });

  test("records v0.29 orchestration scheduler closure", () => {
    for (const marker of [
      "版本：v0.37",
      "P-050 \\| R-003/R-007 \\| DAG 串行依赖样本扩展[\\s\\S]*?\\| 已测通 \\|",
      "P-051 \\| R-003/R-007 \\| DAG 调度仿真与关键路径[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:orchestration:schedule",
      ".meta-kim/state/default/orchestration-scheduler/latest.json",
      ".meta-kim/state/default/orchestration-scheduler/latest.zh-CN.md",
      "5 个 DAG case",
      "3 个有非空 dependsOn",
      "9 条 edge",
      "orphanDependencyCount = 0",
      "cycleCount = 0",
      "blockedDependencyViolationCount = 0",
      "criticalPath",
      "parallelUtilization",
      "serialBottleneck",
      "blockedWaitReason",
      "research -> capability -> execution -> review",
      "fanout-then-merge",
      "approval blocked wait reason",
      "已完成 P-050 / P-051",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.29 marker ${marker}`);
    }
  });

  test("records v0.30 workerTask output contract and retry closure", () => {
    for (const marker of [
      "版本：v0.37",
      "P-040 \\| R-001/R-007 \\| workerTask 输出合同与返工策略[\\s\\S]*?\\| 已测通 \\|",
      "P-052 \\| R-001/R-007 \\| workerTask 输出 schema registry[\\s\\S]*?\\| 已测通 \\|",
      "P-053 \\| R-001/R-007 \\| workerTask 返工 runner[\\s\\S]*?\\| 已测通 \\|",
      "config/contracts/worker-task-output-contract.json",
      "npm run meta:worker:outputs",
      ".meta-kim/state/default/worker-task-output/latest.json",
      ".meta-kim/state/default/worker-task-output/latest.zh-CN.md",
      "6 类 worker output schema",
      "required evidence",
      "failureClass",
      "returnToStage",
      "maxRetries",
      "Review 接收条件",
      "9 个 replay 样本全部 pass",
      "6 accept",
      "1 retry",
      "1 return_to_stage",
      "1 blocked",
      "缺 evidence",
      "owner 越界",
      "schema 不合格",
      "Review 不接收无 owner/evidence/schema 的输出",
      "已完成 P-040 / P-052 / P-053",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.30 marker ${marker}`);
    }
  });

  test("records v0.31 feedback loop and Review Meta-Review gate closure", () => {
    for (const marker of [
      "版本：v0.37",
      "P-041 \\| R-002/R-011 \\| 真实用户纠错 replay 池[\\s\\S]*?\\| 已测通 \\|",
      "P-042 \\| R-002/R-010 \\| 反馈入口与状态闭环[\\s\\S]*?\\| 已测通 \\|",
      "P-054 \\| R-008/R-011 \\| Review / Meta-Review 双层接收门[\\s\\S]*?\\| 已测通 \\|",
      "P-055 \\| R-002/R-010 \\| 用户反馈动作合同[\\s\\S]*?\\| 已测通 \\|",
      "P-056 \\| R-002/R-010/R-011 \\| 反馈 replay 指标面板[\\s\\S]*?\\| 已测通 \\|",
      "config/contracts/feedback-action-contract.json",
      "npm run meta:feedback:loop",
      ".meta-kim/state/default/feedback-loop/latest.json",
      ".meta-kim/state/default/feedback-loop/latest.zh-CN.md",
      "12 条 correction replay",
      "accept / correct / reject / promote_to_long_term / keep_one_time",
      "changedDecisionCount = 12",
      "repeatGapCount = 11",
      "reviewerConfusionReduced = 12",
      "reviewRejectedCount = 3",
      "polish-only review 返回 Review",
      "缺 Fetch 返回 Fetch",
      "缺 writeback boundary 置 blocked",
      "canonicalWritesWithoutApproval = 0",
      "已完成 P-041 / P-042 / P-054 / P-055 / P-056",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.31 marker ${marker}`);
    }
  });

  test("records product delivery bundle and reviewer calibration closure", () => {
    for (const marker of [
      "版本：v0.37",
      "P-045 \\| R-010/R-011 \\| 产品交付包打包[\\s\\S]*?\\| 已测通 \\|",
      "P-046 \\| R-011 \\| reviewer 校准样本[\\s\\S]*?\\| 已测通 \\|",
      "P-059 \\| R-010/R-011 \\| 产品交付 bundle CLI[\\s\\S]*?\\| 已测通 \\|",
      "P-060 \\| R-011 \\| reviewer 评分校准与反例库[\\s\\S]*?\\| 已测通 \\|",
      "config/contracts/product-delivery-bundle-contract.json",
      "npm run meta:delivery:bundle",
      ".meta-kim/state/default/product-delivery-bundle/latest.json",
      ".meta-kim/state/default/product-delivery-bundle/latest.zh-CN.md",
      "fileCount = 12",
      "panel、readability review、rubric、case pack、GitHub gap、runtime matrix、DAG report、research report、feedback report",
      "tests/meta-theory/scenarios/reviewer-calibration-samples.json",
      "8 个 reviewer 评分样本",
      "research-before-orchestration、skill-only capability、fake parallelism、fixture pass as live、unauthorized writeback、GitHub gap overclaim、Warden approval confusion、mixed deliverables",
      "privacyStatus = \"pass\"",
      "missingPitfalls = \\[\\]",
      "已完成 P-045 / P-046 / P-059 / P-060",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.35 marker ${marker}`);
    }
  });

  test("records live research execution, freshness, and innovation sandbox closure", () => {
    for (const marker of [
      "版本：v0.37",
      "P-047 \\| R-007 \\| 真实联网研究执行层[\\s\\S]*?\\| 已测通 \\|",
      "P-048 \\| R-007/R-010 \\| 研究证据缓存与新鲜度策略[\\s\\S]*?\\| 已测通 \\|",
      "P-049 \\| R-007/R-009 \\| 能力创新候选沙箱[\\s\\S]*?\\| 已测通 \\|",
      "config/contracts/research-execution-contract.json",
      "npm run meta:research:execute",
      ".meta-kim/state/default/research-execution/latest.json",
      ".meta-kim/state/default/research-execution/latest.zh-CN.md",
      "6 条研究样本",
      "4 条 live fetch",
      "2 条 blocked",
      "staleRefreshCount = 1",
      "2 个 innovationCandidatePacket",
      "canonicalWrites = 0",
      "已完成 P-047 / P-048 / P-049",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.35 research marker ${marker}`);
    }
  });

  test("records remaining backlog closure without clearing true blockers", () => {
    for (const marker of [
      "版本：v0.37",
      "P-029 \\| R-010 \\| 跨 run 趋势服务化面板[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:trend:panel",
      ".meta-kim/state/default/run-trend-panel/latest.json",
      "5 类 filter",
      "4 个 panel",
      "P-032 \\| R-008 \\| OpenClaw batch live 稳定性改进[\\s\\S]*?\\| 已测通 \\|",
      "P-031 \\| R-009 \\| 真实 Warden approved canonical writeback[\\s\\S]*?\\| 已测通 \\|",
      "file-inventory-skill-approved-writeback",
      "warden-approved-file-inventory-skill-2026-06-05",
      "canonicalWrites = 1",
      "canonical/skills/same-set-reusable-flow-for-project-file-inventor/SKILL.md",
      "npm run meta:openclaw:batch-stability",
      "expectedFailureClass = \"timeout\"",
      "releaseGradeCandidate = false",
      "P-043 \\| R-009/R-010 \\| Warden 审批体验面板[\\s\\S]*?\\| 已测通 \\|",
      "P-044 \\| R-008 \\| runtime 解阻安装/验收手册[\\s\\S]*?\\| 已测通 \\|",
      "P-057 \\| R-009/R-010 \\| Warden 审批 diff 预览与回滚演练[\\s\\S]*?\\| 已测通 \\|",
      "P-058 \\| R-008 \\| runtime probe 变体矩阵[\\s\\S]*?\\| 已测通 \\|",
      "npm run meta:warden:approval-panel",
      "currentRepoCanonicalWrites = 0",
      "rollbackVerified = true",
      "npm run meta:runtime:probe-playbook",
      "至少 12 个 runtime/environment variant",
      "18. 已完成 P-029 / P-032 / P-043 / P-044 / P-057 / P-058",
      "19. 已完成 P-031",
      "P-025 如需升级兼容证据再安装或暴露 Cursor Agent CLI",
      "P-024 兼容验证前不能宣称全 runtime release-grade 完成",
    ]) {
      assert.match(prd, new RegExp(marker), `missing v0.35 remaining backlog marker ${marker}`);
    }
  });

  test("records current live runtime evidence without overclaiming release-grade completion", () => {
    for (const marker of [
      "当前 live evidence matrix",
      "Claude",
      "live pass",
      "Codex",
      "orchestrationTaskBoardPacket.synthesisOwner",
      "workerTaskPackets\\[0\\].owner",
      "OpenClaw",
      "MiniMax M3",
      "Cursor",
      "native live compatibility pending",
      "cursor-live-turn-harness-v0.1",
      "native_harness_missing",
      "evidenceKind = \"unsupported\"",
      "不能当 release-grade native live pass",
    ]) {
      assert.match(prd, new RegExp(marker), `missing live evidence marker ${marker}`);
    }
  });

  test("defines AI-readable standards for product outputs", () => {
    for (const marker of [
      "AI 可读产品标准",
      "设计标准",
      "执行标准",
      "验收标准",
      "反馈标准",
      "交付内容标准",
      "人话问题",
      "通过标准",
      "失败标准",
      "requiredEvidence",
      "config/contracts/ai-readable-product-standards.json",
    ]) {
      assert.match(prd, new RegExp(marker), `missing AI-readable standard ${marker}`);
    }
  });

  test("keeps Capability Gap product settings in a single PRD source", () => {
    assert.equal(
      existsSync(path.join(REPO_ROOT, "docs", "meta-kim-capability-governance-langgraph-plan.zh-CN.md")),
      false,
      "Capability Gap / LangGraph product settings must not live in a second plan"
    );
    assert.match(prd, /单一产品源/);
    assert.match(prd, /不要再维护第二份 Capability Gap \/ LangGraph 产品设定文档/);
  });

  test("defines capability as a multi-type function stack, not skill-only", () => {
    for (const marker of [
      "能力口径",
      "不是 skill-only",
      "governance agent",
      "execution agent",
      "command",
      "script",
      "MCP",
      "tools",
      "hook/runtime adapter",
      "memory/graph",
      "retrieval/research",
      "dependency/external package",
      "workerTask",
      "workerResult",
      "multi-type capability inventory",
      "researchCapabilityDiscovery",
      "deepResearchPlan",
    ]) {
      assert.match(prd, new RegExp(marker), `missing multi-capability marker ${marker}`);
    }
  });

  test("keeps user goal prompt out of product PRD requirements", () => {
    assert.doesNotMatch(prd, /下一目标提示词/);
    assert.doesNotMatch(prd, /复制.*提示词/);
    });
  },
);
