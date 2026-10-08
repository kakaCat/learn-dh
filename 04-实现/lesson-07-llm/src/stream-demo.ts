/**
 * 流式输出演示
 *
 * 展示如何处理流式响应
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('流式输出演示')
console.log('='.repeat(60))

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
}

interface StreamChunk {
  delta: string
  finish_reason?: string
}

// 流式 LLM 接口
class StreamingLLMService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm', true)
  }

  /**
   * 流式聊天
   */
  async *stream(request: { messages: Message[] }): AsyncGenerator<StreamChunk> {
    const lastMessage = request.messages[request.messages.length - 1]
    const content = `I received: "${lastMessage.content}"`

    // 模拟流式输出
    const words = content.split('')
    for (const word of words) {
      await new Promise(resolve => setTimeout(resolve, 10))
      yield { delta: word }
    }

    yield { delta: '', finish_reason: 'stop' }
  }
}

declare module '@cordisjs/core' {
  interface Context {
    llm: StreamingLLMService
  }
}

const ctx = new Context()
ctx.plugin(StreamingLLMService)

console.log('\n📡 流式输出...')
console.log('  ', '─'.repeat(50))

let fullContent = ''
for await (const chunk of ctx.llm.stream({
  messages: [{ role: 'user', content: 'Hello!' }],
})) {
  process.stdout.write(chunk.delta)
  fullContent += chunk.delta
}

console.log('\n  ', '─'.repeat(50))
console.log(`\n完整内容: "${fullContent}"`)

console.log('\n✅ 完成！')
