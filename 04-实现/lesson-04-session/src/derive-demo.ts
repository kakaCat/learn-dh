/**
 * 消息派生演示
 *
 * 从 Session 事件派生出模型可见的消息
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('消息派生演示')
console.log('='.repeat(60))

// 复用 Session 类型
type SessionEvent =
  | { type: 'user/message'; content: string; timestamp: number }
  | { type: 'assistant/message'; content: string; timestamp: number }
  | { type: 'tool/call'; id: string; name: string; args: Record<string, unknown>; timestamp: number }
  | { type: 'tool/result'; id: string; result: unknown; error?: string; timestamp: number }

interface Session {
  id: string
  events: SessionEvent[]
  createdAt: number
  updatedAt: number
}

// 简化的 SessionService
class SessionService extends Service {
  private sessions = new Map<string, Session>()

  constructor(ctx: Context) {
    super(ctx, 'sessions', true)
  }

  create(): Session {
    const session: Session = {
      id: Math.random().toString(36).slice(2, 11),
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(session.id, session)
    return session
  }

  append(sessionId: string, event: SessionEvent): void {
    const session = this.sessions.get(sessionId)!
    session.events.push(event)
    session.updatedAt = Date.now()
  }

  getEvents(sessionId: string): SessionEvent[] {
    return this.sessions.get(sessionId)?.events ?? []
  }
}

// 消息类型
interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/**
 * 从事件派生消息
 */
function deriveMessages(events: SessionEvent[]): Message[] {
  const messages: Message[] = []

  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        messages.push({
          role: 'user',
          content: event.content,
        })
        break

      case 'assistant/message':
        messages.push({
          role: 'assistant',
          content: event.content,
        })
        break

      case 'tool/call':
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: event.id,
            type: 'function',
            function: {
              name: event.name,
              arguments: JSON.stringify(event.args),
            },
          }],
        })
        break

      case 'tool/result':
        messages.push({
          role: 'tool',
          tool_call_id: event.id,
          content: event.error ?? JSON.stringify(event.result),
        })
        break
    }
  }

  return messages
}

// 主程序
const ctx = new Context()
ctx.plugin(SessionService)

const session = ctx.sessions.create()

console.log('\n📝 添加事件...')
ctx.sessions.append(session.id, {
  type: 'user/message',
  content: 'What is 2 + 2?',
  timestamp: Date.now(),
})

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
  type: 'assistant/message',
  content: 'The answer is 4.',
  timestamp: Date.now(),
})

console.log('\n🔄 派生消息...')
const events = ctx.sessions.getEvents(session.id)
const messages = deriveMessages(events)

console.log('\n📋 派生出的消息:')
for (const msg of messages) {
  if (msg.tool_calls) {
    console.log(`  [${msg.role}] 工具调用: ${msg.tool_calls[0].function.name}`)
  } else if (msg.tool_call_id) {
    console.log(`  [${msg.role}] 工具结果: ${msg.content}`)
  } else {
    console.log(`  [${msg.role}] ${msg.content}`)
  }
}

console.log('\n📊 事件 vs 消息:')
console.log(`  事件数: ${events.length}`)
console.log(`  消息数: ${messages.length}`)

console.log('\n✅ 完成！')
