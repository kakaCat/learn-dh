/**
 * 博客20：goal 主题 - 持久化的同会话目标（演示入口）
 *
 * 只做组装和演示。实现分布在 src/ 各文件，对应 dsh 的 packages/goal/：
 *   types.ts       GoalId/GoalPhase/GoalSnapshot/GoalView（goal/src/types.ts）
 *   domain.ts      goal/change 事件与错误码（goal/src/domain.ts）
 *   fold.ts        严格重放（goal/src/fold.ts）
 *   goal.ts        GoalService ctx.goals（goal/src/index.ts）
 *   driver.ts      GoalRoundDriver 自动续跑（goal-round-driver/src/index.ts 简化）
 *   session.ts     Session 事件日志（dsh-session）
 *   agent.ts       Agent + AgentFactory（dsh-agent）
 *   tools.ts       ToolRegistry（dsh-tools）
 *   tool-goal.ts   get_goal/create_goal/update_goal（tool-goal/src/index.ts）
 *
 * 核心机制（dsh README）：
 * - 事件溯源：每次变更写 durable goal/change 事件（完整快照或墓碑）
 * - CAS 修订栅栏：只接受精确 id/revision，过期 ref 拒绝
 * - 生命周期：active / paused / blocked / complete（blocked 带策略 code）
 * - activation 是进程内的，从不持久化
 * - 会话日志是唯一持久权威；重放从 goal/change 派生状态
 */

import { Context } from '@cordisjs/core'
import { AgentFactory } from './agent.ts'
import { GoalService } from './goal.ts'
import { ToolRegistry } from './tools.ts'
import { setupGoalTools } from './tool-goal.ts'
import { GoalRoundDriver } from './driver.ts'
import { foldGoal } from './fold.ts'
import type { Agent } from './agent.ts'
import type { SessionEvent } from './session.ts'

const log = (...args: any[]) => console.log(...args)
const part = (title: string) => {
  console.log('\n' + '='.repeat(60))
  console.log(title)
  console.log('='.repeat(60))
}
const show = (label: string, value: unknown) => log(`  ${label} ${JSON.stringify(value)}`)

console.log('='.repeat(60))
console.log('博客20：goal 主题 - 持久化的同会话目标')
console.log('='.repeat(60))

const ctx = new Context()
await ctx.plugin(AgentFactory)
await ctx.plugin(GoalService)
await ctx.plugin(ToolRegistry)
setupGoalTools(ctx)

/** 一轮"直接人类轮次"：开 turn + 写 user/message（source user）+ 调工具 + 关 turn */
async function humanTurn(agent: Agent, text: string, fn: () => Promise<unknown>): Promise<unknown> {
  agent.startTurn()
  agent.session.append({ type: 'user/message', text, data: { source: { kind: 'user' } } })
  try { return await fn() } finally { agent.endTurn() }
}

/** 一轮"自动目标轮"（模拟 goal-round-driver）：检查 active+armed，写 goal source 消息 */
async function goalRound(agent: Agent, fn: () => Promise<unknown>): Promise<unknown> {
  agent.startTurn()
  const goal = ctx.goals.get(agent)
  if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') {
    agent.endTurn()
    throw new Error(`no armed active goal for ${agent.id}`)
  }
  const next = goal.roundsStarted + 1
  agent.session.append({
    type: 'user/message',
    text: `（目标轮 ${next}）`,
    data: { source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: next } },
  })
  try { return await fn() } finally { agent.endTurn() }
}

// ---- Part 0: 完整案例——driver 自动续跑 ----
part('Part 0: 完整案例——用户请求 → driver 自动续跑 → complete')

const main = ctx.agents.create('main-1')
const driver = new GoalRoundDriver(ctx)

await humanTurn(main, '帮我写一个博客系列，从 0 实现 DeepSeek Harness，每篇讲一个主题', async () => {
  log('\n👤 用户（直接人类轮次）: "帮我写一个博客系列…"')
  log('🤖 模型: 这是长目标，创建 goal')
  const created = await ctx.tools.invoke('create_goal', {
    objective: '写博客系列：从 0 实现 DeepSeek Harness，每篇一个主题',
    max_goal_rounds: 3,
  }, { agent: main })
  show('create_goal →', created)
  return created
})

