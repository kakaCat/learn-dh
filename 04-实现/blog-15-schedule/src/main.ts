/**
 * 博客15：schedule 域 - 定时任务（演示入口）
 *
 * 只做组装和演示。实现分布在 src/ 各文件，每文件对应 dsh 的一个模块：
 *   types.ts   Schedule 值类型（schedule/src/types.ts）
 *   session.ts Session 事件日志（dsh-session）
 *   agent.ts   Agent + AgentFactory（dsh-agent）
 *   domain.ts  纯函数核心：fold + 记录工厂 + 推进（schedule/src/domain.ts）
 *   runtime.ts ScheduleRuntime 定时器投影（schedule/src/runtime.ts）
 *   tools.ts   schedule_create/list/delete 工具（schedule/src/tools.ts）
 *   index.ts   装配：attachSchedule（schedule/src/index.ts）
 *
 * 核心理念（dsh README）：Session 日志拥有提醒状态——定时器、工具值、
 * 模型跟进都是日志的可丢弃投影。
 */

import { Context } from '@cordisjs/core'
import { AgentFactory, Agent } from './agent.ts'
import { ToolRegistry } from './tool-registry.ts'
import { attachSchedule } from './index.ts'
import { ScheduleRuntime } from './runtime.ts'
import { allocateScheduleId, createAfterScheduleRecord, foldScheduleEvents } from './domain.ts'

console.log('='.repeat(60))
console.log('博客15：schedule 域 - 定时任务（基于 Session 日志的提醒）')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(AgentFactory)
await ctx.plugin(ToolRegistry)

// 父代理：有会话 + schedule 管理工具
const parent = ctx.agents.create('main-1')
const disposeParentSchedule = attachSchedule(ctx, parent)

console.log('\n📦 已为 main-1 挂载 ScheduleRuntime + schedule_create/list/delete 工具')

// ---- Part 1: after 延迟提醒（2 秒后触发）----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 创建 after 提醒（2 秒后触发）')
console.log('='.repeat(60))

console.log('\n🚀 模型调用 schedule_create(after_seconds=2):')
const created = await ctx.tools.invoke('schedule_create', {
  prompt: '检查构建结果',
  after_seconds: 2,
}, { agent: parent })
console.log(`  ✅ 创建成功: id=${(created as any).id} kind=${(created as any).kind} scheduledAt=${(created as any).scheduledAt}`)
console.log(`  state=${(created as any).state} deliveryMode=${(created as any).deliveryMode}`)

// ---- Part 2: every 固定间隔提醒（1 秒触发）----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 创建 every 提醒（1 秒间隔）')
console.log('='.repeat(60))

console.log('\n🚀 模型调用 schedule_create(every_seconds=1):')
const created2 = await ctx.tools.invoke('schedule_create', {
  prompt: '心跳上报',
  every_seconds: 1,
}, { agent: parent })
console.log(`  ✅ 创建成功: id=${(created2 as any).id} kind=${(created2 as any).kind} everySeconds=${(created2 as any).everySeconds}`)

// ---- Part 3: schedule_list 查看 ----
console.log('\n' + '='.repeat(60))
console.log('Part 3: schedule_list 查看活跃提醒')
console.log('='.repeat(60))

const list = await ctx.tools.invoke('schedule_list', {}, { agent: parent }) as any[]
console.log('\n📋 活跃提醒:')
for (const v of list) {
  console.log(`  - ${v.id} [${v.kind}] ${v.prompt} → ${v.scheduledAt} (${v.state})`)
}

// ---- Part 4: 等待真实定时触发（after 2 秒到点）----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 等待真实定时触发（after 2 秒到点）')
console.log('='.repeat(60))

console.log('\n⏳ 等待 2.6 秒让 after 提醒触发...')
await new Promise(r => setTimeout(r, 2600))

console.log('📡 触发后 agent 收到的提醒消息:')
const events = parent.session.events
for (const e of events) {
  if (e.type === 'user/message') console.log(`  📥 user/message: ${e.text.slice(0, 60)}`)
  if (e.type === 'assistant/message') console.log(`  📤 assistant/message: ${e.text.slice(0, 60)}`)
}

console.log('\n📜 会话日志中的 schedule/change 事件:')
for (const e of events) {
  if (e.type === 'schedule/change') {
    const d = e.data
    console.log(`  #${e.seq} schedule/change ${d.operation}${'id' in d ? ` id=${d.id}` : ''}${d.operation === 'create' ? ` kind=${d.schedule.kind}` : ''}${'acceptedAt' in d ? ` acceptedAt=${d.acceptedAt}` : ''}`)
  }
}

