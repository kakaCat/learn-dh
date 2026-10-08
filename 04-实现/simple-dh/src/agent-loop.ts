/**
 * Agent Loop 模块
 *
 * Turn/Step 循环，消息派生，工具执行
 */

import { Context, Service } from '@cordisjs/core'
import type { Message, ChatResponse } from './llm'
import type { SessionEvent } from './session'
import type { ToolCall } from './tools'

// ==================== 类型定义 ====================

export interface Agent {
  sessionId: string
  ctx: Context
  currentTurnId?: string
  currentStepId?: string
  status: 'idle' | 'running' | 'stopped'
}

// ==================== 扩展 Cordis 类型 ====================

declare module '@cordisjs/core' {
  interface Events {
    'agent/pre-step': (messages: Message[], next: () => Promise<void>) => Promise<void>
    'agent/request': (request: any, next: () => Promise<ChatResponse>) => Promise<ChatResponse>
    'agent/turn-stopping': (agent: Agent) => Promise<void>
  }

  interface Context {
    agentLoop: AgentLoopService
  }
}

// ==================== AgentLoop Service ====================

export class AgentLoopService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentLoop', true)

    // 注册默认请求处理器
    this.setupDefaultHandlers()
  }

  /**
   * 创建新 Agent
   */
  create(sessionId: string): Agent {
    return {
      sessionId,
      ctx: this.ctx.extend(), // 创建子上下文用于作用域隔离
      status: 'idle',
    }
  }

  /**
   * 运行一个 Turn
   */
  async runTurn(agent: Agent, input: string): Promise<void> {
    agent.status = 'running'
    const turnId = this.generateId()
    agent.currentTurnId = turnId

    try {
      // 记录 turn/start
      this.ctx.sessions.append(agent.sessionId, {
        type: 'turn/start',
        turnId,
        timestamp: Date.now(),
      })

      // pre-step 拦截
      const messages: Message[] = [{ role: 'user', content: input }]
      await this.ctx.waterfall('agent/pre-step', messages)

      // 记录 user/message
      this.ctx.sessions.append(agent.sessionId, {
        type: 'user/message',
        content: input,
        timestamp: Date.now(),
      })

      // Step 循环
      let needsContinue = true
      let stepCount = 0
      const MAX_STEPS = 10 // 防止无限循环

      while (needsContinue && stepCount < MAX_STEPS) {
        needsContinue = await this.runStep(agent)
        stepCount++
      }

      // turn-stopping 拦截
      await this.ctx.serial('agent/turn-stopping', agent)
    } finally {
      // 记录 turn/end
      this.ctx.sessions.append(agent.sessionId, {
        type: 'turn/end',
        turnId,
        timestamp: Date.now(),
      })

      agent.status = 'idle'
    }
  }

  /**
   * 运行一个 Step
   */
  private async runStep(agent: Agent): Promise<boolean> {
    const stepId = this.generateId()
    agent.currentStepId = stepId

    // 记录 step/start
    this.ctx.sessions.append(agent.sessionId, {
      type: 'step/start',
      stepId,
      turnId: agent.currentTurnId!,
      timestamp: Date.now(),
    })

    try {
      // 1. 从 session 派生消息
      const events = this.ctx.sessions.getEvents(agent.sessionId)
      const messages = this.deriveMessages(events)

      // 2. 构建 system prompt 和工具
      const systemPrompt = this.ctx.systemPrompt.build()
      const tools = this.ctx.systemPrompt.getToolSchemas()

      // 3. 发送请求（可被拦截）
      const response = await this.ctx.waterfall('agent/request', {
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools,
      })

      // 4. 记录响应
      if (response.content) {
        this.ctx.sessions.append(agent.sessionId, {
          type: 'assistant/message',
          content: response.content,
          timestamp: Date.now(),
        })
      }

      // 5. 处理工具调用
      let hasToolCalls = false
      if (response.tool_calls && response.tool_calls.length > 0) {
        hasToolCalls = true

        for (const toolCall of response.tool_calls) {
          // 记录 tool/call
          this.ctx.sessions.append(agent.sessionId, {
            type: 'tool/call',
            id: toolCall.id,
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments),
            timestamp: Date.now(),
          })

          // 执行工具
          const call: ToolCall = {
            id: toolCall.id,
            name: toolCall.function.name,
            args: JSON.parse(toolCall.function.arguments),
          }

          // 临时存储 session ID（用于 tools 的 post-execute）
          ;(this.ctx as any)._currentSessionId = agent.sessionId

          await this.ctx.tools.execute(call)
        }
      }

      // 记录 step/end
      this.ctx.sessions.append(agent.sessionId, {
        type: 'step/end',
        stepId,
        timestamp: Date.now(),
      })

      return hasToolCalls // 有工具调用就继续
    } catch (error) {
      console.error('Step error:', error)
      return false
    }
  }

  /**
   * 从 Session 事件派生消息
   */
  private deriveMessages(events: SessionEvent[]): Message[] {
    const messages: Message[] = []
    const toolCallsMap = new Map<string, any>() // 临时存储工具调用

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
          // 先存储工具调用
          toolCallsMap.set(event.id, {
            id: event.id,
            type: 'function',
            function: {
              name: event.name,
              arguments: JSON.stringify(event.args),
            },
          })

          // 添加 assistant 消息（带 tool_calls）
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [toolCallsMap.get(event.id)!],
          })
          break

        case 'tool/result':
          // 添加 tool 消息
          messages.push({
            role: 'tool',
            tool_call_id: event.id,
            content: event.error || JSON.stringify(event.result),
          })
          break
      }
    }

    return messages
  }

  /**
   * 设置默认处理器
   */
  private setupDefaultHandlers() {
    // 默认 request 处理器：调用 LLM
    this.ctx.on('agent/request', async (request, next) => {
      if (this.ctx.llm) {
        return await this.ctx.llm.chat(request)
      }
      return await next()
    })
  }

  /**
   * 生成随机 ID
   */
  private generateId(): string {
    return Math.random().toString(36).slice(2, 11)
  }
}

// 声明依赖
AgentLoopService.inject = ['sessions', 'systemPrompt', 'tools', 'llm']

/**
 * 应用插件
 */
export function apply(ctx: Context) {
  ctx.plugin(AgentLoopService)
}
