/**
 * 博客14：subagent 域 - 子代理委托（演示入口）
 *
 * 只做组装（插件注册 + 工具注册）和演示。实现分布在 src/ 各文件，
 * 每文件对应 dsh 的一个包/模块：
 *   types.ts          类型定义（dsh: subagent/src/types.ts）
 *   session.ts        Session 事件日志（dsh-session）
 *   agent.ts          Agent + AgentFactory（dsh-agent）
 *   tools.ts          ToolRegistry（dsh-tools）
 *   subagent.ts       SubagentRuntime 服务定义（subagent/src/index.ts）
 *   child-agent.ts    深度 + 委托策略 + 组合（subagent/src/child-agent.ts）
 *   driver.ts         共享驱动 startInProcessRun（subagent-in-process-driver）
 *   provider-spawn.ts spawn provider（subagent-spawn-in-process）
 *   tool-subagent.ts  subagent 工具（tool-subagent）
 */

import { Context } from '@cordisjs/core'
import { AgentFactory } from './agent.ts'
import { ToolRegistry } from './tools.ts'
import { SubagentRuntime, finalAssistantOutput } from './subagent.ts'
import { spawnProvider } from './provider-spawn.ts'
import { registerSubagentTool } from './tool-subagent.ts'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun } from './types.ts'

console.log('='.repeat(60))
console.log('博客14：subagent 域 - 子代理委托')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(AgentFactory)
await ctx.plugin(ToolRegistry)
await ctx.plugin(SubagentRuntime)
registerSubagentTool(ctx)

ctx.on('subagent/provider-added', (p) => {
  console.log(`  📡 事件 subagent/provider-added: ${p.name}（capabilities: ${Object.entries(p.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ')}）`)
})
ctx.on('subagent/start', (info) => {
  console.log(`  📡 事件 subagent/start: runId=${info.runId} provider=${info.provider}`)
})
ctx.on('subagent/end', (info) => {
  console.log(`  📡 事件 subagent/end: runId=${info.runId} outcome=${info.outcome}`)
})

// 父代理：有会话 + 自己的 system prompt（模拟部署预设）
const parent = ctx.agents.create('parent-1')
parent.session.meta = { delegationDepth: 0 }
parent.session.append({ type: 'sandbox/mode', mode: 'workspace-write' })
parent.session.append({ type: 'approval/policy', policy: 'ask' })
parent.systemPrompt = ['You are the main agent. You coordinate subtasks and integrate results.']

// ---- Part 1: 注册 provider ----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 注册 provider（命名注册表）')
console.log('='.repeat(60))

const disposeSpawn = ctx.subagents.registerProvider(spawnProvider)
console.log('\n📦 已注册 providers:', ctx.subagents.list().join(', '))

// ---- Part 2: 子代理的提示词（own system prompt）----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 子代理的提示词（applyChildComposition 组装）')
console.log('='.repeat(60))

console.log('\n🧠 父代理的 system prompt:')
for (const line of parent.systemPrompt) console.log(`  - ${line}`)

console.log('\n🧠 子代理的 system prompt（委托时组装，own system prompt）:')
const run = await ctx.subagents.start('spawn', {
  label: '调研',
  prompt: [{ type: 'text', text: '调研 dsh 的 subagent 域包含哪些包' }],
  parent,
  persona: '专注的调研员',
})
const child = run.localAgent!
for (const line of child.systemPrompt) console.log(`  - ${line}`)

console.log('\n📜 子会话事件日志（own session）:')
for (const e of child.session.events) {
  const extra = e.type === 'sandbox/mode' && e.source ? ` source=${e.source}` : e.type === 'approval/policy' && e.source ? ` source=${e.source}` : ''
  const val = 'mode' in e ? ` = ${(e as any).mode}` : 'policy' in e ? ` = ${(e as any).policy}` : 'text' in e ? `: ${(e as any).text.slice(0, 55)}` : ''
  console.log(`    #${e.seq} ${e.type}${val}${extra}`)
}

// ---- Part 3: 父子通信（followup → whenIdle → finalAssistantOutput）----
console.log('\n' + '='.repeat(60))
console.log('Part 3: 父子通信（父投递 → 子执行 → 父读结果）')
console.log('='.repeat(60))

const result = await run.result
console.log(`\n📤 父拿到子代理结果（stopReason: ${result.stopReason}）:`)
for (const b of result.output) console.log(`  ${b.text}`)

console.log('\n🔁 通信时序（同进程，无网络）:')
console.log('  父 followup(prompt)  ──▶  子 inbox 入队')
console.log('  子 drain() 执行       ──▶  子会话写 user + assistant 消息')
console.log('  父 whenIdle() 等待    ◀──  子回复完成')
console.log('  父 finalAssistantOutput()  ◀─  读子会话最后一条 assistant 消息')

// ---- Part 4: 深度控制 + 委托策略固定 ----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 深度控制 + 委托策略固定')
console.log('='.repeat(60))

