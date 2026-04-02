#!/usr/bin/env node
/**
 * Meta_Kim 一键安装脚本
 *
 * Usage:
 *   node setup.mjs            # 首次安装
 *   node setup.mjs --update   # 更新已安装的 skills
 *   node setup.mjs --check    # 仅检查环境，不安装
 */

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readdirSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, platform, tmpdir } from 'node:os'

// ── Config ──────────────────────────────────────────────

const SKILL_OWNER = process.env.META_KIM_SKILL_OWNER || 'KimYx0207'
const SKILLS_DIR = join(homedir(), '.claude', 'skills')
const PROJECT_DIR = resolve(import.meta.dirname || '.')

const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''

const SKILLS = [
  // 项目默认依赖
  { name: 'agent-teams-playbook', repo: `${SKILL_OWNER}/agent-teams-playbook` },
  { name: 'findskill', repo: `${SKILL_OWNER}/findskill` },
  { name: 'hookprompt', repo: `${SKILL_OWNER}/HookPrompt` },
  // 社区高星项目
  { name: 'superpowers', repo: 'obra/superpowers' },
  { name: 'everything-claude-code', repo: 'affaan-m/everything-claude-code' },
  { name: 'planning-with-files', repo: 'OthmanAdi/planning-with-files' },
  { name: 'cli-anything', repo: 'HKUDS/CLI-Anything' },
  { name: 'gstack', repo: 'garrytan/gstack' },
  // Anthropic 官方 (subdir)
  { name: 'skill-creator', repo: 'anthropics/skills', subdir: 'skills/skill-creator' },
]

// ── Helpers ─────────────────────────────────────────────

const isWin = platform() === 'win32'
const args = process.argv.slice(2)
const updateMode = args.includes('--update') || args.includes('-u')
const checkOnly = args.includes('--check')

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

function log(icon, msg) { console.log(`  ${icon} ${msg}`) }
function ok(msg) { log(`${C.green}✓${C.reset}`, msg) }
function skip(msg) { log(`${C.yellow}⊘${C.reset}`, `${C.dim}${msg}${C.reset}`) }
function warn(msg) { log(`${C.yellow}⚠${C.reset}`, msg) }
function fail(msg) { log(`${C.red}✗${C.reset}`, msg) }
function info(msg) { log(`${C.cyan}ℹ${C.reset}`, msg) }
function heading(msg) { console.log(`\n${C.bold}${C.magenta}── ${msg} ──${C.reset}\n`) }

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', cwd: PROJECT_DIR, ...opts }).trim()
  } catch { return null }
}

function gitProxyArgs() {
  if (!PROXY) return ''
  return `-c http.proxy=${PROXY} -c https.proxy=${PROXY}`
}

// ── Step 1: Pre-flight checks ───────────────────────────

function preflight() {
  heading('环境检查')
  let passed = true

  // Node.js version
  const nodeVer = process.versions.node
  const major = parseInt(nodeVer.split('.')[0], 10)
  if (major >= 18) {
    ok(`Node.js v${nodeVer} (需要 >=18)`)
  } else {
    fail(`Node.js v${nodeVer} 太旧了，需要 >=18`)
    passed = false
  }

  // npm
  const npmVer = run('npm --version')
  if (npmVer) {
    ok(`npm v${npmVer}`)
  } else {
    fail('npm 未找到')
    passed = false
  }

  // git
  const gitVer = run('git --version')
  if (gitVer) {
    ok(`${gitVer}`)
  } else {
    fail('git 未找到 — 安装 skills 需要 git')
    passed = false
  }

  // Claude Code
  const claudeVer = run('claude --version 2>/dev/null') || run('claude.exe --version 2>/dev/null')
  if (claudeVer) {
    ok(`Claude Code ${claudeVer}`)
  } else {
    warn('Claude Code CLI 未检测到（可选，但推荐安装）')
  }

  // Proxy
  if (PROXY) {
    info(`代理: ${PROXY}`)
  }

  // package.json exists
  if (existsSync(join(PROJECT_DIR, 'package.json'))) {
    ok('package.json 存在')
  } else {
    fail('package.json 未找到 — 请在 Meta_Kim 根目录运行此脚本')
    passed = false
  }

  return passed
}

// ── Step 2: npm install ─────────────────────────────────

function installDeps() {
  heading('安装 npm 依赖')

  if (existsSync(join(PROJECT_DIR, 'node_modules', '@modelcontextprotocol'))) {
    if (!updateMode) {
      skip('node_modules 已存在，跳过 (用 --update 强制重装)')
      return true
    }
  }

  info('运行 npm install ...')
  const result = spawnSync('npm', ['install'], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    shell: isWin,
  })

  if (result.status === 0) {
    ok('npm 依赖安装完成')
    return true
  }
  fail('npm install 失败')
  return false
}

// ── Step 3: Install skills ──────────────────────────────

function installSkill(skill) {
  const target = join(SKILLS_DIR, skill.name)
  const proxy = gitProxyArgs()

  if (existsSync(target)) {
    if (updateMode) {
      if (skill.subdir) {
        rmSync(target, { recursive: true, force: true })
      } else {
        const pullResult = run(`git ${proxy} pull --ff-only`.trim(), { cwd: target })
        if (pullResult !== null) {
          ok(`${skill.name} — 已更新`)
          return true
        }
        rmSync(target, { recursive: true, force: true })
      }
    } else {
      skip(`${skill.name} — 已安装`)
      return true
    }
  }

  if (skill.subdir) {
    return installSkillFromSubdir(skill, target, proxy)
  }

  const url = `https://github.com/${skill.repo}.git`
  const cloneResult = run(`git ${proxy} clone --depth 1 "${url}" "${target}"`.trim())
  if (cloneResult !== null) {
    ok(`${skill.name} — 安装成功`)
    return true
  }
  fail(`${skill.name} — 安装失败 (${skill.repo})`)
  return false
}

