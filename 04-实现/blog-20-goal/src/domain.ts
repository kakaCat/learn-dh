/**
 * goal 主题事件词汇（dsh: packages/goal/goal/src/domain.ts）
 *
 * goal/change 事件：携带完整快照（或 clear tombstone）——
 * 会话日志是唯一持久权威，重放只从这里派生生命周期。
 */

import type { GoalRef, GoalSnapshot } from './types.ts'

/** 目标状态变更动词（dsh: GoalOperation） */
export type GoalOperation =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear'

/** 全量快照变更（dsh: GoalSnapshotChangeMeta）——每次非 clear 变更携带完整后置状态 */
export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** 清除墓碑（dsh: GoalClearChangeMeta）——保留历史，当前目标置空 */
export interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}

/** goal/change 事件负载联合（dsh: GoalChangeMeta） */
export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta

/** 续跑轮次的归属（dsh: GoalMessageSource）——admitted user/message 带它才计入轮数 */
export interface GoalMessageSource {
  readonly kind: 'goal'
  readonly goalId: GoalRef['id']
  readonly revision: number
  /** 正的已计入续跑轮数 */
  readonly round: number
}

/** 严格重放的结果（dsh: FoldedGoal） */
export interface FoldedGoal {
  readonly goal?: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly lastRef?: GoalRef
}

/** 一次持久变更后的通知（dsh: GoalChanged） */
export interface GoalChanged {
  readonly operation: GoalOperation
  readonly ref: GoalRef
  readonly goal?: import('./types.ts').GoalView
}

/** 稳定的错误码（dsh: GoalErrorCode） */
export type GoalErrorCode =
  | 'GOAL_AGENT_NOT_LIVE'
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION'
