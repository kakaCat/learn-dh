/**
 * GoalService（dsh: packages/goal/goal/src/index.ts 的简化）
 *
 * ctx.goals：事件溯源的同会话目标服务。
 * - 每次变更写一条 durable goal/change 事件（完整快照或 clear 墓碑）
 * - CAS 修订围栏：只接受精确 id/revision，拒绝过期 ref
 * - 生命周期：active / paused / blocked / complete（blocked 带策略 code）
 * - activation（armed/disarmed）是进程内的，从不持久化
 * - 会话日志是唯一持久权威；缓存只做增量折叠
 */

import { Context, Service } from '@cordisjs/core'
import type { Agent } from './agent.ts'
import type { Session } from './session.ts'
import type {
  CreateGoalRequest, EditGoalRequest, GoalActivation, GoalBlockReason,
  GoalPhase, GoalRef, GoalSnapshot, GoalView,
} from './types.ts'
import { GoalId } from './types.ts'
import type { GoalChangeMeta, GoalChanged, GoalOperation, GoalSnapshotChangeMeta, GoalClearChangeMeta } from './domain.ts'
import { applyGoalEvent, emptyGoalFoldState, goalChangeRef, GOAL_CHANGE_VERSION } from './fold.ts'
import type { GoalFoldState } from './fold.ts'

declare module '@cordisjs/core' {
  interface Context {
    goals: GoalService
  }
}

export class GoalError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

interface GoalCache {
  readonly state: GoalFoldState
  activation: GoalActivation
  observedSeq: number
  pendingActivation: { seq: number; activation: GoalActivation } | undefined
}

function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS')
  }
  return value
}

function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE')
  }
  return value.trim()
}

function resolveBlockReason(reason: unknown): GoalBlockReason {
  const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? reason as Record<string, unknown>
    : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}

export class GoalService extends Service {
  static inject = ['agents']

  private readonly defaultMaxGoalRounds: number
  private readonly caches = new WeakMap<Session, GoalCache>()
  private goalCounter = 0
  private listeners = new Set<(agent: Agent, change: GoalChanged) => void>()

  constructor(ctx: Context, config: { defaultMaxGoalRounds?: number } = {}) {
    super(ctx, 'goals')
    this.defaultMaxGoalRounds = resolveMaxGoalRounds(config.defaultMaxGoalRounds ?? 256)
    ctx.on('agent/session-start', ({ agent }) => {
      this.cache(agent.session).activation = 'disarmed'
    })
  }

  /** 读当前目标（dsh: get）——返回新视图或 undefined */
  get(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    return this.view(cache)
  }

  /** 移除进程内续跑权，不改持久阶段与修订（dsh: disarm） */
  disarm(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    cache.activation = 'disarmed'
    return this.view(cache)
  }

