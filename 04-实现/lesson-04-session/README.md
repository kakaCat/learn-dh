# 第4课：Session 模块

## 目标

实现一个事件日志系统，理解为什么 deepseek-harness 用 append-only 日志记录所有交互。

## 运行

```bash
cd lesson-04-session
pnpm install

# 主程序
pnpm run dev

# 消息派生演示
pnpm run derive
```

## 核心概念

### 为什么是事件日志？

传统的消息存储：
```typescript
// ❌ 直接存储消息
const messages = [
  { role: 'user', content: 'Hi' },
  { role: 'assistant', content: 'Hello' },
]
```

事件日志方式：
```typescript
// ✅ 存储事件
const events = [
  { type: 'user/message', content: 'Hi' },
  { type: 'assistant/message', content: 'Hello' },
]
```

**优势**：
- ✅ 可重放 - 从日志重建任何时刻的状态
- ✅ 可持久化 - 保存后可以恢复
- ✅ 可审计 - 完整记录所有操作
- ✅ 可 Fork - 从某个点分叉新会话

### Session 事件类型

```
turn/start    - 回合开始
turn/end      - 回合结束
step/start    - 步骤开始
step/end      - 步骤结束
user/message  - 用户消息
assistant/message - 助手消息
assistant/chunk   - 流式输出块
tool/call     - 工具调用
tool/result   - 工具结果
```

### 消息派生

从事件日志构建模型可见的消息：

```typescript
function deriveMessages(events: SessionEvent[]): Message[] {
  const messages: Message[] = []

  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        messages.push({ role: 'user', content: event.content })
        break
      case 'assistant/message':
        messages.push({ role: 'assistant', content: event.content })
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

## Session Service API

```typescript
class SessionService extends Service {
  // 创建会话
  create(id?: string): Session

  // 追加事件
  append(sessionId: string, event: SessionEvent): void

  // 获取事件
  getEvents(sessionId: string, fromIndex?: number): SessionEvent[]

  // Fork 会话
  fork(sourceId: string, fromIndex: number, newId?: string): Session
}
```

## 练习

### 练习1：添加新事件类型

添加 `system/message` 事件类型，并在 `deriveMessages` 中处理它。

### 练习2：事件过滤

添加一个方法，只获取某个类型的事件。

### 练习3：会话合并

实现 `merge(sessionId1, sessionId2)` 方法，合并两个会话。

## 下一课

[第5课：Tools 模块](../lesson-05-tools/README.md)

我们将学习：
- 工具注册
- JSON Schema
- 执行管道
