/**
 * Schedule 类型定义（dsh: packages/schedule/schedule/src/types.ts）
 *
 * 持久化与模型侧值类型：after/at/every 三种提醒记录、schedule/change 事件
 * 联合（create/delete/dispatch）、模型可见视图与错误码。
 */

// ---- 稳定提醒身份（dsh: ScheduleId，branded）----
export type ScheduleId = string & { readonly __brand: 'ScheduleId' }
export function ScheduleId(value: string): ScheduleId {
  return value as ScheduleId
}

// ---- 三种持久化记录（dsh: AfterScheduleRecord / AtScheduleRecord / EveryScheduleRecord）----

/** 延迟一次性提醒（after_seconds） */
export interface AfterScheduleRecord {
  readonly id: ScheduleId
  readonly kind: 'after'
  readonly prompt: string          // 修剪后的提醒内容
  readonly afterSeconds: number    // 创建时接受的延迟秒数
  readonly scheduledAt: string     // RFC 3339 UTC 目标时刻
}

/** 绝对时刻一次性提醒（at） */
export interface AtScheduleRecord {
  readonly id: ScheduleId
  readonly kind: 'at'
  readonly prompt: string
  readonly scheduledAt: string
}

/** 固定间隔重复提醒（every_seconds）——scheduledAt 是未派发的最早锚点对齐时刻 */
export interface EveryScheduleRecord {
  readonly id: ScheduleId
  readonly kind: 'every'
  readonly prompt: string
  readonly everySeconds: number    // 固定间隔（dsh 最小 5 分钟，演示放宽）
  readonly scheduledAt: string
}

export type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord
export type ScheduleRecord = OneShotScheduleRecord | EveryScheduleRecord

// ---- schedule/change 事件（dsh: ScheduleChange 联合）----

export interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: ScheduleRecord
}

export interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}

/** 一次性派发：id-only（记录终结） */
export interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}

/** 固定间隔派发：acceptedAt 用于推进到下一个锚点 */
export interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  readonly acceptedAt: string
}

export type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange
export type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange

// ---- 模型可见视图与状态 ----

export type ScheduleState = 'scheduled' | 'overdue'
export type ScheduleDeliveryMode = 'session-local'

export type ScheduleView = ScheduleRecord & {
  readonly state: ScheduleState
  readonly deliveryMode: ScheduleDeliveryMode
}

// ---- 稳定错误码（dsh: ScheduleToolError 联合的简化）----
export type ScheduleErrorCode =
  | 'invalid_prompt'
  | 'invalid_selector'
  | 'invalid_rule'
  | 'not_future'
  | 'frequency_too_high'
  | 'corrupt_schedule_log'
  | 'schedule_not_found'

/** 抛错携带稳定 code（dsh: ScheduleInputError / ScheduleLogError） */
export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ScheduleError'
  }
}
