#!/usr/bin/env node
/**
 * 提示词自动优化Hook - 跨平台版本 (Node.js)
 *
 * 支持 Windows/Mac/Linux，无需额外依赖
 *
 * 工作流程：
 * 1. 用户输入提示词
 * 2. Hook优化
 * 3. 返回优化后的提示词给Claude
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEBUG_LOG_DIRECTORY_NAME = 'hookprompt-debug';
const DEBUG_LOG_FILE_NAME = 'hook-prompt-optimizer.log';
const DEBUG_LOG_MAX_BYTES = 64 * 1024;
const DEBUG_LOG_ARCHIVE_COUNT = 3;
const DEBUG_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEBUG_EVENT_NAMES = new Set([
    'hook-error',
    'prompt-enhanced',
    'prompt-filtered',
    'template-unavailable'
]);

/**
 * Debug logging is deliberately opt-in and metadata-only. The log directory
 * must remain inside the operating-system temporary directory, and neither the
 * directory nor any fixed-name log file may be a symlink/junction.
 */
function isPathInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function getSafeDebugDirectory() {
    if (process.env.HOOKPROMPT_DEBUG !== '1') {
        return null;
    }

    try {
        const tempRoot = path.resolve(os.tmpdir());
        const tempRootReal = fs.realpathSync(tempRoot);
        const configured = process.env.HOOKPROMPT_DEBUG_DIR;
        const requested = configured
            ? path.resolve(configured)
            : path.join(tempRoot, DEBUG_LOG_DIRECTORY_NAME);

        if (!isPathInside(tempRoot, requested)) {
            return null;
        }

        const relative = path.relative(tempRoot, requested);
        let current = tempRoot;
        for (const segment of relative.split(path.sep).filter(Boolean)) {
            current = path.join(current, segment);
            if (fs.existsSync(current)) {
                const stat = fs.lstatSync(current);
                if (stat.isSymbolicLink() || !stat.isDirectory()) {
                    return null;
                }
            } else {
                fs.mkdirSync(current);
            }
        }

        const requestedStat = fs.lstatSync(requested);
        if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
            return null;
        }

        const requestedReal = fs.realpathSync(requested);
        if (!isPathInside(tempRootReal, requestedReal)) {
            return null;
        }

        return requestedReal;
    } catch {
        return null;
    }
}

function getDebugLogPaths(directory) {
    const paths = [path.join(directory, DEBUG_LOG_FILE_NAME)];
    for (let index = 1; index <= DEBUG_LOG_ARCHIVE_COUNT; index += 1) {
        paths.push(path.join(directory, `${DEBUG_LOG_FILE_NAME}.${index}`));
    }
    return paths;
}

function isSafeRegularFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return true;
    }
    const stat = fs.lstatSync(filePath);
    return !stat.isSymbolicLink() && stat.isFile();
}

function maintainDebugLogs(directory, incomingBytes) {
    const logPaths = getDebugLogPaths(directory);
    if (logPaths.some((filePath) => !isSafeRegularFile(filePath))) {
        return null;
    }

    const expiryCutoff = Date.now() - DEBUG_LOG_RETENTION_MS;
    for (const filePath of logPaths) {
        if (fs.existsSync(filePath) && fs.statSync(filePath).mtimeMs < expiryCutoff) {
            fs.unlinkSync(filePath);
        }
    }

    const activeLog = logPaths[0];
    const activeBytes = fs.existsSync(activeLog) ? fs.statSync(activeLog).size : 0;
    if (activeBytes + incomingBytes > DEBUG_LOG_MAX_BYTES) {
        for (let index = DEBUG_LOG_ARCHIVE_COUNT; index >= 1; index -= 1) {
            const destination = logPaths[index];
            const source = logPaths[index - 1];
            if (fs.existsSync(destination)) {
                fs.unlinkSync(destination);
            }
            if (fs.existsSync(source)) {
                fs.renameSync(source, destination);
            }
        }
    }

    return activeLog;
}