// driver 自动发起每一轮（agent 静默后 schedule），直到无事可做
const topics = ['loop', 'session', 'tool']
let written = 0
for (;;) {
  const next = driver.schedule(main)     // 检查 active + armed + 预算
  if (next === undefined) break          // 目标 complete / blocked / 预算耗尽 → 停止
  await goalRound(main, async () => {    // 发起一轮
    log(`\n（driver 自动发起 Round ${next.round}）模型工作：写第 ${next.round} 篇（主题：${topics[written] ?? '…'}）`)
    const g = await ctx.tools.invoke('get_goal', {}, { agent: main })
    show('get_goal →', g)
    written += 1
    if (written >= 3) {
      log('  （写完全部 3 篇，模型认为目标已达成）')
      const v = ctx.goals.get(main) as any
      const done = await ctx.tools.invoke('update_goal', {
        goal_id: v.id, revision: v.revision, action: 'complete',
      }, { agent: main })
      show('update_goal complete →', done)
    }
  })
}
// 目标 complete 后 driver 不再发起
const after = driver.schedule(main)
log(`\n目标已 complete → driver 不再发起（schedule 返回 ${JSON.stringify(after)}）`)

// ---- Part 1: create 与 get_goal 的细节 ----
part('Part 1: create 与 get_goal——状态与激活')

const g1 = ctx.agents.create('g1')
await humanTurn(g1, '重构这个项目的配置系统', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '重构配置系统' }, { agent: g1 })
  show('create_goal →', created)
  const read = await ctx.tools.invoke('get_goal', {}, { agent: g1 })
  show('get_goal  →', read)
  return read
})

// ---- Part 2: edit——改目标或轮数上限 ----
part('Part 2: edit——改 objective 或 max_goal_rounds（revision +1）')

const g2 = ctx.agents.create('g2')
await humanTurn(g2, '写一份迁移文档', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '写迁移文档', max_goal_rounds: 2 }, { agent: g2 })
  show('create_goal →', created)
  const v = created as { goal: { id: string; revision: number } }
  const edited = await ctx.tools.invoke('update_goal', {
    goal_id: v.goal.id, revision: v.goal.revision, action: 'edit', objective: '写迁移文档并附回滚方案',
  }, { agent: g2 })
  show('update_goal edit →', edited)
  return edited
})

// ---- Part 3: CAS——过期 revision 拒绝 ----
part('Part 3: CAS 栅栏——过期 revision 拒绝，精确 revision 通过')

const g3 = ctx.agents.create('g3')
await humanTurn(g3, '给博客系列补一个目录索引', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '补目录索引' }, { agent: g3 }) as { goal: { id: string; revision: number } }
  show('create_goal →', created)
  const edited1 = await ctx.tools.invoke('update_goal', {
    goal_id: created.goal.id, revision: created.goal.revision, action: 'edit', objective: '补目录索引并校对',
  }, { agent: g3 }) as { goal: { id: string; revision: number } }
  show('edit（revision 1 → 2）→', edited1)
  try {
    await ctx.tools.invoke('update_goal', {
      goal_id: created.goal.id, revision: created.goal.revision, action: 'edit', objective: '又改一次',
    }, { agent: g3 })
  } catch (error: any) {
    log(`  ❌ 再用过期的 revision 1 edit → ${error.message}`)
  }
  const edited2 = await ctx.tools.invoke('update_goal', {
    goal_id: created.goal.id, revision: edited1.goal.revision, action: 'edit', objective: '补目录索引并校对完成',
  }, { agent: g3 })
  show('用精确 revision 2 edit →', edited2)
  return edited2
})

// ---- Part 4: 轮数——admitted rounds 计入，预算耗尽拒绝 ----
part('Part 4: 轮数——目标轮计入 roundsStarted，预算耗尽 resume 被拒')

