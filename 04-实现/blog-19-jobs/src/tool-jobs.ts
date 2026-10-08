/**
 * 模型可调用的 jobs 工具（dsh: packages/jobs/tool-jobs）
 *
 * 一个 JobRegistry（ctx.jobs），三个工具：
 *   job_output —— 读取某任务的最新输出与快照（增量读，返回 0 字节也是成功）
 *   job_list   —— 列出当前执行者名下的全部任务
 *   job_kill   —— 请求终止一个任务（任务进入 stopping，自己决定何时停）
 *
 * 注意：这里没有 job_start。创建任务属于“执行者内部行为”，
 * 由 agent 层调用 ctx.jobs.start 完成，模型不直接拥有 start 工具。
 */

import type { Context } from '@cordisjs/core'
import type { Agent } from './agent.ts'

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

export function setupJobTools(ctx: Context): void {
  ctx.tools.register({
    name: 'job_output',
    description: '读取后台任务 {jobId} 的输出。返回 {finished, running, status, lines} 与最近追加的输出（增量读）。',
    execute: async (args: { jobId?: string }) => {
      const jobId = args.jobId ?? ''
      const read = ctx.jobs.read(jobId as any)
      return {
        finished: isTerminal(read.snapshot.status),
        running: read.snapshot.status === 'running',
        status: read.snapshot.status,
        lines: read.text,
        jobId,
      }
    },
  })

  ctx.tools.register({
    name: 'job_list',
    description: '列出当前执行者名下的所有后台任务。返回 {jobs: [{jobId, status, done, running, exitCode, error}]}。',
    execute: async (_args: unknown, exec: { agent?: Agent }) => {
      const owner = exec.agent?.session.id ?? 'default'
      const list = ctx.jobs.list(owner)
      return {
        jobs: list.map((j) => ({
          jobId: j.id,
          status: j.status,
          done: isTerminal(j.status),
          running: j.status === 'running',
          exitCode: null,
          error: j.detail ?? null,
        })),
      }
    },
  })

  ctx.tools.register({
    name: 'job_kill',
    description: '请求终止后台任务 {jobId}。任务先进入 stopping，随后以 killed 收场（也可能被其自身拒绝而继续）。返回当前状态。',
    execute: async (args: { jobId?: string }) => {
      const jobId = args.jobId ?? ''
      ctx.jobs.kill(jobId as any)
      const read = ctx.jobs.read(jobId as any)
      return { jobId, status: read.snapshot.status, done: isTerminal(read.snapshot.status) }
    },
  })
}