function installSkillFromSubdir(skill, target, proxy) {
  const url = `https://github.com/${skill.repo}.git`
  const tmp = join(tmpdir(), `meta-kim-skill-${Date.now()}`)

  try {
    const cloneCmd = `git ${proxy} clone --depth 1 --filter=blob:none --sparse "${url}" "${tmp}"`.trim()
    run(cloneCmd)
    run(`git sparse-checkout set "${skill.subdir}"`, { cwd: tmp })

    const src = join(tmp, skill.subdir)
    if (existsSync(src)) {
      mkdirSync(target, { recursive: true })
      cpSync(src, target, { recursive: true })
      ok(`${skill.name} — 安装成功 (subdir: ${skill.subdir})`)
      return true
    }
    fail(`${skill.name} — subdir 不存在`)
    return false
  } catch {
    fail(`${skill.name} — 安装失败`)
    return false
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function installAllSkills() {
  heading(updateMode ? '更新元技能' : '安装元技能')
  mkdirSync(SKILLS_DIR, { recursive: true })

  let installed = 0
  let failed = 0

  for (const skill of SKILLS) {
    if (installSkill(skill)) {
      installed++
    } else {
      failed++
    }
  }

  console.log()
  info(`${installed}/${SKILLS.length} 个技能就绪${failed > 0 ? `，${failed} 个失败` : ''}`)
  return failed === 0
}

// ── Step 4: Validate ────────────────────────────────────

function validate() {
  heading('项目验证')

  // Check MCP config
  const mcpPath = join(PROJECT_DIR, '.mcp.json')
  if (existsSync(mcpPath)) {
    ok('.mcp.json MCP 配置存在')
  } else {
    warn('.mcp.json 不存在 — MCP runtime server 不会自动启动')
  }

  // Check hooks
  const settingsPath = join(PROJECT_DIR, '.claude', 'settings.json')
  if (existsSync(settingsPath)) {
    ok('.claude/settings.json hooks 配置存在')
  } else {
    warn('.claude/settings.json 不存在')
  }

  // Check agents
  const agentsDir = join(PROJECT_DIR, '.claude', 'agents')
  if (existsSync(agentsDir)) {
    const agents = readdirSync(agentsDir).filter(f => f.endsWith('.md'))
    ok(`${agents.length} 个 agent prompts (${agentsDir})`)
  }

  // Run validate script
  info('运行 validate-project.mjs ...')
  const validateResult = spawnSync('node', ['scripts/validate-project.mjs'], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    shell: isWin,
  })

  if (validateResult.status === 0) {
    ok('项目验证通过')
    return true
  }
  warn('项目验证有警告（不影响基本使用）')
  return true
}

// ── Step 5: MCP self-test ───────────────────────────────

function testMcp() {
  heading('MCP 服务器自测')

  const result = spawnSync('node', ['scripts/mcp/meta-runtime-server.mjs', '--self-test'], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    shell: isWin,
    timeout: 15000,
  })

  if (result.status === 0) {
    ok('MCP runtime server 自测通过')
    return true
  }
  warn('MCP 自测未通过（不影响核心功能）')
  return true
}

// ── Main ────────────────────────────────────────────────

function banner() {
  console.log(`
${C.bold}${C.cyan}╔══════════════════════════════════════════╗
║       Meta_Kim 一键安装 v1.2.0           ║
╚══════════════════════════════════════════╝${C.reset}
${C.dim}  模式: ${checkOnly ? '仅检查' : updateMode ? '更新' : '安装'}${C.reset}
${C.dim}  平台: ${platform()} | Node ${process.versions.node}${C.reset}
${C.dim}  项目: ${PROJECT_DIR}${C.reset}
`)
}

function summary(results) {
  heading('安装摘要')
  const total = Object.keys(results).length
  const passed = Object.values(results).filter(Boolean).length

  for (const [step, result] of Object.entries(results)) {
    if (result) {
      ok(step)
    } else {
      fail(step)
    }
  }

  console.log()
  if (passed === total) {
    console.log(`${C.bold}${C.green}  🎉 全部就绪！可以开始使用 Meta_Kim${C.reset}`)
    console.log(`${C.dim}  在项目目录打开 Claude Code 即可${C.reset}`)
  } else {
    console.log(`${C.bold}${C.yellow}  ⚠ ${passed}/${total} 步通过，部分功能可能受限${C.reset}`)
  }
  console.log()
}

async function main() {
  banner()

  const results = {}

  // Step 1: Preflight
  results['环境检查'] = preflight()
  if (!results['环境检查']) {
    console.log(`\n${C.red}  环境不满足要求，请先安装缺失的工具${C.reset}\n`)
    process.exit(1)
  }

  if (checkOnly) {
    console.log(`\n${C.green}  环境检查通过！${C.reset}\n`)
    process.exit(0)
  }

  // Step 2: npm install
  results['npm 依赖'] = installDeps()

  // Step 3: Skills
  results['元技能安装'] = installAllSkills()

  // Step 4: Validate
  results['项目验证'] = validate()

  // Step 5: MCP test
  results['MCP 自测'] = testMcp()

  // Summary
  summary(results)
}

main().catch(err => {
  console.error(`\n${C.red}  安装出错: ${err.message}${C.reset}\n`)
  process.exit(1)
})
