/**
 * 博客17：plan 域 - 计划模式（演示入口）
 *
 * 只做组装和演示。实现分布在 src/ 各文件，对应 dsh 的 packages/plan/plan-mode：
 *   types.ts      plan/mode 事件 + 投影类型（plan-mode/src/types.ts）
 *   session.ts    Session 事件日志（dsh-session）
 *   agent.ts      Agent + AgentFactory（dsh-agent）
 *   tools.ts      ToolRegistry + userQuestions（dsh-tools / dsh-user-questions）
 *   domain.ts     foldPlanMode + resolveConfig + hasOpenTurn（plan-mode/src/index.ts）
 *   plan-mode.ts  PlanModeController（plan-mode/src/index.ts）
 *
 * 核心机制（dsh README）："Plan mode is logged, per-agent collaboration state"
 * - plan/mode 事件：log-only、whole-value-replace，重放恢复
 * - set：idle 立即 append，running 挂起 pending 等 pre-step
 * - exit_plan_mode：始终注册，active 才可用，经 userQuestions 审批
 */

import { Context } from '@cordisjs/core'
import { AgentFactory, Agent } from './agent.ts'
import { ToolRegistry, UserQuestions } from './tools.ts'
import { SystemPromptService } from './system-prompt.ts'
import { PlanModeController, EXIT_PLAN_MODE } from './plan-mode.ts'
import { foldPlanMode } from './domain.ts'

const APPROVE_LABEL = 'Approve'  // dsh: plan-mode/src/index.ts 的 APPROVE_LABEL

console.log('='.repeat(60))
console.log('博客17：plan 域 - 计划模式（记录在案的协作状态）')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(AgentFactory)
await ctx.plugin(ToolRegistry)
await ctx.plugin(UserQuestions)
await ctx.plugin(SystemPromptService)
await ctx.plugin(PlanModeController, {
  section: 'You are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.',
})

const agent = ctx.agents.create('main-1')

// ---- Part 1: 初始状态（未进入计划模式）----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 初始状态（未进入计划模式）')
console.log('='.repeat(60))

console.log(`\n📋 plan 状态: ${JSON.stringify(ctx.planMode.get(agent))}`)
console.log(`  guidance 渲染: ${ctx.planMode.guidance(agent) === '' ? '（空——inactive 不渲染）' : ctx.planMode.guidance(agent)}`)
console.log(`  exit_plan_mode 已注册: ${await ctx.tools.invoke(EXIT_PLAN_MODE, { plan: '# 测试' }, { agent }).then(() => '可用（inactive 也注册，调用会拒绝）').catch((e: any) => `不可用（${e.message}）`)}`)

// 组装完整 system prompt（inactive 时 plan:policy 贡献空串）
console.log('\n🧠 组装 system prompt（未进入计划模式）:')
for (const s of ctx.systemPrompt.assembleDetail({ agent })) {
  console.log(`  [order ${String(s.order).padStart(4)}] ${s.name}: ${s.text === '' ? '（空——不贡献）' : s.text.slice(0, 60)}`)
}

// ---- Part 2: 进入计划模式（idle → committed）----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 进入计划模式（idle 立即生效）')
console.log('='.repeat(60))

const r1 = ctx.planMode.set(agent, true)
console.log(`\n🚀 set(agent, true) → ${r1}（idle 无 open turn，立即 append plan/mode 事件）`)
console.log(`  plan 状态: ${JSON.stringify(ctx.planMode.get(agent))}`)
console.log('  会话日志:')
for (const e of agent.session.events) {
  if (e.type === 'plan/mode') console.log(`    #${e.seq} plan/mode active=${e.data.active}`)
}

console.log('\n🧠 guidance 渲染（active 时）:')
console.log(`  ${ctx.planMode.guidance(agent)}`)

console.log('\n🧠 组装完整 system prompt（进入计划模式后，plan:policy 贡献 section）:')
for (const s of ctx.systemPrompt.assembleDetail({ agent })) {
  console.log(`  [order ${String(s.order).padStart(4)}] ${s.name}: ${s.text === '' ? '（空——不贡献）' : s.text.slice(0, 60)}`)
}

