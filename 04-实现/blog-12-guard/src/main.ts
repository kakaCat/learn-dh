/**
 * 博客13：Guard 模块 - 策略守卫
 *
 * 按 dsh 源码（packages/guard/*）结构实现：
 * - TimeoutPolicy: 工具调用超时守卫（tools/execute 包裹，TOOL_TIMEOUT 结构化结果）
 * - RepeatToolReminder: 重复调用提醒（tools/post-execute 检测 + agent/pre-step 重置）
 * - GuardService: 统一的守卫注册（可选依赖，多个守卫组合）
 *
 * 关键：守卫 = 挂在拦截点事件上的策略插件——不改框架、不改工具。
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 1. 类型定义（简化版：模拟 tools 的 ToolExecution / ToolExecutionResult）
// ============================================================

// 一次工具执行（dsh: ToolExecution）
interface ToolExecution {
  callId: string
  name: string
  arguments: Record<string, unknown> | string  // 解析后的参数（或原始字符串）
  agent?: string   // 调用者 agent（可空——直接调用的没有 model 可提醒）
  signal: AbortSignal
}

// 工具执行结果（dsh: ToolExecutionResult）
interface ToolExecutionResult {
  content: Array<{ type: 'text'; text: string }>
  isError: boolean
  error?: { message: string; info?: { name: string; code: string } }
}

// 工具定义（简化）
interface ToolDefinition {
  name: string
  timeoutMs?: number   // 工具声明的超时预算
  execute: (args: Record<string, unknown>) => Promise<string>
}

// 工具注册表（简化：模拟 blog-05 的 ctx.tools）
const toolRegistry = new Map<string, ToolDefinition>()

// 扩展 Cordis 类型：声明守卫用到的事件
declare module '@cordisjs/core' {
  interface Events {
    // 工具执行管道（简化版，对应 blog-05 的三段瀑布）
    'tools/execute': (exec: ToolExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>
    'tools/post-execute': (exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>
    // 模拟 pre-step（用于重复检测重置）
    'agent/pre-step': (payload: { agent: string; hasUserMessage: boolean }, next: () => Promise<void>) => Promise<void>
  }

  interface Context {
    guard: GuardService
  }
}

// ============================================================
// 2. TimeoutPolicy：工具调用超时守卫（dsh: timeout-policy）
// ============================================================

/**
 * 工具调用超时守卫（dsh: timeout-policy/src/index.ts）。
 * 工具声明 timeoutMs 并承诺尊重 exec.signal；本守卫包装该期限，
 * 到期用结构化 TOOL_TIMEOUT 结果替换，不竞速、不抛弃工具 promise。
 */
const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** 超时结果：模型看到的错误（dsh: toolTimeoutResult） */
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  const message = `tool call timed out after ${timeoutMs}ms`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } },
  }
}

/** 简单的超时信号（dsh 用 @deepseek-ai/dsh-timeout 的 deadline，这里简化） */
function withDeadline(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean } {
  const controller = new AbortController()
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)

  // 上游取消也传导
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })

  return {
    signal: controller.signal,
    timedOut: () => {
      clearTimeout(timer)
      return fired
    },
  }
}

/**
 * 安装超时守卫：包裹 tools/execute。
 * - 工具声明 timeoutMs → 设置期限，替换 exec.signal，委托，恢复
 * - 自己的期限触发 → 用结构化 TOOL_TIMEOUT 替换结果
 * - 工具没声明 → 原样委托
 */
export function applyTimeoutPolicy(ctx: Context): () => void {
  return ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = toolRegistry.get(exec.name)?.timeoutMs
    if (timeoutMs === undefined) return next()  // 无预算：直接委托

    // 设置期限，替换 exec.signal 用于分发
    const { signal, timedOut } = withDeadline(exec.signal, timeoutMs)
    const upstream = exec.signal
    ;(exec as { signal: AbortSignal }).signal = signal

    try {
      const result = await next()
      // 自己的期限触发 → 用结构化 TOOL_TIMEOUT 替换
      if (timedOut()) return toolTimeoutResult(timeoutMs)
      return result
    } finally {
      ;(exec as { signal: AbortSignal }).signal = upstream  // 恢复调用方信号
    }
  })
}

// ============================================================
// 3. RepeatToolReminder：重复调用提醒（dsh: repeat-tool-reminder）
// ============================================================

/**
 * 重复调用提醒守卫（dsh: repeat-tool-reminder/src/index.ts）。
 * 观察性守卫：不否决、不重写调用，只检测「连续相同调用」并在
 * 达到阈值时向模型注入提醒上下文。
 */
interface RepeatConfig {
  thresholds?: number[]      // 触发提醒的连续次数（默认 [3, 5, 8]）
  include?: string[]         // 追踪的工具模式（空 = 全部）
  exclude?: string[]         // 透明的工具模式（不计不重置）
  argumentsPreviewChars?: number  // 提醒中引用参数的最大字符数（默认 500）
}