// ---- Part 5: every 提醒持续触发（再等 1.3 秒，至少再触发一次）----
console.log('\n' + '='.repeat(60))
console.log('Part 5: every 提醒持续触发')
console.log('='.repeat(60))

console.log('\n⏳ 再等 1.3 秒让 every 提醒触发至少一次...')
await new Promise(r => setTimeout(r, 1300))

const everyDispatches = events.filter(e => e.type === 'schedule/change' && e.data.operation === 'dispatch' && 'acceptedAt' in e.data)
console.log(`📡 every 提醒已派发 ${everyDispatches.length} 次（acceptedAt 推进锚点）`)

// ---- Part 6: agent 忙时提醒排队（不新建 agent，复用同一个）----
console.log('\n' + '='.repeat(60))
console.log('Part 6: agent 忙时提醒排队（复用同一个 agent，不新建）')
console.log('='.repeat(60))

// 用一个独立 agent 演示，避免干扰上面的演示。
// busy-1 不注册管理工具（dsh 中工具按 agent 作用域隔离；简化版全局注册会互相覆盖），
// 直接手动 append create 事件等价于模型调 schedule_create。
const busyAgent = ctx.agents.create('busy-1')
const busyRuntime = new ScheduleRuntime(ctx, busyAgent)

console.log('\n🚀 busy-1 创建 1 秒后提醒（等价 schedule_create，手动 append create 事件）:')
const busyFolded = foldScheduleEvents(busyAgent.session.events)
const busyId = allocateScheduleId(busyFolded)
const busyRecord = createAfterScheduleRecord(busyId, '忙完再处理我', 1, Date.now())
busyAgent.session.append({ type: 'schedule/change', data: { version: 1, operation: 'create', schedule: busyRecord } })
console.log(`  ✅ 创建成功: id=${busyId} scheduledAt=${busyRecord.scheduledAt}`)
busyRuntime.start()

console.log('\n🔨 busy-1 立刻开始一个 1.5 秒的长 turn（模拟正在执行的任务）:')
const busyTurn = busyAgent.runTurn('处理大型重构', 1500)

// 1 秒后提醒触发，此时 busy-1 还在忙
console.log('\n⏳ 等 1.1 秒让提醒触发（此时 busy-1 仍在执行长 turn）...')
await new Promise(r => setTimeout(r, 1100))
console.log(`  📌 busy-1 忙状态: ${busyAgent.busy}（提醒已触发，但 agent 还在忙 → 提醒进 inbox 排队）`)

// 等长 turn 结束 + 排队提醒被处理
console.log('\n⏳ 等长 turn 结束（剩余约 0.4 秒），排队提醒被处理...')
await busyTurn
await new Promise(r => setTimeout(r, 400))

console.log('\n📜 busy-1 的消息流（提醒在长 turn 之后才被处理）:')
for (const e of busyAgent.session.events) {
  if (e.type === 'user/message') console.log(`  📥 user/message: ${e.text.slice(0, 50)}`)
  if (e.type === 'assistant/message') console.log(`  📤 assistant/message: ${e.text.slice(0, 50)}`)
}

console.log('\n🔑 关键: 定时器触发时 **不新建 agent**——`followup` 把提醒投递给同一个 busy-1 的 inbox')
console.log('     agent 忙 → 提醒排队；当前 turn 收敛到 idle → 再处理（dsh: inbox is the only queue）')
busyRuntime.dispose()

// ---- Part 7: schedule_delete 删除 every 提醒 ----
console.log('\n' + '='.repeat(60))
console.log('Part 7: schedule_delete 删除 every 提醒')
console.log('='.repeat(60))

const everyId = (created2 as any).id
console.log(`\n🚀 模型调用 schedule_delete(id=${everyId}):`)
const del = await ctx.tools.invoke('schedule_delete', { id: everyId }, { agent: parent })
console.log(`  ✅ 结果: ${JSON.stringify(del)}`)

// 再等 1.2 秒确认不再触发
console.log('\n⏳ 删除后再等 1.2 秒，确认不再触发...')
const dispatchBefore = events.filter(e => e.type === 'schedule/change' && e.data.operation === 'dispatch').length
await new Promise(r => setTimeout(r, 1200))
const dispatchAfter = events.filter(e => e.type === 'schedule/change' && e.data.operation === 'dispatch').length
console.log(`  派发次数: 删除前 ${dispatchBefore} → 删除后 ${dispatchAfter}（${dispatchAfter === dispatchBefore ? '✅ 不再触发' : '❌ 仍在触发'}）`)

