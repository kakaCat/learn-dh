/**
 * 博客18：todo 域 - 任务列表（演示入口）
 *
 * 只做组装和演示。实现分布在 src/ 各文件，对应 dsh 的 packages/todo/tool-todo：
 *   types.ts      TodoItem + 配置（tool-todo/src/types.ts）
 *   session.ts    Session 事件日志（dsh-session，含 todo/write）
 *   agent.ts      Agent + AgentFactory（dsh-agent）
 *   tools.ts      ToolRegistry（dsh-tools）
 *   tool-todo.ts  todo_write 工具（tool-todo/src/index.ts）
 *
 * 核心机制（dsh README）：
 * - 整表替换：模型每次发完整列表，无部分更新
 * - todo/write 事件：全量快照落 Session 日志（last-write-wins）
 * - 单 owner：列表属于调用它的那个 agent session
 */

import { Context } from '@cordisjs/core'
import { AgentFactory } from './agent.ts'
import { ToolRegistry } from './tools.ts'
import { registerTodoTool, currentTodos, renderCounts } from './tool-todo.ts'

console.log('='.repeat(60))
console.log('博客18：todo 域 - 任务列表（整表替换）')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(AgentFactory)
await ctx.plugin(ToolRegistry)
// 部署选择：单活跃纪律（allowParallelInProgress: false）
registerTodoTool(ctx, { allowParallelInProgress: false })

const agent = ctx.agents.create('main-1')

// ---- Part 0: 完整对话案例（模型怎么用 todo_write）----
console.log('\n' + '='.repeat(60))
console.log('Part 0: 完整对话案例——模型用 todo_write 管理任务')
console.log('='.repeat(60))

// 案例用独立 agent，避免污染后面机制演示的日志
const caseAgent = ctx.agents.create('case-1')

// 模拟一轮对话：用户下达任务 → 模型列计划 → 逐步执行 → 完成
console.log('\n👤 用户: "帮我重构这个项目的配置系统，分步做"')
console.log('\n🤖 模型（第 1 步）: 好，我先列出计划')
console.log('  调用 todo_write（列出 5 步计划，全部 pending，第 1 步 in_progress）...')
const case1 = await ctx.tools.invoke('todo_write', {
  todos: [
    { content: '梳理现有配置', status: 'in_progress' },
    { content: '设计新配置结构', status: 'pending' },
    { content: '迁移旧配置', status: 'pending' },
    { content: '更新测试', status: 'pending' },
    { content: '写迁移文档', status: 'pending' },
  ],
}, { agent: caseAgent })
console.log(`  ✅ ${renderCounts(case1.counts)}`)

console.log('\n🤖 模型（第 2 步）: 梳理完成，开始设计结构')
console.log('  调用 todo_write（第 1 项 completed，第 2 项 in_progress）...')
const case2 = await ctx.tools.invoke('todo_write', {
  todos: [
    { content: '梳理现有配置', status: 'completed' },
    { content: '设计新配置结构', status: 'in_progress' },
    { content: '迁移旧配置', status: 'pending' },
    { content: '更新测试', status: 'pending' },
    { content: '写迁移文档', status: 'pending' },
  ],
}, { agent: caseAgent })
console.log(`  ✅ ${renderCounts(case2.counts)}`)

console.log('\n🤖 模型（第 3 步）: 结构设计完成，开始迁移')
console.log('  调用 todo_write（第 2 项 completed，第 3 项 in_progress）...')
const case3 = await ctx.tools.invoke('todo_write', {
  todos: [
    { content: '梳理现有配置', status: 'completed' },
    { content: '设计新配置结构', status: 'completed' },
    { content: '迁移旧配置', status: 'in_progress' },
    { content: '更新测试', status: 'pending' },
    { content: '写迁移文档', status: 'pending' },
  ],
}, { agent: caseAgent })
console.log(`  ✅ ${renderCounts(case3.counts)}`)

console.log('\n👤 用户（中途查看）: UI 渲染最新的 todo/write 快照:')
for (const t of case3.todos as Array<{ content: string; status: string }>) {
  const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
  console.log(`  ${icon} [${t.status}] ${t.content}`)
}

console.log('\n🤖 模型（第 4-5 步）: 迁移和测试完成，写文档')
console.log('  调用 todo_write（第 3-4 项 completed，第 5 项 in_progress）...')
const case4 = await ctx.tools.invoke('todo_write', {
  todos: [
    { content: '梳理现有配置', status: 'completed' },
    { content: '设计新配置结构', status: 'completed' },
    { content: '迁移旧配置', status: 'completed' },
    { content: '更新测试', status: 'completed' },
    { content: '写迁移文档', status: 'in_progress' },
  ],
}, { agent: caseAgent })
console.log(`  ✅ ${renderCounts(case4.counts)}`)

console.log('\n🤖 模型（第 6 步）: 全部完成')
console.log('  调用 todo_write（全部 completed）...')
const case5 = await ctx.tools.invoke('todo_write', {
  todos: [
    { content: '梳理现有配置', status: 'completed' },
    { content: '设计新配置结构', status: 'completed' },
    { content: '迁移旧配置', status: 'completed' },
    { content: '更新测试', status: 'completed' },
    { content: '写迁移文档', status: 'completed' },
  ],
}, { agent: caseAgent })
console.log(`  ✅ ${renderCounts(case5.counts)}`)
console.log('\n👤 用户: UI 显示 5 项全部 ✅，重构完成')

