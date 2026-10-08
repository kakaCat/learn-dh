/**
 * Session 事件日志（dsh: @deepseek-ai/dsh-session 的简化）
 *
 * append-only 日志是唯一真源（blog-04）：预设旋钮、审批策略、委托策略、
 * 消息流全部落在这里，重放即状态。subagent 域新增了 user/assistant 消息事件
 * 和带 source 标记的委托策略事件。
 */

import type { SessionEvent } from './types.ts'

export class Session {
  readonly id: string
  readonly events: SessionEvent[] = []
  /** 会话元数据：父会话 / 来源 / 委托深度（dsh: session header meta） */
  meta: { parentSession?: string; origin?: string; delegationDepth: number } = { delegationDepth: 0 }

  constructor(id: string) {
    this.id = id
  }

  append(event: Omit<SessionEvent, 'seq' | 'timestamp'>): SessionEvent {
    const full = { ...event, seq: this.events.length, timestamp: Date.now() } as SessionEvent
    this.events.push(full)
    return full
  }
}
