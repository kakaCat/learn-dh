/**
 * 第8课：Agent Loop
 *
 * 实现完整的 Agent 执行循环
 */

import { Context, Service } from '@cordisjs/core'

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

interface ChatRequest {
  messages: Message[]
  tools?: any[]
}

interface ChatResponse {
  content: string | null
  tool_calls?: ToolCallObject[]
}

interface Agent {
  sessionId: string
  ctx: Context
  currentTurnId?: string
  status: 'idle' | 'running' | 'stopped'
}

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Events {
    'agent/pre-step': (messages: Message[], next: () => Promise<void>) => Promise<void>
    'agent/request': (request: ChatRequest, next: () => Promise<ChatResponse>) => Promise<ChatResponse>
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
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt', true)
  }

  build(): string {
    return 'You are a helpful AI assistant.'
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

  async execute(call: { id: string; name: string; args: Record<string, unknown> }): Promise<{ id: string; result?: unknown; error?: string }> {
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

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const lastMessage = request.messages[request.messages.length - 1]
    const content = lastMessage.content?.toLowerCase() || ''

    // 模拟工具调用
    if (content.includes('echo') && request.tools?.some(t => t.function.name === 'echo')) {
      return {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'echo', arguments: JSON.stringify({ text: 'Hello!' }) },
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
    return {
      sessionId,
      ctx: this.ctx.extend(),
      status: 'idle',
    }
  }

  async runTurn(agent: Agent, input: string): Promise<void> {
    agent.status = 'running'
    const turnId = Math.random().toString(36).slice(2, 11)
    agent.currentTurnId = turnId

    try {
      // turn/start
      this.ctx.sessions.append(agent.sessionId, {
        type: 'turn/start', turnId, timestamp: Date.now(),
      })

      // pre-step
      const messages: Message[] = [{ role: 'user', content: input }]
      await this.ctx.waterfall('agent/pre-step', messages)

      // user/message
      this.ctx.sessions.append(agent.sessionId, {
        type: 'user/message', content: input, timestamp: Date.now(),
      })

      // Step 循环
      let needsContinue = true
      let stepCount = 0
      const MAX_STEPS = 10

      while (needsContinue && stepCount < MAX_STEPS) {
        needsContinue = await this.runStep(agent)
        stepCount++
      }

      // turn-stopping
      await this.ctx.serial('agent/turn-stopping', agent)

    } finally {
      // turn/end
      this.ctx.sessions.append(agent.sessionId, {
        type: 'turn/end', turnId, timestamp: Date.now(),
      })
      agent.status = 'idle'
    }
  }

  private async runStep(agent: Agent): Promise<boolean> {
    const stepId = Math.random().toString(36).slice(2, 11)

    // step/start
    this.ctx.sessions.append(agent.sessionId, {
      type: 'step/start', stepId, turnId: agent.currentTurnId!, timestamp: Date.now(),
    })

    // 从 session 派生消息
    const events = this.ctx.sessions.getEvents(agent.sessionId)
    const messages = this.deriveMessages(events)

    // 构建 prompt 和工具
    const systemPrompt = this.ctx.systemPrompt.build()
    const tools = this.ctx.systemPrompt.getToolSchemas()

    // 发送请求
    const response = await this.ctx.waterfall('agent/request', {
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools,
    })

    // 记录响应
    if (response.content) {
      this.ctx.sessions.append(agent.sessionId, {
        type: 'assistant/message', content: response.content, timestamp: Date.now(),
      })
    }

    // 处理工具调用
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

    // step/end
    this.ctx.sessions.append(agent.sessionId, {
      type: 'step/end', stepId, timestamp: Date.now(),
    })

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
          tool_calls: [{
            id: event.id,
            type: 'function',
            function: { name: event.name, arguments: JSON.stringify(event.args) },
          }],
        })
      } else if (event.type === 'tool/result') {
        messages.push({
          role: 'tool',
          tool_call_id: event.id,
          content: event.error ?? JSON.stringify(event.result),
        })
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
console.log('第8课：Agent Loop')
console.log('='.repeat(60))

const ctx = new Context()

// 注册服务
console.log('\n📦 注册服务...')
ctx.plugin(SessionService)
ctx.plugin(SystemPromptService)
ctx.plugin(ToolsService)
ctx.plugin(LLMService)
ctx.plugin(AgentLoopService)

// 注册工具
console.log('\n🔧 注册工具...')
ctx.tools.register('echo', {
  description: 'Echo text',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  async execute(args) { return `Echo: ${args.text}` },
})

// 监听事件
console.log('\n👂 监听事件...')
ctx.on('session/event', (sessionId, event) => {
  console.log(`  [${event.type}]`)
})

// 创建会话和 Agent
console.log('\n🎯 创建 Agent...')
const sessionId = ctx.sessions.create()
const agent = ctx.agentLoop.create(sessionId)

// 测试1: 普通对话
console.log('\n' + '='.repeat(60))
console.log('测试1: 普通对话')
console.log('='.repeat(60))
await ctx.agentLoop.runTurn(agent, 'Hello!')

// 测试2: 工具调用
console.log('\n' + '='.repeat(60))
console.log('测试2: 工具调用')
console.log('='.repeat(60))
await ctx.agentLoop.runTurn(agent, 'Can you echo something?')

console.log('\n✅ 完成！')
