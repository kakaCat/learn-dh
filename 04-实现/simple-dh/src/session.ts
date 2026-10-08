/**
 * Session 模块
 *
 * 管理 append-only 的事件日志
 */

import { Context, Service } from '@cordisjs/core'

// ==================== 事件类型定义 ====================

export type SessionEvent =
  | { type: 'turn/start'; turnId: string; timestamp: number }
  | { type: 'turn/end'; turnId: string; timestamp: number }
  | { type: 'step/start'; stepId: string; turnId: string; timestamp: number }
  | { type: 'step/end'; stepId: string; timestamp: number }
  | { type: 'user/message'; content: string; timestamp: number }
  | { type: 'assistant/message'; content: string; timestamp: number }
  | { type: 'assistant/chunk'; delta: string; timestamp: number }
  | { type: 'tool/call'; id: string; name: string; args: Record<string, unknown>; timestamp: number }
  | { type: 'tool/result'; id: string; result: unknown; error?: string; timestamp: number }

export interface Session {
  id: string
  events: SessionEvent[]
  createdAt: number
  updatedAt: number
}

// ==================== 扩展 Cordis 类型 ====================

declare module '@cordisjs/core' {
  interface Events {
    'session/event': (sessionId: string, event: SessionEvent) => void
  }

  interface Context {
    sessions: SessionService
  }
}

// ==================== Session Service ====================

export class SessionService extends Service {
  private sessions = new Map<string, Session>()

  constructor(ctx: Context) {
    super(ctx, 'sessions', true)
  }

  /**
   * 创建新会话
   */
  create(id = this.generateId()): Session {
    const session: Session = {
      id,
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(id, session)
    return session
  }

  /**
   * 获取会话
   */
  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /**
   * 追加事件
   */
  append(sessionId: string, event: SessionEvent): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // 追加事件
    session.events.push(event)
    session.updatedAt = Date.now()

    // 广播事件
    this.ctx.emit('session/event', sessionId, event)
  }

  /**
   * 获取事件（从指定位置开始）
   */
  getEvents(sessionId: string, fromIndex = 0): SessionEvent[] {
    const session = this.sessions.get(sessionId)
    return session ? session.events.slice(fromIndex) : []
  }

  /**
   * Fork 会话
   */
  fork(sourceId: string, fromIndex: number, newId?: string): Session {
    const source = this.sessions.get(sourceId)
    if (!source) {
      throw new Error(`Session ${sourceId} not found`)
    }

    const newSession: Session = {
      id: newId ?? this.generateId(),
      events: source.events.slice(0, fromIndex), // 复制部分事件
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.sessions.set(newSession.id, newSession)
    return newSession
  }

  /**
   * 删除会话
   */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * 列出所有会话
   */
  list(): Session[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 生成随机 ID
   */
  private generateId(): string {
    return Math.random().toString(36).slice(2, 11)
  }
}

/**
 * 应用插件
 */
export function apply(ctx: Context) {
  ctx.plugin(SessionService)
}
