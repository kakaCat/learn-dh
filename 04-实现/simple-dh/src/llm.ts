/**
 * LLM 模块
 *
 * LLM 适配器接口和 Mock 实现
 */

import { Context, Service } from '@cordisjs/core'

// ==================== 类型定义 ====================

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCallObject[]
  tool_call_id?: string
}

export interface ToolCallObject {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ChatRequest {
  messages: Message[]
  tools?: any[]
  temperature?: number
  max_tokens?: number
}

export interface ChatResponse {
  content: string | null
  tool_calls?: ToolCallObject[]
}

// ==================== 扩展 Cordis 类型 ====================

declare module '@cordisjs/core' {
  interface Context {
    llm: LLMService
  }
}

// ==================== LLM Service ====================

export class LLMService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm', true)
  }

  /**
   * 发送聊天请求
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // 这是一个 Mock 实现，实际应用中应该调用真实的 LLM API
    return this.mockChat(request)
  }

  /**
   * Mock 实现（用于测试）
   */
  private async mockChat(request: ChatRequest): Promise<ChatResponse> {
    const lastMessage = request.messages[request.messages.length - 1]

    // 模拟延迟
    await new Promise(resolve => setTimeout(resolve, 100))

    // 简单的规则匹配
    if (lastMessage.role === 'user') {
      const content = lastMessage.content?.toLowerCase() || ''

      // 如果提到 echo，调用 echo 工具
      if (content.includes('echo') && request.tools?.some(t => t.function.name === 'echo')) {
        return {
          content: null,
          tool_calls: [
            {
              id: 'call_' + Math.random().toString(36).slice(2, 11),
              type: 'function',
              function: {
                name: 'echo',
                arguments: JSON.stringify({ text: 'Hello from tool!' }),
              },
            },
          ],
        }
      }

      // 如果提到 add，调用 add 工具
      if (content.includes('add') && request.tools?.some(t => t.function.name === 'add')) {
        return {
          content: null,
          tool_calls: [
            {
              id: 'call_' + Math.random().toString(36).slice(2, 11),
              type: 'function',
              function: {
                name: 'add',
                arguments: JSON.stringify({ a: 10, b: 20 }),
              },
            },
          ],
        }
      }

      // 默认回复
      return {
        content: `I received your message: "${lastMessage.content}"`,
        tool_calls: undefined,
      }
    }

    // 如果是工具结果，总结一下
    if (lastMessage.role === 'tool') {
      return {
        content: `The tool returned: ${lastMessage.content}`,
        tool_calls: undefined,
      }
    }

    // 默认
    return {
      content: 'Hello! How can I help you?',
      tool_calls: undefined,
    }
  }
}

/**
 * 应用插件
 */
export function apply(ctx: Context) {
  ctx.plugin(LLMService)
}
