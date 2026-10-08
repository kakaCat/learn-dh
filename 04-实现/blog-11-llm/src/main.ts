/**
 * 博客11：LLM 模块 - 适配器与流式调用
 *
 * 按 dsh 源码（packages/llm/llm/*）结构实现：
 * - LlmAdapter: 抽象适配器（唯一必需方法 stream()）
 * - MockAdapter: 教学演示用（不联网）
 * - OpenAIAdapter: 真实 OpenAI 兼容 API（fetch + SSE 流式）
 * - LlmRuntime: 适配器注册表 + llm/stream 瀑布
 * - BlockAssembler: 流式块组装（text / tool-call / finish）
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 1. 类型定义（dsh: llm/src/types.ts）
// ============================================================

// 消息（OpenAI 风格，复用前几篇的 Message）
interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

// 工具 schema（blog-05 讲过，发给模型的 tools 字段）
interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// 一次模型请求，完全组装好（dsh: GenerateOptions）
interface GenerateOptions {
  provider: string       // 路由：选择适配器
  model: string
  messages: Message[]    // 对话消息
  system?: string        // system prompt
  tools?: ToolSchema[]   // 工具 schema
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

// 内容块（dsh: ContentBlock）
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

// 流式块（dsh: StreamChunk）——适配器发出的原始流
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' | 'error'; message?: string } }

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Events {
    // llm/stream 瀑布：监听器可以包装/拦截模型调用（洋葱模型）
    'llm/stream': (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
  }

  interface Context {
    llm: LlmRuntime
  }
}

// ============================================================
// 2. LlmAdapter：抽象适配器（dsh: LlmAdapter）
// ============================================================

/**
 * 适配器基类：把「provider 的 wire 协议」翻译成 dsh 的流式词汇。
 * 唯一必需方法是 stream()——其他都有默认实现。
 */
abstract class LlmAdapter {
  /** 描述这个适配器拥有的路由（dsh: providerInfo） */
  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  /**
   * 流式调用一次模型（唯一必需方法，dsh: stream）
   * 适配器负责：发 HTTP 请求 → 解析 SSE → 产出 StreamChunk
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

// ============================================================
// 3. MockAdapter：教学演示（不联网）
// ============================================================

/**
 * Mock 适配器：根据消息历史模拟模型流式输出。
 * 三步决策：先调 calculator → 再调 weather → 最后总结。
 * （和 blog-07 的 MockLlm 类似，但产出的 StreamChunk 词汇）
 */
class MockAdapter extends LlmAdapter {
  providerInfo(provider: string) {
    return { id: provider, name: 'Mock Adapter (教学)' }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 模拟网络延迟
    await new Promise(resolve => setTimeout(resolve, 20))

    const toolResults = options.messages.filter(m => m.role === 'tool')

    if (toolResults.length >= 2) {
      // 两个工具结果都回来了：输出最终总结
      const calc = toolResults[0]?.content
      const weather = toolResults[1]?.content
      const text = `最终回答: ${calc}；${weather}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (toolResults.length === 1) {
      // 有 calculator 结果：再调 weather
      const call = { id: 'weather-1', name: 'weather', arguments: JSON.stringify({ city: 'Shanghai' }) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...call } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    // 初始：先调 calculator
    const call = { id: 'calc-1', name: 'calculator', arguments: JSON.stringify({ expression: '2 + 2' }) }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...call } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

// ============================================================
// 4. OpenAIAdapter：真实 OpenAI 兼容 API（dsh: llm-deepseek 等）
// ============================================================

/**
 * OpenAI 兼容适配器：真实调用 chat/completions 接口（SSE 流式）。
 * 配置：baseURL + apiKey + model。
 * 注意：这是真实网络请求，没有 API key 时会失败——演示用 MockAdapter。
 */
class OpenAIAdapter extends LlmAdapter {
  constructor(
    private baseURL: string,
    private apiKey: string,
  ) {
    super()
  }

  providerInfo(provider: string) {
    return { id: provider, name: `OpenAI Compatible (${this.baseURL})` }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ① 组装 OpenAI 格式的请求体
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [
        ...(options.system ? [{ role: 'system', content: options.system }] : []),
        ...options.messages,
      ],
      stream: true,  // SSE 流式
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.tools !== undefined) body.tools = options.tools

    // ② 发请求（带 AbortSignal 支持取消）
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 200)}`)
    }

    // ③ 解析 SSE 流：data: {...} 行，逐块产出
    // SSE 格式：每块是 "data: {json}\n\n"，结束是 "data: [DONE]"
    let index = 0
    let currentBlock: { type: string; id?: string; name?: string } | null = null
    let currentText = ''
    let currentArgs = ''

    if (!response.body) throw new Error('no response body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 按行切分 SSE
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)

        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') break

        let parsed: any
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        const delta = parsed.choices?.[0]?.delta ?? {}
        const finishReason = parsed.choices?.[0]?.finish_reason

