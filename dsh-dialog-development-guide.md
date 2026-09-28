# DSH 二次开发核心：深入理解 userQuestions 服务

## 引言

在 DeepSeek Harness（DSH）的二次开发中，`userQuestions` 服务是实现人机交互的核心基础设施。本文将深入剖析 `userQuestions` 服务的完整架构、实现原理和使用方式，帮助开发者：

1. **理解核心机制**：`userQuestions` 如何实现前后端解耦的弹框交互
2. **掌握服务层**：五大安全检查、瀑布式事件分发、作用域隔离的原理
3. **学会使用**：如何在自定义工具中正确调用 `ctx.userQuestions.ask()`
4. **二次开发**：基于 `userQuestions` 快速开发业务弹框（如 `reqboard_capture`）

**核心价值**：`userQuestions` 不仅仅是一个弹框工具，它是 DSH 中所有人机交互的统一接口和能力接缝（Capability Seam）。理解它，就理解了 DSH 如何优雅地处理"暂停执行、等待人工决策、继续执行"这一核心流程。

## 为什么要理解 userQuestions？

### 场景 1：你想开发一个立项弹框

```typescript
// ❌ 错误做法：从零造轮子
export class MyOwnDialogService {
  async showDialog() { /* 500 行代码 */ }
}

// ✅ 正确做法：使用 userQuestions
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'reqboard_capture',
    async execute(args, exec) {
      const answer = await ctx.userQuestions.ask({
        questions: [...]  // 只需定义问题
      })
      // 处理答案...
    }
  }))
}
```

**收益**：从 500 行代码减少到 50 行，自动获得错误处理、取消机制、作用域隔离。

### 场景 2：你想理解弹框为什么只发给特定会话

```typescript
// 为什么 Session A 的弹框不会出现在 Session B？
await ctx.userQuestions.ask({
  questions: [...],
  agent: exec.agent  // ← 关键：作用域隔离
})
```

**答案**：`userQuestions` 通过 `scopeTarget(agent, agent)` 实现会话级事件隔离。

### 场景 3：你想处理用户取消弹框

```typescript
try {
  const answer = await ctx.userQuestions.ask({ questions: [...] })
} catch (error) {
  if (error.code === 'ASK_CANCELLED') {
    // ✅ userQuestions 已分类好错误
    console.log('用户主动取消')
  } else if (error.code === 'ASK_ABORTED') {
    console.log('系统中断')
  }
}
```

**收益**：错误分类清晰，无需自己判断各种边界情况。

---

## userQuestions 服务概述

### 什么是 userQuestions？

`userQuestions` 是 DSH 中实现人机交互的**核心服务**，它提供了一个统一的能力接缝（Capability Seam），让 AI Agent 可以在任何时候暂停执行、向用户提问、等待答案、然后继续执行。

**核心接口**：

```typescript
// 服务声明
declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

// 核心方法
class UserQuestionService {
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

// 使用示例
const answer = await ctx.userQuestions.ask({
  questions: [
    { id: 'q1', question: '是否继续？', options: [...] }
  ],
  agent: exec.agent,    // 指定调用的 Agent
  signal: exec.signal   // 取消信号
})
```

---

### userQuestions 的核心价值

#### 1. 统一的交互接口

**问题**：没有 `userQuestions` 之前，每个功能都要自己实现弹框：

```typescript
// ❌ 各自为政，重复造轮子
class DeploymentDialog { /* 200 行 */ }
class ApprovalDialog { /* 180 行 */ }
class ConfigDialog { /* 150 行 */ }
// 总计：500+ 行重复代码，维护噩梦
```

**解决方案**：`userQuestions` 提供统一接口，所有功能都通过它交互：

```typescript
// ✅ 统一使用 userQuestions
await ctx.userQuestions.ask({ questions: [...] })  // 部署
await ctx.userQuestions.ask({ questions: [...] })  // 审批
await ctx.userQuestions.ask({ questions: [...] })  // 配置
// 0 行重复代码，维护简单
```

#### 2. 前后端完全解耦

**架构设计**：

```
┌────────────────────────────────────────────────────────────┐
│ 后端（服务端）                                              │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ ctx.userQuestions.ask()                                │ │
│ │   → 触发事件 'user-questions/request'                  │ │
│ │   → 等待 Promise resolve                               │ │
│ └────────────────────────────────────────────────────────┘ │
└────────────────────────┬───────────────────────────────────┘
                         ↓ Remote Event（跨进程通信）
┌────────────────────────────────────────────────────────────┐
│ 前端（浏览器）                                              │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ ctx.remote.$on('user-questions/request')               │ │
│ │   → 渲染 UI                                            │ │
│ │   → 等待用户输入                                        │ │
│ │   → 返回答案                                            │ │
│ └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

**好处**：
- 后端只管业务逻辑，不关心 UI 如何渲染
- 前端只管交互体验，不关心业务逻辑
- 可以轻松替换 UI（Web → CLI → GUI）

#### 3. 自动处理复杂边界情况

`userQuestions` 内置处理了所有边界情况，你无需操心：

| 边界情况 | userQuestions 的处理 | 你需要做什么 |
|---------|---------------------|-------------|
| 用户关闭标签页 | 自动触发 `ASK_ABORTED` | 捕获错误即可 |
| 用户点击取消 | 抛出 `ASK_CANCELLED` | 捕获错误即可 |
| Agent 被中断 | 监听 `signal.abort` | 传递 `exec.signal` 即可 |
| 子 Agent 尝试弹框 | 拒绝并抛出 `DELEGATED_CALLER` | 无需处理 |
| 网络断开 | 自动重连或降级 | 无需处理 |
| 多标签页同时弹框 | 作用域隔离，互不干扰 | 传递 `exec.agent` 即可 |

```typescript
// 你只需要这样写
try {
  const answer = await ctx.userQuestions.ask({
    questions: [...],
    agent: exec.agent,    // ← 自动实现作用域隔离
    signal: exec.signal   // ← 自动传播取消信号
  })
  // 处理答案
} catch (error) {
  // 所有边界情况已分类好
  if (error.code === 'ASK_CANCELLED') { /* 用户取消 */ }
  if (error.code === 'ASK_ABORTED') { /* 系统中断 */ }
}
```

#### 4. 类型安全的端到端保障

```typescript
// 请求类型
interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[]  // 问题列表
  agent?: Agent                     // 可选的作用域
  signal?: AbortSignal              // 可选的取消信号
}

