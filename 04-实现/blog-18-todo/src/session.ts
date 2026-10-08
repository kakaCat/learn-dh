/**
 * Session 事件日志（dsh: @deepseek-ai/dsh-session 的简化）
 *
 * todo/write 事件携带完整列表快照——last-write-wins（最后一条生效）。
 * 另有 turn/start 事件（todo 投影在 turn/start 时清空：standing plan）。
 */

import type { TodoItem } from './types.ts'

export type SessionEvent =
  | { type: 'todo/write'; seq: number; data: { todos: TodoItem[] }; timestamp: number }
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
