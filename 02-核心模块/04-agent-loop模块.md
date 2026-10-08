# Agent Loop 模块

## 核心概念

Agent Loop 是 Agent 的"大脑"，负责：
- 🔄 **Turn 循环** - 管理用户交互的完整周期
- 📨 **消息处理** - 接收用户输入，调用 LLM
- 🔧 **工具执行** - 解析并执行工具调用
- 📝 **日志记录** - 将所有事件记录到 Session

## Turn 和 Step 的关系

### Turn（回合）
一次完整的用户交互，包含：
- 用户输入
- 多个 Step（如果需要工具调用）
- 最终响应

### Step（步骤）
一次模型请求 + 工具调用：
- 发送请求到 LLM
- 获取响应（可能包含工具调用）
- 执行工具
- 如果需要继续，开始下一个 Step

### 关系图

```
Turn 1
  ├─ Step 1: LLM 回复 + 调用工具 read_file
  ├─ Step 2: 看到结果后调用工具 write_file  
  └─ Step 3: 完成，返回最终响应

Turn 2
  └─ Step 1: 直接回复，无工具调用
```

## Agent Loop 流程

### 完整流程

```
turn/start
  ↓
claim input (获取用户输入)
  ↓
agent/pre-step (拦截点：可以 reject 或修改消息)
  ↓
step/start
  ↓
append user message to session
  ↓
derive messages from session log
  ↓
build system prompt + tool schemas
  ↓
agent/request (拦截点：可以缓存或修改请求)
  ↓
llm.chat() → assistant/chunk* → assistant/message
  ↓
parse tool calls
  ↓
tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
  ↓
step/end
  ↓
需要继续？→ 下一个 Step
  ↓
agent/turn-stopping (拦截点：可以阻止结束)
  ↓
turn/end
```

## Agent 接口

```typescript
interface Agent {
  // 会话 ID
  sessionId: string
  
  // Agent 专用的上下文（用于作用域工具）
  ctx: Context
  
  // 输入消息
  input(message: string): Promise<void>
  
  // 注入上下文（不立即触发 turn）
  inject(context: string): void
  
  // 停止当前 turn
  stop(): void
  
  // 获取状态
  getStatus(): 'idle' | 'running' | 'stopped'
}
```

## AgentLoop Service

```typescript
class AgentLoop extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentLoop')
  }
  
  // 创建新 Agent
  create(sessionId: string): Agent
  
  // 运行一个 turn
  async runTurn(agent: Agent, input: string): Promise<void>
  
  // 运行一个 step
  async runStep(agent: Agent, messages: Message[]): Promise<boolean>
}
```

## 核心实现

### 1. Turn 循环

```typescript
async runTurn(agent: Agent, input: string): Promise<void> {
  const { sessionId, ctx } = agent
  
  // 记录 turn 开始
  ctx.sessions.append(sessionId, {
    type: 'turn/start',
    turnId: generateId(),
    timestamp: Date.now()
  })
  
  try {
    // 准备消息
    let messages = [{ role: 'user', content: input }]
    
    // pre-step 拦截
    await ctx.waterfall('agent/pre-step', messages)
    
    // 记录用户消息
    ctx.sessions.append(sessionId, {
      type: 'user/message',
      content: input,
      timestamp: Date.now()
    })
    
    // Step 循环
    let needsContinue = true
    while (needsContinue) {
      needsContinue = await this.runStep(agent, messages)
    }
    
    // turn-stopping 拦截
    await ctx.serial('agent/turn-stopping', agent)
    
  } finally {
    // 记录 turn 结束
    ctx.sessions.append(sessionId, {
      type: 'turn/end',
      turnId: agent.currentTurnId,
      timestamp: Date.now()
    })
  }
}
```

### 2. Step 执行