// 问题类型
interface AskUserQuestionItem {
  id: string                        // 稳定 ID
  question: string                  // 问题文本
  options?: AskUserQuestionOption[] // 可选项列表
  multiSelect?: boolean             // 是否多选
  intent?: AskUserQuestionIntent    // 特殊渲染模式
}

// 答案类型
interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[]
}

interface AskUserQuestionAnswerItem {
  id: string         // 问题 ID（与请求对应）
  selected: string[] // 选中的选项标签
  custom?: string    // 自定义文本输入
}
```

**TypeScript 编译器会检查**：
- 问题 ID 是否唯一
- 答案 ID 是否对应问题
- 必填字段是否提供
- 类型是否匹配

---

### userQuestions 的工作流程

```
                 【服务层：ctx.userQuestions.ask()】
                              ↓
        ┌─────────────────────┴─────────────────────┐
        ↓                                           ↓
【验证层：五大检查】                     【分发层：waterfall 事件】
  1. 信号预检                            - 作用域过滤
  2. 问题非空                            - 监听器匹配
  3. Agent 活动性                        - 第一个返回答案的胜出
  4. Agent 根节点
  5. 意图合法性
        ↓                                           ↓
    验证通过                            触发 'user-questions/request'
        └─────────────────────┬─────────────────────┘
                              ↓
                  【传输层：Remote Event】
                              ↓
                  跨进程传输到浏览器客户端
                              ↓
                  【客户端层：监听器接收】
                              ↓
                  创建 PendingQuestion 对象
                              ↓
                  【UI 层：渲染界面】
                              ↓
                  用户填写答案 → 点击提交
                              ↓
                  pending.answer(answer)
                              ↓
                  Promise resolve
                              ↓
                  答案返回到服务层
                              ↓
                  ctx.userQuestions.ask() 返回
                              ↓
                  业务逻辑继续执行
```

---

### userQuestions 的三种使用场景

#### 场景 1：AI 直接调用（通过 ask_user_question 工具）

```typescript
// DSH 内置工具：ask_user_question
// AI 可以直接调用，无需开发

// AI 生成的调用
{
  "name": "ask_user_question",
  "arguments": {
    "questions": [{
      "id": "confirm",
      "question": "是否删除 config.json？",
      "options": [
        { "label": "确认删除" },
        { "label": "取消" }
      ]
    }]
  }
}

// 内部实现（已内置）
async execute(args, exec) {
  return await ctx.userQuestions.ask({
    questions: args.questions,
    agent: exec.agent,
    signal: exec.signal
  })
}
```

**适用**：简单问答，不需要额外业务逻辑。

#### 场景 2：自定义工具调用（带业务逻辑）

```typescript
// 你开发的自定义工具
ctx.tools.register(defineTool({
  name: 'reqboard_capture',
  async execute(args, exec) {
    // 1. 调用 userQuestions 服务
    const answer = await ctx.userQuestions.ask({
      questions: [
        { id: 'title', question: '需求名称', options: [...] },
        { id: 'category', question: '需求类型', options: [...] }
      ],
      agent: exec.agent,
      signal: exec.signal
    })
    
    // 2. 提取答案
    const title = answer.answers.find(a => a.id === 'title')?.selected[0]
    const category = answer.answers.find(a => a.id === 'category')?.selected[0]
    
    // 3. 执行业务逻辑（这是自定义部分）
    const reqId = await ctx.database.createRequirement({
      title,
      category,
      createdBy: exec.agent.id,
      createdAt: Date.now()
    })
    
    await ctx.notifications.send({
      to: exec.agent.id,
      message: `需求 ${reqId} 已创建`
    })
    
    // 4. 返回结果
    return {
      success: true,
      requirement_id: reqId,
      status: 'brainstorming'
    }
  }
}))
```

**适用**：需要在弹框前后添加业务逻辑。

#### 场景 3：非工具直接调用（后台服务）

```typescript
// 定时任务、后台服务等
export async function scheduledCleanup(ctx: Context): Promise<void> {
  const filesToDelete = await findOldFiles()
  
  if (filesToDelete.length > 0) {
    // 系统级确认，不关联特定 Agent
    try {
      const answer = await ctx.userQuestions.ask({
        questions: [{
          id: 'confirm',
          question: `发现 ${filesToDelete.length} 个过期文件，是否删除？`,
          options: [
            { label: '确认删除' },
            { label: '取消' }
          ]
        }],
        // agent: undefined  - 全局广播
        signal: AbortSignal.timeout(60000)  // 60 秒超时
      })
      
      if (answer.answers[0].selected[0] === '确认删除') {
        await deleteFiles(filesToDelete)
      }
    } catch (error) {
      if (error.code === 'ASK_CANCELLED') {
        console.log('用户取消清理')
      }
    }
  }
}
```

**适用**：系统级操作，需要人工确认。

---

### userQuestions 与其他方案对比

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| **userQuestions** | 统一接口、类型安全、自动处理边界、前后端解耦 | UI 样式固定 | 90% 的交互场景 |
| **直接实现弹框** | UI 完全自由 | 重复造轮子、维护成本高、易出 bug | 极特殊的 UI 需求 |
| **轮询检查** | 实现简单 | 浪费资源、延迟高、无法取消 | 不推荐 |
| **回调函数** | 传统方案 | 回调地狱、难以组合、无类型检查 | 不推荐 |

---

### 核心设计模式

#### 1. 能力接缝（Capability Seam）

`userQuestions` 不直接实现 UI，而是定义接口，让不同的实现（Web UI、CLI、测试 Mock）都能接入：

```typescript
// 服务层：定义接口
class UserQuestionService {
  async ask(request) {
    // 触发事件，等待任意实现响应
    return await this.ctx.waterfall('user-questions/request', request, fallback)
  }
}

// Web UI 实现
ctx.remote.$on('user-questions/request', async (request) => {
  const ui = new WebQuestionDialog(request)
  return await ui.waitForAnswer()
})

// CLI 实现
ctx.on('user-questions/request', async (request) => {
  const answer = await readline.question(request.questions[0].question)
  return { answers: [{ id: request.questions[0].id, selected: [answer] }] }
})

// 测试 Mock
ctx.on('user-questions/request', async (request) => {
  return { answers: request.questions.map(q => ({ id: q.id, selected: ['mock'] })) }
})
```

#### 2. 瀑布式事件（Waterfall Pattern）

多个监听器按优先级处理请求，第一个返回答案的胜出：

```typescript
// 监听器 1：Web UI（优先级最高）
ctx.remote.$on('user-questions/request', async (request, next) => {
  if (isWebContext()) return await renderUI(request)
  return next()  // 委托给下一个
})

