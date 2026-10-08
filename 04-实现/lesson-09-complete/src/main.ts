/**
 * 第9课：完整整合
 *
 * 把所有模块整合成一个可用的 Agent 系统
 */

import { Context, Service } from '@cordisjs/core'
import * as readline from 'readline'

// ============================================================
// 类型定义
// ============================================================

type SessionEvent =
  | { type: 'turn/start'; turnId: string; timestamp: number }
  | { type: 'turn/end'; turnId: string; timestamp: number }
  | { type: 'step/start'; stepId: string; turnId: string; timestamp: number }
  | { type: 'step/end'; stepId: string; timestamp: number }
  | { type: 'user/message'; content: string; timestamp: number }
  | { type: 'assistant/message'; content: string; timestamp: number }
  | { type: 'tool/call'; id: string; name: string; args: Record<string, unknown>; timestamp: number }
  | { type: 'tool/result'; id: string; result: unknown; error?: string; timestamp: number }

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCallObject[]
  tool_call_id?: string
}

interface ToolCallObject {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface Agent {
  sessionId: string
  ctx: Context
  currentTurnId?: string
  status: 'idle' | 'running' | 'stopped'
}

declare module '@cordisjs/core' {
  interface Events {
    'agent/pre-step': (messages: Message[], next: () => Promise<void>) => Promise<void>
    'agent/request': (request: any, next: () => Promise<any>) => Promise<any>
    'agent/turn-stopping': (agent: Agent) => Promise<void>
    'session/event': (sessionId: string, event: SessionEvent) => void
  }

  interface Context {
    sessions: SessionService
    systemPrompt: SystemPromptService
    tools: ToolsService
    llm: LLMService
    agentLoop: AgentLoopService
  }
}

// ============================================================
// Session Service
// ============================================================

class SessionService extends Service {
  private sessions = new Map<string, { id: string; events: SessionEvent[] }>()

  constructor(ctx: Context) {
    super(ctx, 'sessions', true)
  }

  create(): string {
    const id = Math.random().toString(36).slice(2, 11)
    this.sessions.set(id, { id, events: [] })
    return id
  }

  append(sessionId: string, event: SessionEvent): void {
    const session = this.sessions.get(sessionId)!
    session.events.push(event)
    this.ctx.emit('session/event', sessionId, event)
  }

  getEvents(sessionId: string): SessionEvent[] {
    return this.sessions.get(sessionId)?.events ?? []
  }
}

// ============================================================
// SystemPrompt Service
// ============================================================

class SystemPromptService extends Service {
  private sections = new Map<string, { name: string; content: string; priority: number }>()

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt', true)

    // 添加默认片段
    this.addSection({ name: 'identity', content: 'You are a helpful AI assistant.', priority: 0 })
    this.addSection({ name: 'tools', content: 'You have access to tools.', priority: 20 })
    this.addSection({ name: 'safety', content: 'Always be helpful and honest.', priority: 90 })
  }

  addSection(section: { name: string; content: string; priority: number }) {
    this.sections.set(section.name, section)
  }

  build(): string {
    const sections = Array.from(this.sections.values())
    sections.sort((a, b) => a.priority - b.priority)
    return sections.map(s => s.content).join('\n\n')
  }

  getToolSchemas(): any[] {
    return this.ctx.tools?.getSchemas() ?? []
  }
}

// ============================================================
// Tools Service
// ============================================================

interface Tool {
  description: string
  parameters: any
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

class ToolsService extends Service {
  private tools = new Map<string, Tool>()

  constructor(ctx: Context) {
    super(ctx, 'tools', true)
  }

  register(name: string, tool: Tool) {
    this.tools.set(name, tool)
  }

  getSchemas(): any[] {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      type: 'function',
      function: { name, description: tool.description, parameters: tool.parameters },
    }))
  }

  async execute(call: { id: string; name: string; args: Record<string, unknown> }) {
    const tool = this.tools.get(call.name)
    if (!tool) return { id: call.id, error: 'Tool not found' }
    try {
      const result = await tool.execute(call.args)
      return { id: call.id, result }
    } catch (error: any) {
      return { id: call.id, error: error.message }
    }
  }
}

// ============================================================
// LLM Service
// ============================================================

class LLMService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm', true)
  }

  async chat(request: { messages: Message[]; tools?: any[] }): Promise<{ content: string | null; tool_calls?: ToolCallObject[] }> {
    const lastMessage = request.messages[request.messages.length - 1]
    const content = lastMessage.content?.toLowerCase() || ''

    // 简单的工具调用规则
    if (content.includes('echo') && request.tools?.some(t => t.function.name === 'echo')) {
      return {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'echo', arguments: JSON.stringify({ text: 'Hello from tool!' }) },
        }],
      }
    }

    if (content.includes('add') && request.tools?.some(t => t.function.name === 'add')) {
      return {
        content: null,
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'add', arguments: JSON.stringify({ a: 10, b: 20 }) },
        }],
      }
    }

    if (lastMessage.role === 'tool') {
      return { content: `Tool returned: ${lastMessage.content}` }
    }

    return { content: `I received: "${lastMessage.content}"` }
  }
}

// ============================================================
// AgentLoop Service
// ============================================================

