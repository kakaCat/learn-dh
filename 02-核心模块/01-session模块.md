# Session 模块

## 核心概念

Session 是 **append-only 的事件日志**，记录用户和 Agent 的所有交互。

### 为什么是事件日志？

- ✅ **可重放** - 从日志重建任何时刻的状态
- ✅ **可持久化** - 保存后可以恢复
- ✅ **可审计** - 完整记录所有操作
- ✅ **可 Fork** - 从某个点分叉新会话

## Session Event 类型

### Turn 级别事件

一个 Turn 是一次完整的交互（可能包含多个 Step）：

```typescript
interface TurnStartEvent {
  type: 'turn/start'
  turnId: string
  timestamp: number
}

interface TurnEndEvent {
  type: 'turn/end'
  turnId: string
  timestamp: number
}
```

### Step 级别事件

一个 Step 是一次模型请求 + 工具调用：

```typescript
interface StepStartEvent {
  type: 'step/start'
  stepId: string
  turnId: string
  timestamp: number
}

interface StepEndEvent {
  type: 'step/end'
  stepId: string
  timestamp: number
}
```

### 消息事件

```typescript
// 用户消息
interface UserMessageEvent {
  type: 'user/message'
  content: string
  timestamp: number
}

// 助手消息
interface AssistantMessageEvent {
  type: 'assistant/message'
  content: string
  timestamp: number
}

// 流式输出块
interface AssistantChunkEvent {
  type: 'assistant/chunk'
  delta: string
  timestamp: number
}
```

### 工具调用事件

```typescript
// 工具调用
interface ToolCallEvent {
  type: 'tool/call'
  id: string
  name: string
  args: Record<string, unknown>
  timestamp: number
}

// 工具结果
interface ToolResultEvent {
  type: 'tool/result'
  id: string
  result: unknown
  error?: string
  timestamp: number
}
```

### 联合类型

```typescript
type SessionEvent = 
  | TurnStartEvent
  | TurnEndEvent
  | StepStartEvent
  | StepEndEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | AssistantChunkEvent
  | ToolCallEvent
  | ToolResultEvent
```

## Session Service 接口

```typescript
interface Session {
  id: string
  events: SessionEvent[]
  createdAt: number
  updatedAt: number
}

class SessionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
  
  // 创建新会话
  create(id?: string): Session
  
  // 获取会话
  get(id: string): Session | undefined
  
  // 追加事件
  append(sessionId: string, event: SessionEvent): void
  
  // 获取事件
  getEvents(sessionId: string, fromIndex?: number): SessionEvent[]
  
  // Fork 会话
  fork(sourceId: string, fromIndex: number, newId?: string): Session
  
  // 删除会话
  delete(sessionId: string): void
}
```

## 实现要点

### 1. 内存存储

最简单的实现：

```typescript
class SessionService extends Service {
  private sessions: Map<string, Session> = new Map()
  
  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }
  
  create(id = generateId()): Session {
    const session: Session = {
      id,
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.sessions.set(id, session)
    return session
  }
  
  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }
  
  append(sessionId: string, event: SessionEvent): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }
    
    session.events.push(event)
    session.updatedAt = Date.now()
    
    // 广播事件
    this.ctx.emit('session/event', sessionId, event)
  }
}
```

### 2. 事件广播

追加事件后需要广播：

```typescript
append(sessionId: string, event: SessionEvent): void {
  // ... 追加逻辑
  
  // 广播给所有监听者
  this.ctx.emit('session/event', sessionId, event)
}
```

其他插件可以监听：

```typescript
// UI 插件监听事件更新界面
ctx.on('session/event', (sessionId, event) => {
  if (event.type === 'assistant/chunk') {
    ui.appendText(event.delta)
  }
})

// 持久化插件监听事件保存
ctx.on('session/event', async (sessionId, event) => {
  await db.saveEvent(sessionId, event)
})
```

### 3. 从日志派生消息

Agent 需要从事件日志构建模型可见的消息：

