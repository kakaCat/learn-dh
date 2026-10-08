# Turn Flow - 完整执行流程

## 流程概览

```
用户输入 "帮我读取 file.txt"
    ↓
┌─────────────────────────────────────┐
│         Turn 1 开始                  │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│     Step 1: 读取文件                 │
│  1. 记录 user/message                │
│  2. 调用 LLM                         │
│  3. LLM 决定调用 read_file 工具      │
│  4. 记录 tool/call                   │
│  5. 执行工具                         │
│  6. 记录 tool/result                 │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│     Step 2: 总结内容                 │
│  1. 将工具结果发送给 LLM              │
│  2. LLM 阅读结果并总结               │
│  3. 记录 assistant/message           │
│  4. 无需更多工具                     │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│         Turn 1 结束                  │
└─────────────────────────────────────┘
```

## 详细流程图

```
┌──────────────────────────────────────────────────────────┐
│                      Turn Start                           │
│  • 生成 turnId                                            │
│  • 记录 turn/start 事件                                   │
│  • 状态: idle → running                                   │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│                  Claim Input                              │
│  • 从 inbox 获取下一个消息                                │
│  • 可能是用户输入或注入的上下文                           │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│              agent/pre-step (waterfall)                   │
│  ✓ 插件可以:                                              │
│    - reject(): 拒绝此消息，关闭 turn                      │
│    - rewrite(messages): 修改消息                          │
│    - next(): 继续                                         │
│  ✓ 用例:                                                  │
│    - 安全过滤                                             │
│    - 添加上下文                                           │
│    - 策略检查                                             │
└──────────────────────────────────────────────────────────┘
                            ↓
         rejected? ─────YES────> turn/end (空 turn)
                            ↓ NO
┌──────────────────────────────────────────────────────────┐
│                    Step Start                             │
│  • 生成 stepId                                            │
│  • 记录 step/start 事件                                   │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│              Append User Message                          │
│  • 记录 user/message 事件到 session                       │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│           Derive Messages from Log                        │
│  • 从 session 事件日志重建消息历史                        │
│  • user/message → { role: 'user', ... }                  │
│  • assistant/message → { role: 'assistant', ... }        │
│  • tool/call + tool/result → 工具消息                    │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│        Build System Prompt + Tool Schemas                 │
│  • ctx.systemPrompt.build()                              │
│  • ctx.systemPrompt.getToolSchemas()                     │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│              agent/request (waterfall)                    │
│  ✓ 插件可以:                                              │
│    - 缓存: 如果有缓存，直接返回                           │
│    - 修改: 改写请求参数                                   │
│    - 观察: 记录请求                                       │
│    - next(): 继续到实际 LLM 调用                          │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│                   LLM Stream                              │
│  • llm.chat() 发起请求                                    │
│  • 流式返回 chunks                                        │
│  • 每个 chunk 触发 assistant/chunk 事件                   │
│  • 组装完整的 assistant/message                           │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│            Parse Tool Calls                               │
│  • 检查响应中是否有 tool_calls                            │
│  • 如果有，进入工具执行流程                               │
└──────────────────────────────────────────────────────────┘
                            ↓
                   有工具调用?
                            ↓ YES
┌──────────────────────────────────────────────────────────┐
│                  For Each Tool Call                       │
│  1. 记录 tool/call 事件                                   │
│  2. tools/pre-execute (waterfall)                        │
│     - 权限检查                                            │
│     - 参数验证                                            │
│  3. tools/execute (waterfall)                            │
│     - 实际执行工具                                        │
│  4. tools/post-execute (waterfall)                       │
│     - 记录日志                                            │
│     - 格式化结果                                          │
│  5. 记录 tool/result 事件                                 │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│                    Step End                               │
│  • 记录 step/end 事件                                     │
└──────────────────────────────────────────────────────────┘
                            ↓
              需要继续? (有工具结果待处理)
                            ↓ YES
              ┌──────────────────────┐
              │   回到 Step Start     │  (新的 Step)
              └──────────────────────┘
                            ↓ NO
┌──────────────────────────────────────────────────────────┐
│         agent/turn-stopping (serial)                      │
│  ✓ 插件可以:                                              │
│    - 检查是否应该继续                                     │
│    - 添加后续处理                                         │
│    - 记录统计                                             │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│                    Turn End                               │
│  • 记录 turn/end 事件                                     │
│  • 状态: running → idle                                   │
└──────────────────────────────────────────────────────────┘
```

## 事件时序

### 简单对话（无工具）