class AgentLoopService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentLoop', true)
    this.setupDefaultHandlers()
  }

  create(sessionId: string): Agent {
    return { sessionId, ctx: this.ctx.extend(), status: 'idle' }
  }

  async runTurn(agent: Agent, input: string): Promise<void> {
    agent.status = 'running'
    const turnId = Math.random().toString(36).slice(2, 11)
    agent.currentTurnId = turnId

    try {
      this.ctx.sessions.append(agent.sessionId, { type: 'turn/start', turnId, timestamp: Date.now() })

      const messages: Message[] = [{ role: 'user', content: input }]
      await this.ctx.waterfall('agent/pre-step', messages)

      this.ctx.sessions.append(agent.sessionId, { type: 'user/message', content: input, timestamp: Date.now() })

      let needsContinue = true
      let stepCount = 0
      while (needsContinue && stepCount < 10) {
        needsContinue = await this.runStep(agent)
        stepCount++
      }

      await this.ctx.serial('agent/turn-stopping', agent)
    } finally {
      this.ctx.sessions.append(agent.sessionId, { type: 'turn/end', turnId, timestamp: Date.now() })
      agent.status = 'idle'
    }
  }

  private async runStep(agent: Agent): Promise<boolean> {
    const stepId = Math.random().toString(36).slice(2, 11)
    this.ctx.sessions.append(agent.sessionId, { type: 'step/start', stepId, turnId: agent.currentTurnId!, timestamp: Date.now() })

    const events = this.ctx.sessions.getEvents(agent.sessionId)
    const messages = this.deriveMessages(events)
    const systemPrompt = this.ctx.systemPrompt.build()
    const tools = this.ctx.systemPrompt.getToolSchemas()

    const response = await this.ctx.waterfall('agent/request', {
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools,
    })

    if (response.content) {
      this.ctx.sessions.append(agent.sessionId, { type: 'assistant/message', content: response.content, timestamp: Date.now() })
    }

    let hasToolCalls = false
    if (response.tool_calls?.length) {
      hasToolCalls = true
      for (const toolCall of response.tool_calls) {
        this.ctx.sessions.append(agent.sessionId, {
          type: 'tool/call',
          id: toolCall.id,
          name: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments),
          timestamp: Date.now(),
        })

        const result = await this.ctx.tools.execute({
          id: toolCall.id,
          name: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments),
        })

        this.ctx.sessions.append(agent.sessionId, {
          type: 'tool/result',
          id: result.id,
          result: result.result,
          error: result.error,
          timestamp: Date.now(),
        })
      }
    }

    this.ctx.sessions.append(agent.sessionId, { type: 'step/end', stepId, timestamp: Date.now() })
    return hasToolCalls
  }

  private deriveMessages(events: SessionEvent[]): Message[] {
    const messages: Message[] = []
    for (const event of events) {
      if (event.type === 'user/message') {
        messages.push({ role: 'user', content: event.content })
      } else if (event.type === 'assistant/message') {
        messages.push({ role: 'assistant', content: event.content })
      } else if (event.type === 'tool/call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: event.id, type: 'function', function: { name: event.name, arguments: JSON.stringify(event.args) } }],
        })
      } else if (event.type === 'tool/result') {
        messages.push({ role: 'tool', tool_call_id: event.id, content: event.error ?? JSON.stringify(event.result) })
      }
    }
    return messages
  }

  private setupDefaultHandlers() {
    this.ctx.on('agent/request', async (request, next) => {
      return await this.ctx.llm.chat(request)
    })
  }
}

AgentLoopService.inject = ['sessions', 'systemPrompt', 'tools', 'llm']

// ============================================================
// 主程序
// ============================================================

console.log('='.repeat(60))
console.log('第9课：完整整合')
console.log('='.repeat(60))

const ctx = new Context()

// 注册所有服务
console.log('\n📦 初始化服务...')
ctx.plugin(SessionService)
ctx.plugin(SystemPromptService)
ctx.plugin(ToolsService)
ctx.plugin(LLMService)
ctx.plugin(AgentLoopService)

// 注册工具
console.log('\n🔧 注册工具...')
ctx.tools.register('echo', {
  description: 'Echo back the input text',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(args) { return `Echo: ${args.text}` },
})

ctx.tools.register('add', {
  description: 'Add two numbers',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  async execute(args) { return (args.a as number) + (args.b as number) },
})

// 监听事件
console.log('\n👂 设置事件监听...')
ctx.on('session/event', (sessionId, event) => {
  const icons: Record<string, string> = {
    'turn/start': '🔄',
    'turn/end': '✅',
    'step/start': '▶️',
    'step/end': '⏹️',
    'user/message': '👤',
    'assistant/message': '🤖',
    'tool/call': '🔧',
    'tool/result': '📦',
  }
  console.log(`  ${icons[event.type] ?? '📄'} ${event.type}`)
})

// 创建会话
console.log('\n🎯 创建会话...')
const sessionId = ctx.sessions.create()
const agent = ctx.agentLoop.create(sessionId)

// 测试对话
console.log('\n' + '='.repeat(60))
console.log('测试1: 普通对话')
console.log('='.repeat(60))
await ctx.agentLoop.runTurn(agent, 'Hello!')

console.log('\n' + '='.repeat(60))
console.log('测试2: 工具调用 - echo')
console.log('='.repeat(60))
await ctx.agentLoop.runTurn(agent, 'Can you echo something?')

console.log('\n' + '='.repeat(60))
console.log('测试3: 工具调用 - add')
console.log('='.repeat(60))
await ctx.agentLoop.runTurn(agent, 'Can you add some numbers?')

// 打印统计
console.log('\n' + '='.repeat(60))
console.log('会话统计')
console.log('='.repeat(60))

const events = ctx.sessions.getEvents(sessionId)
console.log(`总事件数: ${events.length}`)

const eventTypes = events.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] || 0) + 1
  return acc
}, {} as Record<string, number>)

for (const [type, count] of Object.entries(eventTypes)) {
  console.log(`  ${type}: ${count}`)
}

console.log('\n✅ 完成！')
