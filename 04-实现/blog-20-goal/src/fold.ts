/**
 * 严格重放（dsh: packages/goal/goal/src/fold.ts）
 *
 * 会话日志是唯一持久权威。重放只从 goal/change 事件派生生命周期，
 * 拒绝：畸形形状、不连续 revision、非法生命周期转换、时间戳回归、
 * 非顺序的 admitted rounds（fail loud——宁可挂起，不静默给出错误状态）。
 */

import { GoalId } from './types.ts'
import type { GoalBlockReason, GoalPhase, GoalRef, GoalSnapshot } from './types.ts'
import type {
  FoldedGoal,
  GoalChangeMeta,
  GoalClearChangeMeta,
  GoalMessageSource,
  GoalOperation,
  GoalSnapshotChangeMeta,
} from './domain.ts'
import type { SessionEvent } from './session.ts'

const SNAPSHOT_OPERATIONS: ReadonlySet<Exclude<GoalOperation, 'clear'>> = new Set([
  'create', 'edit', 'pause', 'resume', 'complete', 'block',
])
const PHASES: ReadonlySet<GoalPhase> = new Set(['active', 'paused', 'blocked', 'complete'])

export const GOAL_CHANGE_VERSION = 1

/** 可变的折叠累加器（纯重放内部使用） */
export interface GoalFoldState {
  goal: GoalSnapshot | undefined
  roundsStarted: number
  createdAt: number | undefined
  updatedAt: number | undefined
  lastRef: GoalRef | undefined
  seenGoalIds: Set<string>
}