```typescript
async runStep(agent: Agent, inputMessages: Message[]): Promise<boolean> {
  const { sessionId, ctx } = agent
  
  // 记录 step 开始
  const stepId = generateId()
  ctx.sessions.append(sessionId, {
    type: 'step/start',
    stepId,
    turnId: agent.currentTurnId,
    timestamp: Date.now()
  })
  
  try {
    // 1. 从 session 派生消息
    const sessionEvents = ctx.sessions.getEvents(sessionId)
    const messages = deriveMessages(sessionEvents)
    
    // 2. 构建 system prompt 和工具
    const systemPrompt = ctx.systemPrompt.build()
    const tools = ctx.systemPrompt.getToolSchemas()
    
    // 3. 发送请求（可被拦截）
    const response = await ctx.waterfall('agent/request', {
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      tools
    })
    
    // 4. 记录助手消息
    if (response.content) {
      ctx.sessions.append(sessionId, {
        type: 'assistant/message',
        content: response.content,
        timestamp: Date.now()
      })
    }
    
    // 5. 处理工具调用
    if (response.tool_calls && response.tool_calls.length > 0) {
      await this.executeTools(agent, response.tool_calls)
      
      // 记录 step 结束
      ctx.sessions.append(sessionId, {
        type: 'step/end',
        stepId,
        timestamp: Date.now()
      })
      
      return true // 需要继续（工具结果需要发送给模型）
    }
    
    // 记录 step 结束
    ctx.sessions.append(sessionId, {
      type: 'step/end',
      stepId,
      timestamp: Date.now()
    })
    
    return false // 不需要继续
    
  } catch (error) {
    // 错误处理
    console.error('Step error:', error)
    return false
  }
}
```

### 3. 工具执行

```typescript
async executeTools(agent: Agent, toolCalls: ToolCall[]): Promise<void> {
  const { sessionId, ctx } = agent
  
  for (const call of toolCalls) {
    // 记录工具调用
    ctx.sessions.append(sessionId, {
      type: 'tool/call',
      id: call.id,
      name: call.name,
      args: call.args,
      timestamp: Date.now()
    })
    
    // 执行工具（通过管道）
    const result = await ctx.tools.execute(call)
    
    // 结果已经在 tools/post-execute 中记录到 session
  }
}
```

## 消息派生

从 Session 事件日志构建模型消息：

```typescript
function deriveMessages(events: SessionEvent[]): Message[] {
  const messages: Message[] = []
  
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        messages.push({
          role: 'user',
          content: event.content
        })
        break
        
      case 'assistant/message':
        messages.push({
          role: 'assistant',
          content: event.content
        })
        break
        
      case 'tool/call':
        // 工具调用作为 assistant 消息
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: event.id,
            type: 'function',
            function: {
              name: event.name,
              arguments: JSON.stringify(event.args)
            }
          }]
        })
        break
        
      case 'tool/result':
        // 工具结果
        messages.push({
          role: 'tool',
          tool_call_id: event.id,
          content: JSON.stringify(event.result)
        })
        break
    }
  }
  
  return messages
}
```

## 完整示例

