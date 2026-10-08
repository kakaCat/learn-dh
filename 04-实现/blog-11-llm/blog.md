---
title: "DeepSeek Harness 从 0 开始：LLM 模块（适配器与流式调用）"
description: "基于 Cordis 框架从 0 开始实现简略版 DeepSeek Harness 的第十一篇：LLM 模块——按 dsh 源码实现适配器抽象（LlmAdapter）、适配器注册表（LlmRuntime）、llm/stream 瀑布拦截、SSE 流式解析（OpenAI 兼容）。"
keywords: [Cordis, DeepSeek Harness, LLM, 适配器, LlmAdapter, LlmRuntime, 流式, SSE, OpenAI, llm/stream, TypeScript]
tags: [Cordis, DeepSeek Harness, Agent, LLM, 适配器, 流式, TypeScript]
author: "learn-dh"
date: "2026-08-19"
lang: "zh-CN"
og:
  title: "DeepSeek Harness 从 0 开始：LLM 模块（适配器与流式调用）"
  description: "LlmAdapter 抽象 + LlmRuntime 注册表 + llm/stream 瀑布 + SSE 流式解析——把 Mock LLM 换成真实 API。"
  type: "article"
---

# DeepSeek Harness 从 0 开始：LLM 模块（适配器与流式调用）

> 本系列从 0 开始，基于 Cordis 框架一步步实现一个简略版本的 DeepSeek Harness（loop、session、tool、system prompt 等）。前一篇我们完成了大纲的 Hooks，这一篇解决整个系列一直「模拟」的那块：**LLM 模块**——把 Agent Loop 篇的 Mock LLM 换成**真实可插拔的适配器**，支持真实 API 调用和流式输出。
>
> 配套代码：[blog-11-llm](./)，运行 `pnpm install && pnpm dev` 即可复现本文全部输出（默认用 Mock，设 `OPENAI_API_KEY` 走真实 API）。

## 上一篇留下的问题

回顾整个系列，Agent Loop（blog-07）里的 LLM 一直是 **MockLlm**——硬编码决策的假模型。它展示了循环逻辑，但：

- **模型是写死的**：换个模型（DeepSeek / OpenAI / 本地）要改代码；
- **没有真实调用**：没有 HTTP 请求、没有 API key、没有流式输出；
- **没有扩展点**：想在模型调用前后加日志/缓存/重试，无处下手。

真实 Harness 需要一个**LLM 模块**：**适配器抽象**（换模型不换框架）+ **流式词汇**（token 级增量）+ **瀑布拦截**（调用可包装）。dsh 的 `packages/llm/` 正是这么做的。

> 💡 dsh 的 `packages/llm/` 有：`llm`（核心：LlmAdapter 抽象 + LlmRuntime 注册表）、`llm-deepseek`（DeepSeek 适配器）、`llm-pi-ai`、`llm-retry`（重试策略）、`token-meter`（计量）。本文实现 llm 核心 + 一个 OpenAI 兼容适配器。

## 项目目录结构

```
blog-11-llm/
├── package.json          # 项目配置：依赖、启动脚本
├── pnpm-lock.yaml        # 依赖锁定文件
└── src/
    └── main.ts           # 代码入口，pnpm dev 运行它
```

## 核心概念

| 概念 | 一句话理解 |
| --- | --- |
| **LlmAdapter** | 适配器抽象：把 provider 的 wire 协议翻译成统一流式词汇（`stream()` 唯一必需） |
| **LlmRuntime** | 适配器注册表：`registerAdapter(providers, adapter)`，按 provider 路由 |
| **GenerateOptions** | 一次完整请求：provider + model + messages + system + tools |
| **StreamChunk** | 流式块词汇：block-start / text-delta / tool-call-delta / block-end / finish |
| **llm/stream 瀑布** | 洋葱模型：监听器可包装/拦截任何模型调用 |

## Part 1：类型定义——流式词汇表

```ts
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
```

**流式词汇的关键设计**（dsh: `StreamChunk`）：
- **`text-delta`**：文本增量——模型一个字一个字吐出来，每个 delta 是一条 chunk；
- **`tool-call-delta`**：工具调用增量——`arguments` 是 JSON 字符串**分块到达**的（`argumentsDelta`），要累积拼接；
- **`block-start` / `block-end`**：块的边界——`index` 关联交错到达的多个块；
- **`finish`**：终止——`reason` 告诉调用方为什么停（stop 正常 / tool-calls 要调工具 / max-tokens 超限 / error 出错）。

**适配器唯一要做的**：把 provider 的 HTTP 响应翻译成这个词汇流。**框架、Loop、Session 都不关心你用哪个 provider——只认 StreamChunk。**

## Part 2：LlmAdapter——适配器抽象

```ts
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
```

**dsh 的设计（源码核对）**：`LlmAdapter` 只有一个必需方法 `stream()`，其他（`providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel`）都有默认实现。**换模型 = 换适配器，框架零改动**——这是「接口与实现分离」（依赖注入篇）在 LLM 层的体现。

## Part 3：MockAdapter——教学演示

