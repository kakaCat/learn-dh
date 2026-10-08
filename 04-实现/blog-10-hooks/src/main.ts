/**
 * 博客10：Hooks 模块 - 钩子协议
 *
 * 按 dsh 源码（packages/hooks/hook-protocol/*）结构实现：
 * - matcher: 模式匹配（match-all / 字面量 / 正则）
 * - codec: 钩子进程输出解码（exit 0 JSON / exit 2 block / 其他 = 非阻塞错误）
 * - runner: 执行钩子命令，解析输出，超时控制
 * - events: hook/invoked + hook/result 配对日志事件
 * - HookService: 注册钩子、匹配、执行、接入拦截点
 */

import { Context, Service } from '@cordisjs/core'
import { randomUUID } from 'node:crypto'

// ============================================================
// 1. 类型定义（dsh: hook-protocol/src/types.ts）
// ============================================================

// 一条命令钩子：要执行的 shell 命令 + 超时（秒）
interface CommandHook {
  command: string
  timeoutSec?: number
}

// 一个 matcher 组：模式 + 匹配时执行的钩子列表
interface MatcherGroup {
  matcher?: string  // 缺省 / '' / '*' = 匹配所有
  hooks: CommandHook[]
}

// 钩子输出：解码后的中立结果（每个字段都可选——钩子可能只用其中几个）
interface HookOutput {
  exitCode: number | undefined
  stderr: string
  stdout: string
  continue?: boolean      // false = 请求停止
  stopReason?: string     // continue=false 时展示给用户
  decision?: 'approve' | 'allow' | 'block' | 'deny' | 'ask'
  reason?: string
  additionalContext?: string  // 注入下一轮请求的额外上下文
  systemMessage?: string      // 警告信息
}

// 钩子方言（dsh 桥接 Claude Code / Codex；这里演示）
type HookDialect = 'claude-code' | 'codex'

// 匹配模式解释方式
type MatcherMode = 'claude-code' | 'codex'

// 一次钩子调用的配对标识
interface HookInvocation {
  turn: number
  point: string       // 钩子点：PreToolUse / Stop / UserPromptSubmit ...
  dialect: HookDialect
  handlerId: string   // 关联 invoked/result 的稳定 id
  matcher?: string
}

// 扩展 Cordis 类型：声明钩子事件 + ctx.hooks 服务
declare module '@cordisjs/core' {
  interface Events {
    // 钩子点拦截事件：监听器可以检查/拒绝（瀑布，dsh: agent/pre-step 等）
    'hook/point': (point: string, payload: Record<string, unknown>, next: () => Promise<void>) => Promise<void>
  }

  interface Context {
    hooks: HookService
  }
}

// ============================================================
// 2. Matcher：模式匹配（dsh: hook-protocol/src/matcher.ts）
// ============================================================

// 缺省 / 空 / '*' = 匹配所有
function isMatchAll(matcher: string | undefined): boolean {
  return matcher === undefined || matcher === '' || matcher === '*'
}

// Claude 字面量模式：纯字母数字下划线 + '|'（'|' = 精确匹配的或）
const CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/

// 编译非锚定正则；非法模式返回 undefined（不抛）
function compileRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

// 校验 matcher：返回诊断信息或 undefined（合法）
function matcherDiagnostic(matcher: string | undefined, mode: MatcherMode): string | undefined {
  if (isMatchAll(matcher)) return undefined
  const pattern = matcher as string
  if (mode === 'claude-code' && CLAUDE_LITERAL.test(pattern)) return undefined
  return compileRegex(pattern) === undefined
    ? `invalid ${mode} regex matcher ${JSON.stringify(pattern)}`
    : undefined
}

// matcher 是否选中 query：
// - Claude 字面量：精确匹配 | 分隔的替代项
// - 其他：非锚定正则
function matchesMatcher(matcher: string | undefined, query: string, mode: MatcherMode): boolean {
  if (isMatchAll(matcher)) return true
  const pattern = matcher as string
  if (mode === 'claude-code' && CLAUDE_LITERAL.test(pattern)) {
    return pattern.split('|').includes(query)  // 字面量：管道分隔的精确匹配
  }
  const regex = compileRegex(pattern)
  return regex === undefined ? false : regex.test(query)  // 正则：非锚定匹配
}

// ============================================================
// 3. Codec：钩子输出解码（dsh: hook-protocol/src/codec.ts）
// ============================================================

// exit 2 = 阻塞错误（stderr 作为原因）
const BLOCKING_EXIT_CODE = 2

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

function bool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key]
  return typeof v === 'boolean' ? v : undefined
}

function asObj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