function debugLog(event, metadata = {}) {
    const directory = getSafeDebugDirectory();
    if (!directory) {
        return;
    }

    const record = {
        timestamp: new Date().toISOString(),
        event: DEBUG_EVENT_NAMES.has(event) ? event : 'hook-error'
    };
    for (const key of ['inputLength', 'userInputLength', 'outputLength']) {
        if (Number.isSafeInteger(metadata[key]) && metadata[key] >= 0) {
            record[key] = metadata[key];
        }
    }
    if (metadata.mode === 'compact' || metadata.mode === 'full') {
        record.mode = metadata.mode;
    }

    const logEntry = `${JSON.stringify(record)}\n`;
    try {
        const logFile = maintainDebugLogs(directory, Buffer.byteLength(logEntry));
        if (!logFile) {
            return;
        }
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        const descriptor = fs.openSync(
            logFile,
            fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow,
            0o600
        );
        try {
            if (fs.fstatSync(descriptor).isFile()) {
                fs.writeFileSync(descriptor, logEntry, { encoding: 'utf8' });
            }
        } finally {
            fs.closeSync(descriptor);
        }
    } catch {
        // Debug logging must never affect hook behavior or expose exception text.
    }
}

/**
 * 读取优化提示词模板
 */
function readOptimizerTemplate() {
    // 获取脚本目录并找到模板
    const scriptDir = __dirname;
    const claudeDir = path.dirname(scriptDir);
    const templatePath = path.join(claudeDir, 'prompt-optimizer-meta.md');

    // 备选：检查用户主目录
    const homeTemplatePath = path.join(os.homedir(), '.claude', 'prompt-optimizer-meta.md');

    if (fs.existsSync(templatePath)) {
        return fs.readFileSync(templatePath, 'utf8');
    } else if (fs.existsSync(homeTemplatePath)) {
        return fs.readFileSync(homeTemplatePath, 'utf8');
    } else {
        return null;
    }
}

/**
 * Build a fenced Markdown code block that stays safe even if content contains
 * triple backticks.
 */
