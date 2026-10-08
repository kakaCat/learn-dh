/**
 * 博客4：Session 模块 - 事件日志系统
 *
 * 本文包含：
 * - Part 1: Session 基础 - 事件日志系统
 * - Part 2: 消息派生 - 从事件生成模型消息
 * - Part 3: 高级功能 - Fork、重放、审计
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('博客4：Session 模块')
console.log('='.repeat(60))

// ============================================================
// Part 1: Session 基础 - 事件日志系统
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 1: Session 基础')
console.log('='.repeat(60))

console.log('\n💡 什么是 Session？')
console.log('Session 是 append-only 的事件日志，记录所有交互。')
console.log('所有操作都以事件形式存储，可以重放、审计、fork。')

// ----------------------------------------
// Session 事件类型定义
// ----------------------------------------

type SessionEvent =
  | { type: 'turn/start'; seq: number; turnId: string; timestamp: number }
  | { type: 'turn/end'; seq: number; turnId: string; timestamp: number }
  | { type: 'step/start'; seq: number; stepId: string; turnId: string; timestamp: number }
  | { type: 'step/end'; seq: number; stepId: string; turnId: string; timestamp: number }
  | { type: 'user/message'; seq: number; content: string; timestamp: number }
  | { type: 'assistant/message'; seq: number; content: string; timestamp: number }
  | { type: 'assistant/chunk'; seq: number; delta: string; timestamp: number }
  | { type: 'tool/call'; seq: number; id: string; name: string; args: Record<string, unknown>; timestamp: number }
  | { type: 'tool/result'; seq: number; id: string; result: unknown; error?: string; timestamp: number }

// 调用方追加事件时不需要自己填 seq，由 SessionService.append 自动分配
type SessionEventInput = SessionEvent extends infer E ? Omit<E, 'seq'> : never

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

// ----------------------------------------
// Session Service 实现
// ----------------------------------------

class SessionService extends Service {
  private sessions = new Map<string, Session>()
  private counter = 0  // 自增计数器，用于生成唯一 ID（与 dsh 内存版一致）

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  /**
   * 生成唯一会话 ID：自增 session-<n>
   * （dsh 内存版 SessionStore 的做法；真实持久化版用 randomUUID）
   */
  private mintId(): string {
    return `session-${++this.counter}`
  }

  /**
   * 创建新会话
   */
  create(id?: string): Session {
    const sessionId = id ?? this.mintId()
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
   * 追加事件：自动分配 seq + push + 更新 updatedAt + 广播
   * seq 单调递增，从 0 开始，保证事件可精确重放
   */
  append(sessionId: string, input: SessionEventInput): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // 自动分配 seq：等于当前事件数（从 0 开始，连续递增）
    const event: SessionEvent = { seq: session.events.length, ...input }
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
   * Fork 会话（从某个时间点分叉）
   */
  fork(sourceId: string, fromIndex: number, newId?: string): Session {
    const source = this.sessions.get(sourceId)
    if (!source) {
      throw new Error(`Session ${sourceId} not found`)
    }

    const sessionId = newId ?? this.mintId()
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

// ----------------------------------------
// 演示：使用 Session
// ----------------------------------------

let ctx = new Context()
// ctx.plugin() 是异步的，需要 await 等待服务激活
await ctx.plugin(SessionService)

// 监听事件
console.log('\n👂 设置事件监听...')
ctx.on('session/event', (sessionId, event) => {
  console.log(`  [${sessionId}] ${event.type}`)
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

// Step 3: 总结结果
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

// 查看会话统计
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

console.log('\n✅ Part 1 完成！')

// ============================================================
// Part 2: 消息派生 - 从事件生成模型消息
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 2: 消息派生')
console.log('='.repeat(60))

console.log('\n💡 什么是消息派生？')
console.log('Session 存储的是完整的事件流，但 LLM 需要的是消息格式。')
console.log('我们需要将事件流转换为模型可理解的消息数组。')

// 消息类型（OpenAI 格式）
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

// 演示消息派生
console.log('\n🔄 派生消息...')
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
console.log(`  事件数: ${events.length}（包含 turn/step 等元事件）`)
console.log(`  消息数: ${messages.length}（只包含 user/assistant/tool 消息）`)

console.log('\n✅ Part 2 完成！')

// ============================================================
// Part 3: 高级功能 - Fork、重放、审计
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 3: 高级功能')
console.log('='.repeat(60))

// Fork 会话
console.log('\n🍴 Fork 会话演示...')
const forked = ctx.sessions.fork(session.id, 6)
console.log(`  新会话 ID: ${forked.id}`)
console.log(`  新会话事件数: ${forked.events.length}`)

// 重放事件
console.log('\n🔄 事件重放演示...')
console.log('  重放前 6 个事件:')
for (let i = 0; i < Math.min(6, forked.events.length); i++) {
  const event = forked.events[i]
  console.log(`    ${i + 1}. ${event.type}`)
}

// 审计功能
console.log('\n🔍 会话审计...')
console.log(`  会话 ID: ${session.id}`)
console.log(`  创建时间: ${new Date(session.createdAt).toISOString()}`)
console.log(`  最后更新: ${new Date(session.updatedAt).toISOString()}`)
console.log(`  总事件数: ${session.events.length}`)

const userMessages = session.events.filter(e => e.type === 'user/message')
const toolCalls = session.events.filter(e => e.type === 'tool/call')
console.log(`  用户消息: ${userMessages.length}`)
console.log(`  工具调用: ${toolCalls.length}`)

console.log('\n✅ Part 3 完成！')

// ============================================================
// 总结
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('🎊 博客4 完成！')
console.log('='.repeat(60))
console.log('\n📝 核心概念：')
console.log('  1. Session - append-only 事件日志')
console.log('  2. 消息派生 - 事件 → LLM 消息格式')
console.log('  3. Fork - 从任意时间点分叉会话')
console.log('  4. 重放 - 回放历史事件')
console.log('  5. 审计 - 追踪和分析会话')
console.log('\n💡 实际应用：')
console.log('  - 对话历史管理')
console.log('  - A/B 测试（fork 不同路径）')
console.log('  - 调试和审计')
console.log('  - 时间旅行（回到过去某个状态）')