console.log('\n📜 模型实际看到的完整 system prompt:')
console.log('  ──────────────────────────────────────')
const full = ctx.systemPrompt.assemble({ agent })
for (const line of full.split('\n')) console.log(`  ${line}`)
console.log('  ──────────────────────────────────────')

// ---- Part 3: running 时切换（不打断当前轮——真实场景）----
console.log('\n' + '='.repeat(60))
console.log('Part 3: running 时切换（不打断——真实场景）')
console.log('='.repeat(60))

// 场景：agent 处于计划模式（Part 2 进入），用户让它写报告（长 turn），写一半时用户改主意切回默认模式
console.log('\n📝 场景：agent 在计划模式下，用户让它先写份报告（一轮长 turn，进行到一半）...')
agent.session.append({ type: 'turn/start', turn: agent.turn + 1 })
agent.session.append({ type: 'user/message', text: '把这份报告写到 docs/report.md' })
agent.session.append({ type: 'assistant/message', text: '正在写第 3/10 段...（还没写完）' })

// 此时用户切换回默认模式
console.log('👤 用户此刻切换回默认模式（set(agent, false)）...')
const r2 = ctx.planMode.set(agent, false)
console.log(`  set 返回: ${r2}（open turn → 挂起 pending，不打断写报告）`)

// 关键：当前轮不受影响，照常完成
console.log('\n✅ 当前轮不受影响，agent 继续把报告写完:')
agent.session.append({ type: 'assistant/message', text: '第 4/10 段... 第 10/10 段，写完了。' })
agent.session.append({ type: 'turn/end', turn: agent.turn, reason: { kind: 'completed' } })
console.log('  报告写完，turn 正常结束。')
console.log('  对比：如果 set 打断当前轮，写到一半的报告就丢了——这就是"不打断"的好处。')

// 下一轮 turn/start：pre-step 应用 pending
console.log('\n⚙️  下一轮开始（turn/start），pre-step 应用挂起的 plan 选择:')
agent.session.append({ type: 'turn/start', turn: agent.turn + 1 })
ctx.planMode.applyPending(agent)
console.log(`  plan 状态: ${JSON.stringify(ctx.planMode.get(agent))}（此时才生效，因为新的一轮要组装 prompt）`)
console.log('  新一轮的 guidance（已退出计划模式，不渲染）:')
console.log(`    ${ctx.planMode.guidance(agent) === '' ? '（空——已退出）' : ctx.planMode.guidance(agent)}`)
agent.session.append({ type: 'turn/end', turn: agent.turn, reason: { kind: 'completed' } })

console.log('\n📋 时间线:')
console.log('  turn 1 开始 → 用户 set(false) [挂起] → 写完报告 → turn 1 结束')
console.log('  turn 2 开始 → pre-step 应用 pending → 新轮无 plan guidance → turn 2 结束')
console.log('  （退出计划模式从 turn 2 才开始生效——写报告那轮完全没被打断）')

// ---- Part 4: 重复选择（noop）----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 重复选择（noop）')
console.log('='.repeat(60))

const r3 = ctx.planMode.set(agent, false)
console.log(`\n🚀 再 set(agent, false) → ${r3}（已是该状态，无操作）`)

// ---- Part 5: 重新进入 + exit_plan_mode 审批（Approve）----
console.log('\n' + '='.repeat(60))
console.log('Part 5: exit_plan_mode 审批（用户 Approve）')
console.log('='.repeat(60))

ctx.planMode.set(agent, true)
console.log(`\n📋 当前 plan 状态: ${JSON.stringify(ctx.planMode.get(agent))}（重新进入）`)

// 注册回答者：模拟用户点 Approve
ctx.userQuestions.setAnswerer(async (q) => {
  console.log(`  🖥️ [UI] 收到审批: ${q.question}`)
  console.log(`  🖥️ [UI] 选项: ${q.options.map(o => o.label).join(' / ')}`)
  console.log(`  👤 [用户] 点击 Approve`)
  return { answers: [{ id: q.id, selected: [APPROVE_LABEL], custom: undefined }] }
})