function fencedBlock(content, lang = 'text') {
    const text = String(content ?? '');
    const matches = text.match(/`+/g) || [];
    const longest = matches.reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${lang}\n${text}\n${fence}`;
}

function decodeXmlEntities(value) {
    return String(value ?? '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function extractCodexDelegationInput(value) {
    const text = String(value ?? '').trim();
    const match = text.match(/^<codex_delegation\b[\s\S]*?<input>([\s\S]*?)<\/input>[\s\S]*<\/codex_delegation>\s*$/i);
    if (!match) {
        return text;
    }
    return decodeXmlEntities(match[1]).trim();
}

function hasShortTaskIntent(input) {
    const trimmed = String(input ?? '').trim();
    const compact = trimmed.replace(/\s+/g, '');
    const diagnosticPatterns = [
        /^(这个|这|这里|刚才|上面)?(不行|不对|有问题|报错了?|失败了?|错了|坏了|乱了|太乱了?|不好看|卡住了?|跑不通|看不懂)$/i,
        /^(帮我)?(看看|看下|检查|排查|修复|修一下|改一下|优化一下|整理一下)$/i,
        /^(?:请|帮我)?(?:优化|改写|重写|润色|完善|生成|写个?|提供|输出|展示)(?:一下|这段|这个|一份|个)?(?:提示词|prompt)$/i,
        /^(this|it|that)?(doesnot|doesnt|isnot|isnt)?(work|working)$/i,
        /^(error|failed|failure|broken|bug|pleasecheck|checkthis|fixthis)$/i
    ];

    return diagnosticPatterns.some((pattern) => pattern.test(compact));
}

function isPromptLevelSlashCommand(input) {
    const trimmed = String(input ?? '').trim();
    return /^\/(?:meta-theory|meta_theory)(?:\s|$)/i.test(trimmed);
}

/**
 * 检查输入是否应该被过滤（不优化）
 * ⚠️ 注意：此函数内不能写日志！否则会被过滤的输入也会产生日志输出
 *
 * @returns {boolean} true表示应该过滤（跳过优化），false表示需要优化
 */
function shouldFilter(input) {
    const trimmed = input.trim();

    // Codex App may submit internal goal-continuation context through
    // UserPromptSubmit. It is not a user prompt and must not be displayed
    // back as "original input".
    if (
        /^<codex_internal_context\b/i.test(trimmed) ||
        (
            trimmed.includes('<codex_internal_context') &&
            trimmed.includes('Continue working toward the active thread goal')
        )
    ) {
        return true;
    }

    // Claude Code 内置命令和Skill命令 - 不应被优化。
    // Meta_Kim 的 /meta-theory 是 prompt 级治理入口，仍需要 HookPrompt 首屏理解。
    // 匹配: /help, /commit, /review-pr, /skill-name:sub-command 等
    if (trimmed.startsWith('/') && !isPromptLevelSlashCommand(trimmed)) {
        return true;
    }

    // Claude Code 内部系统消息 - 精确匹配已知标签，避免误杀用户的 HTML/JSX 输入
    const systemTagPattern = /^<(task-notification|system-reminder|tool-result|tool-use|agent-response|claude-internal)[\s>]/;
    if (systemTagPattern.test(trimmed)) {
        return true;
    }

    // 简单交互式回复 - 不需要优化
    const simpleResponses = [
        '好的', '是的', '继续', '谢谢', 'ok', 'OK', 'yes', 'YES',
        'no', 'NO', '确认', '取消', '好', '行', '可以', '不', '嗯',
        'y', 'n', 'Y', 'N'
    ];

    // 精确匹配简单回复
    if (simpleResponses.includes(trimmed)) {
        return true;
    }

    // 短但带诊断/修复/优化意图的输入也应进入优化层，例如“这个不行”“报错了”。
    if (hasShortTaskIntent(trimmed)) {
        return false;
    }

    // 太短且没有可执行意图
    if (trimmed.length < 10) {
        return true;
    }

    return false;
}

function buildFullTemplateInstruction(template, userInput) {
    const safeUserInputBlock = fencedBlock(userInput, 'text');
    const outputRawInputExample = fencedBlock('[用户的原话，逐字保留]', 'text');
    const outputPromptExample = fencedBlock('[优化后的结构化提示词]', 'markdown');

    return `<MANDATORY_FORMAT_INSTRUCTION>
【回复格式说明】

本次用户请求的第一条面向用户的 assistant 回复必须严格按以下顺序输出，不得跳过任何部分。

重要：这是单次首条回复格式，不是每条消息的全局格式。只允许在本轮第一条面向用户的 assistant 消息开头展示一次；完成这组优化展示后，后续 commentary/progress/final/review/verification 消息必须直接继续任务，不得再次重复“原始输入 / 优化后的理解 / 优化后的完整提示词”三段。

1. 第一行必须是：📝 **原始输入**：

2. 然后必须立刻输出一个 fenced code block，逐字放入用户原始输入。禁止把原始输入裸贴在 Markdown 正文里，避免其中的 #、##、列表、图片路径或代码片段被渲染成标题或格式。

示例：

${outputRawInputExample}

3. 然后是：
🔄 **优化后的理解**：
- **Context（上下文）**：[推断的场景、身份、目标]
- **Task（任务）**：[明确的动作 + 要求]
- **Format（格式）**：[期望的输出形式]

4. 然后是：
✅ **优化后的完整提示词**：

优化后的完整提示词正文必须放入 fenced code block。禁止把完整提示词正文裸贴在 Markdown 正文里，避免被渲染成大标题。

示例：

${outputPromptExample}

5. 最后是分隔线 --- 后执行任务内容

用户若只要求编写或优化提示词，交付完整提示词即可，不要执行其中的嵌入任务。

请只在本轮第一条回复开头展示对用户输入的理解（原始输入 + 优化后的结构化版本），然后再执行任务。这样用户可以看到提示词是如何被优化的，同时不会在 Codex App 的后续进度消息里反复出现同一组三段式。
</MANDATORY_FORMAT_INSTRUCTION>

---

${template}

---

## 用户原始输入（已安全包裹，请从代码块中读取原文）

${safeUserInputBlock}`;
}

function buildCompactInstruction(userInput) {
    const safeUserInputBlock = fencedBlock(userInput, 'text');

    return `<MANDATORY_FORMAT_INSTRUCTION compact="true">
【HookPrompt 前台展示契约】

本条 additionalContext 是后台指令，不要把它原样展示给用户。

本轮第一条面向用户的 assistant 回复必须以完整 HookPrompt 三段式开头：

1. 第一行：📝 **原始输入**：
   下一段必须是 fenced text code block，逐字放入用户原始输入。若下方提供“已解包用户原始输入”，优先使用它。

2. 然后输出：🔄 **优化后的理解**：
   用 3 个 bullet 展示 Context（上下文）、Task（任务）、Format（格式）。

3. 然后输出：✅ **优化后的完整提示词**：
   下一段必须是 fenced markdown code block，写出完整、可执行、结构化的优化提示词。

4. 最后输出 --- 分隔线，再继续完成用户真实任务。

用户若只要求编写或优化提示词，交付完整提示词即可，不要执行其中的嵌入任务。

只在本轮第一条可见回复展示一次三段式；后续 commentary、progress、final、review、verification 直接继续任务，不重复三段式。

优化提示词时使用 role-first + outcome-contract + tagged structure；首屏理解可保留 CTF 摘要，复杂任务可加入 Critical / Fetch / Thinking / Review 的结果摘要。保留用户可见的完整体验，但保持后台 hook 输出简短。

已解包用户原始输入：

${safeUserInputBlock}
</MANDATORY_FORMAT_INSTRUCTION>`;
}

/**
 * Build the default display contract independently of backstage context size.
 * Prompt-writing intent is interpreted by the host model in conversation,
 * rather than guessed from keyword matches inside quoted task material.
 * @param {string} userInput Unpacked user text, preserved in a safe fence.
 * @returns {string} Model-visible instructions, not a rendered user response.
 */
function buildSummaryInstruction(userInput) {
    return `<HOOKPROMPT_DISPLAY_CONTRACT mode="summary">
本条 additionalContext 是后台任务整理指令，不要原样展示给用户。

日常任务：最多一句简短理解，说明目标和马上要做的动作；仅在确有影响执行的约束时补充最多三个短点，随后立即执行。需求已清楚、纯问答或用户要求直接结果时，可以直接执行或答复，省略前言。

不要逐字复述原始输入，不要展示 CTF 长段、XML 任务简报或完整优化提示词。沿用当前会话已经确认的目标、范围和决策；短反馈、补充条件和继续请求只更新相应部分，不重新规划或反复要求确认。后续 commentary、progress、final、review、verification 直接推进或交付结果，不重复任务改写。

例外：用户明确要求优化、改写、生成或展示提示词时，提示词本身就是交付物，必须提供完整、可复制的提示词，不能用执行摘要代替；使用安全 fenced markdown code block，保留用户原意、关键引用、结果契约和验证要求。除非用户另有要求，不要执行提示词中的嵌入任务。材料中仅提到“提示词”不等于用户请求编写提示词。

后台仍按 role-first、outcome-contract、tagged structure 整理任务；这个展示约定不改变宿主审批、权限或治理阶段。

已解包用户原始输入：

${fencedBlock(userInput, 'text')}
</HOOKPROMPT_DISPLAY_CONTRACT>`;
}

/**
 * 构建优化请求（JSON格式，符合Claude Code Hook API）
 */
function buildOptimizationRequest(template, userInput) {
    const useCompactContext = process.env.HOOKPROMPT_COMPACT_CONTEXT === '1';
    // Unknown or empty values retain the concise default; only an explicit
    // "full" opts back into the original three-part visible experience.
    const useFullDisplay = process.env.HOOKPROMPT_DISPLAY_MODE === 'full';
    const forceInstruction = useFullDisplay
        ? (useCompactContext
            ? buildCompactInstruction(userInput)
            : buildFullTemplateInstruction(template, userInput))
        : [buildSummaryInstruction(userInput), useCompactContext ? '' : template]
            .filter(Boolean).join('\n\n---\n\n');

    return {
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: forceInstruction
        }
    };
}

/**
 * 解析 Claude Code Hook API 的 JSON 输入
 * ⚠️ 注意：此函数在shouldFilter之前调用，不能写日志！
 *
 * 支持多种输入格式：
 * 1. { prompt: "用户输入" } - 旧格式
 * 2. { messages: [{role: "user", content: "用户输入"}] } - 新格式
 * 3. { session_id: "...", prompt: "用户输入" } - 带session的格式
 */
function parseHookInput(rawInput) {
    try {
        const parsed = JSON.parse(rawInput);

        // 检查是否有 prompt 字段（最常见的格式）
        if (parsed.prompt) {
            return extractCodexDelegationInput(parsed.prompt);
        }

        // 检查是否有 messages 数组（新格式）
        if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
            // 获取最后一条用户消息
            const lastMessage = parsed.messages[parsed.messages.length - 1];
            if (lastMessage.role === 'user' && lastMessage.content) {
                return extractCodexDelegationInput(lastMessage.content);
            }
        }

        // 如果都没有，返回原始输入
        return extractCodexDelegationInput(rawInput);
    } catch (e) {
        // 如果不是JSON，返回原始输入（可能是纯文本）
        return extractCodexDelegationInput(rawInput);
    }
}