        // 文本增量
        if (delta.content) {
          if (!currentBlock || currentBlock.type !== 'text') {
            if (currentBlock) {
              // 关闭上一个块
              yield { type: 'block-end', index, block: this.finishBlock(currentBlock, currentText, currentArgs) }
              index++
            }
            currentBlock = { type: 'text' }
            currentText = ''
            yield { type: 'block-start', index, blockType: 'text' }
          }
          currentText += delta.content
          yield { type: 'text-delta', index, text: delta.content }
        }

        // 工具调用增量（arguments 分块到达）
        if (delta.tool_calls?.[0]) {
          const tc = delta.tool_calls[0]
          if (!currentBlock || currentBlock.type !== 'tool-call') {
            if (currentBlock) {
              yield { type: 'block-end', index, block: this.finishBlock(currentBlock, currentText, currentArgs) }
              index++
            }
            currentBlock = { type: 'tool-call', id: tc.id, name: tc.function?.name }
            currentArgs = ''
            yield { type: 'block-start', index, blockType: 'tool-call' }
            if (tc.function?.name) {
              yield { type: 'tool-call-delta', index, id: tc.id, name: tc.function.name, argumentsDelta: '' }
            }
          }
          if (tc.function?.arguments) {
            currentArgs += tc.function.arguments
            yield { type: 'tool-call-delta', index, id: tc.id, argumentsDelta: tc.function.arguments }
          }
        }

        // 结束
        if (finishReason) {
          const reason = finishReason === 'tool_calls' ? 'tool-calls'
            : finishReason === 'length' ? 'max-tokens' : 'stop'
          if (currentBlock) {
            yield { type: 'block-end', index, block: this.finishBlock(currentBlock, currentText, currentArgs) }
            index++
          }
          yield { type: 'finish', reason: { kind: reason } }
          currentBlock = null
        }
      }
    }

    // 流结束但块未闭合（异常情况）
    if (currentBlock) {
      yield { type: 'block-end', index, block: this.finishBlock(currentBlock, currentText, currentArgs) }
    }
  }

  /** 把累积的块数据组装成最终 ContentBlock */
  private finishBlock(block: { type: string; id?: string; name?: string }, text: string, args: string): ContentBlock {
    if (block.type === 'tool-call') {
      return { type: 'tool-call', id: block.id ?? '', name: block.name ?? '', arguments: args }
    }
    return { type: 'text', text }
  }
}

// ============================================================
// 5. LlmRuntime：适配器注册表 + llm/stream 瀑布（dsh: LlmRuntime）
// ============================================================

class LlmRuntime extends Service {
  private adapters = new Map<string, LlmAdapter>()  // provider → adapter

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * 注册适配器（dsh: registerAdapter）
   * 一个适配器可以拥有多个 provider 路由；effect 管理生命周期
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): () => void {
    return this.ctx.effect(() => {
      for (const provider of providers) {
        if (this.adapters.has(provider)) {
          throw new Error(`LLM provider "${provider}" is already registered`)
        }
        this.adapters.set(provider, adapter)
      }
      this.ctx.emit('llm/adapters-updated')
      return () => {
        for (const provider of providers) {
          this.adapters.delete(provider)
        }
        this.ctx.emit('llm/adapters-updated')
      }
    })
  }

  /** 列出所有已注册的 provider */
  listProviders(): string[] {
    return [...this.adapters.keys()]
  }

  /**
   * 流式调用（dsh: stream）
   * 走 llm/stream 瀑布（洋葱模型）——监听器可以包装/拦截
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(
      'llm/stream', options,
      () => this.adapterStream(options),
    )
  }

  /** 选择适配器并调用（dsh: adapterStream） */
  private adapterStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const adapter = this.adapters.get(options.provider)
    if (!adapter) {
      throw new Error(`LLM provider "${options.provider}" is not registered (available: ${this.listProviders().join(', ')})`)
    }
    return adapter.stream(options)
  }
}

// ============================================================
// 6. 演示
// ============================================================

console.log('='.repeat(60))
console.log('博客11：LLM 模块 - 适配器与流式调用')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(LlmRuntime)

// 注册 Mock 适配器（教学，不联网）
ctx.llm.registerAdapter(['mock'], new MockAdapter())
console.log('\n📦 已注册适配器:')
for (const provider of ctx.llm.listProviders()) {
  const info = (ctx.llm as any).adapters.get(provider).providerInfo(provider)
  console.log(`  - ${provider}: ${info.name}`)
}

// ---- Part 1: 基础调用（Mock）----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 基础调用（Mock 适配器）')
console.log('='.repeat(60))

// 收集流式块的辅助函数
async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<{ blocks: ContentBlock[]; reason: string }> {
  const blocks: ContentBlock[] = []
  let reason = 'unknown'
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'block-start': break
      case 'text-delta': process.stdout.write(chunk.text); break
      case 'tool-call-delta':
        if (chunk.name) process.stdout.write(`[工具 ${chunk.name} 调用]`)
        break
      case 'block-end': blocks.push(chunk.block); break
      case 'finish': reason = chunk.reason.kind; break
    }
  }
  return { blocks, reason }
}