export function emptyGoalFoldState(): GoalFoldState {
  return { goal: undefined, roundsStarted: 0, createdAt: undefined, updatedAt: undefined, lastRef: undefined, seenGoalIds: new Set() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`goal change ${field} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`goal change ${field} must be a non-negative safe integer`)
  }
  return value
}

function decodeBlockReason(value: unknown): GoalBlockReason {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'code,message') {
    throw new Error('goal change goal.blockedReason must have exactly code and message fields')
  }
  if (typeof value['code'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value['code'])) {
    throw new Error('goal change goal.blockedReason.code must be lower-kebab-case')
  }
  if (typeof value['message'] !== 'string' || value['message'].trim().length === 0
    || value['message'] !== value['message'].trim()) {
    throw new Error('goal change goal.blockedReason.message must be non-empty and normalized')
  }
  return { code: value['code'], message: value['message'] }
}

function decodeSnapshot(value: unknown): GoalSnapshot {
  if (!isRecord(value)) throw new Error('goal change goal must be a record')
  if (typeof value['id'] !== 'string' || value['id'].length === 0) throw new Error('goal change goal.id must be a non-empty string')
  if (typeof value['objective'] !== 'string' || value['objective'].trim().length === 0
    || value['objective'] !== value['objective'].trim()) {
    throw new Error('goal change goal.objective must be non-empty and normalized')
  }
  if (typeof value['phase'] !== 'string' || !PHASES.has(value['phase'] as GoalPhase)) {
    throw new Error('goal change goal.phase is invalid')
  }
  const phase = value['phase'] as GoalPhase
  const expectedKeys = phase === 'blocked'
    ? 'blockedReason,id,maxGoalRounds,objective,phase,revision'
    : 'id,maxGoalRounds,objective,phase,revision'
  if (Object.keys(value).sort().join(',') !== expectedKeys) {
    throw new Error(`goal change goal for phase ${phase} must have exactly ${expectedKeys} fields`)
  }
  return {
    id: GoalId(value['id']),
    revision: positiveInteger(value['revision'], 'goal.revision'),
    objective: value['objective'],
    phase,
    maxGoalRounds: positiveInteger(value['maxGoalRounds'], 'goal.maxGoalRounds'),
    ...phase === 'blocked' ? { blockedReason: decodeBlockReason(value['blockedReason']) } : {},
  }
}

function decodeRef(value: unknown): GoalRef {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,revision') {
    throw new Error('goal clear tombstone must have exactly id and revision fields')
  }
  if (typeof value['id'] !== 'string' || value['id'].length === 0) throw new Error('goal clear tombstone id must be a non-empty string')
  return { id: GoalId(value['id']), revision: positiveInteger(value['revision'], 'cleared.revision') }
}

/**
 * 解码一个自称 goal change 的值。无关值返回 undefined；
 * 畸形 goal change 让重放大声失败（fail loud）。
 */
export function decodeGoalChange(value: unknown): GoalChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'goal/change') return undefined
  if (value['version'] !== GOAL_CHANGE_VERSION) {
    throw new Error(`unsupported goal change version ${String(value['version'])}`)
  }
  if (value['operation'] === 'clear') {
    const allowed = ['cleared', 'clearedAt', 'kind', 'operation', 'version']
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) {
      throw new Error(`goal clear change must have exactly ${allowed.sort().join(',')} fields`)
    }
    return {
      kind: 'goal/change', version: GOAL_CHANGE_VERSION, operation: 'clear',
      cleared: decodeRef(value['cleared']), clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    } satisfies GoalClearChangeMeta
  }
  if (typeof value['operation'] !== 'string'
    || !SNAPSHOT_OPERATIONS.has(value['operation'] as Exclude<GoalOperation, 'clear'>)) {
    throw new Error('goal change operation is invalid')
  }
  const allowed = ['createdAt', 'goal', 'kind', 'operation', 'roundsStarted', 'updatedAt', 'version']
  if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) {
    throw new Error(`goal snapshot change must have exactly ${allowed.sort().join(',')} fields`)
  }
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt')
  if (updatedAt < createdAt) throw new Error('goal change updatedAt cannot precede createdAt')
  return {
    kind: 'goal/change', version: GOAL_CHANGE_VERSION,
    operation: value['operation'] as Exclude<GoalOperation, 'clear'>,
    goal: decodeSnapshot(value['goal']),
    roundsStarted: nonNegativeInteger(value['roundsStarted'], 'roundsStarted'),
    createdAt, updatedAt,
  } satisfies GoalSnapshotChangeMeta
}

/** 只允许 edit 替换的字段必须保留（dsh: requireSameDefinition） */
function requireSameDefinition(current: GoalSnapshot, next: GoalSnapshot, operation: GoalOperation): void {
  if (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) {
    throw new Error(`goal ${operation} cannot change objective or maxGoalRounds`)
  }
}

/** 下一修订必须恰好 +1（dsh: requireNextRevision） */
function requireNextRevision(current: GoalSnapshot, next: GoalRef, operation: GoalOperation): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`goal ${operation} must advance the current goal by one revision`)
  }
}

/** 校验一次非 create 快照操作（dsh: validateSnapshotTransition） */
function validateSnapshotTransition(state: GoalFoldState, change: GoalSnapshotChangeMeta, current: GoalSnapshot): void {
  const next = change.goal
  requireNextRevision(current, next, change.operation)
  if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt')
  if (change.createdAt !== state.createdAt
    || change.updatedAt < state.updatedAt
    || change.roundsStarted !== state.roundsStarted) {
    throw new Error(`goal ${change.operation} does not preserve the current counters and timestamps`)
  }
  switch (change.operation) {
    case 'edit':
      if (next.phase !== current.phase
        || JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)) {
        throw new Error('goal edit cannot change phase or blocked reason')
      }
      break
    case 'pause':
      requireSameDefinition(current, next, change.operation)
      if (current.phase !== 'active' || next.phase !== 'paused') throw new Error('goal pause has an invalid phase transition')
      break
    case 'resume': {
      requireSameDefinition(current, next, change.operation)
      const resumable: ReadonlySet<GoalPhase> = new Set(['active', 'paused', 'blocked'])
      if (!resumable.has(current.phase) || next.phase !== 'active' || state.roundsStarted >= next.maxGoalRounds) {
        throw new Error('goal resume has an invalid phase transition or exhausted round budget')
      }
      break
    }
    case 'complete':
      requireSameDefinition(current, next, change.operation)
      if (current.phase === 'complete' || next.phase !== 'complete') throw new Error('goal complete has an invalid phase transition')
      break
    case 'block':
      requireSameDefinition(current, next, change.operation)
      if (current.phase !== 'active' || next.phase !== 'blocked') throw new Error('goal block has an invalid phase transition')
      break
    case 'create':
      throw new Error('goal create cannot be validated as a current-goal transition')
  }
}

/** 快照或墓碑携带的修订身份（dsh: goalChangeRef） */
export function goalChangeRef(change: GoalChangeMeta): GoalRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.goal.id, revision: change.goal.revision }
}

/** 校验并应用一个已解码变更（dsh: applyGoalChange） */
export function applyGoalChange(state: GoalFoldState, change: GoalChangeMeta): void {
  const ref = goalChangeRef(change)
  if (change.operation === 'clear') {
    const current = state.goal
    if (current === undefined) throw new Error('goal clear requires a current goal')
    requireNextRevision(current, change.cleared, change.operation)
    if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt')
    if (change.clearedAt < state.updatedAt) throw new Error('goal clear timestamp cannot precede the current goal update')
    state.goal = undefined
    state.roundsStarted = 0
    state.createdAt = undefined
    state.updatedAt = undefined
    state.lastRef = ref
    return
  }
  if (change.operation === 'create') {
    if (change.goal.revision !== 1 || change.goal.phase !== 'active' || change.roundsStarted !== 0
      || (state.goal !== undefined && state.goal.phase !== 'complete')
      || state.seenGoalIds.has(change.goal.id)) {
      throw new Error('goal create requires a fresh active revision-one goal with zero rounds')
    }
    state.seenGoalIds.add(change.goal.id)
  } else {
    const current = state.goal
    if (current === undefined) throw new Error(`goal ${change.operation} requires a current goal`)
    validateSnapshotTransition(state, change, current)
  }
  state.goal = change.goal
  state.roundsStarted = change.roundsStarted
  state.createdAt = change.createdAt
  state.updatedAt = change.updatedAt
  state.lastRef = ref
}

/** 把续跑轮归属收窄为合法 goal source（dsh: goalSource） */
function goalSource(source: unknown): GoalMessageSource | undefined {
  if (!isRecord(source) || source['kind'] !== 'goal') return undefined
  if (typeof source['goalId'] !== 'string' || source['goalId'].length === 0
    || !Number.isSafeInteger(source['revision']) || source['revision'] < 1
    || !Number.isSafeInteger(source['round']) || source['round'] < 1) {
    throw new Error('goal message source is invalid')
  }
  return { kind: 'goal', goalId: source['goalId'], revision: source['revision'], round: source['round'] }
}

/** 应用一个会话事件到严格折叠（dsh: applyGoalEvent） */
export function applyGoalEvent(state: GoalFoldState, event: SessionEvent): void {
  if (event.type === 'goal/change') {
    const change = decodeGoalChange(event.data)
    if (change === undefined) throw new Error(`goal change at session event ${event.seq} has an invalid kind`)
    applyGoalChange(state, change)
    return
  }
  if (event.type === 'user/message') {
    const source = goalSource(event.data.source)
    if (source === undefined) return
    const current = state.goal
    if (current === undefined || current.phase !== 'active' || source.goalId !== current.id
      || source.revision !== current.revision || source.round !== state.roundsStarted + 1
      || source.round > current.maxGoalRounds) {
      throw new Error(`goal round at session event ${event.seq} is not the next admitted round of the active goal`)
    }
    state.roundsStarted = source.round
  }
}

/** 从连续会话事件流折叠出当前目标状态（dsh: foldGoal） */
export function foldGoal(events: readonly SessionEvent[]): FoldedGoal {
  const state = emptyGoalFoldState()
  for (const event of events) applyGoalEvent(state, event)
  return {
    ...state.goal === undefined ? {} : { goal: { ...state.goal } },
    roundsStarted: state.roundsStarted,
    ...state.createdAt === undefined ? {} : { createdAt: state.createdAt },
    ...state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt },
    ...state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } },
  }
}