// 温和的第一档提醒（dsh: GENTLE_REMINDER）
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is '
  + 'not complete, try a different approach or different arguments instead of '
  + 'repeating the call.'

// 详细的后续档提醒（dsh: detailedReminder）
function detailedReminder(toolName: string, count: number, args: string): string {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${args}\n`
    + 'The repeated calls are not making progress. Do not call this tool with '
    + 'these exact arguments again.'
}

// 深排序 JSON 值：{b:1,a:2} 和 {a:2,b:1} 规范化相同（dsh: sortJsonValue）
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

// 参数的规范化字符串（深排序 + stringify）——检测「相同调用」的键
function canonicalize(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

// 通配符 → 锚定正则（* = 任意，其余正则元字符按字面匹配）
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

// 截断参数预览（只影响模型可见文本，检测键始终用完整字符串）
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/** 一个 agent 的连续重复链：最后调用身份键 + 运行长度（dsh: Chain） */
interface Chain {
  key: string
  count: number
}

/**
 * 安装重复提醒守卫：tools/post-execute 计数 + agent/pre-step 重置。
 * - 观察并丰富，从不否决：先计数（状态推进与下游无关），再委托，
 *   最后把提醒折叠到返回结果上
 * - 用户插话改变上下文：跨用户消息的重复不是循环 → 重置链
 */
export function applyRepeatToolReminder(ctx: Context, config: RepeatConfig = {}): () => void {
  const thresholds = [...(config.thresholds ?? [3, 5, 8])].sort((a, b) => a - b)
  const thresholdSet = new Set(thresholds)
  const includePatterns = (config.include ?? []).map(wildcardToRegExp)
  const excludePatterns = (config.exclude ?? []).map(wildcardToRegExp)
  const previewCap = config.argumentsPreviewChars ?? 500

  const chains = new Map<string, Chain>()  // agent id → chain（教学简化用 Map；dsh 用 WeakMap<Agent, Chain>）

  /** 工具是否参与链（未追踪的调用透明：不计也不重置） */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(p => p.test(toolName))) return false
    return !excludePatterns.some(p => p.test(toolName))
  }

  /** 推进链并返回提醒（达到阈值时）——计数发生在 post-execute（被拒的调用也计数） */
  function observe(exec: ToolExecution): string | undefined {
    if (!exec.agent) return undefined       // 直接调用无 model 可提醒
    if (!tracked(exec.name)) return undefined
    const key = JSON.stringify([exec.name, canonicalize(exec.arguments)])
    const chain = chains.get(exec.agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    chains.set(exec.agent, { key, count })
    if (!thresholdSet.has(count)) return undefined
    if (count === thresholds[0]) return GENTLE_REMINDER
    return detailedReminder(exec.name, count, previewArguments(key, previewCap))
  }

  // post-execute：观察 + 委托 + 折叠提醒（不否决）
  const post = ctx.on('tools/post-execute', async (exec, result, next): Promise<ToolExecutionResult> => {
    const reminder = observe(exec)
    const downstream = await next()
    if (!reminder) return downstream
    // 把提醒拼进结果内容（模拟 dsh 的 additionalContexts）
    return {
      ...downstream,
      content: [
        ...downstream.content,
        { type: 'text' as const, text: `\n[guard] ${reminder}` },
      ],
    }
  })

  // pre-step：用户插话重置链（跨用户消息的重复不是循环）
  const pre = ctx.on('agent/pre-step', async ({ agent, hasUserMessage }, next) => {
    if (hasUserMessage) chains.delete(agent)
    return next()
  })

  return () => { post(); pre() }
}

// ============================================================
// 4. GuardService：统一守卫注册
// ============================================================

/**
 * Guard 服务：统一注册守卫（dsh 的 guard/ 域没有此服务——各守卫是独立插件，
 * 这里作为教学聚合，演示「多个守卫可组合」）。
 */
class GuardService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'guard')
  }
}

declare module '@cordisjs/core' {
  interface Context {
    guard: GuardService
  }
}

// ============================================================
// 5. 演示
// ============================================================

console.log('='.repeat(60))
console.log('博客13：Guard 模块 - 策略守卫')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(GuardService)

// ---- Part 1: 超时守卫 ----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 超时守卫（TimeoutPolicy）')
console.log('='.repeat(60))

// 安装超时守卫
applyTimeoutPolicy(ctx)

// 注册两个工具：一个快（50ms），一个慢（声明 100ms 超时但实际跑 500ms）
toolRegistry.set('fast-tool', {
  name: 'fast-tool',
  async execute() { return '快速完成' },
})
toolRegistry.set('slow-tool', {
  name: 'slow-tool',
  timeoutMs: 100,  // 声明超时
  async execute() { await new Promise(r => setTimeout(r, 500)); return '慢速完成' },
})

// 简化执行器：模拟 tools/execute 管道
async function executeTool(name: string, args: Record<string, unknown>, agent?: string): Promise<ToolExecutionResult> {
  const exec: ToolExecution = {
    callId: `c-${Math.random().toString(36).slice(2, 6)}`,
    name,
    arguments: args,
    agent,  // 传入 agent：重复检测需要它（无 agent = 直接调用，不计数）
    signal: new AbortController().signal,
  }
  const result = await ctx.waterfall('tools/execute', exec, async () => {
    const tool = toolRegistry.get(name)
    if (!tool) throw new Error(`Tool ${name} not found`)
    const text = await tool.execute(args)
    return { content: [{ type: 'text', text }], isError: false }
  })
  // post-execute 管道
  return ctx.waterfall('tools/post-execute', exec, result, async () => result)
}

console.log('\n🚀 执行 fast-tool（无超时声明）:')
const fast = await executeTool('fast-tool', {})
console.log(`  ✅ ${fast.content[0]!.text} (isError: ${fast.isError})`)

console.log('\n🚀 执行 slow-tool（声明 100ms 超时，实际 500ms）:')
const slow = await executeTool('slow-tool', {})
console.log(`  ❌ ${slow.content[0]!.text}`)
console.log(`  🔍 error.code: ${slow.error?.info?.code}（TOOL_TIMEOUT，模型可据此路由）`)

// ---- Part 2: 重复调用提醒 ----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 重复调用提醒（RepeatToolReminder）')
console.log('='.repeat(60))

// 安装重复提醒守卫
applyRepeatToolReminder(ctx, { thresholds: [3, 5] })

// 注册一个被重复调用的工具
toolRegistry.set('probe', {
  name: 'probe',
  async execute(args) { return `probe result for ${JSON.stringify(args)}` },
})

// 模拟 agent 连续调用同一个工具、相同参数
async function agentCalls(times: number, args: Record<string, unknown>) {
  for (let i = 1; i <= times; i++) {
    const result = await executeTool('probe', args, 'agent-1')
    console.log(`  调用 #${i}: ${result.content.map(b => b.text).join('')}`)
  }
}