```typescript
import { Context, Service } from '@cordisjs/core'

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: any[]
  tool_call_id?: string
}

interface Agent {
  sessionId: string
  ctx: Context
  currentTurnId?: string
  status: 'idle' | 'running' | 'stopped'
}

declare module '@cordisjs/core' {
  interface Events {
    'agent/pre-step': (messages: Message[], next: () => Promise<void>) => Promise<void>
    'agent/request': (payload: any, next: () => Promise<any>) => Promise<any>
    'agent/turn-stopping': (agent: Agent) => Promise<void>
  }
  
  interface Context {
    agentLoop: AgentLoopService
  }
}

class AgentLoopService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentLoop', true)
    
    // 注册默认请求处理器
    this.setupDefaultHandlers()
  }
  
  private setupDefaultHandlers() {
    // 默认 request 处理器：调用 LLM
    this.ctx.on('agent/request', async (payload, next) => {
      // 如果没有其他处理器，调用 LLM
      if (this.ctx.llm) {
        return await this.ctx.llm.chat(payload)
      }
      return await next()
    })
  }
  
  create(sessionId: string): Agent {
    return {
      sessionId,
      ctx: this.ctx.extend(), // 创建子上下文
      status: 'idle'
    }
  }
  
  async runTurn(agent: Agent, input: string): Promise<void> {
    agent.status = 'running'
    const turnId = Math.random().toString(36).slice(2)
    agent.currentTurnId = turnId
    
    try {
      // turn/start
      this.ctx.sessions.append(agent.sessionId, {
        type: 'turn/start',
        turnId,
        timestamp: Date.now()
      })
      
      // pre-step
      const messages = [{ role: 'user' as const, content: input, tool_calls: undefined, tool_call_id: undefined }]
      await this.ctx.waterfall('agent/pre-step', messages)
      
      // user/message
      this.ctx.sessions.append(agent.sessionId, {
        type: 'user/message',
        content: input,
        timestamp: Date.now()
      })
      
      // step 循环
      let needsContinue = true
      let stepCount = 0
      const MAX_STEPS = 10 // 防止无限循环
      
      while (needsContinue && stepCount < MAX_STEPS) {
        needsContinue = await this.runStep(agent)
        stepCount++
      }
      
      // turn-stopping
      await this.ctx.serial('agent/turn-stopping', agent)
      
    } finally {
      // turn/end
      this.ctx.sessions.append(agent.sessionId, {
        type: 'turn/end',
        turnId,
        timestamp: Date.now()
      })
      
      agent.status = 'idle'
    }
  }
  
  async runStep(agent: Agent): Promise<boolean> {
    const stepId = Math.random().toString(36).slice(2)
    
    // step/start
    this.ctx.sessions.append(agent.sessionId, {
      type: 'step/start',
      stepId,
      turnId: agent.currentTurnId!,
      timestamp: Date.now()
    })
    
    try {
      // 从 session 派生消息
      const events = this.ctx.sessions.getEvents(agent.sessionId)
      const messages = this.deriveMessages(events)
      
      // 构建 prompt 和工具
      const systemPrompt = this.ctx.systemPrompt.build()
      const tools = this.ctx.systemPrompt.getToolSchemas()
      
      // 发送请求
      const response = await this.ctx.waterfall('agent/request', {
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        tools
      })
      
      // 记录响应
      if (response.content) {
        this.ctx.sessions.append(agent.sessionId, {
          type: 'assistant/message',
          content: response.content,
          timestamp: Date.now()
        })
      }
      
      // 处理工具调用
      let hasToolCalls = false
      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const call of response.tool_calls) {
          hasToolCalls = true
          
          // tool/call
          this.ctx.sessions.append(agent.sessionId, {
            type: 'tool/call',
            id: call.id,
            name: call.function.name,
            args: JSON.parse(call.function.arguments),
            timestamp: Date.now()
          })
          
          // 执行工具
          await this.ctx.tools.execute({
            id: call.id,
            name: call.function.name,
            args: JSON.parse(call.function.arguments)
          })
        }
      }
      
      // step/end
      this.ctx.sessions.append(agent.sessionId, {
        type: 'step/end',
        stepId,
        timestamp: Date.now()
      })
      
      return hasToolCalls // 有工具调用就继续
      
    } catch (error) {
      console.error('Step error:', error)
      return false
    }
  }
  
  private deriveMessages(events: any[]): Message[] {
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
            type: 'function',
            function: {
              name: event.name,
              arguments: JSON.stringify(event.args)
            }
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
}

AgentLoopService.inject = ['sessions', 'systemPrompt', 'tools']

// 使用示例
export async function apply(ctx: Context) {
  ctx.plugin(AgentLoopService)
  
  // 创建 agent
  const agent = ctx.agentLoop.create('session-1')
  
  // 运行
  await ctx.agentLoop.runTurn(agent, 'Hello!')
}
```

## 关键要点

1. ✅ **Turn = 多个 Step** - 直到不需要工具
2. ✅ **事件驱动** - 通过 waterfall 事件扩展
3. ✅ **从日志派生** - 所有消息来自 session
4. ✅ **工具循环** - 自动处理多轮工具调用
5. ✅ **可拦截** - pre-step, request, turn-stopping

## 下一步

学习 [../03-执行流程/01-turn-flow.md](../03-执行流程/01-turn-flow.md) 了解完整的执行流程。