// ---- Part 1: 计划——整表写入 ----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 计划——todo_write 整表写入')
console.log('='.repeat(60))

console.log('\n🚀 模型调 todo_write（列出 4 步计划，全量替换）:')
const r1 = await ctx.tools.invoke('todo_write', {
  todos: [
    { content: '实现 todo_write 工具', status: 'in_progress' },
    { content: '写 Session 事件', status: 'pending' },
    { content: '补测试', status: 'pending' },
    { content: '写博客', status: 'pending' },
  ],
}, { agent })
console.log(`  ✅ ${renderCounts(r1.counts)}`)
console.log(`  todos: ${JSON.stringify(r1.todos.map((t: any) => `${t.content}[${t.status}]`))}`)

console.log('\n📜 Session 日志（todo/write 全量快照）:')
for (const e of agent.session.events) {
  if (e.type === 'todo/write') console.log(`    #${e.seq} todo/write ${e.data.todos.length} 条`)
}

// ---- Part 2: 进度更新——整表重写（含 completed）----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 进度更新——整表重写（无部分更新）')
console.log('='.repeat(60))

console.log('\n🚀 模型完成一步，整表重写（第 1 项 completed，第 2 项 in_progress）:')
const r2 = await ctx.tools.invoke('todo_write', {
  todos: [
    { content: '实现 todo_write 工具', status: 'completed' },
    { content: '写 Session 事件', status: 'in_progress' },
    { content: '补测试', status: 'pending' },
    { content: '写博客', status: 'pending' },
  ],
}, { agent })
console.log(`  ✅ ${renderCounts(r2.counts)}`)

// ---- Part 3: 校验拒绝 ----
console.log('\n' + '='.repeat(60))
console.log('Part 3: 校验拒绝（空 content / 重复 / 单活跃违规 / 非 agent）')
console.log('='.repeat(60))

// 空 content
try {
  await ctx.tools.invoke('todo_write', { todos: [{ content: '  ', status: 'pending' }] }, { agent })
} catch (error: any) {
  console.log(`\n❌ 空 content → ${error.message}`)
}

// 重复 content
try {
  await ctx.tools.invoke('todo_write', {
    todos: [
      { content: '写博客', status: 'pending' },
      { content: '写博客', status: 'pending' },
    ],
  }, { agent })
} catch (error: any) {
  console.log(`❌ 重复 content → ${error.message}`)
}

// 单活跃违规（allowParallelInProgress: false）
try {
  await ctx.tools.invoke('todo_write', {
    todos: [
      { content: '任务 A', status: 'in_progress' },
      { content: '任务 B', status: 'in_progress' },
    ],
  }, { agent })
} catch (error: any) {
  console.log(`❌ 两个 in_progress → ${error.message}`)
}

// 非 agent 调用（无 exec.agent）
try {
  await ctx.tools.invoke('todo_write', { todos: [{ content: '孤儿任务', status: 'pending' }] })
} catch (error: any) {
  console.log(`❌ 非 agent 调用 → ${error.message}`)
}

// ---- Part 4: 完成全部 ----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 完成全部——整表重写为全 completed')
console.log('='.repeat(60))

console.log('\n🚀 模型完成所有步骤:')
const r4 = await ctx.tools.invoke('todo_write', {
  todos: [
    { content: '实现 todo_write 工具', status: 'completed' },
    { content: '写 Session 事件', status: 'completed' },
    { content: '补测试', status: 'completed' },
    { content: '写博客', status: 'completed' },
  ],
}, { agent })
console.log(`  ✅ ${renderCounts(r4.counts)}`)

// ---- Part 5: 重放恢复（last-write-wins）----
console.log('\n' + '='.repeat(60))
console.log('Part 5: 重放恢复（todo/write 事件 last-write-wins）')
console.log('='.repeat(60))

console.log('\n📊 重放日志得当前列表（最后一条 todo/write 生效）:')
const todos = currentTodos(agent.session.events)
console.log(`  当前列表（${todos!.length} 条）:`)
for (const t of todos!) console.log(`    - [${t.status}] ${t.content}`)
console.log('\n  会话日志中的 todo/write 事件:')
let n = 0
for (const e of agent.session.events) {
  if (e.type === 'todo/write') { n++; console.log(`    #${e.seq} ${e.data.todos.length} 条快照`) }
}
console.log(`  （共 ${n} 条——重放即完整历史，UI 从事件流渲染）`)

console.log('\n✅ 博客18 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. todo_write 工具 - 整表替换（tool-todo/src/index.ts）')
console.log('  2. todo/write 事件 - 全量快照 last-write-wins（index.ts）')
console.log('  3. toTodoList - 校验：空/重复 content + 单活跃（index.ts）')
console.log('  4. allowParallelInProgress - 部署选择（index.ts Config）')
console.log('  5. 单 owner - exec.agent 必须有（index.ts）')
console.log('  6. renderCounts - Updated todo list 渲染（index.ts output.render）')
console.log('  7. currentTodos - 重放日志得当前列表（简化 fold）')
