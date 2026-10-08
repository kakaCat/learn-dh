/**
 * 博客19：jobs 域 - 后台任务（演示入口）
 *
 * 只做组装和演示。实现分布在 src/ 各文件，对应 dsh 的 packages/jobs/：
 *   types.ts      JobId/JobStatus/JobStart/JobHooks/JobSnapshot（jobs/src/types.ts）
 *   jobs.ts       抽象 JobRegistry 服务契约（jobs/src/index.ts）
 *   jobs-local.ts 进程内注册表实现（jobs-local/src/index.ts）
 *   tools.ts      ToolRegistry（dsh-tools）
 *   tool-jobs.ts  job_output/job_list/job_kill 工具（tool-jobs/src/index.ts）
 *
 * 核心机制（dsh README）：
 * - 生命周期 running →（stopping）→ 恰好一个终态 completed/killed/failed
 * - 结算 first-wins：done 只结算一次，通知监听器 + 释放等待者
 * - owner-fenced：job_list 只返回当前执行者名下的任务
 * - 模型没有 job_start：创建任务属于执行者内部行为
 */

import { Context } from '@cordisjs/core'
import { JobRegistry } from './jobs.ts'
import { LocalJobRegistry } from './jobs-local.ts'
import { ToolRegistry } from './tools.ts'
import { setupJobTools } from './tool-jobs.ts'
import { createAgent } from './agent.ts'
import type { JobId, JobOutcome } from './types.ts'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const log = (...args: any[]) => console.log(...args)
const part = (title: string) => {
  console.log('\n' + '='.repeat(60))
  console.log(title)
  console.log('='.repeat(60))
}

/** 模拟一个 bash 后台任务：按固定节奏逐行产出输出 */
function startBash(ctx: Context, opts: {
  label: string
  lines: number
  intervalMs?: number
  owner?: { id: string }
  failAfter?: number
  failDetail?: string
}): JobId {
  const intervalMs = opts.intervalMs ?? 300
  return ctx.jobs.start({
    kind: 'bash',
    label: opts.label,
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    run: () => {
      const buf: string[] = []
      let count = 0            // 行号用独立计数，不受 readOutput drain 影响
      let cancelled = false
      let settled = false
      let resolveDone!: (o: JobOutcome) => void
      const done = new Promise<JobOutcome>((r) => { resolveDone = r })
      const timer = setInterval(() => {
        if (settled) return
        if (cancelled) {
          settled = true
          clearInterval(timer)
          resolveDone({ status: 'killed', detail: 'cancel requested', output: buf.join('\n') })
          return
        }
        count += 1
        buf.push(`line ${count}`)
        if (opts.failAfter !== undefined && count >= opts.failAfter) {
          settled = true
          clearInterval(timer)
          resolveDone({ status: 'failed', detail: opts.failDetail ?? 'exit code 2', output: buf.join('\n') })
          return
        }
        if (count >= opts.lines) {
          settled = true
          clearInterval(timer)
          resolveDone({ status: 'completed', output: buf.join('\n') })
        }
      }, intervalMs)
      return {
        cancel: () => { cancelled = true },
        done,
        readOutput: () => {
          if (buf.length === 0) return ''
          const s = buf.join('\n')
          buf.length = 0
          return s
        },
      }
    },
  })
}

console.log('='.repeat(60))
console.log('博客19：jobs 域 - 后台任务（JobRegistry + 三工具）')
console.log('='.repeat(60))

const ctx = new Context()
await ctx.plugin(ToolRegistry)
await ctx.plugin(LocalJobRegistry)
setupJobTools(ctx)

const agent1 = createAgent('agent-1')
const agent2 = createAgent('agent-2')

// 全局完成监听器：每次结算恰好通知一次（first-wins）
ctx.jobs.onDone((snapshot) => {
  log(`  [done listener] ${snapshot.id} 结算: ${snapshot.status}${snapshot.detail ? `（${snapshot.detail}）` : ''}`)
})

// ---- Part 0: 抽象 seam + 启动第一个任务 ----
part('Part 0: 抽象 JobRegistry（fail-loud）+ 启动任务')

console.log('\n直接实例化抽象 JobRegistry（没有实现时 fail loud）:')
try {
  new JobRegistry(ctx)
} catch (error: any) {
  log(`  ❌ ${error.message}`)
}

const job1 = startBash(ctx, { label: '模拟构建：逐行输出', lines: 5, owner: { id: agent1.session.id } })
log(`\n🚀 ctx.jobs.start → ${job1}`)
let r = ctx.jobs.read(job1)
log(`   读取: status=${r.snapshot.status} output=${JSON.stringify(r.text)}`)

// ---- Part 1: 生命周期状态机 running → completed ----
part('Part 1: 生命周期——running 到 completed')

await sleep(350)
r = ctx.jobs.read(job1)
log(`  +350ms 读取: status=${r.snapshot.status} output=${JSON.stringify(r.text)}`)
await sleep(400)
r = ctx.jobs.read(job1)
log(`  +400ms 读取: status=${r.snapshot.status} output=${JSON.stringify(r.text)}`)

