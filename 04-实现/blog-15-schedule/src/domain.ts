/**
 * Schedule 域逻辑（dsh: packages/schedule/schedule/src/domain.ts）
 *
 * 纯函数核心：事件解码、日志折叠（唯一真源）、id 分配、三种记录工厂、
 * 固定间隔推进、模型可见视图与提醒渲染。
 */

import type { Session } from './session.ts'
import type { SessionEvent } from './session.ts'
import {
  EveryScheduleRecord,
  OneShotScheduleRecord,
  ScheduleChange,
  ScheduleError,
  ScheduleId,
  ScheduleRecord,
  ScheduleView,
} from './types.ts'

export const SCHEDULE_CHANGE_VERSION = 1 as const
/** dsh 最小固定间隔 5 分钟（演示放宽到 1 秒以便观察） */
export const MIN_EVERY_INTERVAL_SECONDS = 1

// ============================================================
// 事件解码（dsh: decodeScheduleChange）
// ============================================================

function decodeScheduleChange(value: unknown): ScheduleChange {
  if (typeof value !== 'object' || value === null) throw new ScheduleError('corrupt_schedule_log', 'schedule/change must be an object')
  const v = value as Record<string, any>
  if (v.version !== 1) throw new ScheduleError('corrupt_schedule_log', `unknown schedule change version ${String(v.version)}`)
  switch (v.operation) {
    case 'create':
      if (v.schedule === undefined) throw new ScheduleError('corrupt_schedule_log', 'create change missing schedule')
      return { version: 1, operation: 'create', schedule: v.schedule }
    case 'delete':
      return { version: 1, operation: 'delete', id: v.id }
    case 'dispatch':
      return v.acceptedAt === undefined
        ? { version: 1, operation: 'dispatch', id: v.id }
        : { version: 1, operation: 'dispatch', id: v.id, acceptedAt: v.acceptedAt }
    default:
      throw new ScheduleError('corrupt_schedule_log', `unknown schedule change operation ${String(v.operation)}`)
  }
}

// ============================================================
// 日志折叠（dsh: foldScheduleEvents）——唯一真源
// ============================================================

export interface FoldedSchedules {
  readonly active: ScheduleRecord[]
  readonly seenIds: ScheduleId[]
}

/**
 * 折叠 schedule/change 事件流：create 加入、delete 移除、dispatch 终结或推进。
 * 非法转移（复用 id、删除不活跃记录、派发不活跃记录）抛 corrupt_schedule_log。
 */
export function foldScheduleEvents(events: readonly SessionEvent[], seedLength = 0): FoldedSchedules {
  if (!Number.isSafeInteger(seedLength) || seedLength < 0 || seedLength > events.length) {
    throw new ScheduleError('corrupt_schedule_log', 'seedLength must be within the event log')
  }
  const active = new Map<string, ScheduleRecord>()
  const seen = new Set<string>()
  for (const event of events.slice(seedLength)) {
    if (event.type !== 'schedule/change') continue
    const change = decodeScheduleChange(event.data)
    switch (change.operation) {
      case 'create':
        if (seen.has(change.schedule.id)) {
          throw new ScheduleError('corrupt_schedule_log', `schedule id ${change.schedule.id} was reused`)
        }
        seen.add(change.schedule.id)
        active.set(change.schedule.id, change.schedule)
        break
      case 'delete':
        if (!active.delete(change.id)) {
          throw new ScheduleError('corrupt_schedule_log', `schedule delete targets inactive id ${change.id}`)
        }
        break
      case 'dispatch': {
        const record = active.get(change.id)
        if (record === undefined) {
          throw new ScheduleError('corrupt_schedule_log', `schedule dispatch targets inactive id ${change.id}`)
        }
        const next = dispatchedRecord(record, change)
        if (next === undefined) active.delete(change.id)
        else active.set(change.id, next)
        break
      }
    }
  }
  return Object.freeze({
    active: Object.freeze([...active.values()]),
    seenIds: Object.freeze([...seen]),
  })
}

/** 一次性派发 → 终结（删除）；固定间隔派发 → 推进到下一锚点（dsh: dispatchedRecord） */
function dispatchedRecord(
  record: ScheduleRecord,
  change: Extract<ScheduleChange, { operation: 'dispatch' }>,
): ScheduleRecord | undefined {
  if (record.kind !== 'every') {
    if (change.acceptedAt !== undefined) {
      throw new ScheduleError('corrupt_schedule_log', 'one-shot dispatch must not contain acceptedAt')
    }
    return undefined  // 一次性提醒派发后终结
  }
  if (change.acceptedAt === undefined) {
    throw new ScheduleError('corrupt_schedule_log', 'every dispatch must contain acceptedAt')
  }
  const occurrence = resolveEveryOccurrence(record, Date.parse(change.acceptedAt))
  return occurrence.nextScheduledAt === undefined
    ? undefined
    : { ...record, scheduledAt: occurrence.nextScheduledAt }
}