// 顶层 decision 只有 approve/block（allow/deny/ask 是 hookSpecificOutput 专属）
function topLevelDecisionOf(value: string | undefined): HookOutput['decision'] {
  return value === 'approve' || value === 'block' ? value : undefined
}

// permissionDecision 只有 allow/deny/ask
function permissionDecisionOf(value: string | undefined): HookOutput['decision'] {
  return value === 'allow' || value === 'deny' || value === 'ask' ? value : undefined
}

/**
 * 解码钩子进程输出（dsh: parseHookOutput）
 * - exit 0 + stdout 是 JSON 对象 → 解析结构化字段
 * - exit 2 → block，stderr 作为 reason
 * - 其他 exit / 无法运行 → 非阻塞错误
 * - 非法 JSON 保持为普通 stdout
 */
function parseHookOutput(exitCode: number | undefined, stdout: string, stderr: string): HookOutput {
  const trimmedErr = stderr.trim()
  const trimmedOut = stdout.trim()
  const output: HookOutput = { exitCode, stderr: trimmedErr, stdout: trimmedOut }

  // exit 2 = 阻塞，stderr 为原因
  if (exitCode === BLOCKING_EXIT_CODE) {
    output.decision = 'block'
    if (trimmedErr.length > 0) output.reason = trimmedErr
  }

  // exit 0 才解析结构化 stdout
  if (exitCode === 0 && trimmedOut.startsWith('{')) {
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = asObj(JSON.parse(trimmedOut))
    } catch {
      parsed = undefined  // 非法 JSON 保持普通文本
    }
    if (parsed) applyStructured(output, parsed)
  }

  return output
}

// 把结构化 stdout 折进 output（dsh: applyStructured）
function applyStructured(output: HookOutput, parsed: Record<string, unknown>): void {
  const cont = bool(parsed, 'continue')
  if (cont !== undefined) output.continue = cont
  const stopReason = str(parsed, 'stopReason')
  if (stopReason !== undefined) output.stopReason = stopReason
  const sysMsg = str(parsed, 'systemMessage')
  if (sysMsg !== undefined) output.systemMessage = sysMsg

  // 顶层 legacy decision（approve/block only）
  const topDecision = topLevelDecisionOf(str(parsed, 'decision'))
  if (topDecision !== undefined) output.decision = topDecision
  const topReason = str(parsed, 'reason')
  if (topReason !== undefined) output.reason = topReason

  // hookSpecificOutput：permissionDecision 覆盖顶层 decision
  const hso = asObj(parsed.hookSpecificOutput)
  if (hso) {
    const permission = permissionDecisionOf(str(hso, 'permissionDecision'))
    if (permission !== undefined) output.decision = permission
    const permissionReason = str(hso, 'permissionDecisionReason')
    if (permissionReason !== undefined) output.reason = permissionReason
    const addCtx = str(hso, 'additionalContext')
    if (addCtx !== undefined) output.additionalContext = addCtx
  }
}

// ============================================================
// 4. Runner：执行钩子命令（dsh: hook-protocol/src/runner.ts）
// ============================================================

// 参考默认超时：10 分钟（Claude Code / Codex 的默认）
const DEFAULT_HOOK_TIMEOUT_MS = 600_000

interface RunHookOptions {
  payload: unknown          // 写入 stdin 的 JSON
  env?: Record<string, string>  // 额外环境变量
  cwd?: string
  signal: AbortSignal
  defaultTimeoutMs?: number
}

interface RunHookResult {
  output: HookOutput
  durationMs: number
}

/**
 * 执行一条钩子命令（dsh: runHook）
 * 通过子进程执行（教学简化：直接 spawn），超时控制，
 * 基础设施故障 → 无 exitCode 的非阻塞错误（绝不抛到调用方）
 */
async function runHook(hook: CommandHook, options: RunHookOptions): Promise<RunHookResult> {
  const started = Date.now()
  const timeoutMs = hook.timeoutSec !== undefined
    ? hook.timeoutSec * 1000
    : (options.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)
  const stdin = JSON.stringify(options.payload)

  try {
    // 教学简化：用 child_process 执行钩子命令
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    const result = await execFileAsync('/bin/sh', ['-c', hook.command], {
      input: stdin,
      timeout: timeoutMs,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      maxBuffer: 1024 * 1024,
    })

    return {
      output: parseHookOutput(0, result.stdout, result.stderr ?? ''),
      durationMs: Date.now() - started,
    }
  } catch (error: any) {
    // 子进程非零退出：execFile 抛错，error.code 是 exit code
    if (typeof error?.code === 'number') {
      return {
        output: parseHookOutput(error.code, error.stdout ?? '', error.stderr ?? ''),
        durationMs: Date.now() - started,
      }
    }
    // 基础设施故障（超时/无法运行）：无 exitCode，非阻塞
    const message = error instanceof Error ? error.message : String(error)
    return {
      output: parseHookOutput(undefined, '', message),
      durationMs: Date.now() - started,
    }
  }
}

