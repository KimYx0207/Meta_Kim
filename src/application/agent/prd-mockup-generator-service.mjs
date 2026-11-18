/**
 * Page UI Mockup (页面效果图) Generator with Model-First + Structured Wireframe Fallback.
 *
 * Strategy:
 * 1. First attempts real image model generation via configured local CLI or API credentials:
 *    - `gemini-api image` CLI (when installed & authenticated)
 *    - Gemini Image API (`GEMINI_API_KEY` / `GOOGLE_API_KEY`)
 *    - OpenAI-compatible Images API (`MOCKUP_IMAGE_API_KEY` / `OPENAI_API_KEY`)
 * 2. If no image model is configured or generation fails/times out, cleanly falls back to a
 *    structured, feedback-responsive UI wireframe blueprint (`wireframe_fallback`) so page
 *    confirmation gates remain 100% visual and interactive offline.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_ID_RE = /^[a-z0-9][a-z0-9_-]{3,78}\.(?:png|jpg|webp)$/u;

function detectImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

function ensureMockupDir(workflowStateDir) {
  const dir = path.join(workflowStateDir, "mockups");
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError("Mockup storage directory must not be a symlink");
  }
  return dir;
}

function persistImageAtomically(mockupDir, baseSlug, version, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_IMAGE_BYTES) return null;
  const detected = detectImageExtension(buffer);
  if (!detected) return null;
  const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const safeSlug = String(baseSlug || "node")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32) || "node";
  const filename = `${safeSlug}-v${Math.max(1, Number(version) || 1)}-${digest}.${detected.ext}`;
  if (!IMAGE_ID_RE.test(filename)) return null;
  const finalPath = path.join(mockupDir, filename);
  if (existsSync(finalPath)) {
    return { imageId: filename, mime: detected.mime };
  }
  const tmpPath = path.join(mockupDir, `${filename}.${randomUUID()}.tmp`);
  let fd = null;
  try {
    fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    writeFileSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    writeFileSync(finalPath, buffer, { mode: 0o600 });
    return { imageId: filename, mime: detected.mime };
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
    }
  }
}

export function readStoredMockupImage({ workflowStateDir, imageId }) {
  if (typeof imageId !== "string" || !IMAGE_ID_RE.test(imageId)) return null;
  const mockupDir = path.join(workflowStateDir, "mockups");
  if (!existsSync(mockupDir)) return null;
  const target = path.join(mockupDir, imageId);
  if (!existsSync(target)) return null;
  let fd = null;
  try {
    if (lstatSync(target).isSymbolicLink()) return null;
    fd = openSync(target, constants.O_RDONLY | O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 16 || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = readFileSync(fd);
    const detected = detectImageExtension(bytes);
    if (!detected) return null;
    return { bytes, contentType: detected.mime };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function inferMockupVariant({ nodeId = "", title = "", objective = "", explicitVariant = "" } = {}) {
  if (explicitVariant && ["workbench", "media_studio", "catalog_grid", "binding_hub", "flowchart_studio", "desktop_shell", "review_gate"].includes(explicitVariant)) {
    return explicitVariant;
  }
  const text = `${nodeId} ${title} ${objective}`.toLowerCase();
  if (/(?:音色|配音|改稿|脚本|视频|口型|字幕|封面|导出|审片|media|video|audio|tts|avatar|subtitle)/u.test(text)) {
    return "media_studio";
  }
  if (/(?:目录|技能|角色|选角|仓库列表|插件|商城|catalog|inventory|library)/u.test(text)) {
    return "catalog_grid";
  }
  if (/(?:绑定|渠道|协同|多仓|接入|会话|binding|channel|repo)/u.test(text)) {
    return "binding_hub";
  }
  if (/(?:流程图|拓扑|画布|图谱|prd|flowchart|graph|canvas)/u.test(text)) {
    return "flowchart_studio";
  }
  if (/(?:桌面|托盘|客户端|窗口|tauri|desktop|electron)/u.test(text)) {
    return "desktop_shell";
  }
  if (/(?:门禁|审核|拍板|验收|确认|风控|gate|review|approval)/u.test(text)) {
    return "review_gate";
  }
  return "workbench";
}

export function buildMockupPrompt({ projectName = "产品", title = "功能页面", objective = "", features = [], feedback = "" } = {}) {
  const featSummary = Array.isArray(features) && features.length ? features.slice(0, 3).join("；") : "";
  const parts = [
    `High-fidelity modern dark-mode desktop SaaS UI mockup for "${projectName} - ${title}".`,
    objective ? `Core user purpose: ${objective}.` : "",
    featSummary ? `Visible UI components: ${featSummary}.` : "",
    feedback ? `Apply human UI revision request: ${feedback}.` : "",
    "Clean Chinese UI labels, crisp cards, clear hierarchy, 16:9 product interface screenshot style, no device bezel.",
  ].filter(Boolean);
  return parts.join(" ");
}

export function buildStructuredWireframeSpec({
  title = "核心功能页面",
  objective = "",
  features = [],
  feedback = "",
  version = 1,
  variant = "workbench",
} = {}) {
  const cleanStr = (v, max = 90) => String(v || "").replace(/\s+/gu, " ").trim().slice(0, max);
  const v2Plus = (Number(version) || 1) >= 2 || Boolean(feedback && feedback.trim());
  const fb = cleanStr(feedback, 72);
  const dualCol = v2Plus || /双栏|对照|分栏|并排|左右/u.test(fb);
  const hasDrawer = /抽屉|侧栏|侧边|详情/u.test(fb);
  const featurePills = (Array.isArray(features) && features.length ? features : [
    objective || `${title}主操作区`,
    "状态实时反馈与校验提示",
    "确认提交与下一步流转",
  ]).slice(0, 3).map((item) => cleanStr(item, 38));

  return {
    layoutType: variant,
    version: Math.max(1, Number(version) || 1),
    headerTitle: `${cleanStr(title, 32)} · 页面预览 v${Math.max(1, Number(version) || 1)}`,
    badgeText: dualCol ? "双栏对照布局" : hasDrawer ? "主画布+侧边大抽屉" : "标准响应式布局",
    dualColumn: dualCol,
    sideDrawer: hasDrawer,
    summaryLine: cleanStr(objective || `${title}核心交互界面`, 64),
    featurePills,
    feedbackApplied: fb || null,
    primaryCta: /导出|发布/u.test(title) ? "一键导出交付" : /审|门禁|确认/u.test(title) ? "确认无误并放行" : "保存并进入下一步",
  };
}

function resolveCliCandidate(environment = process.env) {
  if (typeof environment.GEMINI_API_CLI_BIN === "string" && environment.GEMINI_API_CLI_BIN.trim()) {
    return environment.GEMINI_API_CLI_BIN.trim();
  }
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of String(environment.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `gemini-api${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function tryGeminiCliImage({ cliBin, prompt, mockupDir, execFileImpl }) {
  if (!cliBin) return { ok: false, reason: "gemini_cli_not_installed" };
  const tempOut = path.join(mockupDir, `cli-${randomUUID()}.png`);
  try {
    await new Promise((resolve, reject) => {
      execFileImpl(
        cliBin,
        ["image", prompt, "--aspect-ratio", "16:9", "--out", tempOut, "--no-interactive"],
        { timeout: 22_000, windowsHide: true },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
    for (const candidate of [tempOut, tempOut.replace(/\.png$/u, ".jpg"), tempOut.replace(/\.png$/u, ".webp")]) {
      if (existsSync(candidate)) {
        const bytes = readFileSync(candidate);
        try { unlinkSync(candidate); } catch { /* ignore */ }
        if (detectImageExtension(bytes)) return { ok: true, bytes, provider: "gemini-api-cli" };
      }
    }
    return { ok: false, reason: "gemini_cli_no_image_output" };
  } catch {
    for (const candidate of [tempOut, tempOut.replace(/\.png$/u, ".jpg"), tempOut.replace(/\.png$/u, ".webp")]) {
      if (existsSync(candidate)) {
        try { unlinkSync(candidate); } catch { /* ignore */ }
      }
    }
    return { ok: false, reason: "gemini_cli_invocation_failed" };
  }
}