console.log('\n🚀 Agent 连续 6 次调用 probe（相同参数 {query:"x"}）:')
await agentCalls(6, { query: 'x' })

// ---- Part 3: 参数规范化（相同调用检测）----
console.log('\n' + '='.repeat(60))
console.log('Part 3: 参数规范化（相同调用检测）')
console.log('='.repeat(60))

console.log('📋 参数键排序规范化（{b,a} vs {a,b} 视为相同）:')
const k1 = JSON.stringify(['probe', canonicalize({ b: 1, a: 2 })])
const k2 = JSON.stringify(['probe', canonicalize({ a: 2, b: 1 })])
console.log(`  key1: ${k1}`)
console.log(`  key2: ${k2}`)
console.log(`  相同: ${k1 === k2}`)

// ---- Part 4: 用户插话重置链 ----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 用户插话重置链')
console.log('='.repeat(60))

console.log('\n🔄 模拟用户插话（pre-step 带 user 消息）:')
await ctx.waterfall('agent/pre-step', { agent: 'agent-1', hasUserMessage: true }, async () => {})
console.log('  ✅ 链已重置（跨用户消息的重复不是循环）')

console.log('\n🚀 用户插话后再调用 3 次:')
await agentCalls(3, { query: 'x' })

// ---- Part 5: 组合守卫（超时 + 重复提醒同时生效）----
console.log('\n' + '='.repeat(60))
console.log('Part 5: 组合守卫（超时 + 重复同时生效）')
console.log('='.repeat(60))

// 一个又慢又会被重复调用的工具
toolRegistry.set('slow-probe', {
  name: 'slow-probe',
  timeoutMs: 50,
  async execute() { await new Promise(r => setTimeout(r, 300)); return 'slow' },
})

console.log('\n🚀 连续调用 slow-probe 3 次（每次超时 + 第 3 次触发提醒）:')
for (let i = 1; i <= 3; i++) {
  const result = await executeTool('slow-probe', { q: 1 }, 'agent-1')
  console.log(`  调用 #${i}: ${result.content.map(b => b.text).join(' | ')}`)
}

console.log('\n✅ 博客13 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. TimeoutPolicy - tools/execute 包裹 + TOOL_TIMEOUT（guard/timeout-policy/src/index.ts）')
console.log('  2. RepeatToolReminder - post-execute 计数 + pre-step 重置（guard/repeat-tool-reminder/src/index.ts）')
console.log('  3. GENTLE_REMINDER + detailedReminder - 提醒分级（repeat-tool-reminder/src/index.ts）')
console.log('  4. sortJsonValue - 参数规范化（repeat-tool-reminder/src/index.ts）')
console.log('  5. 守卫本质 - 挂在拦截点事件上的策略插件')
