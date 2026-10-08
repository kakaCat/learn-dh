/**
 * 第4课：Session 模块
 *
 * 实现事件日志系统
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// Session 事件类型定义
// ============================================================

/**
 * Session 是 append-only 的事件日志
 * 所有交互都记录为事件，可以重放和审计
 */
type SessionEvent =
  | { type: 'turn/start'; turnId: string; timestamp: number }
  | { type: 'turn/end'; turnId: string; timestamp: number }
  | { type: 'step/start'; stepId: string; turnId: string; timestamp: number }
  | { type: 'step/end'; stepId: string; timestamp: number }
  | { type: 'user/message'; content: string; timestamp: number }
  | { type: 'assistant/message'; content: string; timestamp: number }
  | { type: 'assistant/chunk'; delta: string; timestamp: number }
  | { type: 'tool/call'; id: string; name: string; args: Record<string, unknown>; timestamp: number }
  | { type: 'tool/result'; id: string; result: unknown; error?: string; timestamp: number }

interface Session {
  id: string
  events: SessionEvent[]
  createdAt: number
  updatedAt: number
}

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Events {
    'session/event': (sessionId: string, event: SessionEvent) => void
  }

  interface Context {
    sessions: SessionService
  }
}

// ============================================================
// Session Service 实现
// ============================================================

class SessionService extends Service {
  private sessions = new Map<string, Session>()

  constructor(ctx: Context) {
    super(ctx, 'sessions', true)
  }

  /**
   * 创建新会话
   */
  create(id?: string): Session {
    const sessionId = id ?? Math.random().toString(36).slice(2, 11)
    const session: Session = {
      id: sessionId,
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(sessionId, session)
    console.log(`  📁 创建会话: ${sessionId}`)
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

    session.events.push(event)
    session.updatedAt = Date.now()

    // 广播事件
    this.ctx.emit('session/event', sessionId, event)
  }

  /**
   * 获取事件
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

    const sessionId = newId ?? Math.random().toString(36).slice(2, 11)
    const newSession: Session = {
      id: sessionId,
      events: source.events.slice(0, fromIndex),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.sessions.set(sessionId, newSession)
    console.log(`  🍴 Fork 会话: ${sourceId} → ${sessionId} (从索引 ${fromIndex})`)
    return newSession
  }

  /**
   * 列出所有会话
   */
  list(): Session[] {
    return Array.from(this.sessions.values())
  }
}

// ============================================================
// 主程序
// ============================================================

console.log('='.repeat(60))
console.log('第4课：Session 模块')
console.log('='.repeat(60))

const ctx = new Context()
ctx.plugin(SessionService)

// 监听事件
console.log('\n👂 设置事件监听...')
ctx.on('session/event', (sessionId, event) => {
  console.log(`  [${sessionId.slice(0, 6)}] ${event.type}`)
})

// 创建会话
console.log('\n📁 创建会话...')
const session = ctx.sessions.create()

// 模拟一个完整的对话
console.log('\n💬 模拟对话...')

// Turn 1: 用户问问题
const turn1Id = 'turn-1'
ctx.sessions.append(session.id, {
  type: 'turn/start',
  turnId: turn1Id,
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'step/start',
  stepId: 'step-1',
  turnId: turn1Id,
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'user/message',
  content: 'Hello!',
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'assistant/message',
  content: 'Hi! How can I help you?',
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'step/end',
  stepId: 'step-1',
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'turn/end',
  turnId: turn1Id,
  timestamp: Date.now(),
})

// Turn 2: 使用工具
const turn2Id = 'turn-2'
ctx.sessions.append(session.id, {
  type: 'turn/start',
  turnId: turn2Id,
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'step/start',
  stepId: 'step-2',
  turnId: turn2Id,
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'user/message',
  content: 'What is 2 + 2?',
  timestamp: Date.now(),
})

// 助手决定调用工具
ctx.sessions.append(session.id, {
  type: 'tool/call',
  id: 'call-1',
  name: 'calculator',
  args: { a: 2, b: 2, op: 'add' },
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'tool/result',
  id: 'call-1',
  result: 4,
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'step/end',
  stepId: 'step-2',
  timestamp: Date.now(),
})

// Step 2: 总结结果
ctx.sessions.append(session.id, {
  type: 'step/start',
  stepId: 'step-3',
  turnId: turn2Id,
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'assistant/message',
  content: 'The answer is 4.',
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'step/end',
  stepId: 'step-3',
  timestamp: Date.now(),
})

ctx.sessions.append(session.id, {
  type: 'turn/end',
  turnId: turn2Id,
  timestamp: Date.now(),
})

// 查看会话
console.log('\n📊 会话统计:')
const events = ctx.sessions.getEvents(session.id)
console.log(`  总事件数: ${events.length}`)

const eventTypes = events.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] || 0) + 1
  return acc
}, {} as Record<string, number>)

for (const [type, count] of Object.entries(eventTypes)) {
  console.log(`  ${type}: ${count}`)
}

// Fork 会话
console.log('\n🍴 Fork 会话...')
const forked = ctx.sessions.fork(session.id, 6)
console.log(`  新会话 ID: ${forked.id}`)
console.log(`  新会话事件数: ${forked.events.length}`)

console.log('\n✅ 完成！')
