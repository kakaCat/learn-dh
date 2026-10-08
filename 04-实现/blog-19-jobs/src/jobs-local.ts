/**
 * [jobs-local] 进程内注册表实现（dsh: packages/jobs/jobs-local/src/index.ts）
 *
 * LocalJobRegistry 实现抽象契约：维护记录表、分配 `<kind>-N` id、
 * 生命周期状态机、完成通知（first-wins）、owner-fenced 访问。
 */

import { JobRegistry } from './jobs.ts'
import { JobDoneListener, JobHooks, JobId, JobRead, JobSnapshot, JobStart, JobsChangedListener } from './types.ts'
import { JobId as brandJobId } from './types.ts'

interface InternalRecord {
  hooks: JobHooks
  snapshot: JobSnapshot
  doneListeners: JobDoneListener[]
  waiters: Array<{ resolve: (s: JobSnapshot) => void; timer?: ReturnType<typeof setTimeout> }>
}

function isTerminal(status: JobSnapshot['status']): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

export class LocalJobRegistry extends JobRegistry {
  private records = new Map<JobId, InternalRecord>()
  private counters = new Map<string, number>()   // kind → 已分配数
  private doneListeners = new Set<JobDoneListener>()
  private changedListeners = new Set<JobsChangedListener>()

  /** 启动：预检（run 同步返回 hooks）→ 分配 id → 注册 → 观察 done */
  start(spec: JobStart): JobId {
    const kind = spec.kind
    const hooks = spec.run()   // 同步返回 hooks；抛错则不留任何 id/资源
    const n = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, n)
    const id = brandJobId(`${kind}-${n}`)
    if (this.records.has(id)) throw new Error(`job ${id} already registered`)

    const snapshot: JobSnapshot = {
      id, kind, label: spec.label,
      ...spec.owner !== undefined ? { ownerSession: spec.owner.id } : {},
      status: 'running', startedAt: Date.now(), reported: false,
    }
    const record: InternalRecord = { hooks, snapshot, doneListeners: [], waiters: [] }
    this.records.set(id, record)

    // 观察 done：结算 → 更新快照 → 通知监听器 → 释放等待者（first-wins）
    void hooks.done.then((outcome) => {
      record.snapshot = { ...record.snapshot, status: outcome.status, detail: outcome.detail, finishedAt: Date.now() }
      this.notifySettled(id)
    })
    this.emitChanged(snapshot.ownerSession)
    return id
  }

  read(id: JobId): JobRead {
    const record = this.records.get(id)
    if (!record) throw new Error(`no job ${id}`)
    const text = record.hooks.readOutput?.() ?? ''
    return { text, snapshot: { ...record.snapshot } }
  }

  list(ownerSession?: string): JobSnapshot[] {
    return [...this.records.values()]
      .filter(r => r.snapshot.ownerSession === ownerSession)
      .map(r => ({ ...r.snapshot }))
  }

  kill(id: JobId, reason?: string): void {
    const record = this.records.get(id)
    if (!record) return
    if (!isTerminal(record.snapshot.status)) {
      record.snapshot = { ...record.snapshot, status: 'stopping', detail: reason }
      try { record.hooks.cancel(reason) } catch { /* force-fail only the record */ }
    }
  }

  wait(id: JobId, timeoutMs?: number): Promise<JobSnapshot> {
    const record = this.records.get(id)
    if (!record) throw new Error(`no job ${id}`)
    if (isTerminal(record.snapshot.status)) return Promise.resolve({ ...record.snapshot })
    return new Promise((resolve) => {
      const waiter = { resolve: (s: JobSnapshot) => resolve({ ...s }) }
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const r = this.records.get(id)
          if (r) r.waiters = r.waiters.filter(w => w !== waiter)
          resolve({ ...record.snapshot })
        }, timeoutMs)
      }
      record.waiters.push(waiter)
    })
  }

  onDone(listener: JobDoneListener): () => void {
    this.doneListeners.add(listener)
    return () => { this.doneListeners.delete(listener) }
  }

  onChanged(listener: JobsChangedListener): () => void {
    this.changedListeners.add(listener)
    return () => { this.changedListeners.delete(listener) }
  }

  /** 结算：标记 reported → 通知监听器 → 释放等待者（dsh: settlement is first-wins） */
  private notifySettled(id: JobId): void {
    const record = this.records.get(id)
    if (!record) return
    record.snapshot = { ...record.snapshot, reported: true }
    for (const listener of this.doneListeners) listener(record.snapshot, undefined)
    for (const waiter of record.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(record.snapshot)
    }
    record.waiters = []
    this.emitChanged(record.snapshot.ownerSession)
  }

  private emitChanged(ownerSession: string | undefined): void {
    for (const listener of this.changedListeners) listener(undefined)
  }
}
