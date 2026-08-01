import process from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFromStdin } from "./utils.mjs";
import {
  projectRootCandidatesFromPayload,
  resolveProjectRoot,
} from "./project-root.mjs";
import {
  readSpineState,
  readSpineStateIncludingInactive,
  activateSpineState,
  createInitialState,
  createProjectTaskIdentity,
  readExistingTaskIdentityBinding,
} from "./spine-state.mjs";

const cwd = process.cwd();
const payload = await readJsonFromStdin();
const toolName = payload?.tool_name ?? "";
const toolInput = payload?.tool_input ?? {};

// 开源场景：sync/setup 曾把 canonical 仓库根占位标记渲染成绝对路径，写到
// 全局/项目 settings 后跨机器即死路径。candidate 在用户机器不存在时，从脚本
// 自身位置往上找含 scripts/project-post-copy-init.mjs 的仓根。
function resolvePackageRoot(candidate) {
  if (candidate && existsSync(candidate)) return candidate;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "scripts", "project-post-copy-init.mjs"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const packageRootArgIndex = process.argv.indexOf("--package-root");
const rawPackageRoot =
  packageRootArgIndex >= 0 && process.argv[packageRootArgIndex + 1]
    ? process.argv[packageRootArgIndex + 1]
    : process.env.META_KIM_PACKAGE_ROOT || null;
const packageRoot = resolvePackageRoot(rawPackageRoot);

// 多 agent / 军团 / fan-out 触发词只说明任务可能适合拆分。它不能证明
// capability discovery 已执行，也不能替 Critical/Fetch/Thinking 推进阶段。
const MULTI_AGENT_TRIGGER_RE =
  /\b(?:team|fan-?out|multi-?agent|agent\s+teams|军团|分队|并行|并发|多\s*agent)\b|(?:开\s*\d+\s*个)/iu;
const LINKED_COMMAND_RE =
  /\/([a-z][a-z0-9_-]{1,40})/g;
const SKILL_NAME_RE =
  /\bskill[\s:：]+([a-z][a-z0-9_-]{1,40})/iu;

const EXPLICIT_META_THEORY_RE =
  /(?:^|\b)(?:\/?meta-theory|meta theory|run meta theory|execute meta theory)(?:\b|$)|元理论/u;
const CRITICAL_FETCH_THINKING_RE =
  /critical[\s\S]{0,80}fetch[\s\S]{0,80}thinking[\s\S]{0,80}review|critical\s+and\s+fetch\s+thinking\s+and\s+review|深度.*(?:fetch|检索|研究).*review|critical.*review/iu;
const CONTINUATION_REQUEST_RE =
  /\b(?:continue|resume|continuation|current\s+run|active\s+run|same\s+run)\b|(?:继续|续跑|接着|恢复|当前\s*run|active\s*run|同一个\s*run|不要重启|不重启)/iu;
const ACTION_RE =
  /\b(?:build|create|implement|fix|repair|change|update|refactor|plan|start|handle|organize|prioritize|verify|review|audit|generate|write|sync|release|publish|ship|commit|push)\b|(?:帮我|开始|处理|整理|规划|修复|验证|审查|检查|生成|写|改|优化|同步|提交|推送|发布|更新|实机测试)/iu;
const DURABLE_OUTPUT_RE =
  /\b(?:plan|checklist|priority|priorities|recommendation|recommendations|verification|audit|report|artifact|implementation|fixes|tests?|release notes?|changelog|version)\b|(?:优先级|修复建议|验证清单|计划|报告|产物|测试|清单|建议|更新记录|版本|发布)/iu;
const FILE_OR_MUTATION_RE =
  /\b(?:file|code|repo|repository|project|app|page|component|test|config|contract|script|hook|runtime|release|version)\b|(?:文件|代码|仓库|项目|页面|组件|测试|配置|合同|脚本|钩子|运行时|发布|版本)/iu;
const PRODUCT_BUILD_OBJECT_RE =
  /\b(?:app|web app|dashboard|platform|tool|saas|automation|publisher|scheduler|workflow)\b|(?:系统|平台|工具|应用|网站|面板|看板|自动发布器|发布器|营销.*器|自动化|工作流)/iu;
const PROJECT_UNDERSTANDING_RE =
  /\b(?:project|repo|repository|codebase|architecture|commerciali[sz]e|market|competitor|business model|strategy|roadmap)\b|(?:项目|仓库|代码库|架构|怎么玩|干啥|做什么|商业化|市场|竞品|商业模式|发展|路线图|战略)/iu;
const SUBJECTIVE_QUALITY_RE =
  /\b(?:good|bad|beautiful|ugly|smooth|professional|premium|advanced|clean|simple|fast|slow|feels off|hard to use)\b|(?:好看|不好看|顺畅|不顺|高级|专业|简洁|太慢|太快|难用|怪|不对劲)/iu;

const DEFAULT_STALE_MINUTES = 360;

function getRawPromptText() {
  const candidates = [
    payload?.prompt,
    payload?.user_prompt,
    payload?.hook_input?.prompt,
    payload?.hook_input?.user_prompt,
    payload?.input,
    payload?.text,
    payload?.message,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function getPromptText() {
  return getRawPromptText().toLowerCase();
}

function getSkillName() {
  return (
    toolInput?.skill_name ||
    toolInput?.name ||
    toolInput?.skill ||
    ""
  ).toLowerCase();
}

function classifyPromptActivation(promptText) {
  if (!promptText) {
    return {
      triggered: false,
      taskClassification: "empty_input",
      triggerReason: "empty_input",
    };
  }
  if (EXPLICIT_META_THEORY_RE.test(promptText)) {
    return {
      triggered: true,
      taskClassification: "meta_theory_explicit",
      triggerReason: "explicit_meta_theory",
    };
  }
  if (CRITICAL_FETCH_THINKING_RE.test(promptText)) {
    return {
      triggered: true,
      taskClassification: "meta_theory_auto",
      triggerReason: "critical_fetch_thinking_review_requested",
    };
  }
  const actionIntent = ACTION_RE.test(promptText);
  const durableOutputIntent = DURABLE_OUTPUT_RE.test(promptText);
  const fileOrMutationIntent = FILE_OR_MUTATION_RE.test(promptText);
  const productBuildIntent = actionIntent && PRODUCT_BUILD_OBJECT_RE.test(promptText);
  if (SUBJECTIVE_QUALITY_RE.test(promptText) && actionIntent) {
    return {
      triggered: true,
      taskClassification: "meta_theory_auto",
      triggerReason: "subjective_quality_ambiguous",
    };
  }
  if (actionIntent && (durableOutputIntent || fileOrMutationIntent || productBuildIntent)) {
    return {
      triggered: true,
      taskClassification: "meta_theory_auto",
      triggerReason: durableOutputIntent
        ? "natural_language_durable_work"
        : productBuildIntent
          ? "natural_language_product_build"
          : "natural_language_execution_work",
    };
  }
  if (PROJECT_UNDERSTANDING_RE.test(promptText)) {
    return {
      triggered: true,
      taskClassification: "meta_theory_auto",
      triggerReason: "project_understanding_requires_fetch",
    };
  }
  return {
    triggered: false,
    taskClassification: "unclassified_low_signal",
    triggerReason: "no_governance_trigger",
  };
}

function isMetaTheoryTrigger() {
  const skillName = getSkillName();
  if (toolName === "Skill" && skillName.includes("meta-theory")) {
    return {
      triggered: true,
      taskClassification: "meta_theory_auto",
      triggerReason: "skill_activation_auto",
    };
  }

  return classifyPromptActivation(getPromptText());
}

function detectPromptLanguage(promptText) {
  if (/[\u4e00-\u9fff]/u.test(promptText)) return "zh-CN";
  if (/[\u3040-\u30ff]/u.test(promptText)) return "ja-JP";
  if (/[\uac00-\ud7af]/u.test(promptText)) return "ko-KR";
  return "en";
}

function reportTaskIdentityRecoveryBoundary(status, promptText) {
  const language = detectPromptLanguage(promptText);
  const reason = status === "existing_key_invalid" ? "invalid" : "missing";
  const messages = {
    "zh-CN": `现有运行的任务身份密钥${reason === "invalid" ? "已损坏" : "缺失"}；为避免错误替换，已保持原运行不变。请显式恢复原密钥，或在确认放弃现有运行后重置当前 profile 的治理状态。`,
    "ja-JP": `既存実行のタスク識別キーが${reason === "invalid" ? "破損しています" : "見つかりません"}。誤った置換を防ぐため既存実行は変更していません。元のキーを明示的に復元するか、既存実行を破棄すると確認した後で現在の profile のガバナンス状態をリセットしてください。`,
    "ko-KR": `기존 실행의 작업 식별 키가 ${reason === "invalid" ? "손상되었습니다" : "없습니다"}. 잘못된 교체를 막기 위해 기존 실행을 변경하지 않았습니다. 원래 키를 명시적으로 복구하거나 기존 실행을 포기한 뒤 현재 profile의 거버넌스 상태를 재설정하세요.`,
    en: `The existing run's task identity key is ${reason}. The run was left unchanged to prevent an incorrect replacement. Explicitly restore the original key, or reset this profile's governance state only after confirming that the existing run may be abandoned.`,
  };
  process.stderr.write(
    `[meta-theory][task-identity-key-${reason}] ${messages[language] || messages.en}\n`,
  );
}

function staleMinutes() {
  const raw = Number.parseInt(process.env.META_KIM_SPINE_STALE_MINUTES || "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_STALE_MINUTES;
}

function ageMs(state) {
  const raw = state?.triggeredAt || state?.startedAt || state?.stageRuntimeControl?.createdAt;
  const time = raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Date.now() - time;
}

function isObservedState(state) {
  const control = state?.stageRuntimeControl || {};
  return (
    control.activationMode === "hook_observed" ||
    control.driverMode === "hook_observed" ||
    control.hookGateMode === "advisory" ||
    state?.activationMode === "hook_observed" ||
    state?.driverMode === "hook_observed" ||
    state?.hookGateMode === "advisory"
  );
}

function isManagedStageState(state) {
  const control = state?.stageRuntimeControl || {};
  return (
    control.driverMode === "managed" ||
    control.activationMode === "managed_stage_runtime" ||
    state?.driverMode === "managed"
  );
}

function shouldReplaceActiveState(existing, promptFingerprint) {
  if (!existing?.active) return true;

  const existingFingerprint =
    existing?.stageRuntimeControl?.promptFingerprint ||
    existing?.promptFingerprint ||
    null;
  if (existingFingerprint && existingFingerprint === promptFingerprint) return false;

  if (isObservedState(existing)) return true;

  const legacyWithoutControl = !existing.stageRuntimeControl;
  const staleCutoffMs = staleMinutes() * 60 * 1000;
  if (legacyWithoutControl && ageMs(existing) > staleCutoffMs) return true;

  return !isManagedStageState(existing) && ageMs(existing) > staleCutoffMs;
}

// ── EXECUTION_DELTA ─────────────────────────────────────────────────────────
// The block below this marker is the spine-activator's top-level flow. It is
// the only place that consumes the helpers above (isMetaTheoryTrigger,
// shouldReplaceActiveState, buildContinuationBoundary, etc.). Keep helper
// definitions and the EXECUTION_DELTA block in the same file so projection
// stays in sync; do not move shouldReplaceActiveState or its dependents
// across this boundary without re-running meta:sync + meta:validate.

function buildContinuationBoundary(previousState, promptText) {
  if (!previousState || previousState.active !== false) return null;
  if (!CONTINUATION_REQUEST_RE.test(promptText || "")) return null;

  return {
    status: "new_run_from_inactive_request",
    mode:
      previousState.deactivationReason === "session_stop"
        ? "session_stop_continuation_request"
        : "inactive_run_continuation_request",
    previousRunId: previousState.runId || null,
    previousActive: false,
    previousStage: previousState.currentStage || null,
    previousDeactivatedAt: previousState.deactivatedAt || null,
    previousDeactivationReason: previousState.deactivationReason || null,
    authority:
      "HookPrompt may preserve the user's continuation wording, but runtime state says the previous run is inactive.",
    requiredNextAction:
      "Reconcile current active-run/spine-state before claiming continuation; choose new governed run or offline audit if the previous run stopped.",
  };
}

function startPostCopyAutoInit(root) {
  if (process.env.META_KIM_POST_COPY_AUTO === "off") return;

  const globalScriptPath = packageRoot
    ? join(packageRoot, "scripts", "project-post-copy-init.mjs")
    : null;
  const scriptPath =
    globalScriptPath && existsSync(globalScriptPath)
      ? globalScriptPath
      : existsSync(join(root, ".meta-kim", "meta-kim-post-copy.mjs"))
        ? join(root, ".meta-kim", "meta-kim-post-copy.mjs")
        : join(root, "meta-kim-post-copy.mjs");
  if (!existsSync(scriptPath)) return;

  try {
    spawnSync(process.execPath, [scriptPath, "--auto", "--project-root", root], {
      cwd: root,
      stdio: "ignore",
      timeout: 4000,
      windowsHide: true,
      env: {
        ...process.env,
        META_KIM_POST_COPY_AUTO: "1",
      },
    });
  } catch {
    // Post-copy auto-init is opportunistic. A failure here must not block
    // the meta-theory state machine from starting.
  }
}

const activation = isMetaTheoryTrigger();
if (!activation.triggered) {
  process.exit(0);
}

const projectRoot = resolveProjectRoot({
  cwd,
  explicitDeclarations: [process.env.CLAUDE_PROJECT_DIR],
  runtimeCandidates: projectRootCandidatesFromPayload(payload),
});
if (!projectRoot) {
  // No legitimate project root (e.g. hook invoked from a temp dir with no
  // .git / project-bootstrap manifest and no valid explicit declaration). Never
  // bootstrap an arbitrary cwd — skip spine-state + post-copy projection.
  process.exit(0);
}

startPostCopyAutoInit(projectRoot);

const rawPromptText = getRawPromptText();
const rawExisting = await readSpineStateIncludingInactive(projectRoot);
const existing = rawExisting?.active === false ? null : rawExisting || (await readSpineState(projectRoot));
const identityBinding = await readExistingTaskIdentityBinding(projectRoot);
const taskIdentity = await createProjectTaskIdentity(projectRoot, rawPromptText, {
  profile: identityBinding.profile,
  requireExisting: identityBinding.hmacBound,
});
if (["existing_key_missing", "existing_key_invalid"].includes(taskIdentity.status)) {
  reportTaskIdentityRecoveryBoundary(taskIdentity.status, rawPromptText);
  process.exit(0);
}
const promptFingerprint = taskIdentity.taskFingerprint;
if (existing && existing.active && !shouldReplaceActiveState(existing, promptFingerprint)) {
  const existingFingerprint =
    existing?.stageRuntimeControl?.promptFingerprint ||
    existing?.promptFingerprint ||
    null;
  if (existingFingerprint && existingFingerprint === promptFingerprint) {
    await activateSpineState(projectRoot, existing, {
      expectedRunId: existing.runId || null,
      refreshExisting: true,
    });
  }
  process.exit(0);
}

const state = createInitialState({
  taskClassification: activation.taskClassification,
  triggerReason: activation.triggerReason,
  activationMode: "hook_observed",
  driverMode: "hook_observed",
  hookGateMode: "advisory",
  promptFingerprint,
  taskFingerprint: taskIdentity.taskFingerprint,
  taskIdentitySource: taskIdentity.taskIdentitySource,
  latestUserInputLanguage: detectPromptLanguage(rawPromptText),
  factGatePolicy: "managed_gate_required_for_public_ready",
  executionLeasePolicy: "advisory_until_managed_stage_driver",
});

const continuationBoundary = buildContinuationBoundary(rawExisting, rawPromptText);
if (continuationBoundary) {
  state.continuationBoundary = continuationBoundary;
}

// 命中可并行的入口信号时只标记 fanout_eligible。
// 真正的 fan_out_ready 必须由 Thinking 在形成 2+ 个安全、独立且有合并边界的
// workerTaskPacket 后再写入，入口 Hook 不能提前替 Thinking 作出派发结论。
const isFanoutActivation =
  MULTI_AGENT_TRIGGER_RE.test(rawPromptText) ||
  CRITICAL_FETCH_THINKING_RE.test(rawPromptText) ||
  EXPLICIT_META_THEORY_RE.test(rawPromptText) ||
  (() => {
    const natural = classifyPromptActivation(rawPromptText.toLowerCase());
    const isDurableExecution = [
      "natural_language_durable_work",
      "natural_language_product_build",
      "natural_language_execution_work",
    ].includes(natural.triggerReason);
    const separatorCount = (rawPromptText.match(/[、，,；;\n]/gu) || []).length;
    const numberedWorkItems = (rawPromptText.match(/(?:^|\n)\s*\d+[.)、]/gu) || []).length;
    return isDurableExecution && (separatorCount >= 3 || numberedWorkItems >= 2);
  })();
if (isFanoutActivation) {
  const linkedCommands = collectLinkedCommands(rawPromptText);
  const linkedSkills = collectLinkedSkills(rawPromptText);
  if (linkedCommands.length) state.stageRuntimeControl.linkedCommands = linkedCommands;
  if (linkedSkills.length) state.stageRuntimeControl.linkedSkills = linkedSkills;
  state.stageRuntimeControl.dispatchMode = "fanout_eligible";
  state.stageRuntimeControl.fanoutEligibilityEvidence = "prompt_signal_only";
  state.stageRuntimeControl.requiredBeforeFanOutReady = [
    "fetchRecord.capabilitySearchPerformed=true from real discovery evidence",
    "Thinking produces at least two independent workerTaskPackets with collision and merge boundaries",
  ];
  state.stageRuntimeControl.fanoutActivationSource =
    MULTI_AGENT_TRIGGER_RE.test(rawPromptText)
      ? "direct_parallel_agent_request"
      : CRITICAL_FETCH_THINKING_RE.test(rawPromptText)
        ? "structured_governance_chain_request"
        : "meta_theory_trigger_request";
}

await activateSpineState(projectRoot, state, {
  replaceActive: existing?.active === true,
  expectedRunId: existing?.runId || null,
});

// ── multi-agent helpers ───────────────────────────────────────────────────────
// 1) runAutoCapabilitySearch：扫 canonical/agents/ + agent-eligibility.json，
//    返回 [{id, role, tier}]，作为 fetchRecord.capabilityMatches。
function runAutoCapabilitySearch(root) {
  const matches = [];
  if (!root) return matches;
  try {
    const eligibilityPath = join(root, "config", "capability-index", "agent-eligibility.json");
    if (existsSync(eligibilityPath)) {
      const data = JSON.parse(readFileSync(eligibilityPath, "utf8"));
      for (const tier of ["eligible", "conditional", "hard_reject"]) {
        for (const agent of data?.tiers?.[tier]?.agents || []) {
          matches.push({
            id: agent.id,
            role: agent.role || tier,
            tier,
            owns: Array.isArray(agent.owns) ? agent.owns : [],
          });
        }
      }
    }
    const agentsDir = join(root, "canonical", "agents");
    if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
      for (const name of readdirSync(agentsDir)) {
        if (!name.endsWith(".md")) continue;
        const id = name.replace(/\.md$/, "");
        if (!matches.some((m) => m.id === id)) {
          matches.push({ id, role: "canonical-agent", tier: "eligible", owns: [] });
        }
      }
    }
  } catch {
    // 自动 capability search 是 advisory；失败不阻塞 spine。
  }
  return matches;
}

// 2) collectLinkedCommands：从 prompt 提 /xxx slash 命令名。
function collectLinkedCommands(promptText) {
  const out = new Set();
  const matches = String(promptText || "").matchAll(LINKED_COMMAND_RE);
  for (const m of matches) out.add(m[1]);
  return [...out];
}

// 3) collectLinkedSkills：从 prompt 提 skill:xxx / skill xxx 引用。
function collectLinkedSkills(promptText) {
  const out = new Set();
  const re = new RegExp(SKILL_NAME_RE.source, "giu");
  for (const m of String(promptText || "").matchAll(re)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

process.exit(0);