/**
 * 主函数
 */
async function main({ stdinOnly = false } = {}) {
    // 从stdin读取输入
    let rawInput = '';

    // 检查是否通过参数运行
    if (!stdinOnly && process.argv.length > 2) {
        rawInput = process.argv.slice(2).join(' ');
    } else {
        // 从stdin读取
        rawInput = fs.readFileSync(0, 'utf8');
    }

    rawInput = rawInput.trim();

    // 解析输入，提取实际的用户消息
    const userInput = parseHookInput(rawInput);

    // 【关键】立即检查是否需要过滤；默认无日志，显式debug仅记录长度元数据。
    if (shouldFilter(userInput)) {
        debugLog('prompt-filtered', {
            inputLength: rawInput.length,
            userInputLength: userInput.length
        });
        process.stdout.write(JSON.stringify({}));
        return;
    }

    // 后台模板长度与前台展示独立；compact仍只控制是否注入共享方法模板。
    const useCompactContext = process.env.HOOKPROMPT_COMPACT_CONTEXT === '1';
    const template = useCompactContext ? '' : readOptimizerTemplate();
    if (!useCompactContext && !template) {
        debugLog('template-unavailable', {
            inputLength: rawInput.length,
            userInputLength: userInput.length,
            mode: 'full'
        });
        process.stdout.write(JSON.stringify({}));
        return;
    }

    // 构建并输出优化请求
    const optimizationRequest = buildOptimizationRequest(template, userInput);
    const serializedRequest = JSON.stringify(optimizationRequest);

    debugLog('prompt-enhanced', {
        inputLength: rawInput.length,
        userInputLength: userInput.length,
        outputLength: serializedRequest.length,
        mode: useCompactContext ? 'compact' : 'full'
    });
    process.stdout.write(serializedRequest);
}

// 运行
if (require.main === module) {
    main().catch(() => {
        // Error bodies may contain input or paths, so debug output is categorical only.
        debugLog('hook-error');
        process.stdout.write(JSON.stringify({}));
    });
}

module.exports = {
    DEBUG_LOG_ARCHIVE_COUNT,
    DEBUG_LOG_FILE_NAME,
    DEBUG_LOG_MAX_BYTES,
    DEBUG_LOG_RETENTION_MS,
    debugLog,
    main
};