// ============================================================
// 5. HookService：注册、匹配、执行、事件日志
// ============================================================

// 配置：方言 + 钩子组
interface HooksConfig {
  dialect?: HookDialect
  groups?: MatcherGroup[]
  defaultTimeoutSec?: number
}

// 简单 Session 事件日志（复用系列前几篇的模式）
type SessionEvent =
  | { type: 'hook/invoked'; seq: number; turn: number; point: string; matcher?: string; handlerId: string; timestamp: number }
  | { type: 'hook/result'; seq: number; turn: number; point: string; handlerId: string; decision: string; exitCode?: number; durationMs: number; timestamp: number }

class HookService extends Service {
  private groups: MatcherGroup[] = []
  private counter = 0        // handlerId 计数器
  private logSeq = 0         // 事件日志 seq（连续递增）
  readonly dialect: HookDialect

  constructor(ctx: Context, config: HooksConfig = {}) {
    super(ctx, 'hooks')
    this.dialect = config.dialect ?? 'claude-code'
    // 注册配置里的钩子组
    for (const group of config.groups ?? []) {
      this.registerGroup(group)
    }
  }

  /** 注册一个 matcher 组（dsh: 配置解析后注册） */
  registerGroup(group: MatcherGroup): () => void {
    // 校验 matcher 合法性
    const diagnostic = matcherDiagnostic(group.matcher, this.dialect)
    if (diagnostic !== undefined) {
      throw new Error(`hook config: ${diagnostic}`)
    }
    return this.ctx.effect(() => {
      this.groups.push(group)
      return () => {
        this.groups.splice(this.groups.indexOf(group), 1)
      }
    })
  }

  /** 在某个钩子点执行所有匹配的钩子（dsh: 桥接到拦截点） */
  async fire(point: string, query: string, payload: Record<string, unknown>, turn = 1): Promise<HookOutput[]> {
    const results: HookOutput[] = []

    for (const group of this.groups) {
      if (!matchesMatcher(group.matcher, query, this.dialect)) continue

      for (const hook of group.hooks) {
        const handlerId = `hook-${++this.counter}`
        // 记录 invoked（配对开始）
        const invoked: SessionEvent = {
          type: 'hook/invoked', seq: ++this.logSeq, turn, point,
          ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          handlerId, timestamp: Date.now(),
        }
        this.log(invoked)

        // 执行钩子
        const { output, durationMs } = await runHook(hook, {
          payload: { ...payload, hookEventName: point },
          env: { DSH_HOOK_POINT: point, DSH_HOOK_QUERY: query },
          signal: new AbortController().signal,
        })

        // 记录 result（配对结束）
        const decision = output.decision ?? (output.continue === false ? 'stop' : 'pass')
        const result: SessionEvent = {
          type: 'hook/result', seq: ++this.logSeq, turn, point, handlerId,
          decision,
          ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
          durationMs, timestamp: Date.now(),
        }
        this.log(result)

        console.log(`  🔌 [${point}] matcher=${group.matcher ?? '*'} 钩子 "${hook.command}" → ${decision}${output.reason ? ` (${output.reason})` : ''}`)
        results.push(output)
      }
    }

    return results
  }

  /** 事件日志（简化：内存数组，dsh 写入 Session） */
  private events: SessionEvent[] = []
  private log(event: SessionEvent): void {
    this.events.push(event)
  }

  /** 查看钩子事件日志（审计） */
  getLog(): SessionEvent[] {
    return [...this.events]
  }
}

// ============================================================
// 6. 演示
// ============================================================

console.log('='.repeat(60))
console.log('博客10：Hooks 模块 - 钩子协议')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(HookService, {
  dialect: 'claude-code',
  groups: [
    // 匹配所有工具的钩子：记录每个工具调用
    { matcher: '*', hooks: [
      { command: 'echo "{\\"continue\\":true,\\"hookEventName\\":\\"PreToolUse\\"}"', timeoutSec: 5 },
    ] },
    // 精确匹配 bash 的钩子：要求批准
    { matcher: 'bash', hooks: [
      { command: 'echo "{\\"decision\\":\\"block\\",\\"reason\\":\\"bash 需要人工批准\\"}"', timeoutSec: 5 },
    ] },
    // 正则匹配 read_* 的钩子：注入额外上下文
    { matcher: 'read_.*', hooks: [
      { command: 'echo "{\\"hookSpecificOutput\\":{\\"permissionDecision\\":\\"allow\\",\\"additionalContext\\":\\"文件读取需谨慎\\"}}"', timeoutSec: 5 },
    ] },
  ],
})

