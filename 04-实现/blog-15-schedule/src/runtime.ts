/**
 * ScheduleRuntime：可丢弃的定时器投影（dsh: packages/schedule/schedule/src/runtime.ts）
 *
 * 一个运行中的 root agent 对应一个 ScheduleRuntime。它不做持久化——提醒状态
 * 全在 Session 日志里（foldScheduleEvents），runtime 只是"定时器 + 派发"的
 * 可丢弃投影：到期 → 折叠日志 → 决策（one-shot 优先 / every 批量 / wait）→
 * dispatch 事件 + followup 提醒给 agent。
 *
 * dsh README 原文："timers, tool values, and model follow-ups are disposable
 * projections of that log"——定时器是可丢弃投影，日志才是唯一真源。
 */

import type { Context } from '@cordisjs/core'
import type { Agent } from './agent.ts'
import {
  EveryScheduleRecord,
  OneShotScheduleRecord,
  ScheduleChange,
} from './types.ts'
import { FoldedSchedules, foldScheduleEvents, renderEveryReminderBatchFraming, renderReminderFraming, resolveEveryOccurrence } from './domain.ts'

/** Node 定时器不 clamp 的最大延迟（dsh: MAX_TIMER_DELAY_MS） */
const MAX_TIMER_DELAY_MS = 2_147_483_647

interface EveryDue {
  readonly record: EveryScheduleRecord
  readonly occurrenceAt: string
}

type DueDecision =
  | { readonly kind: 'one-shot'; readonly record: OneShotScheduleRecord }
  | { readonly kind: 'every'; readonly reminders: readonly EveryDue[]; readonly acceptedAt: string }
  | { readonly kind: 'wait'; readonly target?: number }

/**
 * 决策：选一个到期的一次性提醒（按目标时刻 + 创建序）、
 * 或一批到期的固定间隔提醒、或下一次唤醒目标。
 */
function dueDecision(folded: FoldedSchedules, now: number): DueDecision {
  const byTarget = (a: { record: { scheduledAt: string } }, b: { record: { scheduledAt: string } }): number =>
    Date.parse(a.record.scheduledAt) - Date.parse(b.record.scheduledAt)

  const oneShot = folded.active
    .filter((r): r is OneShotScheduleRecord => r.kind !== 'every' && Date.parse(r.scheduledAt) <= now)
    .sort(byTarget)[0]
  if (oneShot !== undefined) return { kind: 'one-shot', record: oneShot }

  const every = folded.active
    .filter((r): r is EveryScheduleRecord => r.kind === 'every' && Date.parse(r.scheduledAt) <= now)
    .sort(byTarget)
  if (every.length > 0) {
    return {
      kind: 'every',
      acceptedAt: new Date(now).toISOString(),
      reminders: every.map((record) => ({
        record,
        occurrenceAt: resolveEveryOccurrence(record, now).occurrenceAt,
      })),
    }
  }

  const target = folded.active.reduce<number | undefined>((selected, record) => {
    const candidate = Date.parse(record.scheduledAt)
    return candidate > now && (selected === undefined || candidate < selected) ? candidate : selected
  }, undefined)
  return { kind: 'wait', ...(target === undefined ? {} : { target }) }
}

export class ScheduleRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopping = false
  private faulted = false

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {}

  /** 开始：首次决策 + 装定时器 */
  start(): void {
    this.requestDrive()
  }

  /** 提醒触发 / 管理操作提交后：重算投影 */
  requestDrive(): void {
    if (this.stopping || this.faulted) return
    this.clearTimer()
    void this.driveOnce()
  }

  /** 停止：取消定时器 */
  dispose(): void {
    this.stopping = true
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 一次驱动：折叠 → 决策 → 派发或装定时器 */
  private async driveOnce(): Promise<void> {
    if (this.stopping) return
    const folded = foldScheduleEvents(this.agent.session.events, this.agent.session.meta.seedLength)
    const now = Date.now()
    const decision = dueDecision(folded, now)

    if (decision.kind === 'wait') {
      if (decision.target !== undefined) this.arm(decision.target, now)
      return
    }

    // 派发（dsh: runMaintenance——从 true idle 阶段执行）：
    // 构造提醒消息 → followup 给同一个 agent → 写 dispatch 事件
    const text = decision.kind === 'one-shot'
      ? renderReminderFraming(decision.record)
      : renderEveryReminderBatchFraming(decision.reminders)

    if (this.agent.busy) {
      // agent 正在执行当前 turn：提醒先进 inbox 排队，等当前 turn 收敛到 idle 再处理
      console.log(`  ⏳ agent 忙（当前 turn 执行中）→ 提醒进 inbox 排队: ${text.slice(0, 40)}...`)
    }
    this.agent.followup({ type: 'text', text })

    if (decision.kind === 'one-shot') {
      this.agent.session.append({ type: 'schedule/change', data: { version: 1, operation: 'dispatch', id: decision.record.id } })
    } else {
      for (const reminder of decision.reminders) {
        this.agent.session.append({
          type: 'schedule/change',
          data: { version: 1, operation: 'dispatch', id: reminder.record.id, acceptedAt: decision.acceptedAt } as ScheduleChange,
        })
      }
    }
    // 派发后继续驱动（固定间隔可能还有下一批）
    if (!this.stopping) this.requestDrive()
  }

  /** 装一个 bounded 定时器段；每次唤醒重读墙钟（dsh: arm） */
  private arm(target: number, now: number): void {
    const delay = Math.min(target - now, MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestDrive()
    }, delay)
  }
}