```ts
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
    await new Promise(resolve => setTimeout(resolve, 20))  // 模拟网络延迟

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

    // 工具调用：按顺序 calculator → weather
    const call = toolResults.length === 1
      ? { id: 'weather-1', name: 'weather', arguments: JSON.stringify({ city: 'Shanghai' }) }
      : { id: 'calc-1', name: 'calculator', arguments: JSON.stringify({ expression: '2 + 2' }) }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...call } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
```

**Mock 的价值**：它产出的**词汇和真实适配器完全一致**（StreamChunk）——所以框架、Loop、演示代码在 Mock 和真实 API 之间切换**零改动**。这就是适配器模式的意义：**先 Mock 开发，后换真实，接口不变。**

## Part 4：OpenAIAdapter——真实 SSE 流式解析

这是「换真适配器」的核心。OpenAI 兼容 API 的流式响应是 **SSE（Server-Sent Events）**——每行 `data: {json}`，最后 `data: [DONE]`：

```ts
/**
 * OpenAI 兼容适配器：真实调用 chat/completions 接口（SSE 流式）。
 * 配置：baseURL + apiKey + model。
 */
class OpenAIAdapter extends LlmAdapter {
  constructor(
    private baseURL: string,
    private apiKey: string,
  ) {
    super()
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
          }
          if (tc.function?.arguments) {
            currentArgs += tc.function.arguments  // arguments 分块累积
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
  }
}
```

**SSE 解析的三个要点**：

1. **按行切分**：`data:` 开头是数据行，`data: [DONE]` 是流结束标记；
2. **文本增量**：`delta.content` 每次到达一小段——逐条产出 `text-delta`；
3. **工具调用参数累积**：`delta.tool_calls[0].function.arguments` **分块到达**（JSON 字符串被切成片段）——必须累积拼接（`currentArgs += ...`），块结束时才是完整 JSON。这正是流式工具调用的难点。

## Part 5：LlmRuntime——适配器注册表 + llm/stream 瀑布

```ts
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
```

**LlmRuntime 的三个职责**：

1. **注册表**：`registerAdapter(providers, adapter)`——provider 路由到适配器（effect 管理生命周期，卸载自动移除，广播 `llm/adapters-updated`）；
2. **路由**：`stream()` 按 `options.provider` 找到适配器，未注册就报错（列出可用 provider，快速定位）；
3. **瀑布**：`stream()` 走 `llm/stream` **waterfall**（洋葱模型）——**这是扩展点**：日志、缓存、重试、限流全挂这里，不动框架。

## Part 6：演示

### 注册适配器

```ts
let ctx = new Context()
await ctx.plugin(LlmRuntime)

// 注册 Mock 适配器（教学，不联网）
ctx.llm.registerAdapter(['mock'], new MockAdapter())
```

### 基础调用（Mock 三步决策）

```ts
// 收集流式块：text-delta 实时打印，tool-call 标记，块和 reason 收集
async function collectStream(stream) {
  const blocks: ContentBlock[] = []
  let reason = 'unknown'
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta': process.stdout.write(chunk.text); break
      case 'tool-call-delta': if (chunk.name) process.stdout.write(`[工具 ${chunk.name} 调用]`); break
      case 'block-end': blocks.push(chunk.block); break
      case 'finish': reason = chunk.reason.kind; break
    }
  }
  return { blocks, reason }
}

// 第 1 次：返回 calculator 工具调用
await collectStream(ctx.llm.stream({
  provider: 'mock', model: 'mock-model',
  messages: [{ role: 'user', content: '帮我计算 2 + 2' }],
}))
```

运行输出：

```
🚀 调用 mock 模型（第 1 次：应返回 calculator 工具调用）:
[工具 calculator 调用]
  块: tool-call (reason: tool-calls)

🚀 调用 mock 模型（带 1 个工具结果：应返回 weather 调用）:
[工具 weather 调用]

🚀 调用 mock 模型（带 2 个工具结果：应输出最终总结）:
最终回答: 4；晴天 25°C
```

**三步决策对应 Agent Loop 的工具循环**（blog-07）：模型第一次要 calculator → 执行 → 结果回填 → 模型要 weather → 执行 → 结果回填 → 模型输出最终文本。**这就是 Loop 篇 `step()` 里 `llm.stream()` 接真实模块后的样子。**

### llm/stream 瀑布拦截

```ts
// 监听 llm/stream：记录调用（洋葱模型——日志/缓存/重试挂这里）
let callCount = 0
ctx.on('llm/stream', async function* (options, next) {
  callCount++
  console.log(`  [拦截] LLM 调用 #${callCount}: provider=${options.provider} model=${options.model}`)
  yield* next()
})
```

运行输出：

```
🚀 再调用一次（被瀑布拦截记录）:
  [拦截] LLM 调用 #1: provider=mock model=mock-model messages=1
  ✅ 共拦截 1 次调用