// 监听器 2：CLI（备用）
ctx.on('user-questions/request', async (request, next) => {
  if (isCLI() && isSimpleQuestion(request)) return await cliPrompt(request)
  return next()  // 委托给下一个
})

// 监听器 3：自动化测试（兜底）
ctx.on('user-questions/request', async (request) => {
  return autoAnswer(request)
})
```

#### 3. Promise 外部化 Resolver

```typescript
// PendingQuestion 类
class PendingQuestion {
  readonly result: Promise<QuestionAnswer>
  readonly #resolve: (answer: QuestionAnswer) => void
  
  constructor() {
    const { promise, resolve, reject } = Promise.withResolvers<QuestionAnswer>()
    this.result = promise
    this.#resolve = resolve
    this.#reject = reject
  }
  
  // 用户提交答案时调用
  answer(answer: QuestionAnswer): void {
    this.#resolve(answer)  // 触发 Promise resolve
  }
}

// 使用
const pending = new PendingQuestion()
renderUI(pending)  // UI 持有 pending 对象
return await pending.result  // 等待用户回答
```

---

### 小结

`userQuestions` 是 DSH 中实现人机交互的核心服务，它：

1. **统一接口**：所有交互都通过 `ctx.userQuestions.ask()`
2. **前后端解耦**：服务层只管逻辑，UI 层只管展示
3. **自动处理边界**：取消、中断、作用域隔离等自动搞定
4. **类型安全**：TypeScript 端到端保障
5. **易于扩展**：通过瀑布式事件支持多种实现

理解 `userQuestions`，就掌握了 DSH 二次开发的核心能力。

## 架构分层

DSH 的弹框机制按照执行顺序分为七个步骤，每一步都有明确的职责。

### 执行流程图

```
AI 调用工具
    ↓
【步骤 1】创建和注册工具 ask_user_question (Tool Layer)
    ↓
【步骤 2】挂载 userQuestions 服务 (Service Layer)
    ↓
【步骤 3】问题内容校验 (Service Layer - Validation)
    ↓
【步骤 4】触发瀑布式事件分发 (Service Layer - Dispatch)
    ↓
【步骤 5】客户端接收并渲染 UI (Client Layer)
    ↓
【步骤 6】用户填写答案并提交 (UI Layer)
    ↓
【步骤 7】答案返回并展示结果 (Display Layer)
```

---

### 步骤 1：创建和注册工具 ask_user_question（Tool Layer）

**职责**：提供 AI 可调用的工具接口，负责参数映射和格式转换。

**位置**：`packages/interaction/tool-ask-user/src/index.ts`

**实现代码**：

```typescript
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-user-questions'

export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']  // 声明依赖

export function apply(ctx: Context): void {
  // 注册工具到工具系统
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding.',
    
    // 定义参数 schema
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { 
              type: 'string', 
              required: true, 
              description: 'Stable id for this question; echoed in the answer.' 
            },
            question: { 
              type: 'string', 
              required: true, 
              description: 'The specific question to ask the user.' 
            },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
    },
    
    // 定义输出 schema
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    
    // 工具执行函数
    async execute(args, exec) {
      // 调用 userQuestions 服务（步骤 2）
      const result = await ctx.userQuestions.ask({
        questions: args.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header !== undefined ? { header: question.header } : {},
          ...question.options !== undefined ? { options: question.options } : {},
          ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
        })),
        agent: exec.agent,      // 传递调用 Agent
        signal: exec.signal,    // 传递取消信号
      })
      
      // 格式化返回结果
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
      }
    },
  }))
}
```

**关键点**：
1. **依赖声明**：`inject: ['tools', 'userQuestions']` 确保 `ctx.tools` 和 `ctx.userQuestions` 可用
2. **参数映射**：snake_case（`multi_select`）→ camelCase（`multiSelect`）
3. **上下文传递**：将 `exec.agent` 和 `exec.signal` 传递给服务层
4. **格式转换**：移除 undefined 字段，确保输出符合 schema

**AI 调用示例**：

```json
{
  "name": "ask_user_question",
  "arguments": {
    "questions": [
      {
        "id": "deploy_method",
        "question": "选择部署方式",
        "header": "部署配置",
        "options": [
          { "label": "Docker 容器", "description": "推荐用于生产环境" },
          { "label": "原生部署", "description": "需要手动配置依赖" }
        ],
        "multi_select": false
      }
    ]
  }
}
```

---

### 步骤 2：挂载 userQuestions 服务（Service Layer）

**职责**：提供 `ctx.userQuestions.ask()` 方法，作为核心服务接口。

**位置**：`packages/interaction/user-questions/src/index.ts`

**实现代码**：

```typescript
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from './types.ts'

export type { 
  AskUserQuestionAnswer, 
  AskUserQuestionAnswerItem, 
  AskUserQuestionIntent, 
  AskUserQuestionItem,
  AskUserQuestionOption,
} from './types.ts'

/** 用户问答错误类 */
export class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}

/** 用户问答服务 */
export class UserQuestionService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'userQuestions', { immediate: true })
  }

  /**
   * 发起用户问答请求
   * @param request - 包含问题列表、Agent 和信号的请求
   * @returns 用户的答案
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    // 步骤 3：问题内容校验（见下一步）
    // 步骤 4：触发瀑布式事件分发（见下下步）
  }
}

/** 挂载到 Context */
declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

export default UserQuestionService
```

**服务注册**：

```typescript
// packages/bundle/base/src/index.ts
import UserQuestionService from '@deepseek-ai/dsh-user-questions'

export function apply(ctx: Context) {
  ctx.plugin(UserQuestionService)  // 注册服务
}
```

**使用方式**：

```typescript
// 在任何插件中使用
export const inject = ['userQuestions']

