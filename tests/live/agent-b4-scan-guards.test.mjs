import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentAcceptanceService } from "../../src/application/agent/agent-acceptance-service.mjs";
import { snapshotProjectBaseline } from "../../src/application/agent/agent-native-execution-service.mjs";

const KEY = "agent_scan_guard_0001";
const HANDOFF = "a".repeat(64);
const BIG_BYTES = 2 * 1024 * 1024 + 300_000; // just over the 2 MiB per-file limit

function sha(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function write(root, rel, content) {
  const target = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function bigAsset(fill = 7) {
  return Buffer.alloc(BIG_BYTES, fill);
}

// Fake B3 services: B4 only reads trusted state from them.
function createHarness({ baselineFiles, prepareWorktree }) {
  const projectRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "meta-kim-b4-scan-")));
  write(projectRoot, "README.md", "# shop\n");
  write(projectRoot, "docs/images/social-card.png", bigAsset());
  const worktree = path.join(projectRoot, ".claude-worktrees", "wt-scan");
  mkdirSync(worktree, { recursive: true });
  prepareWorktree(worktree);

  const trustedInput = {
    goal: "更新店铺说明",
    basis: { selectedStrategy: "minimal", selectionReason: "test" },
    envelope: { design: { system: { title: "scan guard", techStack: "" }, modules: [] } },
  };
  const workflowService = {
    inspectHandoff: async () => null,
    inspectDesign: async () => null,
    recordDesign: async () => null,
    getTrustedExecutionInput: () => trustedInput,
  };
  const nativeExecutionService = {
    inspect: async () => ({ status: "ready_for_review", handoffDigest: HANDOFF }),
    getTrustedExecutionState: () => ({
      idempotencyKey: KEY,
      handoffDigest: HANDOFF,
      nativeWorktreePath: worktree,
      baselineFiles: baselineFiles(projectRoot),
    }),
  };
  const service = createAgentAcceptanceService({
    projectRoot,
    workflowService,
    nativeExecutionService,
    launch: async () => ({ status: 0, stdout: "" }),
  });
  return { projectRoot, worktree, service };
}

function readmeBaseline(projectRoot) {
  const readme = readFileSync(path.join(projectRoot, "README.md"));
  // The B3 baseline never hashes files above 2 MiB, so the PNG is absent here.
  return { "README.md": { sha256: sha(readme), bytes: readme.length } };
}

test("B4 accepts a draft that leaves an existing oversize asset untouched", async () => {
  const { projectRoot, service } = createHarness({
    baselineFiles: readmeBaseline,
    prepareWorktree(worktree) {
      write(worktree, "README.md", "# shop\n\n欧洲站上线说明。\n");
      write(worktree, "docs/images/social-card.png", bigAsset());
    },
  });
  try {
    const verified = await service.verifyArtifacts({ idempotencyKey: KEY });
    assert.equal(verified.status, "awaiting_human_b4", verified.reason ?? verified.nextAction);
    assert.deepEqual(verified.forbiddenPaths, []);
    assert.deepEqual(verified.oversizePaths, []);
    assert.deepEqual(verified.changedFiles.map((item) => item.path), ["README.md"]);

    const accepted = await service.decide({
      idempotencyKey: KEY,
      decisionKey: "agent_scan_decide_0001",
      handoffDigest: HANDOFF,
      artifactsDigest: verified.artifactsDigest,
      action: "accept",
    });
    assert.equal(accepted.status, "accepted_and_integrated");
    assert.match(readFileSync(path.join(projectRoot, "README.md"), "utf8"), /欧洲站上线说明/u);
    assert.equal(readFileSync(path.join(projectRoot, "docs/images/social-card.png")).length, BIG_BYTES);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("B4 blocks only a changed oversize file and says it is too large", async () => {
  const { projectRoot, service } = createHarness({
    baselineFiles: readmeBaseline,
    prepareWorktree(worktree) {
      write(worktree, "README.md", "# shop\n");
      write(worktree, "docs/images/social-card.png", bigAsset(9));
    },
  });
  try {
    const inspected = await service.inspect({ idempotencyKey: KEY });
    assert.equal(inspected.status, "blocked");
    assert.equal(inspected.reason, "worktree_changed_file_too_large");
    assert.deepEqual(inspected.oversizePaths, ["docs/images/social-card.png"]);
    assert.deepEqual(inspected.forbiddenPaths, []);
    assert.match(inspected.nextAction, /超过 2 MB 上限/u);
    assert.doesNotMatch(inspected.nextAction, /产物已变化/u);

    await assert.rejects(
      service.decide({
        idempotencyKey: KEY,
        decisionKey: "agent_scan_decide_0002",
        handoffDigest: HANDOFF,
        artifactsDigest: inspected.artifactsDigest,
        action: "accept",
      }),
      (error) => error.reason === "agent_b4_changed_file_too_large",
    );
    assert.equal(readFileSync(path.join(projectRoot, "docs/images/social-card.png"))[0], 7);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("B4 hard-fails a worktree above the scan limit instead of treating unscanned files as deleted", async () => {
  const { projectRoot, service } = createHarness({
    baselineFiles(root) {
      write(root, "zz/keep.txt", "must survive\n");
      const keep = readFileSync(path.join(root, "zz/keep.txt"));
      return { ...readmeBaseline(root), "zz/keep.txt": { sha256: sha(keep), bytes: keep.length } };
    },
    prepareWorktree(worktree) {
      write(worktree, "README.md", "# shop\n");
      write(worktree, "zz/keep.txt", "must survive\n");
      // Sorted before zz/, these push the baseline file past a 2,500-file scan.
      for (let index = 0; index < 2_500; index += 1) {
        write(worktree, `aa/generated-${String(index).padStart(4, "0")}.txt`, `${index}\n`);
      }
    },
  });
  try {
    const inspected = await service.inspect({ idempotencyKey: KEY });
    assert.equal(inspected.status, "blocked");
    assert.equal(inspected.reason, "worktree_scan_limit_exceeded");
    assert.match(inspected.nextAction, /扫描上限/u);
    assert.deepEqual(inspected.changedFiles, []);

    const verified = await service.verifyArtifacts({ idempotencyKey: KEY });
    assert.equal(verified.status, "blocked");
    assert.equal(verified.reason, "worktree_scan_limit_exceeded");

    await assert.rejects(
      service.decide({
        idempotencyKey: KEY,
        decisionKey: "agent_scan_decide_0003",
        handoffDigest: HANDOFF,
        artifactsDigest: "b".repeat(64),
        action: "accept",
      }),
      (error) => error.reason === "agent_b4_scan_limit_exceeded",
    );
    assert.equal(readFileSync(path.join(projectRoot, "zz/keep.txt"), "utf8"), "must survive\n");
    assert.equal(existsSync(path.join(projectRoot, "aa")), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("B3 baseline snapshot reports truncation instead of returning a partial file map", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-b3-baseline-"));
  try {
    for (const name of ["a.txt", "b.txt", "c.txt"]) write(root, name, name);
    const complete = snapshotProjectBaseline(root, { maxFiles: 3 });
    assert.equal(complete.truncated, false);
    assert.deepEqual(Object.keys(complete.files).sort(), ["a.txt", "b.txt", "c.txt"]);

    write(root, "d.txt", "d");
    const partial = snapshotProjectBaseline(root, { maxFiles: 3 });
    assert.equal(partial.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