console.log('\n🚀 调用 mock 模型（第 1 次：应返回 calculator 工具调用）:')
const r1 = await collectStream(ctx.llm.stream({
  provider: 'mock',
  model: 'mock-model',
  messages: [{ role: 'user', content: '帮我计算 2 + 2' }],
}))
console.log(`\n  块: ${r1.blocks.map(b => b.type).join(', ')} (reason: ${r1.reason})`)

console.log('\n🚀 调用 mock 模型（带 1 个工具结果：应返回 weather 调用）:')
await collectStream(ctx.llm.stream({
  provider: 'mock',
  model: 'mock-model',
  messages: [
    { role: 'user', content: '帮我计算 2 + 2' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'calc-1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2 + 2"}' } }] },
    { role: 'tool', tool_call_id: 'calc-1', content: '4' },
  ],
}))

console.log('\n🚀 调用 mock 模型（带 2 个工具结果：应输出最终总结）:')
await collectStream(ctx.llm.stream({
  provider: 'mock',
  model: 'mock-model',
  messages: [
    { role: 'user', content: '帮我计算 2 + 2 然后查天气' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'calc-1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2 + 2"}' } }] },
    { role: 'tool', tool_call_id: 'calc-1', content: '4' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'weather-1', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } }] },
    { role: 'tool', tool_call_id: 'weather-1', content: '晴天 25°C' },
  ],
}))
console.log()

// ---- Part 2: 工具 schema 传递 ----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 工具 schema 传递')
console.log('='.repeat(60))

console.log('\n📋 组装 tools 字段（发给模型的工具 schema）:')
const tools: ToolSchema[] = [
  { name: 'calculator', description: 'Add two numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
]
for (const tool of tools) {
  console.log(`  - ${tool.name}: ${tool.description}`)
}
console.log('\n（这些 tools 会随请求发给模型——OpenAI 的 tools 字段，blog-05 FAQ 讲过）')

// ---- Part 3: llm/stream 瀑布（洋葱模型拦截）----
console.log('\n' + '='.repeat(60))
console.log('Part 3: llm/stream 瀑布（洋葱模型拦截）')
console.log('='.repeat(60))

// 监听 llm/stream：记录调用 + 统计
let callCount = 0
ctx.on('llm/stream', async function* (options, next) {
  callCount++
  console.log(`  [拦截] LLM 调用 #${callCount}: provider=${options.provider} model=${options.model} messages=${options.messages.length}`)
  yield* next()
})

console.log('\n🚀 再调用一次（被瀑布拦截记录）:')
await collectStream(ctx.llm.stream({
  provider: 'mock',
  model: 'mock-model',
  messages: [{ role: 'user', content: 'hi' }],
}))
console.log(`\n  ✅ 共拦截 ${callCount} 次调用`)

// ---- Part 4: OpenAI 适配器（真实 API，无 key 时演示错误处理）----
console.log('\n' + '='.repeat(60))
console.log('Part 4: OpenAI 适配器（真实 API）')
console.log('='.repeat(60))

// 注册 OpenAI 兼容适配器（用环境变量；没有就演示错误路径）
const OPENAI_BASE = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? ''
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

if (OPENAI_KEY) {
  ctx.llm.registerAdapter(['openai'], new OpenAIAdapter(OPENAI_BASE, OPENAI_KEY))
  console.log(`\n🚀 调用真实 OpenAI（${OPENAI_MODEL}）:`)
  try {
    const r = await collectStream(ctx.llm.stream({
      provider: 'openai',
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: 'Say hello in one word' }],
      maxTokens: 20,
    }))
    console.log(`\n  ✅ 完成 (reason: ${r.reason})`)
  } catch (error: any) {
    console.log(`  ❌ 调用失败: ${error.message.slice(0, 120)}`)
  }
} else {
  console.log('\n⚠️  未设置 OPENAI_API_KEY，演示错误路径:')
  ctx.llm.registerAdapter(['openai'], new OpenAIAdapter(OPENAI_BASE, 'invalid-key'))
  try {
    await collectStream(ctx.llm.stream({
      provider: 'openai',
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    }))
  } catch (error: any) {
    console.log(`  ❌ 无有效 key 时正确报错: ${error.message.slice(0, 100)}`)
  }
}

// ---- Part 5: 未注册 provider 的错误处理 ----
console.log('\n' + '='.repeat(60))
console.log('Part 5: 未注册 provider 的错误处理')
console.log('='.repeat(60))

try {
  await collectStream(ctx.llm.stream({
    provider: 'unknown-provider',
    model: 'x',
    messages: [{ role: 'user', content: 'hi' }],
  }))
} catch (error: any) {
  console.log(`  ❌ 正确报错: ${error.message}`)
}

console.log('\n✅ 博客11 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. LlmAdapter - 抽象适配器，stream() 唯一必需（llm/src/index.ts）')
console.log('  2. LlmRuntime - 适配器注册表 + llm/stream 瀑布（llm/src/index.ts）')
console.log('  3. StreamChunk - 流式块词汇（llm/src/types.ts）')
console.log('  4. OpenAIAdapter - 真实 SSE 流式解析（llm-deepseek 等适配器）')
console.log('  5. GenerateOptions - 完整请求（provider/model/messages/system/tools）')