export function apply(ctx: Context) {
  const answer = await ctx.userQuestions.ask({
    questions: [
      { id: 'q1', question: '是否继续？', options: [...] }
    ],
    agent: myAgent,
    signal: mySignal
  })
  
  console.log(answer.answers[0].selected)
}
```

**关键点**：
1. **继承 Service**：自动管理生命周期
2. **immediate: true**：立即初始化，不等待首次调用
3. **类型导出**：导出所有类型供其他包使用
4. **Context 声明**：通过 module augmentation 挂载到 `ctx.userQuestions`

---

### 步骤 3：问题内容校验（Service Layer - Validation）

**职责**：在发送请求前进行五大安全检查，确保请求合法。

**位置**：`packages/interaction/user-questions/src/index.ts` 中的 `ask()` 方法

**实现代码**：

```typescript
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  // ========== 检查 1：信号预检 ==========
  if (request.signal?.aborted) {
    throw new UserQuestionError(
      'ask_user_question was aborted before the user answered',
      'ASK_ABORTED'
    )
  }
  
  // ========== 检查 2：问题非空 ==========
  if (request.questions.length === 0) {
    throw new UserQuestionError(
      'ask_user_question requires at least one question',
      'EMPTY_QUESTIONS'
    )
  }
  
  // ========== 检查 3：Agent 活动性验证 ==========
  const agent = request.agent
  if (agent !== undefined) {
    const agents = this.ctx.get('agents')
    
    // 3.1 检查 Agent 是否为当前活动实例
    if (agents === undefined || agents.get(agent.id) !== agent) {
      throw new UserQuestionError(
        'human interaction requires the exact live calling agent when an agent is supplied',
        'CALLER_NOT_LIVE'
      )
    }
    
    // 3.2 检查 Agent 是否为根节点（不能是子 Agent）
    if (!agents.roots().includes(agent)) {
      throw new UserQuestionError(
        'human interaction is unavailable while the calling agent is owned by another live agent; '
        + "include the unresolved question or decision in the child agent's final result",
        'DELEGATED_CALLER'
      )
    }
  }
  
  // ========== 检查 4：意图合法性验证 ==========
  for (const question of request.questions) {
    const intent = question.intent
    if (intent === undefined) continue
    
    // 4.1 验证 approve 选项是否存在
    if (!(question.options ?? []).some(option => option.label === intent.approve)) {
      throw new UserQuestionError(
        `question ${question.id} declares intent ${intent.kind} whose approve label `
        + `${JSON.stringify(intent.approve)} names none of its options`,
        'BAD_INTENT'
      )
    }
    
    // 4.2 验证 plan-review 是否包含 detail
    if (question.detail === undefined) {
      throw new UserQuestionError(
        `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
        'BAD_INTENT'
      )
    }
  }
  
  // ========== 检查 5：问题 ID 唯一性（可选） ==========
  const ids = new Set<string>()
  for (const question of request.questions) {
    if (ids.has(question.id)) {
      throw new UserQuestionError(
        `duplicate question id: ${question.id}`,
        'DUPLICATE_ID'
      )
    }
    ids.add(question.id)
  }
  
  // 验证通过，进入步骤 4：事件分发
  // ...
}
```

**五大检查详解**：

| 检查 | 目的 | 错误码 | 何时触发 |
|------|------|--------|----------|
| **1. 信号预检** | 避免向已取消的请求发送弹框 | `ASK_ABORTED` | `signal.aborted === true` |
| **2. 问题非空** | 防止空请求占用 UI 资源 | `EMPTY_QUESTIONS` | `questions.length === 0` |
| **3.1 Agent 活动性** | 防止使用过期或伪造的 Agent | `CALLER_NOT_LIVE` | Agent 不在注册表中 |
| **3.2 Agent 根节点** | 禁止子 Agent 弹框（避免嵌套混乱） | `DELEGATED_CALLER` | Agent 不是根节点 |
| **4.1 意图选项存在** | 防止 UI 展示不存在的选项 | `BAD_INTENT` | `approve` 标签不在 `options` 中 |
| **4.2 意图包含详情** | 确保 plan-review 有内容可审查 | `BAD_INTENT` | `intent.kind === 'plan-review'` 但 `detail` 为空 |
| **5. ID 唯一性** | 确保答案能正确配对问题 | `DUPLICATE_ID` | 多个问题使用相同 `id` |

**错误处理示例**：

```typescript
// 场景 1：使用过期 Agent
try {
  const oldAgent = JSON.parse(localStorage.getItem('agent'))
  await ctx.userQuestions.ask({ questions: [...], agent: oldAgent })
} catch (error) {
  // ❌ CALLER_NOT_LIVE - oldAgent 不是当前活动实例
  console.error(error.code)  // "CALLER_NOT_LIVE"
}

// 场景 2：子 Agent 尝试弹框
await ctx.subagent({
  prompt: 'analyze code',
  execute: async (subCtx, subAgent) => {
    try {
      await subCtx.userQuestions.ask({ questions: [...], agent: subAgent })
    } catch (error) {
      // ❌ DELEGATED_CALLER - 子 Agent 不能弹框
      console.error(error.code)  // "DELEGATED_CALLER"
    }
  }
})

// 场景 3：意图配置错误
try {
  await ctx.userQuestions.ask({
    questions: [{
      id: 'plan',
      question: '是否批准？',
      detail: planMarkdown,
      options: [
        { label: '同意' },   // 实际选项
        { label: '拒绝' }
      ],
      intent: {
        kind: 'plan-review',
        approve: '批准'  // ❌ "批准" 不在 options 中
      }
    }]
  })
} catch (error) {
  // ❌ BAD_INTENT - approve 标签不存在
  console.error(error.code)  // "BAD_INTENT"
}

// 场景 4：正确用法 ✅
await ctx.userQuestions.ask({
  questions: [{
    id: 'plan',
    question: '是否批准？',
    detail: planMarkdown,
    options: [
      { label: '批准' },   // ✅ 匹配
      { label: '需要修改' }
    ],
    intent: {
      kind: 'plan-review',
      approve: '批准'  // ✅ 存在于 options
    }
  }],
  agent: exec.agent,  // ✅ 工具执行器提供的活动 Agent
  signal: exec.signal // ✅ 自动取消传播
})
```

**关键点**：
1. **检查顺序**：从快到慢（信号 → 非空 → Agent → 意图）
2. **明确错误码**：每种错误都有唯一的 code，方便调试
3. **防御编程**：不信任任何输入，全部验证
4. **早期失败**：验证失败立即抛出，不浪费资源

---

### 步骤 4：触发瀑布式事件分发（Service Layer - Dispatch）

**职责**：通过 Cordis waterfall 机制将请求分发给客户端监听器。

**位置**：`packages/interaction/user-questions/src/index.ts` 中的 `ask()` 方法（续）

**实现代码**：

```typescript
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  // ... 步骤 3 的验证代码 ...
  
  // 定义 fallback：无人响应时的处理
  const noAnswerer = () => Promise.reject(
    new UserQuestionError(
      'no user-questions answerer accepted the request',
      'NO_PROVIDER'
    )
  )
  
  try {
    // 根据是否有 agent 选择分发方式
    return await (agent === undefined
      // 无作用域：全局广播，所有监听器都会收到
      ? this.ctx.waterfall('user-questions/request', request, noAnswerer)
      
      // 有作用域：只发送给指定 Agent 的监听器
      : this.ctx.waterfall(
          scopeTarget(agent, agent),  // 作用域过滤
          'user-questions/request',
          { ...request, agent },
          noAnswerer
        )
    )
  } catch (error) {
    // 错误恢复：跨进程传输后重建错误对象
    const restored = restoreUserQuestionError(error)
    if (restored instanceof UserQuestionError) throw restored
    
    // 信号中断特殊处理：统一错误码
    if (request.signal?.aborted) {
      throw new UserQuestionError(
        'ask_user_question was aborted before the user answered',
        'ASK_ABORTED',
        { cause: error }
      )
    }
    
    throw restored
  }
}

/** 错误恢复函数 */
function restoreUserQuestionError(reason: unknown): unknown {
  if (reason instanceof UserQuestionError) return reason
  
  // 从序列化对象重建
  if (isRecord(reason)
    && reason.name === 'UserQuestionError'
    && typeof reason.message === 'string'
    && typeof reason.code === 'string') {
    return new UserQuestionError(reason.message, reason.code, { cause: reason })
  }
  
  return reason
}
```

**Waterfall 机制详解**：

```typescript
// 事件声明
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request'(
      this: Scoped<Agent>,  // 作用域上下文
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>  // 委托给下一个监听器
    ): Promise<AskUserQuestionAnswer>
  }
}

// 监听器 1：Web UI（优先级最高）
ctx.remote.$on('user-questions/request', async function (request, next) {
  const sessionId = ctx.sessions.scopeOf(this)
  if (sessionId === undefined) return next()  // 不匹配则委托
  
  // 渲染 UI，等待用户响应
  const pending = new PendingQuestion(sessionId, request.questions, request.signal)
  return await pending.result
})

// 监听器 2：CLI（备用）
ctx.on('user-questions/request', async (request, next) => {
  if (request.questions.length > 1) return next()  // 复杂问题委托给 UI
  
  const question = request.questions[0]
  if (question.options?.length > 2) return next()  // 多选项委托
  
  // 简单 yes/no 在终端处理
  const answer = await cliPrompt(question.question)
  return { answers: [{ id: question.id, selected: [answer] }] }
})

// 监听器 3：自动化测试（最低优先级）
ctx.on('user-questions/request', async (request) => {
  // 自动选择第一个选项
  return {
    answers: request.questions.map(q => ({
      id: q.id,
      selected: q.options?.[0]?.label ? [q.options[0].label] : []
    }))
  }
})
```

**执行流程**：
1. 按注册顺序调用监听器
2. 第一个返回答案的监听器胜出
3. 调用 `next()` 则委托给下一个监听器
4. 所有监听器都委托则调用 `noAnswerer`（抛出 NO_PROVIDER）

**作用域隔离**：

```typescript
// 服务端：只通知指定 Agent 的监听器
await this.ctx.waterfall(
  scopeTarget(agent, agent),  // 目标作用域
  'user-questions/request',
  { ...request, agent },
  noAnswerer
)

// 客户端：作用域匹配检查
ctx.remote.$on('user-questions/request', function (request, next) {
  // this 是作用域上下文
  const sessionId = ctx.sessions.scopeOf(this)
  
  if (sessionId === undefined) {
    return next()  // 不匹配，委托给其他监听器
  }
  
  // 匹配成功，处理请求
  // ...
})
```

**隔离效果**：
- Session A 的弹框 → 只发送到 Session A 的浏览器标签
- Session B 的弹框 → 只发送到 Session B 的浏览器标签
- 没有 Agent 的请求 → 全局广播（如系统级确认）

---

### 步骤 5：客户端接收并渲染 UI（Client Layer）

**职责**：在浏览器端监听事件，创建 PendingQuestion 并渲染弹框。

**位置**：`packages/client/ui-user-questions/src/client/index.ts`

**实现代码**：

```typescript
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { PendingQuestion } from './contract/slots.ts'

export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

/** 处理一个问题请求 */
async function answerQuestion(
  ctx: ClientContext,
  owner: ClientContext,
  request: any,
  next: any,
  registerPendingInteraction: any
): Promise<any> {
  // 1. 获取会话 ID
  const sessionId = (ctx.sessions as ISessions).scopeOf(owner)
  if (sessionId === undefined) return next()  // 不匹配则委托
  
  // 2. 创建 PendingQuestion 对象
  const pending = new PendingQuestion(
    sessionId, 
    request.questions, 
    request.signal
  )
  
  // 3. 注册到 UI Session（显示弹框）
  const completed = Promise.withResolvers<void>()
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate()  // 用户切换到其他会话时委托
    await completed.promise
  })
  
  try {
    try {
      // 4. 等待用户回答（pending.result 在步骤 6 中 resolve）
      return await pending.result
    } catch (error) {
      // 用户委托给下一个处理器
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    // 5. 清理
    remove()
    completed.resolve()
  }
}

export function apply(ctx: ClientContext): void {
  // 注册本地化字典
  ctx.effect(() => ctx.locale.register('question', { zh, en }))
  
  // 注册待处理交互
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction(
    pending => pending.kind === 'plan-review' ? 2 : 1  // 优先级
  )
  
  // 注册 Composer 组件（步骤 6）
  ctx.slots.inject('conversation.composer', () => 
    ctx.slots.register(
      { 
        name: 'conversation.composer', 
        select: ({ pendingInteraction }) => 
          pendingInteraction instanceof PendingQuestion ? pendingInteraction : null,
        locale: 'question'
      }, 
      QuestionComposer
    )
  )
  
  // 监听 Remote Event
  ctx.remote.$on('user-questions/request', function (request, next) {
    return answerQuestion(ctx, this, request, next, registerPendingInteraction)
  })
}
```

**PendingQuestion 实现**：

```typescript
// packages/client/ui-user-questions/src/client/contract/slots.ts
export class PendingQuestion {
  readonly kind: 'question' | 'plan-review'
  readonly key: string
  readonly questions: readonly AskUserQuestionItem[]
  readonly result: Promise<QuestionAnswer>
  
  readonly #resolve: (answer: QuestionAnswer) => void
  readonly #reject: (reason: unknown) => void
  #settled = false
  
  constructor(
    readonly sessionId: SessionId,
    questions: readonly AskUserQuestionItem[],
    signal?: AbortSignal
  ) {
    this.key = `question:${++nextQuestionKey}`
    this.questions = questions
    this.kind = planReviewOf(questions) === undefined ? 'question' : 'plan-review'
    
    // 创建可外部 resolve 的 Promise
    const completion = Promise.withResolvers<QuestionAnswer>()
    this.result = completion.promise
    this.#resolve = completion.resolve
    this.#reject = completion.reject
    
    // 监听取消信号
    if (signal !== undefined) {
      const onAbort = () => this.abort(questionError('aborted', 'ASK_ABORTED'))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  }
  
  /** 用户提交答案（步骤 6 调用） */
  answer(answer: QuestionAnswer): Promise<void> {
    if (this.#settled) throw new Error('already settled')
    this.#settled = true
    this.#resolve(answer)
    return Promise.resolve()
  }
  
  /** 用户取消弹框 */
  cancel(): Promise<void> {
    if (this.#settled) throw new Error('already settled')
    this.#settled = true
    this.#reject(questionError('cancelled', 'ASK_CANCELLED'))
    return Promise.resolve()
  }
  
  /** 信号中断 */
  abort(reason: unknown): void {
    if (this.#settled) return
    this.#settled = true
    this.#reject(reason)
  }
}
```

**关键点**：
1. **作用域匹配**：`scopeOf(owner)` 确保只处理自己会话的请求
2. **Promise.withResolvers()**：ES2024 新特性，分离 Promise 和 resolver
3. **单次结算**：`#settled` 防止重复提交
4. **生命周期管理**：`registerPendingInteraction` 注册到 UI Session

---

### 步骤 6：用户填写答案并提交（UI Layer）

**职责**：渲染问题界面，收集用户输入，提交答案。

**位置**：`packages/client/ui-user-questions/src/client/QuestionComposer.tsx`

**核心流程**：

```typescript
export function QuestionComposer({ pending, t, useStore, actions }) {
  const questions = pending.questions
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState(
    questions.map(() => ({ selected: [], custom: '', skipped: false }))
  )
  const [busy, setBusy] = useState(false)
  
  /** 1. 用户选择选项 */
  const choose = (label: string) => {
    const nextDrafts = [...drafts]
    if (question.multiSelect) {
      // 多选：切换
      const selected = draft.selected.includes(label)
        ? draft.selected.filter(l => l !== label)
        : [...draft.selected, label]
      nextDrafts[index] = { ...draft, selected, skipped: false }
    } else {
      // 单选：替换并自动跳转
      nextDrafts[index] = { selected: [label], custom: '', skipped: false }
      if (index < questions.length - 1) setIndex(index + 1)
    }
    setDrafts(nextDrafts)
  }
  
  /** 2. 用户输入自定义文本 */
  const changeCustom = (value: string) => {
    const nextDrafts = [...drafts]
    nextDrafts[index] = {
      ...draft,
      selected: question.multiSelect ? draft.selected : [],  // 单选清空选项
      custom: value,
      skipped: false
    }
    setDrafts(nextDrafts)
  }
  
  /** 3. 提交答案 */
  const submit = async () => {
    // 检查完整性
    const missing = drafts.findIndex(d => 
      d.selected.length === 0 && d.custom.trim() === '' && !d.skipped
    )
    if (missing >= 0) {
      setError('请回答所有问题或跳过')
      return
    }
    
    // 格式化答案
    const answer = {
      answers: questions.map((q, i) => ({
        id: q.id,
        selected: drafts[i].skipped ? [] : drafts[i].selected,
        ...(drafts[i].custom.trim() && { custom: drafts[i].custom.trim() })
      }))
    }
    
    // 提交到 PendingQuestion（触发 pending.result resolve）
    setBusy(true)
    try {
      await pending.answer(answer)  // ← 关键：resolve Promise
      actions.clear(pending.key)
    } catch (err) {
      setBusy(false)
      setError(err.message)
    }
  }
  
  return (
    <div className="question-card">
      {/* UI 渲染代码见完整实现章节 */}
    </div>
  )
}
```

**用户交互流程**：
1. 用户点击选项 → `choose(label)` → 更新 `drafts`
2. 用户输入文本 → `changeCustom(value)` → 更新 `drafts`
3. 用户点击提交 → `submit()` → `pending.answer(answer)` → `pending.result` resolve
4. 客户端监听器（步骤 5）的 `await pending.result` 返回答案
5. Remote Event 将答案传回服务端
6. 服务层 waterfall 返回答案给工具层
7. 工具层返回答案给 AI

---

### 步骤 7：答案返回并展示结果（Display Layer）

**职责**：在对话历史中展示工具调用的状态和结果。

**位置**：`packages/client/ui-tool/src/client/tool/toolviews/ask-question-row.tsx`

**实现代码**：

```typescript
import { IconQuestionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ToolRow } from '../components/ToolRow.tsx'
import { toolRowModel } from '../models/tool-call-model.ts'

export function AskQuestionRow({ toolName, block, t, inspect, useDisclosure }) {
  const model = toolRowModel(toolName, block)
  const code = 'kind' in block ? block.error?.code : undefined
  
  let summary = model.summary
  let state = model.state
  let transcript = null
  
  // 根据不同状态展示不同内容
  if (code === 'ASK_CANCELLED') {
    summary = t('ask.cancelled')  // "用户已取消"
    state = 'ok'  // 用户主动取消视为正常结束
    transcript = { kind: 'unanswered', questions, verdict: t('ask.cancelledDetail') }
  } else if (code === 'ASK_ABORTED') {
    summary = t('ask.interrupted')  // "执行已中断"
    state = 'stopped'  // 系统中断显示为停止状态
    transcript = { kind: 'unanswered', questions, verdict: t('ask.interruptedDetail') }
  } else if (model.state === 'running') {
    summary = t('ask.waiting')  // "等待用户响应..."
  } else if ('kind' in block && model.state === 'ok') {
    // 成功状态：解析答案
    const text = singleResultText(block)
    if (text !== undefined) {
      const presentation = answeredPresentation(argsRaw, text, t)
      summary = presentation?.summary ?? answeredSummary(text, t) ?? model.summary
      // "已回答 3/3 个问题"
      
      if (presentation?.questions !== null) {
        // 构建完整问答记录
        transcript = { 
          kind: 'answered', 
          questions: presentation.questions,  // [{id, question, answers: string[]}]
          skippedLabel: t('ask.skipped') 
        }
      }
    }
  }
  
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconQuestionOutlineRegular />}
      title={t(model.titleKey)}  // "询问用户"
      summary={summary}
      bodyRaw={transcript === null ? model.bodyRaw : null}
      output={transcript === null ? model.output : null}
      askQuestion={transcript}  // 传递结构化问答记录
      state={state}
      inspect={inspect}
    />
  )
}

/** 注册到工具视图 */
export const askQuestionToolview = {
  name: 'ask-question-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', 
      key: 'ask_user_question', 
      locale: 'conversation'
    }, AskQuestionRow))
  }
}
```

**展示效果**：

| 状态 | 图标 | 标题 | 摘要 | 颜色 |
|------|------|------|------|------|
| 等待中 | 🔵 | 询问用户 | 等待用户响应... | 蓝色 |
| 已回答 | ✅ | 询问用户 | 已回答 3/3 个问题 | 绿色 |
| 已取消 | ⚪ | 询问用户 | 用户已取消 | 灰色 |
| 已中断 | 🟠 | 询问用户 | 执行已中断 | 琥珀色 |

**完整问答记录展示**：

```
┌─────────────────────────────────────┐
│ ✅ 询问用户                          │
│ 已回答 3/3 个问题                    │
├─────────────────────────────────────┤
│ 1. 选择部署方式                     │
│    ✓ Docker 容器                    │
│                                     │
│ 2. 是否启用 SSL                     │
│    ✓ 启用                           │
│                                     │
│ 3. 数据库配置                       │
│    ✓ PostgreSQL                     │
│    ✓ Redis                          │
│    自定义: 使用主从复制             │
└─────────────────────────────────────┘
```

---

### 完整数据流示意图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AI Agent 发起调用                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 1】Tool Layer: ask_user_question                             │
│ ├─ AI 调用工具                                                      │
│ ├─ 参数验证（schema）                                               │
│ ├─ 参数映射（snake_case → camelCase）                               │
│ └─ 调用 ctx.userQuestions.ask()                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 2】Service Layer: UserQuestionService                        │
│ └─ 服务已挂载到 ctx.userQuestions                                   │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 3】Validation: 五大安全检查                                   │
│ ├─ ✓ 信号预检                                                       │
│ ├─ ✓ 问题非空                                                       │
│ ├─ ✓ Agent 活动性                                                   │
│ ├─ ✓ Agent 根节点                                                   │
│ └─ ✓ 意图合法性                                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 4】Dispatch: 瀑布式事件分发                                   │
│ ├─ 触发 'user-questions/request' 事件                               │
│ ├─ 作用域过滤（scopeTarget）                                        │
│ └─ 等待监听器返回答案                                               │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓ [Remote Event 传输到浏览器]
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 5】Client Layer: 接收并渲染                                   │
│ ├─ ctx.remote.$on 监听事件                                          │
│ ├─ 作用域匹配（scopeOf）                                            │
│ ├─ 创建 PendingQuestion                                             │
│ ├─ 注册到 UI Session                                                │
│ └─ 等待 pending.result (Promise)                                    │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 6】UI Layer: 用户交互                                         │
│ ├─ QuestionComposer 渲染弹框                                        │
│ ├─ 用户点击选项 / 输入文本                                          │
│ ├─ 用户点击"提交"                                                   │
│ ├─ pending.answer(answer)                                           │
│ └─ pending.result Promise resolve ✓                                 │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓ [答案返回到服务端]
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 4】Dispatch 返回                                              │
│ └─ waterfall 返回答案给 Service                                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 1】Tool Layer 返回                                            │
│ └─ 格式化答案返回给 AI                                              │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│                         AI 收到答案继续执行                          │
└──────────────────────────┬──────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────────┐
│ 【步骤 7】Display Layer: 结果展示                                    │
│ ├─ AskQuestionRow 在对话历史中渲染                                  │
│ └─ 显示"已回答 3/3 个问题"                                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 小结

通过这七个步骤，DSH 实现了一个完整的、类型安全的、可扩展的用户弹框机制：

1. **步骤 1**：工具层提供 AI 接口
2. **步骤 2**：服务层挂载核心能力
3. **步骤 3**：严格的安全检查
4. **步骤 4**：灵活的事件分发
5. **步骤 5**：客户端接收处理
6. **步骤 6**：用户交互收集答案
7. **步骤 7**：结果展示和历史记录

每一步都有明确的职责边界，通过类型系统和 Cordis 插件机制紧密协作。

## 用户选择后的完整流程

这是弹框机制中最关键的部分——从用户点击按钮到 AI 收到答案的完整数据流。

### 流程概览

```
用户点击选项 → QuestionComposer 收集答案 → PendingQuestion.answer()
  → Promise resolve → Remote Event 返回 → 服务端 waterfall 完成
  → UserQuestionService.ask() 返回 → 工具执行完成 → AI 继续执行
```

### 1. 前端收集答案（QuestionComposer.tsx）

#### 1.1 用户交互处理

```typescript
// 用户点击选项
const choose = (label: string): void => {
  updateDraft((current) => {
    if (question.multiSelect === true) {
      // 多选：切换选中状态
      const selected = current.selected.includes(label)
        ? current.selected.filter(item => item !== label)
        : [...current.selected, label]
      return { ...current, selected, skipped: false }
    }
    // 单选：替换选项并自动跳转下一题
    return { selected: [label], custom: '', skipped: false }
  }, question.multiSelect !== true && index < questions.length - 1 ? index + 1 : index)
}

// 用户输入自定义文本
const draftCustom = (event: ChangeEvent<HTMLTextAreaElement>): void => {
  const value = event.target.value
  updateDraft(current => ({
    ...current,
    selected: question.multiSelect === true ? current.selected : [], // 单选清空选项
    custom: value,
    skipped: false
  }))
}

// 用户跳过当前问题
const skipQuestion = (): void => {
  const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index
    ? { selected: [], custom: '', skipped: true }
    : item)
  replaceProgress(index < questions.length - 1 ? index + 1 : index, nextDrafts)
  setError(null)
  if (index < questions.length - 1) return
  submitDrafts(nextDrafts) // 最后一题跳过直接提交
}
```

**设计要点**：
- **草稿存储**：答案暂存在 Session 级别的 Store 中，页面刷新可恢复
- **单选优化**：选择选项后自动跳转下一题，提升体验
- **跳过机制**：允许跳过非必答问题

#### 1.2 答案验证与提交

```typescript
const submitDrafts = (values: QuestionDraftAnswer[]): void => {
  // 1. 完整性检查
  const missing = values.findIndex(item => !completed(item))
  if (missing >= 0) {
    replaceProgress(missing, values)
    setError({ key: 'error.incomplete' })
    return
  }
  
  // 2. 格式化答案
  const answer: QuestionAnswer = {
    answers: questions.map((item, itemIndex) => {
      const value = values[itemIndex] as QuestionDraftAnswer
      
      // 跳过的问题返回空答案
      if (value.skipped) {
        return { id: item.id, selected: [] }
      }
      
      const custom = value.custom.trim()
      return {
        id: item.id,
        // 单选自定义输入时清空 selected
        selected: custom === '' || item.multiSelect === true ? value.selected : [],
        ...(custom === '' ? {} : { custom })
      }
    })
  }
  
  // 3. 提交到 PendingQuestion
  setBusy('answer')
  setError(null)
  void pending.answer(answer)
    .then(() => { 
      actions.clear(pending.key) // 清理草稿
    })
    .catch((cause: unknown) => {
      setBusy(null)
      setError({ text: cause instanceof Error ? cause.message : String(cause) })
    })
}
```

**答案结构示例**：

```json
{
  "answers": [
    {
      "id": "title",
      "selected": ["实现登录功能"],
      "custom": ""
    },
    {
      "id": "category",
      "selected": [],
      "custom": "混合类型需求"
    },
    {
      "id": "features",
      "selected": ["OAuth", "邮箱登录"],
      "custom": "支持企业微信"
    }
  ]
}
```

### 2. 答案提交到服务端（PendingQuestion）

```typescript
export class PendingQuestion {
  readonly result: Promise<QuestionAnswer>
  
  readonly #resolve: (answer: QuestionAnswer) => void
  readonly #reject: (reason: unknown) => void
  #settled = false
  
  constructor(
    readonly sessionId: SessionId,
    questions: readonly AskUserQuestionItem[],
    signal?: AbortSignal
  ) {
    // 创建可外部 resolve 的 Promise
    const completion = Promise.withResolvers<QuestionAnswer>()
    this.result = completion.promise
    this.#resolve = completion.resolve
    this.#reject = completion.reject
    
    // 监听取消信号
    if (signal !== undefined) {
      const onAbort = (): void => {
        this.abort(questionError('aborted before the user answered', 'ASK_ABORTED'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  }
  
  /**
   * 用户提交答案 → resolve Promise → 服务端 waterfall 完成
   */
  answer(answer: QuestionAnswer): Promise<void> {
    return settlePendingComposer(() => {
      this.finish(() => { this.#resolve(answer) })
    }, 'pending question settlement failed')
  }
  
  /**
   * 用户取消弹框 → reject 带 ASK_CANCELLED 错误码
   */
  cancel(): Promise<void> {
    return settlePendingComposer(() => {
      this.finish(() => {
        this.#reject(questionError('the user cancelled', 'ASK_CANCELLED'))
      })
    }, 'pending question cancellation failed')
  }
  
  /**
   * 信号中断 → reject 带 ASK_ABORTED 错误码
   */
  abort(reason: unknown): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(reason) })
  }
  
  private finish(settle: () => void): void {
    if (this.#settled) throw new Error(`pending question already settled`)
    this.#settled = true
    // 清理事件监听
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener('abort', this.#onAbort)
    }
    settle()
  }
}
```

**关键设计**：
- **Promise.withResolvers()**：ES2024 新特性，分离 Promise 和 resolver
- **单次结算**：`#settled` 标志防止重复提交
- **错误区分**：`ASK_CANCELLED`（用户主动）vs `ASK_ABORTED`（系统中断）

### 3. 答案返回到服务端（Remote Events）

在 `client/index.ts` 中，Remote Event 监听器持有 `pending.result`：

```typescript
async function answerQuestion(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientQuestionRequest,
  next: ClientQuestionNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingQuestion>
): Promise<ClientQuestionAnswer> {
  const sessionId = (ctx.sessions as ISessions).scopeOf(owner)
  if (sessionId === undefined) return next()
  
  // 创建 PendingQuestion 并注册到 UI
  const pending = new PendingQuestion(sessionId, request.questions, request.signal)
  const completed = Promise.withResolvers<void>()
  
  const remove = registerPendingInteraction(pending, async () => {
    pending.delegate() // 用户切换到其他会话时委托给下一个处理器
    await completed.promise
  })
  
  try {
    try {
      // 等待 pending.result，用户提交答案后 resolve
      return await pending.result
    } catch (error) {
      // 委托给下一个 waterfall 监听器
      if (pending.isDelegation(error)) return await next()
      throw error
    }
  } finally {
    remove()
    completed.resolve()
  }
}

// 注册到 Remote Events
ctx.remote.$on('user-questions/request', function (request, next) {
  return answerQuestion(ctx, this, request, next, registerPendingInteraction)
})
```

**执行流程**：
1. 服务端触发 `user-questions/request` 事件
2. 客户端监听器创建 `PendingQuestion` 并等待 `pending.result`
3. UI 渲染弹框，用户填写答案
4. 用户点击提交 → `pending.answer(answer)` → `pending.result` resolve
5. 监听器返回答案给服务端 waterfall

### 4. 工具层接收答案

服务端的 `UserQuestionService.ask()` 方法通过 waterfall 收到答案：

```typescript
// packages/interaction/user-questions/src/index.ts
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
  // ... 前置检查 ...
  
  // 触发 waterfall，等待任意监听器返回答案
  const answer = await this.ctx.waterfall(
    scopeTarget(agent, agent),
    'user-questions/request',
    { ...request, agent },
    noAnswerer // fallback：无人响应时的错误
  )
  
  return answer // 返回给工具层
}
```

工具执行器收到答案后返回给 AI：

```typescript
// packages/interaction/tool-ask-user/src/index.ts
async execute(args, exec) {
  const result = await ctx.userQuestions.ask({
    questions: args.questions.map(...),
    agent: exec.agent,
    signal: exec.signal
  })
  
  // 格式化为工具输出
  return {
    answers: result.answers.map(answer => ({
      id: answer.id,
      selected: [...answer.selected],
      ...answer.custom !== undefined ? { custom: answer.custom } : {}
    }))
  }
}
```

### 5. 状态展示（ask-question-row.tsx）

对话历史中的工具调用卡片展示最终状态：

```typescript
export function AskQuestionRow({ toolName, block, t }: ToolCallViewProps) {
  const model = toolRowModel(toolName, block)
  const code = 'kind' in block ? block.error?.code : undefined
  
  let summary = model.summary
  let state = model.state
  let transcript: AskQuestionCardModel | null = null
  
  // 处理不同结果状态