// ---- Part 8: 删除不存在的 id（schedule_not_found）----
console.log('\n' + '='.repeat(60))
console.log('Part 8: 删除不存在的 id')
console.log('='.repeat(60))

const del2 = await ctx.tools.invoke('schedule_delete', { id: 'schedule-999' }, { agent: parent })
console.log(`\n🚀 schedule_delete(schedule-999) → ${JSON.stringify(del2)}`)

// ---- Part 9: 窗口关闭 / 进程重启——overdue 补发 ----
console.log('\n' + '='.repeat(60))
console.log('Part 9: 窗口关闭后重启（状态在日志里，overdue 补发）')
console.log('='.repeat(60))

// 模拟"窗口关闭"：创建提醒但不启动 runtime（相当于进程没跑，定时器不存在）
const restartAgent = ctx.agents.create('restart-1')
console.log('\n💤 模拟窗口关闭：restart-1 创建 1 秒提醒，但不启动 runtime（进程不在，定时器不存在）')
const restartFolded = foldScheduleEvents(restartAgent.session.events)
const restartId = allocateScheduleId(restartFolded)
const restartRecord = createAfterScheduleRecord(restartId, '窗口关了也要提醒我', 1, Date.now())
restartAgent.session.append({ type: 'schedule/change', data: { version: 1, operation: 'create', schedule: restartRecord } })
console.log(`  ✅ 提醒已写入日志: id=${restartId} scheduledAt=${restartRecord.scheduledAt}`)
console.log('  ❌ 窗口关了 → 定时器没了 → 提醒"过期"（但日志里状态还在）')

// 等 1.3 秒让提醒过期（模拟窗口关闭期间时间流逝）
console.log('\n⏳ 等 1.3 秒（模拟窗口关闭期间，时间流逝，提醒过期）...')
await new Promise(r => setTimeout(r, 1300))

// 重启：新建 runtime，fold 日志发现 overdue → 立即派发
console.log('\n🔄 重新打开窗口：新建 ScheduleRuntime，折叠日志发现 overdue')
const restartRuntime = new ScheduleRuntime(ctx, restartAgent)
restartRuntime.start()
await new Promise(r => setTimeout(r, 400))

console.log('\n📜 restart-1 的消息流（overdue 提醒被补发）:')
for (const e of restartAgent.session.events) {
  if (e.type === 'user/message') console.log(`  📥 user/message: ${e.text.slice(0, 50)}`)
  if (e.type === 'assistant/message') console.log(`  📤 assistant/message: ${e.text.slice(0, 50)}`)
}
const restartFolded2 = foldScheduleEvents(restartAgent.session.events)
console.log(`\n🔑 关键: 窗口关闭不丢提醒——日志在状态就在，重启后 overdue 立即补发`)
console.log(`   活跃提醒: ${restartFolded2.active.length} 个（过期的一次性提醒派发后终结）`)
restartRuntime.dispose()

// ---- Part 10: 最终折叠视图 ----
console.log('\n' + '='.repeat(60))
console.log('Part 10: 最终折叠视图（日志是唯一真源）')
console.log('='.repeat(60))

const folded = foldScheduleEvents(parent.session.events)
console.log('\n📊 折叠结果:')
console.log(`  活跃提醒: ${folded.active.length} 个`)
for (const r of folded.active) console.log(`    - ${r.id} [${r.kind}] ${r.prompt}`)
console.log(`  历史 id: ${folded.seenIds.join(', ')}`)
console.log(`\n✅ 会话日志共 ${parent.session.events.length} 条事件——重放即完整状态，定时器只是可丢弃投影`)

// 清理：停掉演示用的调度循环（真实部署里 agent 存活期间 runtime 一直运行，进程不退出）
disposeParentSchedule()

console.log('\n✅ 博客15 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. foldScheduleEvents - 日志折叠 唯一真源（schedule/src/domain.ts）')
console.log('  2. allocateScheduleId - id 分配 永不重用（domain.ts）')
console.log('  3. createAfter/At/EveryScheduleRecord - 三种记录工厂（domain.ts）')
console.log('  4. resolveEveryOccurrence - 固定间隔锚点推进（domain.ts）')
console.log('  5. ScheduleRuntime - 定时器投影 + due 决策 + dispatch（runtime.ts）')
console.log('  6. renderReminderFraming - 提醒渲染（domain.ts）')
console.log('  7. schedule_create/list/delete - 管理工具（tools.ts）')
console.log('  8. attachSchedule - agent 挂载（index.ts）')
console.log('  9. schedule/change 事件 - create/delete/dispatch（types.ts）')