// ============================================================
// id 分配（dsh: allocateScheduleId）——永不重用
// ============================================================

export function allocateScheduleId(folded: FoldedSchedules): ScheduleId {
  const seen = new Set(folded.seenIds)
  let sequence = seen.size + 1
  let candidate = ScheduleId(`schedule-${sequence}`)
  while (seen.has(candidate)) {
    sequence += 1
    candidate = ScheduleId(`schedule-${sequence}`)
  }
  return candidate
}

// ============================================================
// 三种记录工厂（dsh: createAfterScheduleRecord 等）
// ============================================================

function futureInstant(target: number, now: number): string {
  if (!Number.isSafeInteger(target) || target <= now) {
    throw new ScheduleError('not_future', 'target must be a future instant')
  }
  return new Date(target).toISOString()
}

/** after：延迟一次性提醒 */
export function createAfterScheduleRecord(id: ScheduleId, prompt: string, afterSeconds: number, now: number): OneShotScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) throw new ScheduleError('invalid_prompt', 'prompt must be non-empty after trimming')
  if (!Number.isSafeInteger(afterSeconds) || afterSeconds <= 0) {
    throw new ScheduleError('invalid_rule', 'after_seconds must be a positive safe integer')
  }
  const target = now + afterSeconds * 1000
  return Object.freeze({ id, kind: 'after', prompt: normalizedPrompt, afterSeconds, scheduledAt: futureInstant(target, now) })
}

/** at：绝对时刻一次性提醒（简化：只支持 ISO 字符串，dsh 还支持本地日历 + 时区） */
export function createAtScheduleRecord(id: ScheduleId, prompt: string, at: string, now: number): OneShotScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) throw new ScheduleError('invalid_prompt', 'prompt must be non-empty after trimming')
  const target = Date.parse(at)
  if (Number.isNaN(target)) throw new ScheduleError('invalid_rule', 'at must be an RFC 3339 instant')
  return Object.freeze({ id, kind: 'at', prompt: normalizedPrompt, scheduledAt: futureInstant(target, now) })
}

/** every：固定间隔重复提醒（scheduledAt = 最早的未派发锚点对齐时刻） */
export function createEveryScheduleRecord(
  id: ScheduleId,
  prompt: string,
  everySeconds: number,
  now: number,
): EveryScheduleRecord {
  const normalizedPrompt = prompt.trim()
  if (normalizedPrompt.length === 0) throw new ScheduleError('invalid_prompt', 'prompt must be non-empty after trimming')
  if (!Number.isSafeInteger(everySeconds) || everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    throw new ScheduleError('frequency_too_high', `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}`)
  }
  const target = now + everySeconds * 1000
  return Object.freeze({ id, kind: 'every', prompt: normalizedPrompt, everySeconds, scheduledAt: futureInstant(target, now) })
}

// ============================================================
// 固定间隔推进（dsh: resolveEveryOccurrence）
// ============================================================

/** 一次固定间隔决策：给出这次要派发的 occurrenceAt 和下一锚点（或无） */
export function resolveEveryOccurrence(
  record: EveryScheduleRecord,
  now: number,
): { occurrenceAt: string; nextScheduledAt: string | undefined } {
  const intervalMs = record.everySeconds * 1000
  const anchor = Date.parse(record.scheduledAt)
  // 从锚点向后取最近不晚于 now 的对齐时刻
  let occurrence = anchor
  while (occurrence + intervalMs <= now) occurrence += intervalMs
  const next = occurrence + intervalMs
  return {
    occurrenceAt: new Date(occurrence).toISOString(),
    nextScheduledAt: new Date(next).toISOString(),
  }
}

// ============================================================
// 模型可见视图（dsh: scheduleView）
// ============================================================

export function scheduleView(record: ScheduleRecord, now: number): ScheduleView {
  return {
    ...record,
    state: Date.parse(record.scheduledAt) <= now ? 'overdue' : 'scheduled',
    deliveryMode: 'session-local',
  }
}

// ============================================================
// 提醒渲染（dsh: renderReminderFraming / renderEveryReminderBatchFraming）
// ============================================================

/** 一次性提醒 → 给 agent 的用户消息文本 */
export function renderReminderFraming(record: OneShotScheduleRecord): string {
  return `Reminder (${record.kind}): ${record.prompt}`
}

/** 固定间隔批量提醒 → 给 agent 的用户消息文本 */
export function renderEveryReminderBatchFraming(reminders: Array<{ record: EveryScheduleRecord; occurrenceAt: string }>): string {
  return reminders.map(r => `Recurring reminder (${r.record.everySeconds}s): ${r.record.prompt}`).join('\n')
}