const done1 = await ctx.jobs.wait(job1, 5000)
log(`\n⏳ wait(${job1}, 5000) → status=${done1.status} finishedAt=${done1.finishedAt !== undefined ? '已记录' : '无'}`)

// ---- Part 2: 增量读（模型视角 job_output）----
part('Part 2: 增量读——模型视角的 job_output')

const job2 = startBash(ctx, { label: '模拟下载：分块输出', lines: 6, owner: { id: agent1.session.id } })
log(`\n🚀 启动 ${job2}，模型轮询输出:`)
await sleep(350)
let toolR = await ctx.tools.invoke('job_output', { jobId: job2 }, { agent: agent1 })
log(`  第 1 次 job_output → status=${toolR.status} lines=${JSON.stringify(toolR.lines)}`)
await sleep(400)
toolR = await ctx.tools.invoke('job_output', { jobId: job2 }, { agent: agent1 })
log(`  第 2 次 job_output → status=${toolR.status} lines=${JSON.stringify(toolR.lines)}`)
await ctx.jobs.wait(job2, 5000)
log('  （第 3 次轮询时任务已完成，lines 为空——增量读，0 字节也是成功）')

// ---- Part 3: 请求终止——stopping → killed ----
part('Part 3: job_kill——stopping 之后由任务自己收场')

const job3 = startBash(ctx, { label: '模拟长任务：永不主动结束', lines: 10, owner: { id: agent1.session.id } })
log(`\n🚀 启动 ${job3}，模型决定终止它:`)
toolR = await ctx.tools.invoke('job_kill', { jobId: job3 }, { agent: agent1 })
log(`  job_kill → ${JSON.stringify(toolR)}`)
await sleep(100)
r = ctx.jobs.read(job3)
log(`  +100ms 读取: status=${r.snapshot.status}（已进入 stopping，等任务自己确认）`)
const done3 = await ctx.jobs.wait(job3, 5000)
log(`  wait → status=${done3.status} detail=${JSON.stringify(done3.detail)}`)

// ---- Part 4: 失败结算 ----
part('Part 4: 失败结算——failed')

const job4 = startBash(ctx, { label: '模拟脚本：中途报错', lines: 5, failAfter: 2, failDetail: 'exit code 2', owner: { id: agent1.session.id } })
log(`\n🚀 启动 ${job4}（第 2 行后失败）:`)
const done4 = await ctx.jobs.wait(job4, 5000)
log(`  wait → status=${done4.status} detail=${JSON.stringify(done4.detail)}`)

// ---- Part 5: owner-fenced 可见性 ----
part('Part 5: owner-fenced——job_list 只看得到自己的任务')

const job5 = startBash(ctx, { label: 'agent-1 的任务', lines: 3, owner: { id: agent1.session.id } })
const job6 = startBash(ctx, { label: 'agent-2 的任务', lines: 3, owner: { id: agent2.session.id } })
log(`\n🚀 启动 ${job5}（agent-1）与 ${job6}（agent-2）:`)
const list1 = await ctx.tools.invoke('job_list', {}, { agent: agent1 })
log(`  agent-1 的 job_list → ${JSON.stringify(list1.jobs.map((j: any) => j.jobId))}`)
const list2 = await ctx.tools.invoke('job_list', {}, { agent: agent2 })
log(`  agent-2 的 job_list → ${JSON.stringify(list2.jobs.map((j: any) => j.jobId))}`)
log(`  （agent-2 看不到 ${job5}，agent-1 看不到 ${job6}——授权而非保密）`)
await ctx.jobs.wait(job5, 5000)
await ctx.jobs.wait(job6, 5000)

// ---- Part 6: wait 超时 ----
part('Part 6: wait 超时——等不到就带着当前快照回来')

const job7 = startBash(ctx, { label: '模拟长任务：用于超时演示', lines: 6, owner: { id: agent1.session.id } })
log(`\n🚀 启动 ${job7}，只等 200ms:`)
const timedOut = await ctx.jobs.wait(job7, 200)
log(`  wait(${job7}, 200) → status=${timedOut.status}（超时返回当前快照，任务继续跑）`)
const done7 = await ctx.jobs.wait(job7, 5000)
log(`  wait(${job7}, 5000) → status=${done7.status}`)

// ---- Part 7: 总结 ----
part('Part 7: 与 dsh 的对应')

console.log('\n📝 与 dsh 源码对应：')
console.log('  1. JobRegistry - 抽象注册表服务（packages/jobs/jobs/src/index.ts）')
console.log('  2. LocalJobRegistry - 进程内实现（packages/jobs/jobs-local/src/index.ts）')
console.log('  3. job_output/job_list/job_kill - 模型工具（packages/jobs/tool-jobs/src/index.ts）')
console.log('  4. running/stopping/completed/killed/failed - 状态机（jobs/src/types.ts JobStatus）')
console.log('  5. <kind>-N - 任务 id（jobs/src/types.ts JobId）')
console.log('  6. 结算 first-wins - done 恰好结算一次，通知监听器（jobs/src/index.ts）')
console.log('  7. owner-fenced - 访问按拥有者 session 隔离（jobs/src/index.ts）')
console.log('\n✅ 博客19 完成！')