// ---- Part 1: Matcher 匹配 ----
console.log('\n' + '='.repeat(60))
console.log('Part 1: Matcher 匹配')
console.log('='.repeat(60))

console.log('📋 matcher 匹配测试（dialect: claude-code）:')
const testCases: Array<[string, string]> = [
  ['*', 'bash'],
  ['bash', 'bash'],
  ['bash', 'read_file'],
  ['read_.*', 'read_file'],
  ['read_.*', 'write_file'],
  ['bash|read_file', 'read_file'],  // 管道 = 精确匹配或
  ['bash|read_file', 'write_file'],
]
for (const [matcher, query] of testCases) {
  console.log(`  matcher "${matcher}" vs "${query}" → ${matchesMatcher(matcher, query, 'claude-code')}`)
}

// ---- Part 2: Codec 输出解码 ----
console.log('\n' + '='.repeat(60))
console.log('Part 2: Codec 输出解码')
console.log('='.repeat(60))

console.log('📋 输出解码测试:')
const codecTests: Array<[number | undefined, string, string]> = [
  [0, '{"decision":"approve"}', ''],
  [0, '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"不合规"}}', ''],
  [2, '', '检测到危险操作'],
  [1, 'some error output', 'failed'],
  [undefined, '', '无法运行'],
]
for (const [exitCode, stdout, stderr] of codecTests) {
  const out = parseHookOutput(exitCode, stdout, stderr)
  console.log(`  exit=${exitCode} stdout="${stdout.slice(0, 40)}" → decision=${out.decision ?? '无'}${out.reason ? ` reason="${out.reason}"` : ''}`)
}

// ---- Part 3: 钩子执行（模拟工具调用拦截）----
console.log('\n' + '='.repeat(60))
console.log('Part 3: 钩子执行（工具调用拦截）')
console.log('='.repeat(60))

// 模拟 Agent 要调用工具前触发 PreToolUse 钩子
console.log('🚀 Agent 尝试调用 bash...')
const bashResults = await ctx.hooks.fire('PreToolUse', 'bash', { tool_name: 'bash', tool_input: { command: 'rm -rf /' } })
console.log(`  决策汇总: ${bashResults.map(r => r.decision ?? 'pass').join(', ')}`)

console.log('\n🚀 Agent 尝试调用 read_file...')
const readResults = await ctx.hooks.fire('PreToolUse', 'read_file', { tool_name: 'read_file', tool_input: { path: '/etc/passwd' } })
console.log(`  决策汇总: ${readResults.map(r => r.decision ?? 'pass').join(', ')}`)
for (const r of readResults) {
  if (r.additionalContext) console.log(`  📎 附加上下文: ${r.additionalContext}`)
}

console.log('\n🚀 Agent 尝试调用 write_file...')
const writeResults = await ctx.hooks.fire('PreToolUse', 'write_file', { tool_name: 'write_file', tool_input: { path: '/tmp/x' } })
console.log(`  决策汇总: ${writeResults.map(r => r.decision ?? 'pass').join(', ')}`)

// ---- Part 4: 钩子事件日志（审计）----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 钩子事件日志（审计）')
console.log('='.repeat(60))

console.log('📜 hook/invoked + hook/result 配对事件:')
for (const event of ctx.hooks.getLog()) {
  if (event.type === 'hook/invoked') {
    console.log(`  #${event.seq} hook/invoked point=${event.point} matcher=${event.matcher ?? '*'} id=${event.handlerId}`)
  } else {
    console.log(`  #${event.seq} hook/result  id=${event.handlerId} decision=${event.decision}${event.exitCode !== undefined ? ` exit=${event.exitCode}` : ''} ${event.durationMs}ms`)
  }
}

console.log('\n✅ 博客10 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. Matcher - 字面量/正则/匹配所有（hook-protocol/src/matcher.ts）')
console.log('  2. Codec - exit 0 JSON / exit 2 block 解码（hook-protocol/src/codec.ts）')
console.log('  3. Runner - 执行钩子 + 超时 + 基础设施故障容错（hook-protocol/src/runner.ts）')
console.log('  4. Events - hook/invoked + hook/result 配对日志（hook-protocol/src/events.ts）')
console.log('  5. HookService - 注册/匹配/执行/接入拦截点（hooks-claude-code / hooks-codex）')