const g4 = ctx.agents.create('g4')
await humanTurn(g4, '把测试套件迁移到 vitest', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '迁移测试套件到 vitest', max_goal_rounds: 2 }, { agent: g4 })
  show('create_goal →', created)
})
await goalRound(g4, async () => {
  log('（目标轮 1）模型迁移第一批测试')
  const g = await ctx.tools.invoke('get_goal', {}, { agent: g4 })
  show('轮 1 后 get_goal →', g)
})
await goalRound(g4, async () => {
  log('（目标轮 2）模型迁移第二批测试')
  const g = await ctx.tools.invoke('get_goal', {}, { agent: g4 })
  show('轮 2 后 get_goal →', g)
})
await humanTurn(g4, '继续，把剩下的测试也迁了', async () => {
  const v = ctx.goals.get(g4) as any
  await ctx.tools.invoke('update_goal', { goal_id: v.id, revision: v.revision, action: 'pause' }, { agent: g4 })
  try {
    await ctx.tools.invoke('update_goal', { goal_id: v.id, revision: v.revision + 1, action: 'resume' }, { agent: g4 })
  } catch (error: any) {
    log(`  ❌ 预算耗尽后 resume → ${error.message}`)
  }
  const edited = await ctx.tools.invoke('update_goal', {
    goal_id: v.id, revision: v.revision + 1, action: 'edit', max_goal_rounds: 5,
  }, { agent: g4 })
  show('edit 提高预算到 5 →', edited)
  return edited
})

// ---- Part 5: pause 与 resume ----
part('Part 5: pause 与 resume——暂停与恢复（激活变化）')

const g5 = ctx.agents.create('g5')
let pausedV: any
await humanTurn(g5, '整理仓库的 README', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '整理仓库 README' }, { agent: g5 })
  show('create_goal →', created)
  pausedV = await ctx.tools.invoke('update_goal', { goal_id: created.goal.id, revision: created.goal.revision, action: 'pause' }, { agent: g5 })
  show('pause →', pausedV)
})
try {
  await goalRound(g5, async () => '不会执行')
  log('  ❌ 暂停后仍能续跑？（不该发生）')
} catch (error: any) {
  log(`  ✅ paused 后 goalRound 被拒 → ${error.message}`)
}
await humanTurn(g5, '继续整理 README', async () => {
  const resumed = await ctx.tools.invoke('update_goal', {
    goal_id: pausedV.goal.id, revision: pausedV.goal.revision, action: 'resume',
  }, { agent: g5 })
  show('resume →', resumed)
  return resumed
})

// ---- Part 6: complete 后可被新目标替换 ----
part('Part 6: complete 后可替换——完成的目标让位给新目标')

const g6 = ctx.agents.create('g6')
await humanTurn(g6, '升级 CI 到 GitHub Actions', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '升级 CI 到 GitHub Actions' }, { agent: g6 }) as { goal: { id: string; revision: number } }
  show('create_goal →', created)
  const done = await ctx.tools.invoke('update_goal', { goal_id: created.goal.id, revision: created.goal.revision, action: 'complete' }, { agent: g6 })
  show('complete →', done)
  const next = await ctx.tools.invoke('create_goal', { objective: '写 CI 迁移文档' }, { agent: g6 })
  show('complete 后 create 新目标 →', next)
  return next
})

// ---- Part 7: blocked——阻塞与恢复 ----
part('Part 7: blocked——带 blocked_reason 的阻塞（阈值 + 恢复）')

const g7 = ctx.agents.create('g7')
await humanTurn(g7, '把用户反馈分类器接到生产环境', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '上线反馈分类器', max_goal_rounds: 6 }, { agent: g7 })
  show('create_goal →', created)
})
// 三个轮次里模型都遇到同一个阻塞条件（还差一个审批）
for (let round = 1; round <= 3; round++) {
  await goalRound(g7, async () => {
    log(`（目标轮 ${round}）模型工作：准备上线，但缺少审批人回复`)
  })
}
await goalRound(g7, async () => {
  log('（目标轮 4）模型尝试报 blocked')
  const v = ctx.goals.get(g7) as any
  const blocked = await ctx.tools.invoke('update_goal', {
    goal_id: v.id, revision: v.revision, action: 'blocked', blocked_reason: '审批人在三个轮次中均未回复，无法继续',
  }, { agent: g7 })
  show('update_goal blocked →', blocked)
  return blocked
})
await humanTurn(g7, '审批通过了，继续上线', async () => {
  const v = ctx.goals.get(g7) as any
  const resumed = await ctx.tools.invoke('update_goal', { goal_id: v.id, revision: v.revision, action: 'resume' }, { agent: g7 })
  show('审批通过后 resume →', resumed)
  return resumed
})

