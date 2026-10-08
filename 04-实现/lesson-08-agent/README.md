# 第8课：Agent Loop

## 目标

实现完整的 Agent 执行循环，理解 Turn 和 Step 的关系。

## 运行

```bash
cd lesson-08-agent
pnpm install

# 主程序
pnpm run dev

# 拦截点演示
pnpm run intercept
```

## 核心概念

### Turn 和 Step

- **Turn**: 一次完整的用户交互（可能包含多个 Step）
- **Step**: 一次模型请求 + 工具调用

```
Turn 1
  ├─ Step 1: LLM 回复 + 调用工具
  ├─ Step 2: 看到结果后调用另一个工具
  └─ Step 3: 完成，返回最终响应
```

### 执行流程

```
turn/start
  ↓
agent/pre-step (可拦截)
  ↓
step/start
  ↓
user/message
  ↓
derive messages from session
  ↓
build system prompt + tools
  ↓
agent/request (可拦截)
  ↓
LLM 调用
  ↓
assistant/message
  ↓
tool/call* → tool/result*
  ↓
step/end
  ↓
需要继续？ → 下一个 Step
  ↓
agent/turn-stopping (可拦截)
  ↓
turn/end
```

### 三个拦截点

| 拦截点 | 时机 | 用途 |
|--------|------|------|
| `agent/pre-step` | Step 开始前 | 安全过滤、添加上下文 |
| `agent/request` | LLM 请求前 | 缓存、修改请求 |
| `agent/turn-stopping` | Turn 结束前 | 检查目标、统计 |

## Agent 接口

```typescript
interface Agent {
  sessionId: string
  ctx: Context        // Agent 专用上下文
  currentTurnId?: string
  status: 'idle' | 'running' | 'stopped'
}
```

## 消息派生

从 Session 事件构建模型消息：

```typescript
function deriveMessages(events: SessionEvent[]): Message[] {
  const messages: Message[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        messages.push({ role: 'user', content: event.content })
        break
      case 'tool/call':
        messages.push({ role: 'assistant', content: null, tool_calls: [...] })
        break
      case 'tool/result':
        messages.push({ role: 'tool', tool_call_id: event.id, content: ... })
        break
    }
  }
  return messages
}
```

## 练习

### 练习1：添加新的拦截点

在 `agent/pre-step` 中添加一个监听器，自动添加当前时间。

### 练习2：实现缓存

在 `agent/request` 中实现简单的请求缓存。

### 练习3：限制 Step 数量

在 `agent/turn-stopping` 中检查 Step 数量，超过限制时停止。

## 下一课

[第9课：完整整合](../lesson-09-complete/README.md)

我们将学习：
- 整合所有模块
- 命令行交互
- 实际使用