async function tryGeminiRestImage({ apiKey, model, baseUrl, prompt, fetchImpl }) {
  if (!apiKey) return { ok: false, reason: "gemini_api_key_missing" };
  const modelsToTry = [model || "gemini-3.1-flash-lite-image", "gemini-2.0-flash-preview-image-generation"];
  const rootUrl = (baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/u, "");
  for (const modelId of [...new Set(modelsToTry)]) {
    try {
      const endpoint = `${rootUrl}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const payload = await res.json();
      const parts = payload?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        const b64 = part?.inlineData?.data || part?.inline_data?.data;
        if (typeof b64 === "string" && b64.length > 64) {
          const bytes = Buffer.from(b64, "base64");
          if (detectImageExtension(bytes)) {
            return { ok: true, bytes, provider: `gemini:${modelId}` };
          }
        }
      }
    } catch {
      // Try next fallback model or fall through cleanly.
    }
  }
  return { ok: false, reason: "gemini_image_api_unavailable" };
}

async function tryOpenAiCompatibleImage({ apiKey, baseUrl, model, prompt, fetchImpl }) {
  if (!apiKey) return { ok: false, reason: "openai_image_key_missing" };
  try {
    const rootUrl = (baseUrl || "https://api.openai.com").replace(/\/+$/u, "");
    const endpoint = rootUrl.endsWith("/v1") ? `${rootUrl}/images/generations` : `${rootUrl}/v1/images/generations`;
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || "gpt-image-1",
        prompt,
        n: 1,
        size: "1024x1024",
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, reason: `openai_image_http_${res.status}` };
    const payload = await res.json();
    const b64 = payload?.data?.[0]?.b64_json;
    if (typeof b64 === "string" && b64.length > 64) {
      const bytes = Buffer.from(b64, "base64");
      if (detectImageExtension(bytes)) {
        return { ok: true, bytes, provider: `images-api:${model || "gpt-image-1"}` };
      }
    }
    return { ok: false, reason: "openai_image_empty_payload" };
  } catch {
    return { ok: false, reason: "openai_image_request_failed" };
  }
}

export async function generatePageEffectMockup({
  workflowStateDir,
  projectId = "",
  projectName = "当前产品",
  nodeId = "module",
  title = "页面模块",
  objective = "",
  features = [],
  feedback = "",
  version = 1,
  explicitVariant = "",
  tryModelFirst = true,
  environment = process.env,
  execFileImpl = execFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  const variant = inferMockupVariant({ nodeId, title, objective, explicitVariant });
  const prompt = buildMockupPrompt({ projectName, title, objective, features, feedback });
  const wireframeSpec = buildStructuredWireframeSpec({
    title,
    objective,
    features,
    feedback,
    version,
    variant,
  });

  const attempted = [];
  if (tryModelFirst && workflowStateDir) {
    const mockupDir = ensureMockupDir(workflowStateDir);
    const cliBin = resolveCliCandidate(environment);
    if (cliBin) {
      attempted.push("gemini-api-cli");
      const cliRes = await tryGeminiCliImage({ cliBin, prompt, mockupDir, execFileImpl });
      if (cliRes.ok) {
        const stored = persistImageAtomically(mockupDir, nodeId, version, cliRes.bytes);
        if (stored) {
          const query = projectId
            ? `projectId=${encodeURIComponent(projectId)}&imageId=${encodeURIComponent(stored.imageId)}`
            : `imageId=${encodeURIComponent(stored.imageId)}`;
          return {
            mode: "model_image",
            provider: cliRes.provider,
            attemptedProviders: attempted,
            fallbackReason: null,
            version: Math.max(1, Number(version) || 1),
            variant,
            prompt,
            imageId: stored.imageId,
            imageUrl: `/api/agent/prd-mockup-image?${query}`,
            lastFeedback: feedback ? String(feedback).trim().slice(0, 400) : null,
            wireframeSpec,
          };
        }
      }
    }

    const geminiKey = (environment.GEMINI_API_KEY || environment.GOOGLE_API_KEY || "").trim();
    if (geminiKey && typeof fetchImpl === "function") {
      attempted.push("gemini-image-api");
      const gemRes = await tryGeminiRestImage({
        apiKey: geminiKey,
        model: environment.GEMINI_IMAGE_MODEL,
        baseUrl: environment.GEMINI_API_BASE_URL,
        prompt,
        fetchImpl,
      });
      if (gemRes.ok) {
        const stored = persistImageAtomically(mockupDir, nodeId, version, gemRes.bytes);
        if (stored) {
          const query = projectId
            ? `projectId=${encodeURIComponent(projectId)}&imageId=${encodeURIComponent(stored.imageId)}`
            : `imageId=${encodeURIComponent(stored.imageId)}`;
          return {
            mode: "model_image",
            provider: gemRes.provider,
            attemptedProviders: attempted,
            fallbackReason: null,
            version: Math.max(1, Number(version) || 1),
            variant,
            prompt,
            imageId: stored.imageId,
            imageUrl: `/api/agent/prd-mockup-image?${query}`,
            lastFeedback: feedback ? String(feedback).trim().slice(0, 400) : null,
            wireframeSpec,
          };
        }
      }
    }

    const openAiKey = (environment.MOCKUP_IMAGE_API_KEY || environment.OPENAI_API_KEY || "").trim();
    if (openAiKey && typeof fetchImpl === "function") {
      attempted.push("openai-images-api");
      const oaiRes = await tryOpenAiCompatibleImage({
        apiKey: openAiKey,
        baseUrl: environment.MOCKUP_IMAGE_BASE_URL || environment.OPENAI_BASE_URL,
        model: environment.MOCKUP_IMAGE_MODEL,
        prompt,
        fetchImpl,
      });
      if (oaiRes.ok) {
        const stored = persistImageAtomically(mockupDir, nodeId, version, oaiRes.bytes);
        if (stored) {
          const query = projectId
            ? `projectId=${encodeURIComponent(projectId)}&imageId=${encodeURIComponent(stored.imageId)}`
            : `imageId=${encodeURIComponent(stored.imageId)}`;
          return {
            mode: "model_image",
            provider: oaiRes.provider,
            attemptedProviders: attempted,
            fallbackReason: null,
            version: Math.max(1, Number(version) || 1),
            variant,
            prompt,
            imageId: stored.imageId,
            imageUrl: `/api/agent/prd-mockup-image?${query}`,
            lastFeedback: feedback ? String(feedback).trim().slice(0, 400) : null,
            wireframeSpec,
          };
        }
      }
    }
  }

  const fallbackReason = attempted.length > 0
    ? `已尝试模型生图（${attempted.join(" / ")}）暂未返回图片，已自动回退为组件级可交互效果图`
    : "未检测到图像生成模型凭据（gemini-api / GEMINI_API_KEY / OPENAI_API_KEY），已自动回退为组件级可交互效果图";

  return {
    mode: "wireframe_fallback",
    provider: "structured_wireframe",
    attemptedProviders: attempted,
    fallbackReason,
    version: Math.max(1, Number(version) || 1),
    variant,
    prompt,
    imageId: null,
    imageUrl: null,
    lastFeedback: feedback ? String(feedback).trim().slice(0, 400) : null,
    wireframeSpec,
  };
}