```

**瀑布的价值**：调用前记录日志、调用后缓存结果、失败重试、限流——全部通过 `llm/stream` 监听器实现，**LlmRuntime 和适配器零改动**。这正是 blog-03 洋葱模型在真实场景的应用。

### OpenAI 适配器（真实 API）

```ts
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? ''
if (OPENAI_KEY) {
  ctx.llm.registerAdapter(['openai'], new OpenAIAdapter('https://api.openai.com/v1', OPENAI_KEY))
  // 真实调用...
} else {
  // 无 key 演示错误路径
  ctx.llm.registerAdapter(['openai'], new OpenAIAdapter('https://api.openai.com/v1', 'invalid-key'))
  // → ❌ 无有效 key 时正确报错: fetch failed
}
```

**设置 `OPENAI_API_KEY` 环境变量**即可走真实 API（默认 `gpt-4o-mini`）；不设则演示错误路径（fetch 失败被正确抛出）。

### 未注册 provider 的错误处理

```
🚀 调用未注册 provider:
  ❌ 正确报错: LLM provider "unknown-provider" is not registered (available: mock, openai)
```

**错误信息带可用列表**——快速定位「写错 provider 名」这类问题。

## 常见问题 FAQ

**Q: LlmAdapter 和 LlmRuntime 什么关系？**

A: 分工明确：**LlmAdapter 是「翻译器」**（把 provider 的 wire 协议翻译成 StreamChunk），**LlmRuntime 是「路由器」**（按 provider 选适配器 + 瀑布拦截）。注册：`ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter())`；调用：`ctx.llm.stream({ provider: 'deepseek', model: '...' })`。**换模型 = 注册不同适配器，框架零改动。**

**Q: 为什么用流式（SSE）而不是一次拿完整响应？**

A: 两个原因：**延迟**——文本增量到达就能显示（首字延迟远小于全量）；**工具调用**——Agent Loop 需要尽早知道「模型要调工具」，流式里 `finish_reason: tool_calls` 一到就能执行，不用等完整 JSON。dsh 的 `assistant/chunk` 事件（Session 篇）记录的正是 token 级流。

**Q: `tool-call-delta` 的 arguments 为什么要累积？**

A: OpenAI 的流式工具调用里，`arguments` 是 JSON 字符串**分块到达**的——比如 `{"expr` + `ession":` + `"2 + 2"}` 三块。必须 `currentArgs += argumentsDelta` 累积拼接，块结束时才是完整 JSON（才能 `JSON.parse`）。这是流式工具调用最常见的坑。

**Q: `llm/stream` 瀑布能做什么？**

A: 洋葱模型，任意监听器可包装：**日志**（记录每次调用）、**缓存**（相同请求返回缓存流）、**重试**（失败重发）、**限流**（控制频率）、**路由**（按需切换 provider）。dsh 的 `llm-retry` 插件就是这么做的。**框架和适配器零改动——挂监听器就行。**

**Q: 和 blog-07 的 MockLlm 什么关系？**

A: MockLlm 是**写死在 Loop 里的假模型**（决策硬编码）；本博客的 MockAdapter 是**实现了 LlmAdapter 接口的假模型**——产出真实的 StreamChunk 词汇。**区别在可替换性**：MockAdapter 能随时换成 OpenAIAdapter，Loop 代码一行不改。

**Q: 适配器里 fetch 失败会怎样？**

A: 直接抛错（`LLM request failed: 401 ...` / `fetch failed`）。真实 dsh 会把失败归一化成 `LlmFailure`（message + code + status），配合 `llm-retry` 策略决定是否重试（dsh: `LlmError`）。我们这里保持简单——抛错，由调用方（Loop）决定怎么处理。

## 小结

1. **LLM = 适配器 + 注册表**：LlmAdapter（翻译 wire 协议）→ LlmRuntime（按 provider 路由）——**换模型不换框架**；
2. **统一流式词汇**：StreamChunk（block-start / text-delta / tool-call-delta / block-end / finish）——Mock 和真实 API 产出相同词汇，可无缝切换；
3. **SSE 流式解析**：`data:` 行切分 + 文本增量 + 工具参数累积拼接——真实 API 接入的核心；
4. **llm/stream 瀑布**：洋葱模型拦截点——日志/缓存/重试/限流全挂监听器，框架零改动；
5. **错误处理**：未注册 provider 报错带可用列表，API 失败正确抛出。

至此，系列把 Mock LLM 换成了真实可插拔的 LLM 模块——**Agent Loop（07）接上真实模型，整套框架可以跑真实任务了**。整个系列 11 篇覆盖了 dsh 的核心：Cordis 基础（01-03）→ Session（04）→ Tools（05）→ Inbox（06）→ Loop（07）→ Compaction（08）→ System Prompt（09）→ Hooks（10）→ **LLM（11）**。

**下一篇（可选）**：Persistence 持久化——把 Session 日志落盘（JSONL/SQLite），重启后恢复，让框架真正可部署。

---

*本文代码已验证可运行（Node.js + tsx，@cordisjs/core v4.0.0-beta.5）。完整源码见同目录 `src/main.ts`，实现结构对应 dsh 的 `packages/llm/llm` 与 `packages/llm/llm-deepseek`。*
