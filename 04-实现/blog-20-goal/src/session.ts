/**
 * Session 事件日志（dsh: @deepseek-ai/dsh-session 的简化）
 *
 * goal 主题的两类关键事件：
 * - goal/change：每次变更携带完整快照（或 clear tombstone）——last-write-wins
 * - user/message：带 source 归属——source.kind === 'goal' 的续跑轮计入 roundsStarted
 * - turn/start / turn/end：定义"当前回合窗口"（authority 检查用）
 */

import type { GoalChangeMeta } from './domain.ts'

export interface UserSource { kind: 'user' }
export interface GoalRoundSource { kind: 'goal'; goalId: string; revision: number; round: number }

export type MessageSource = UserSource | GoalRoundSource

export type SessionEvent =
  | { type: 'goal/change'; seq: number; data: GoalChangeMeta; timestamp: number }
  | { type: 'user/message'; seq: number; text: string; data: { source: MessageSource }; timestamp: number }
  | { type: 'assistant/message'; seq: number; text: string; timestamp: number }
  | { type: 'turn/start'; seq: number; turn: number; timestamp: number }
  | { type: 'turn/end'; seq: number; turn: number; reason: { kind: string }; timestamp: number }

export class Session {
  readonly id: string
  readonly events: SessionEvent[] = []

  constructor(id: string) {
    this.id = id
  }

  /** 下一条事件的 seq（append 前 == 当前长度） */
  get seq(): number {
    return this.events.length
  }

  append(event: Omit<SessionEvent, 'seq' | 'timestamp'>): SessionEvent {
    const full = { ...event, seq: this.events.length, timestamp: Date.now() } as SessionEvent
    this.events.push(full)
    return full
  }
}
