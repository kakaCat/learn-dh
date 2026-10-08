/**
 * Session 事件日志（dsh: @deepseek-ai/dsh-session 的简化）
 *
 * **Schedule 的核心理念**：Session 日志拥有提醒状态——定时器、工具值、
 * 模型跟进都是日志的可丢弃投影（dsh README 原文： "The Session event log owns
 * reminder state; timers, tool values, and model follow-ups are disposable
 * projections of that log"）。create/delete/dispatch 全部落在日志里。
 */

import type { ScheduleChange } from './types.ts'

export type SessionEvent =
  | { type: 'schedule/change'; seq: number; data: ScheduleChange; timestamp: number }
  | { type: 'user/message'; seq: number; text: string; timestamp: number }
  | { type: 'assistant/message'; seq: number; text: string; timestamp: number }

export class Session {
  readonly id: string
  readonly events: SessionEvent[] = []
  /** 继承前缀长度（fork 子代理不继承父的提醒，dsh: seedLength） */
  meta: { seedLength: number } = { seedLength: 0 }

  constructor(id: string) {
    this.id = id
  }

  append(event: Omit<SessionEvent, 'seq' | 'timestamp'>): SessionEvent {
    const full = { ...event, seq: this.events.length, timestamp: Date.now() } as SessionEvent
    this.events.push(full)
    return full
  }
}
