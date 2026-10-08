/**
 * 第7课：LLM 适配器
 *
 * 实现 LLM 接口抽象和 Mock 适配器
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 类型定义
// ============================================================

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCallObject[]
  tool_call_id?: string
}

interface ToolCallObject {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface ChatRequest {
  messages: Message[]
  tools?: any[]
  temperature?: number
  max_tokens?: number
}

interface ChatResponse {
  content: string | null
  tool_calls?: ToolCallObject[]
}

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Context {
    llm: LLMService
  }
}

// ============================================================
// LLM Service 接口
// ============================================================

class LLMService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm', true)
  }

  /**
   * 发送聊天请求
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    throw new Error('Not implemented')
  }
}

// ============================================================
// Mock LLM 实现
// ============================================================

class MockLLMService extends LLMService {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    console.log('  🤖 Mock LLM 收到请求')
    console.log(`     消息数: ${request.messages.length}`)
    console.log(`     工具数: ${request.tools?.length ?? 0}`)

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
        content: `I received: "${lastMessage.content}"`,
        tool_calls: undefined,
      }
    }

    // 如果是工具结果，总结一下
    if (lastMessage.role === 'tool') {
      return {
        content: `Tool returned: ${lastMessage.content}`,
        tool_calls: undefined,
      }
    }

    return {
      content: 'Hello! How can I help you?',
      tool_calls: undefined,
    }
  }
}

// ============================================================
// OpenAI LLM 实现（示例，需要真实 API key）
// ============================================================

class OpenAILLMService extends LLMService {
  private apiKey: string
  private baseUrl = 'https://api.openai.com/v1'

  constructor(ctx: Context, apiKey: string) {
    super(ctx)
    this.apiKey = apiKey
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    console.log('  🤖 OpenAI LLM 发送请求...')

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.max_tokens ?? 1000,
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`)
    }

    const data = await response.json()
    const choice = data.choices[0]

    return {
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    }
  }
}

// ============================================================
// 主程序
// ============================================================

console.log('='.repeat(60))
console.log('第7课：LLM 适配器')
console.log('='.repeat(60))

const ctx = new Context()

// 使用 Mock LLM
console.log('\n🤖 使用 Mock LLM...')
ctx.plugin(MockLLMService)

// 测试请求
console.log('\n📤 发送请求...')

const response1 = await ctx.llm.chat({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
})
console.log(`  回复: ${response1.content}`)

const response2 = await ctx.llm.chat({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Can you echo something?' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'echo',
        description: 'Echo text',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
})
console.log(`  工具调用: ${response2.tool_calls?.[0]?.function.name}`)

console.log('\n✅ 完成！')
console.log('\n💡 提示: 要使用真实的 OpenAI，设置环境变量 OPENAI_API_KEY')
