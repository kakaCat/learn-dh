/**
 * goal 主题纯类型（dsh: packages/goal/goal/src/types.ts）
 *
 * 持久化的同会话目标：身份（GoalId）、CAS 修订（GoalRef）、
 * 生命周期阶段（GoalPhase）、完整快照（GoalSnapshot）、
 * 当前投影（GoalView，含进程内激活）。
 */

/** 目标 id（dsh: GoalId，branded string）——`goal-N` */
export type GoalId = string & { readonly __brand: 'GoalId' }
export function GoalId(value: string): GoalId {
  return value as GoalId
}

/** Compare-and-set 身份：一次精确修订（dsh: GoalRef） */
export interface GoalRef {
  readonly id: GoalId
  /** 正修订号；每次持久变更 +1 */
  readonly revision: number
}

/** 创建请求（dsh: CreateGoalRequest）——省略轮数上限由部署默认值补齐 */
export interface CreateGoalRequest {
  readonly objective: string
  readonly maxGoalRounds?: number
}

/** 编辑请求（dsh: EditGoalRequest）——至少一个字段 */
export interface EditGoalRequest {
  readonly objective?: string
  readonly maxGoalRounds?: number
}

/** 持久生命周期阶段（dsh: GoalPhase）——激活（activation）是进程内的，与阶段分离 */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** 阻塞原因（dsh: GoalBlockReason）——策略所有的稳定 code + 人类可读 message */
export interface GoalBlockReason {
  /** 稳定 lower-kebab-case 分类（如 model-reported） */
  readonly code: string
  /** 非空说明（给人看、给模型看） */
  readonly message: string
}

/** 每次非 clear 变更写入的完整持久状态（dsh: GoalSnapshot） */
export interface GoalSnapshot extends GoalRef {
  readonly objective: string
  readonly phase: GoalPhase
  /** 恰好当 phase 为 blocked 时存在 */
  readonly blockedReason?: GoalBlockReason
  /** 续跑轮数总上限 */
  readonly maxGoalRounds: number
}

/** 当前进程是否允许自动续跑（dsh: GoalActivation）——从不持久化 */
export type GoalActivation = 'armed' | 'disarmed'

/** 当前目标投影（dsh: GoalView）——含从会话日志派生的计数 */
export interface GoalView extends GoalSnapshot {
  /** 本目标已计入的最高续跑轮数 */
  readonly roundsStarted: number
  /** create 变更的毫秒时间戳 */
  readonly createdAt: number
  /** 最近一次变更的毫秒时间戳 */
  readonly updatedAt: number
  /** 进程内续跑资格（从不持久化） */
  readonly activation: GoalActivation
}

/** goal 投影值（dsh: GoalProjection）——不带 activation（反映持久阶段） */
export interface GoalProjection {
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}