  /** 创建并 arm 一个目标（dsh: create）——只有无目标或目标是 complete 时才允许 */
  create(agent: Agent, request: CreateGoalRequest): GoalView {
    const spec = {
      objective: resolveObjective(request.objective),
      maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds ?? this.defaultMaxGoalRounds),
    }
    const cache = this.prepareMutation(agent)
    const current = cache.state.goal
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS')
    }
    const now = Date.now()
    const goal: GoalSnapshot = {
      id: GoalId(`goal-${++this.goalCounter}`),
      revision: 1,
      objective: spec.objective,
      phase: 'active',
      maxGoalRounds: spec.maxGoalRounds,
    }
    return this.commitSnapshot(agent, cache, 'create', goal, 0, now, now, 'armed')
  }

  /** 编辑 objective/轮数上限，不改阶段（dsh: edit） */
  edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT')
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...request.objective === undefined ? {} : { objective: resolveObjective(request.objective) },
      ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) },
    }
    return this.commitCurrent(agent, cache, 'edit', goal, cache.activation)
  }

  /** 暂停并 disarm（dsh: pause） */
  pause(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed')
  }

  /** 恢复并 arm（dsh: resume）——预算有余量；active 已 armed 拒绝 */
  resume(agent: Agent, ref: GoalRef): GoalView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) throw this.transitionError(current, 'resume', resumable)
    if (current.phase === 'active' && cache.activation === 'armed') {
      throw new GoalError(`goal "${current.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION')
    }
    if (cache.state.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(
        `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    return this.commitCurrent(agent, cache, 'resume', this.withPhase(current, 'active'), 'armed')
  }

  /** 标记完成并 disarm（dsh: complete） */
  complete(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(agent, ref, 'complete', ['active', 'paused', 'blocked'], 'complete', 'disarmed')
  }

  /** 标记阻塞并 disarm（dsh: block）——只接受 active */
  block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    if (current.phase !== 'active') throw this.transitionError(current, 'block', ['active'])
    return this.commitCurrent(
      agent, cache, 'block',
      { ...this.withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) },
      'disarmed',
    )
  }

  /** 清除当前目标，保留墓碑与历史（dsh: clear） */
  clear(agent: Agent, ref: GoalRef): GoalRef {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 }
    const change: GoalClearChangeMeta = {
      kind: 'goal/change', version: GOAL_CHANGE_VERSION, operation: 'clear',
      cleared: tombstone, clearedAt: this.nextMutationTime(cache),
    }
    this.commit(agent, cache, change, 'disarmed')
    return { ...tombstone }
  }

  /** 订阅 goal/changed（简化：全量回调，不做 scope 过滤） */
  onChanged(listener: (agent: Agent, change: GoalChanged) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 精确 live-agent 校验（dsh: assertLive）——不信任匹配的 id */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new GoalError(`agent "${agent.id}" is not live in this registry`, 'GOAL_AGENT_NOT_LIVE')
    }
  }

  /** 每 session 一个缓存，首次折叠全部事件（activation 初始 disarmed） */
  private cache(session: Session): GoalCache {
    let cache = this.caches.get(session)
    if (cache !== undefined) return cache
    const state = emptyGoalFoldState()
    for (const event of session.events) applyGoalEvent(state, event)
    cache = { state, activation: 'disarmed', observedSeq: session.events.length, pendingActivation: undefined }
    this.caches.set(session, cache)
    return cache
  }

  /** 增量观察 durable 事件，并调和本地 activation 意图 */
  private sync(session: Session, cache: GoalCache): void {
    for (const event of session.events.slice(cache.observedSeq)) {
      applyGoalEvent(cache.state, event)
      if (event.type === 'goal/change') {
        cache.activation = cache.pendingActivation?.seq === event.seq
          ? cache.pendingActivation.activation
          : 'disarmed'
      }
      cache.observedSeq += 1
    }
  }

  /** 拒绝过期或缺失的 ref（dsh: expectCurrent） */
  private expectCurrent(cache: GoalCache, ref: GoalRef): GoalSnapshot {
    const current = cache.state.goal
    if (current === undefined) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'GOAL_STALE_REVISION',
      )
    }
    return current
  }

  private prepareMutation(agent: Agent): GoalCache {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    return cache
  }

  private withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return { id: current.id, revision: current.revision + 1, objective: current.objective, phase, maxGoalRounds: current.maxGoalRounds }
  }

  private transition(
    agent: Agent, ref: GoalRef, operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly GoalPhase[], phase: GoalPhase, activation: GoalActivation,
  ): GoalView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    if (!allowed.includes(current.phase)) throw this.transitionError(current, operation, allowed)
    return this.commitCurrent(agent, cache, operation, this.withPhase(current, phase), activation)
  }

  private transitionError(current: GoalSnapshot, operation: GoalOperation, allowed: readonly GoalPhase[]): GoalError {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }

  private commitCurrent(
    agent: Agent, cache: GoalCache, operation: Exclude<GoalOperation, 'create' | 'clear'>,
    goal: GoalSnapshot, activation: GoalActivation,
  ): GoalView {
    const createdAt = cache.state.createdAt
    if (createdAt === undefined) throw new Error('current goal cache lacks createdAt')
    return this.commitSnapshot(agent, cache, operation, goal, cache.state.roundsStarted, createdAt, this.nextMutationTime(cache), activation)
  }

  /** 墙钟倒退时钳制时间戳（dsh: nextMutationTime） */
  private nextMutationTime(cache: GoalCache): number {
    const updatedAt = cache.state.updatedAt
    if (updatedAt === undefined) throw new Error('current goal cache lacks updatedAt')
    return Math.max(Date.now(), updatedAt)
  }

  private commitSnapshot(
    agent: Agent, cache: GoalCache, operation: Exclude<GoalOperation, 'clear'>,
    goal: GoalSnapshot, roundsStarted: number, createdAt: number, updatedAt: number, activation: GoalActivation,
  ): GoalView {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change', version: GOAL_CHANGE_VERSION, operation, goal, roundsStarted, createdAt, updatedAt,
    }
    this.commit(agent, cache, change, activation)
    const view = this.view(cache)
    if (view === undefined) throw new Error('snapshot commit cleared the goal unexpectedly')
    return view
  }

  /** 提交一次变更：写日志 → 增量折叠 → 通知监听器（dsh: commit） */
  private commit(agent: Agent, cache: GoalCache, change: GoalChangeMeta, activation: GoalActivation): void {
    const ref = goalChangeRef(change)
    cache.pendingActivation = { seq: agent.session.seq, activation }
    try {
      agent.session.append({ type: 'goal/change', data: change })
      this.sync(agent.session, cache)
    } finally {
      cache.pendingActivation = undefined
    }
    const goal = this.view(cache)
    const notification: GoalChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...goal === undefined ? {} : { goal },
    }
    for (const listener of this.listeners) listener(agent, notification)
  }

  private view(cache: GoalCache): GoalView | undefined {
    const goal = cache.state.goal
    const createdAt = cache.state.createdAt
    const updatedAt = cache.state.updatedAt
    if (goal === undefined) return undefined
    if (createdAt === undefined || updatedAt === undefined) throw new Error(`goal "${goal.id}" cache lacks timestamps`)
    return { ...goal, roundsStarted: cache.state.roundsStarted, createdAt, updatedAt, activation: cache.activation }
  }
}

export default GoalService
