/**
 * [jobs] 服务定义：抽象 JobRegistry（dsh: packages/jobs/jobs/src/index.ts）
 *
 * 后台任务注册表的能力契约（ctx.jobs）：
 * - start：预检 → 启动 → 注册，返回 `<kind>-N` id
 * - 生命周期：running →（stopping）→ completed/killed/failed
 * - owner-fenced：访问按拥有者 session id 隔离（授权而非保密）
 * - 完成通知：结算时通知监听器 + 释放等待者（first-wins）
 */

import { Context, Service } from '@cordisjs/core'
import type { JobDoneListener, JobId, JobRead, JobSnapshot, JobStart, JobsChangedListener } from './types.ts'

declare module '@cordisjs/core' {
  interface Context {
    jobs: JobRegistry
  }
}

/** 注册表内部的一条记录（简化：生产者的 hooks + 生命周期状态） */
export interface JobRecord {
  hooks: import('./types.ts').JobHooks
  snapshot: JobSnapshot
  doneListeners: JobDoneListener[]
}

/**
 * 抽象后台任务注册表（dsh: JobRegistry）。
 * 实现者（jobs-local）加载后注册为 ctx.jobs——每 context 一份，二次加载抛错。
 * 本抽象类直接实例化会 fail loud（防止把无实现的 seam 当实现加载）。
 */
export abstract class JobRegistry extends Service {
  constructor(ctx: Context) {
    if (new.target === JobRegistry) {
      throw new Error('@dsh/jobs is the abstract job registry seam; load an implementation such as jobs-local')
    }
    super(ctx, 'jobs')
  }

  /** 启动并注册一个任务（dsh: start）——预检失败不留任何 id/资源 */
  abstract start(spec: JobStart): JobId

  /** 按 id 读任务快照（dsh: read）——返回新对象，非活状态 */
  abstract read(id: JobId): JobRead

  /** 列出某 owner 可见的任务（dsh: list） */
  abstract list(ownerSession?: string): JobSnapshot[]

  /** 请求终止一个任务（dsh: kill）——幂等 */
  abstract kill(id: JobId, reason?: string): void

  /** 等待任务到达终态（dsh: wait）——可带超时 */
  abstract wait(id: JobId, timeoutMs?: number): Promise<JobSnapshot>

  /** 注册完成监听器（dsh: onDone）——结算时通知，返回取消函数 */
  abstract onDone(listener: JobDoneListener): () => void

  /** 注册变更监听器（dsh: onChanged）——owner 可见集变化时通知 */
  abstract onChanged(listener: JobsChangedListener): () => void
}
