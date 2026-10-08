# 第7课：LLM 适配器

## 目标

实现 LLM 接口抽象，学会连接不同的语言模型。

## 运行

```bash
cd lesson-07-llm
pnpm install

# 主程序
pnpm run dev

# 流式输出演示
pnpm run stream
```

## 核心概念

### LLM 接口

```typescript
class LLMService extends Service {
  async chat(request: ChatRequest): Promise<ChatResponse>
}
```

### 消息格式

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCallObject[]
  tool_call_id?: string
}
```

### 工具调用

```typescript
interface ToolCallObject {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON string
  }
}
```

## 适配器实现

### Mock 适配器

用于测试，不需要真实 API：

```typescript
class MockLLMService extends LLMService {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    // 简单规则匹配
    if (request.messages[0].content.includes('echo')) {
      return { content: null, tool_calls: [...] }
    }
    return { content: 'Hello!' }
  }
}
```

### OpenAI 适配器

```typescript
class OpenAILLMService extends LLMService {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: request.messages,
        tools: request.tools,
      }),
    })
    // ...
  }
}
```

### Anthropic 适配器

```typescript
class AnthropicLLMService extends LLMService {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        model: 'claude-3-opus-20240229',
        messages: request.messages,
      }),
    })
    // ...
  }
}
```

## 流式输出

```typescript
async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
  const response = await fetch(..., { stream: true })
  const reader = response.body.getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const chunk = parseChunk(value)
    yield chunk
  }
}
```

## 练习

### 练习1：实现 DeepSeek 适配器

查看 deepseek-harness 源码，实现一个 DeepSeek 适配器。

### 练习2：添加重试逻辑

为 LLM 请求添加自动重试。

### 练习3：添加 Token 计数

统计每次请求使用的 token 数量。

## 下一课

[第8课：Agent Loop](../lesson-08-agent/README.md)

我们将学习：
- Turn / Step 循环
- 消息派生
- 工具调用