```typescript
function deriveMessages(events: SessionEvent[]): Message[] {
  const messages: Message[] = []
  
  for (const event of events) {
    if (event.type === 'user/message') {
      messages.push({
        role: 'user',
        content: event.content
      })
    } else if (event.type === 'assistant/message') {
      messages.push({
        role: 'assistant',
        content: event.content
      })
    } else if (event.type === 'tool/call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: event.id,
          name: event.name,
          arguments: JSON.stringify(event.args)
        }]
      })
    } else if (event.type === 'tool/result') {
      messages.push({
        role: 'tool',
        tool_call_id: event.id,
        content: JSON.stringify(event.result)
      })
    }
  }
  
  return messages
}
```

### 4. Fork 会话

从某个点分叉新会话：

```typescript
fork(sourceId: string, fromIndex: number, newId = generateId()): Session {
  const source = this.sessions.get(sourceId)
  if (!source) {
    throw new Error(`Session ${sourceId} not found`)
  }
  
  const newSession: Session = {
    id: newId,
    events: source.events.slice(0, fromIndex), // 复制事件
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  
  this.sessions.set(newId, newSession)
  return newSession
}
```

## 完整示例

```typescript
import { Context, Service } from '@cordisjs/core'

// 事件类型定义
type SessionEvent = {
  type: 'user/message'
  content: string
  timestamp: number
} | {
  type: 'assistant/message'
  content: string
  timestamp: number
} | {
  type: 'tool/call'
  id: string
  name: string
  args: Record<string, unknown>
  timestamp: number
} | {
  type: 'tool/result'
  id: string
  result: unknown
  timestamp: number
}

interface Session {
  id: string
  events: SessionEvent[]
  createdAt: number
  updatedAt: number
}

// 扩展事件类型
declare module '@cordisjs/core' {
  interface Events {
    'session/event': (sessionId: string, event: SessionEvent) => void
  }
  
  interface Context {
    sessions: SessionService
  }
}

class SessionService extends Service {
  private sessions = new Map<string, Session>()
  
  constructor(ctx: Context) {
    super(ctx, 'sessions', true)
  }
  
  create(id = Math.random().toString(36).slice(2)): Session {
    const session: Session = {
      id,
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.sessions.set(id, session)
    return session
  }
  
  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }
  
  append(sessionId: string, event: SessionEvent): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }
    
    session.events.push(event)
    session.updatedAt = Date.now()
    this.ctx.emit('session/event', sessionId, event)
  }
  
  getEvents(sessionId: string, fromIndex = 0): SessionEvent[] {
    const session = this.sessions.get(sessionId)
    return session ? session.events.slice(fromIndex) : []
  }
  
  fork(sourceId: string, fromIndex: number, newId?: string): Session {
    const source = this.sessions.get(sourceId)
    if (!source) {
      throw new Error(`Session ${sourceId} not found`)
    }
    
    const newSession: Session = {
      id: newId ?? Math.random().toString(36).slice(2),
      events: source.events.slice(0, fromIndex),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    
    this.sessions.set(newSession.id, newSession)
    return newSession
  }
  
  delete(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

// 使用示例
export function apply(ctx: Context) {
  ctx.plugin(SessionService)
  
  // 创建会话
  const session = ctx.sessions.create()
  
  // 追加用户消息
  ctx.sessions.append(session.id, {
    type: 'user/message',
    content: 'Hello',
    timestamp: Date.now()
  })
  
  // 追加助手响应
  ctx.sessions.append(session.id, {
    type: 'assistant/message',
    content: 'Hi! How can I help?',
    timestamp: Date.now()
  })
  
  // 监听事件
  ctx.on('session/event', (sessionId, event) => {
    console.log(`[${sessionId}] ${event.type}`)
  })
}
```

## 关键要点

1. ✅ **Append-only** - 只追加，不修改历史
2. ✅ **事件驱动** - 追加后广播 `session/event`
3. ✅ **可派生** - 从事件日志构建模型消息
4. ✅ **可 Fork** - 从任意点分叉新会话
5. ✅ **模型可见 = 记录** - 所有模型看到的内容都必须在日志中

## 下一步

学习 [02-tools模块.md](./02-tools模块.md) 了解工具系统的实现。
