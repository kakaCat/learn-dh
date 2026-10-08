/**
 * Jobs 类型定义（dsh: packages/jobs/jobs/src/types.ts + brand.ts）
 *
 * 后台任务协议的核心契约：生产者（producer）声明 JobStart + JobHooks，
 * 注册表（registry）管理身份与生命周期，工具（tool-jobs）暴露给模型。
 */

/** Job id：`<kind>-N`（dsh: JobId，branded string） */
export type JobId = string & { readonly __brand: 'JobId' }
export function JobId(value: string): JobId {
  return value as JobId
}

/** 任务生命周期：running →（stopping）→ 恰好一个终态（dsh: JobStatus） */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** 任务种类（dsh: JobKindMap）——也是 id 前缀（bash / subagent / ...） */
export interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}
export type JobKind = JobKindMap[keyof JobKindMap]

/** 终态结果（dsh: JobOutcome）——生产者通过 done 提供 */
export interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  output?: string
}

/** 生产者声明（dsh: JobStart）——start 的入参 */
export interface JobStart {
  kind: JobKind
  label: string
  owner?: { id: string }          // 拥有者 agent（简化：只记 id 做 fence）
  run(): JobHooks                 // 预检后启动工作，同步返回 hooks
}

/** 运行钩子（dsh: JobHooks）——注册表通过它控制/观察生产者工作 */
export interface JobHooks {
  cancel(reason?: string): void       // 请求终止（同步、幂等、最终 settle done）
  done: Promise<JobOutcome>           // 生产者释放资源后 resolve（不 reject）
  readOutput?(): string               // 消费自上次以来的输出（增量）
}

/** 任务只读快照（dsh: JobSnapshot）——每次调用返回新对象，非活注册表状态 */
export interface JobSnapshot {
  id: JobId
  kind: JobKind
  label: string
  ownerSession?: string
  status: JobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
  reported: boolean
}

/** 读取结果（dsh: JobRead） */
export interface JobRead {
  text: string
  snapshot: JobSnapshot
}

/** 完成监听器（dsh: JobDoneListener）——结算时收到快照；error 恒为 undefined（简化） */
export type JobDoneListener = (snapshot: JobSnapshot, error?: Error) => void

/** 变更监听器（dsh: JobsChangedListener）——owner 可见集变化时通知 */
export type JobsChangedListener = (ownerSession: string) => void