```
user input: "Hello"
  ↓
turn/start
  ↓
step/start
  ↓
user/message: "Hello"
  ↓
[LLM 请求]
  ↓
assistant/chunk: "Hi"
assistant/chunk: " there"
assistant/chunk: "!"
  ↓
assistant/message: "Hi there!"
  ↓
step/end
  ↓
turn/end
```

### 工具调用（单步）

```
user input: "Read file.txt"
  ↓
turn/start
  ↓
step/start
  ↓
user/message: "Read file.txt"
  ↓
[LLM 请求]
  ↓
assistant/message: null
  ↓
tool/call: { name: "read", args: { path: "file.txt" } }
  ↓
[工具执行]
  ↓
tool/result: { content: "Hello World" }
  ↓
step/end
  ↓
step/start (自动开始新 step)
  ↓
[LLM 请求，包含工具结果]
  ↓
assistant/message: "The file contains: Hello World"
  ↓
step/end
  ↓
turn/end
```

### 工具调用（多步）

```
user input: "Read file1.txt and file2.txt, then compare"
  ↓
turn/start
  ↓
step/start
  ↓
user/message: "Read file1.txt and file2.txt, then compare"
  ↓
[LLM 请求]
  ↓
tool/call: { name: "read", args: { path: "file1.txt" } }
tool/result: { content: "Content 1" }
  ↓
step/end
  ↓
step/start
  ↓
tool/call: { name: "read", args: { path: "file2.txt" } }
tool/result: { content: "Content 2" }
  ↓
step/end
  ↓
step/start
  ↓
assistant/message: "The differences are: ..."
  ↓
step/end
  ↓
turn/end
```

## 关键拦截点

### 1. agent/pre-step

**时机**: 在 step 开始前，用户消息被接受前

**用例**:
```typescript
// 安全过滤
ctx.on('agent/pre-step', async (messages, next) => {
  for (const msg of messages) {
    if (containsBadWord(msg.content)) {
      throw new Error('Message rejected')
    }
  }
  await next()
})

// 添加上下文
ctx.on('agent/pre-step', async (messages, next) => {
  messages.unshift({
    role: 'system',
    content: 'Current time: ' + new Date()
  })
  await next()
})
```

### 2. agent/request

**时机**: 在发送 LLM 请求前

**用例**:
```typescript
// 缓存
ctx.on('agent/request', async (payload, next) => {
  const key = hash(payload.messages)
  if (cache.has(key)) {
    return cache.get(key)
  }
  const result = await next()
  cache.set(key, result)
  return result
})

// 请求修改
ctx.on('agent/request', async (payload, next) => {
  payload.temperature = 0.7
  payload.max_tokens = 1000
  return await next()
})
```

### 3. tools/pre-execute

**时机**: 在工具执行前

**用例**:
```typescript
// 权限检查
ctx.on('tools/pre-execute', async (call, next) => {
  if (!hasPermission(call.name)) {
    throw new Error('Permission denied')
  }
  await next()
})

// 参数验证
ctx.on('tools/pre-execute', async (call, next) => {
  if (!validateArgs(call.args)) {
    throw new Error('Invalid arguments')
  }
  await next()
})
```

### 4. agent/turn-stopping

**时机**: turn 即将结束前

**用例**:
```typescript
// 检查目标完成
ctx.on('agent/turn-stopping', async (agent) => {
  const goal = getGoal(agent.sessionId)
  if (goal && !isGoalComplete(goal)) {
    // 可以注入新消息继续
    agent.inject('Continue working on the goal')
  }
})

// 统计记录
ctx.on('agent/turn-stopping', async (agent) => {
  const events = ctx.sessions.getEvents(agent.sessionId)
  const stepCount = events.filter(e => e.type === 'step/start').length
  console.log(`Turn completed with ${stepCount} steps`)
})
```

## 状态机

```
┌─────┐  input   ┌─────────┐  turn done  ┌──────┐
│Idle │─────────→│ Running │────────────→│ Idle │
└─────┘          └─────────┘             └──────┘
                      │
                      │ stop()
                      ↓
                 ┌─────────┐
                 │ Stopped │
                 └─────────┘
```

## 关键要点

1. ✅ **Turn = 多个 Step** - 直到无需工具
2. ✅ **事件驱动** - 每个阶段都有事件
3. ✅ **可拦截** - 4 个关键拦截点
4. ✅ **从日志派生** - 消息从 session 重建
5. ✅ **工具自动循环** - 有工具结果就继续

## 下一步

学习 [../04-实现/README.md](../04-实现/README.md) 开始实现简单的 dh。