const plan = '# 重构方案\n\n1. 抽取 Service 层\n2. 迁移配置\n3. 补测试'
console.log(`\n🚀 模型调用 exit_plan_mode(plan=${JSON.stringify(plan.slice(0, 12))}...)`)
const exit1 = await ctx.tools.invoke(EXIT_PLAN_MODE, { plan }, { agent })
console.log(`  ✅ 工具返回: ${JSON.stringify(exit1)}`)
console.log(`  plan 状态: ${JSON.stringify(ctx.planMode.get(agent))}（pending 退出，pre-step 应用）`)

// pre-step 应用退出
ctx.planMode.applyPending(agent)
console.log(`  pre-step 应用后: ${JSON.stringify(ctx.planMode.get(agent))}`)
console.log('  会话日志:')
for (const e of agent.session.events) {
  if (e.type === 'plan/mode') console.log(`    #${e.seq} plan/mode active=${e.data.active}`)
}

// ---- Part 6: exit_plan_mode 审批（Keep planning）----
console.log('\n' + '='.repeat(60))
console.log('Part 6: exit_plan_mode 审批（用户 Keep planning）')
console.log('='.repeat(60))

ctx.planMode.set(agent, true)
ctx.userQuestions.setAnswerer(async (q) => {
  console.log(`  👤 [用户] 点击 Keep planning（附反馈: 先加测试再重构）`)
  return { answers: [{ id: q.id, selected: [], custom: '先加测试再重构' }] }
})

console.log('\n🚀 模型再次调用 exit_plan_mode:')
try {
  await ctx.tools.invoke(EXIT_PLAN_MODE, { plan: '# 重构方案 v2' }, { agent })
} catch (error: any) {
  console.log(`  ❌ 工具报错（保持计划模式）: ${error.message}`)
}
console.log(`  plan 状态: ${JSON.stringify(ctx.planMode.get(agent))}（仍在计划模式）`)

// ---- Part 7: 非计划模式调用 exit（拒绝）----
console.log('\n' + '='.repeat(60))
console.log('Part 7: 非计划模式调用 exit_plan_mode（拒绝）')
console.log('='.repeat(60))

ctx.planMode.set(agent, false)
console.log(`\n📋 当前 plan 状态: ${JSON.stringify(ctx.planMode.get(agent))}（已退出）`)
try {
  await ctx.tools.invoke(EXIT_PLAN_MODE, { plan: '# 不该出现' }, { agent })
} catch (error: any) {
  console.log(`  ❌ 正确拒绝: ${error.message}`)
}

// ---- Part 8: 重放恢复（日志是唯一真源）----
console.log('\n' + '='.repeat(60))
console.log('Part 8: 重放恢复（foldPlanMode——日志是唯一真源）')
console.log('='.repeat(60))

console.log('\n📊 最终重放:')
console.log(`  foldPlanMode(events) = ${foldPlanMode(agent.session.events)}（最后一条 plan/mode 生效）`)
console.log('  会话日志中的 plan/mode 事件:')
let n = 0
for (const e of agent.session.events) {
  if (e.type === 'plan/mode') { n++; console.log(`    #${e.seq} active=${e.data.active}`) }
}
console.log(`  （共 ${n} 条——重放即完整状态，resume/fork 恢复不需要实时镜像）`)

console.log('\n✅ 博客17 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. PlanModeController - 计划模式控制器（plan-mode/src/index.ts）')
console.log('  2. foldPlanMode - 重放日志算 plan 状态（index.ts）')
console.log('  3. set 的 committed/queued/cancelled/noop - idle 与 running 分支（index.ts）')
console.log('  4. pendingIntents - 等待 pre-step 的挂起选择（index.ts WeakMap）')
console.log('  5. exit_plan_mode 工具 - 始终注册，active 才可用（index.ts）')
console.log('  6. userQuestions 审批 - plan-review intent（index.ts，复用 blog-13 的提问服务）')
console.log('  7. resolveConfig - 部署配置校验（index.ts）')
console.log('  8. plan/mode 事件 - log-only whole-value-replace（index.ts SessionEventMap）')
