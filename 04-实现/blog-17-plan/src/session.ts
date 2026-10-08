/**
 * Session 事件日志（dsh: @deepseek-ai/dsh-session 的简化）
 *
 * plan/mode 事件落在这里——log-only、whole-value-replace，
 * 最后一条生效（重放恢复，和 blog-15 schedule 的 schedule/change 同思路）。
 */

import type { PlanModeChange } from './types.ts'

export type SessionEvent =
  | { type: 'plan/mode'; seq: number; data: PlanModeChange; timestamp: number }
  | { type: 'user/message'; seq: number; text: string; timestamp: number }
  | { type: 'assistant/message'; seq: number; text: string; timestamp: number }
  | { type: 'turn/start'; seq: number; turn: number; timestamp: number }
  | { type: 'turn/end'; seq: number; turn: number; reason: { kind: string }; timestamp: number }

export class Session {
  readonly id: string
  readonly events: SessionEvent[] = []

  constructor(id: string) {
    this.id = id
  }

  append(event: Omit<SessionEvent, 'seq' | 'timestamp'>): SessionEvent {
    const full = { ...event, seq: this.events.length, timestamp: Date.now() } as SessionEvent
    this.events.push(full)
    return full
  }
}