// 深度 1 的父 → maxDepth 2 未超限
const midParent = ctx.agents.create('mid-1')
midParent.session.meta = { delegationDepth: 1 }
const deepRun = await ctx.subagents.start('spawn', {
  label: '孙子任务', prompt: [{ type: 'text', text: '深度未超限' }], parent: midParent, maxDepth: 2,
})
console.log(`\n✅ 深度 1 的父委托 maxDepth=2 → 子深度 ${deepRun.localAgent!.session.meta.delegationDepth}（未超限）`)

// 深度 2 的父 → 超限
const greatParent = ctx.agents.create('ggp-1')
greatParent.session.meta = { delegationDepth: 2 }
try {
  await ctx.subagents.start('spawn', {
    label: '曾孙任务', prompt: [{ type: 'text', text: '太深了' }], parent: greatParent, maxDepth: 2,
  })
} catch (error: any) {
  console.log(`❌ 深度 2 的父委托 maxDepth=2 → 正确报错: ${error.message}`)
}

// 委托策略固定
console.log('\n🔒 委托策略固定:')
console.log(`  sandbox/mode: ${child.session.events.find(e => e.type === 'sandbox/mode')!.mode}（继承父的 workspace-write）`)
console.log(`  approval/policy: ${child.session.events.find(e => e.type === 'approval/policy')!.policy}（无论父是 ask 一律 never）`)

// ---- Part 5: 能力校验 ----
console.log('\n' + '='.repeat(60))
console.log('Part 5: 能力校验（assertCapabilities）')
console.log('='.repeat(60))

// 演示用 provider：什么能力都不支持（真实代码里放 provider 文件，这里是演示用例）
const simpleProvider: SubagentProvider = {
  name: 'simple',
  capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
  inheritsParentContext: false,
  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const child = ctx.agents.create('child-simple-demo')
    const result: Promise<SubagentResult> = (async () => {
      child.followup({ type: 'text', text: request.prompt.map(b => b.text).join('') })
      await child.whenIdle()
      return { output: finalAssistantOutput(child.session), stopReason: 'completed' }
    })()
    return { id: child.id, localAgent: child, result, dispose: async () => {} }
  },
}
ctx.subagents.registerProvider(simpleProvider)

try {
  await ctx.subagents.start('simple', {
    label: '要 schema', prompt: [{ type: 'text', text: '返回 JSON' }], parent, outputSchema: { type: 'object' },
  })
} catch (error: any) {
  console.log(`❌ simple provider 不支持 outputSchema → 正确报错: ${error.message}`)
}
console.log(`\n📦 现在 providers: ${ctx.subagents.list().join(', ')}`)

// ---- Part 6: 模型经工具委托（完整链路）----
console.log('\n' + '='.repeat(60))
console.log('Part 6: 模型经工具委托（完整链路）')
console.log('='.repeat(60))

console.log('\n🚀 模型声明 subagent 工具调用:')
console.log('  模型 ──▶ subagent 工具 ──▶ ctx.subagents.start ──▶ spawn provider')
console.log('       ──▶ ctx.agents.create（新 Agent）──▶ followup 投递 ──▶ 子执行 ──▶ 结果返回')

const toolResult = await ctx.tools.invoke('subagent', {
  description: '代码审查',
  prompt: '审查 blog-13 的 interaction 实现，指出设计要点',
  provider: 'spawn',
  persona: '严格的代码审查员',
}, { agent: parent })
console.log(`  ✅ 工具返回: ${toolResult.output}`)
console.log(`  runId: ${toolResult.runId}`)

// ---- Part 7: provider 注销（生命周期闭环）----
console.log('\n' + '='.repeat(60))
console.log('Part 7: provider 注销（生命周期闭环）')
console.log('='.repeat(60))

disposeSpawn()
console.log(`\n🔌 注销 spawn provider 后 providers: ${ctx.subagents.list().join(', ')}`)
console.log(`  getProvider('spawn'): ${ctx.subagents.getProvider('spawn') === undefined ? 'undefined（新委托会 NO_PROVIDER）' : '存在'}`)

console.log('\n✅ 博客14 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. SubagentRuntime - 命名 provider 注册表 + start（subagent/src/index.ts）')
console.log('  2. spawn provider - 薄封装（subagent-spawn-in-process/src/index.ts）')
console.log('  3. startInProcessRun - ctx.agents.create + followup + whenIdle（subagent-in-process-driver/src/index.ts）')
console.log('  4. applyChildComposition - 子代理 system prompt 组装（child-agent.ts）')
console.log('  5. SUBAGENT_DELEGATION_CONTEXT - 子代理固定权限声明（child-agent.ts）')
console.log('  6. captureDelegatedPolicyOverrides - 委托策略固定（child-agent.ts）')
console.log('  7. finalAssistantOutput - 从子会话日志读结果（assistant-output.ts）')
console.log('  8. resolveChildDepth - 深度控制（child-agent.ts）')
console.log('  9. subagent 工具 - 模型侧委托（tool-subagent/src/index.ts）')
console.log('  10. subagent/start + subagent/end - 生命周期事件（index.ts）')