// ---- Part 8: clear——墓碑与重放恢复 ----
part('Part 8: clear 墓碑 + 重放——历史仍在，当前目标置空')

const g8 = ctx.agents.create('g8')
await humanTurn(g8, '清理旧的 npm 脚本', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '清理旧的 npm 脚本' }, { agent: g8 }) as { goal: { id: string; revision: number } }
  show('create_goal →', created)
  const cleared = await ctx.tools.invoke('update_goal', { goal_id: created.goal.id, revision: created.goal.revision, action: 'edit', objective: '清理并归档 npm 脚本' }, { agent: g8 })
  const v = cleared as { goal: { id: string; revision: number } }
  const ref = ctx.goals.clear(g8, { id: v.goal.id, revision: v.goal.revision })
  show('clear →', ref)
  const read = await ctx.tools.invoke('get_goal', {}, { agent: g8 })
  show('clear 后 get_goal →', read)
  log('\n📜 重放会话日志（goal/change 事件）:')
  for (const e of g8.session.events) {
    if (e.type === 'goal/change') log(`    #${e.seq} goal/change ${e.data.operation}${e.data.operation === 'clear' ? '' : ` revision ${(e.data as any).goal.revision}`}`)
  }
  const folded = foldGoal(g8.session.events)
  show('foldGoal 重放结果 →', { goal: folded.goal ?? null, roundsStarted: folded.roundsStarted, lastRef: folded.lastRef ?? null })
  return read
})

// ---- Part 9: 重放严格性——非法事件 fail loud ----
part('Part 9: 重放严格性——畸形与非法事件 fail loud')

const g9 = ctx.agents.create('g9')
await humanTurn(g9, '做一个零配置的开发服务器', async () => {
  const created = await ctx.tools.invoke('create_goal', { objective: '零配置开发服务器' }, { agent: g9 }) as { goal: { id: string; revision: number } }
  show('create_goal →', created)

  // 服务层拒绝非法转换：paused 状态下 blocked
  await ctx.tools.invoke('update_goal', { goal_id: created.goal.id, revision: created.goal.revision, action: 'pause' }, { agent: g9 })
  try {
    await ctx.tools.invoke('update_goal', { goal_id: created.goal.id, revision: created.goal.revision + 1, action: 'blocked', blocked_reason: '审批未通过' }, { agent: g9 })
  } catch (error: any) {
    log(`  ❌ paused 状态 blocked → ${error.message}`)
  }

  // 重放拒绝畸形事件：手工写入一条字段不全的 goal/change
  const tampered: SessionEvent = {
    type: 'goal/change', seq: g9.session.events.length, timestamp: Date.now(),
    data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'goal-x', revision: 99 } } as any,
  }
  g9.session.events.push(tampered)
  try {
    foldGoal(g9.session.events)
    log('  ❌ 畸形事件未被重放拒绝？（不该发生）')
  } catch (error: any) {
    log(`  ✅ 重放拒绝畸形 goal/change → ${error.message}`)
  }
  return created
})

// ---- Part 10: 总结 ----
part('Part 10: 与 dsh 的对应')

console.log('\n📝 与 dsh 源码对应：')
console.log('  1. GoalService - 事件溯源目标服务（packages/goal/goal/src/index.ts）')
console.log('  2. GoalPhase - active/paused/blocked/complete（goal/src/types.ts）')
console.log('  3. goal/change 事件 - 完整快照或墓碑（goal/src/domain.ts）')
console.log('  4. 严格重放 - 拒绝畸形/不连续/非法转换（goal/src/fold.ts）')
console.log('  5. CAS 修订栅栏 - GoalRef id/revision（goal/src/types.ts）')
console.log('  6. get_goal/create_goal/update_goal - 模型工具（tool-goal/src/index.ts）')
console.log('  7. activation - 进程内 armed/disarmed，从不持久化（goal/src/index.ts）')
console.log('  8. roundsStarted - 只由 goal source 的 user/message 计入（goal/src/fold.ts）')
console.log('\n✅ 博客20 完成！')
