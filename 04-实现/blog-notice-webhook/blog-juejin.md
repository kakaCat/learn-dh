---
title: "从零给 DSH 写一个 Webhook 通知插件"
description: "从 DSH 插件怎么嵌进宿主讲起，再讲用了 DSH 的哪些能力、分层原理，最后逐文件实现一个可复制的 Webhook 通知插件。"
keywords: [DSH, DeepSeek Harness, Cordis, Plugin, Webhook, 插件开发, session/event, dsh-session, 依赖注入, 事件总线, TypeScript]
tags: [DSH, Cordis, Plugin, Webhook, 插件开发, TypeScript]
author: "learn-dh"
date: "2026-08-20"
updated: "2026-10-08"
lang: "zh-CN"
license: "MIT"
og:
  title: "从零给 DSH 写一个 Webhook 通知插件"
  description: "插件怎么嵌进 DSH、用了哪些能力、为什么这样分层，以及逐文件实现——附取自 dsh-session 真实 .d.ts 的事件签名与字段。"
  type: "article"
  locale: "zh_CN"
  site_name: "learn-dh"
---

> 这篇文章按这个顺序讲：
> 1. **插件是怎么嵌进 DSH 的**（先讲清"放在哪、谁来调它"）
> 2. **到底用了 DSH 的什么**（事件清单、拦截点、服务）
> 3. **原理**（为什么要分层、依赖注入解决什么）
> 4. **业务实现**（逐文件写代码，跑出真实输出）
> 5. **附录 FAQ**（怎么确认装好了 / id 冲突会怎样 / 收不到通知怎么查）

> 本文所有代码都在正文里（第 4 章逐文件给出），`pnpm install && pnpm dev` 可复现文中全部输出；
> 完整依赖清单见 4.5。

> 📌 **阅读约定（关于代码片段）**：**第 1～3 章的片段是示意**——为聚焦概念，省略了 `import`、上下文和错误处理，
> **单独复制无法编译**（例如 2.2 的 `ctx.emit("session/event", session, event)` 里 `session`/`event` 是宿主侧变量，
> 3.6 的 `flush` 是占位函数）。**第 4 章起是完整文件**，与仓库源文件逐字一致，可以整段复制。

---

## 速览（TL;DR）

- **给谁看**：想给 DSH 加功能，但不确定"插件放哪、谁来调它、能拿到什么"的开发者。
- **解决什么**：从零写出一个通知插件——DSH 会话事件一发生，就把消息 POST 到你配置的 webhook。
- **三个关键结论**：
  ① 插件就是 Cordis 插件，靠 `app.plugin()` / profile 加载；
  ② 通知类插件接 `session/event`，**第一个参数是 `Session` 对象**（会话 id 在 `session.header.id`）；
  ③ 工具失败通知需要**两阶段关联**（`tool/call` 的 `callId` ↔ `tool/result` 的 `message.toolCallId`）。
- **能拿到什么**：4 个可复制源文件 + 一份 `package.json`，`pnpm install && pnpm dev` 复现本文全部输出。
- **依据**：事件签名与字段均取自**已发布包** `@deepseek-ai/dsh-session@0.2.0-rc.2` 的 `.d.ts`，不是推测。

## 目录

- 第一章　插件是怎么嵌进 DSH 的
- 第二章　到底用了 DSH 的什么
- 第三章　原理：为什么这样分层
- 第四章　业务实现（逐文件）
- 第五章　小结
- 附录：常见问题 FAQ

## 第一章　插件是怎么嵌进 DSH 的

很多人写 DSH 插件卡在第一步：代码写完了，**不知道放到哪、谁去调它**。
所以这一章先不谈业务，只讲"嵌入"。

### 1.1 先分清两层：Cordis 与 DSH

| 层 | 是什么 | 你的插件跟它的关系 |
| --- | --- | --- |
| **Cordis** | 插件框架（`@deepseek-ai/cordis`） | 提供 `Context`、`plugin()`、事件、依赖注入；你的插件是 **Cordis 插件** |
| **DSH** | 用 Cordis 搭起来的 Agent 应用 | 它在运行中发出事件、暴露服务；你的插件**监听这些事件**做事 |

一句话：**你写的是 Cordis 插件，挂到 DSH 这台机器的插槽上。**
所以学会 Cordis 的插件机制，就学会了大部分。

### 1.2 插件的三种形态

Cordis 识别三种插件写法，任选其一：

```ts
// 形态 1：函数插件
function loggerPlugin(ctx: Context) {
  console.log("logger 插件已激活")
}

// 形态 2：对象插件（可以带 name / inject 等元信息）
const webhookPlugin = {
  name: "notice-webhook",
  inject: ["notice"],        // 声明：我需要 notice 这个服务
  apply(ctx: Context, config) {
    console.log("webhook 插件已激活")
  },
}

// 形态 3：类插件（适合需要保存状态，或本身就是"服务"的）
class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, "myService")
  }
}
```

**本文的插件用形态 2，服务用形态 3。**

### 1.3 "嵌进去"的那一刻发生了什么

宿主只需要一行：

```ts
await app.plugin(webhookPlugin, config)
```

这一行背后有四步——**这就是"嵌入"的全部**：

```
app.plugin(插件, 配置)
        │
        ├─ 1. 注册一个 fiber（插件实例），记录 name / inject
        │
        ├─ 2. 解析 inject：它要的 "notice" 服务就绪了吗
        │      └─ 没就绪 → 挂起等待（不报错，等提供者出现再激活）
        │
        ├─ 3. 调 apply(ctx, config)   ← 你的代码从这里开始跑
        │
        └─ 4. 你在 apply 里 ctx.on(...) 注册的监听器，挂到事件总线上
```

三个要点：

1. **宿主不需要知道你的插件存在**：它只负责把事件发到总线上；
2. **你也不需要知道宿主内部实现**：你只认事件名和载荷结构；
3. 双方唯一的契约就是**事件名 + 载荷形状**。

### 1.4 真实 DSH 里的嵌入方式

真实 DSH（含桌面版）用的是同一套机制。具体装载是「**包自带 patch + profile 登记为 bundle**」两步。

**第一步：插件包声明自己的装载层**——在 `package.json` 里加 `dsh` 字段：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

包内的 `cordis.patch.yml` 是一个 Loader patch 数组，用 `insert` 声明要插入的条目：

```yaml
- insert:
    - id: dsh-notice-webhook
      name: dsh-notice-webhook
      config:
        webhookUrl: ''
```

**第二步：目标 profile 把它登记进 `bundles`**——`~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": { "dsh-notice-webhook": "link:/path/to/plugin" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-notice-webhook"]
    }
  }
}
```

profile 根部的 `cordis.yml` 写明了套用顺序：**先按 `dsh.profile.bundles` 顺序套每个 bundle 的 patch，
再套 profile 自己的 `cordis.patch.yml`，最后是 `--patch` 覆盖**。

**生效方式**：Host 半只在启动时加载 → **重启 Host**；客户端半 → **刷新页面**。
（若插件还带客户端半（设置页 UI），再在 `dsh` 字段里加 `client` 声明。）

> 装完怎么确认放对了、id 撞车了会怎样：见附录 **Q1 / Q2**。

---

---

## 第二章　到底用了 DSH 的什么

这一块是写插件时最容易含糊的地方，这里讲透。DSH 给插件的能力只有三大块：**拦截点、会话事件、服务**。

### 2.1 拦截点：可以"插手"的地方

这类事件**多数是 waterfall**：签名 `(载荷, next)`，你调用 `next()` 才让流程继续，因此**能改参数、能短路**。

| 拦截点 | 触发时机 | 典型用途 |
| --- | --- | --- |
| `agent/pre-step` | 每一步开始前 | 注入上下文、改消息列表 |
| `agent/request` | 向模型发请求前 | 改请求参数、换模型 |
| `tools/pre-execute` | 工具执行前 | **权限检查**、参数校验 |
| `tools/execute` | 工具执行时 | 包装执行、超时守卫 |
| `tools/post-execute` | 工具执行后 | 记日志、格式化结果 |
| `agent/turn-stopping` | 一轮将要结束时 | 检查是否该继续、记统计 |

> 例外：表里最后一条 `agent/turn-stopping` 走的是 **serial 派发**（`ctx.serial`），
> 监听器签名是 `(agent)`，**没有 `next`**、不能短路；其余五条才是可插手的 waterfall。

### 2.2 会话事件（session/event）：可以"旁听"的地方

DSH 把一轮对话里发生的每件事都写成一条**会话事件**，写日志的同时广播到总线上：

```ts
ctx.emit("session/event", session, event)
```

所以插件只要监听一个事件，就能拿到**全部**会话动态：

```ts
ctx.on("session/event", (session, event) => {
  if (event.type === "turn/end") { /* 一轮结束 */ }
  if (event.type === "tool/result") { /* 工具出结果 */ }
  if (event.type === "assistant/message") { /* 模型回复完成 */ }
})
```

常见的事件类型：`turn/start`、`turn/end`、`step/start`、`step/end`、
`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`。

> 📌 真实 DSH 里这个事件的签名（取自 `@deepseek-ai/dsh-session` 发布的 `.d.ts`）：
> `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`
>
> 两个容易写错的点：
> ① **第一个参数是 `Session` 对象**，会话 id 在 `session.header.id`（**不是** `sessionId` 字符串）；
> ② `@mode emit`，并且**带作用域过滤**（`@deepseek-ai/dsh-scope`）：agent 作用域的监听器只会收到
> 经该 agent 上下文进入的会话的事件。

事件字段速查（写过滤条件时用得上）：

DSH 的事件是**信封 + 负载**结构：外面是 `{ type, seq, time, data }`，负载在 `data` 里。几个常用事件：

| 事件 | `data` 里的关键字段 |
| --- | --- |
| `turn/start` | `turn` |
| `turn/end` | `turn`、`reason`（`reason.kind` 是 `completed` / `aborted` / `blocked` / …） |
| `step/start` / `step/end` | `turn`、`step` |
| `tool/call` | `callId`、`name`、`arguments`（JSON 字符串） |
| `tool/result` | `message`（`message.toolCallId`、`message.isError`）、`error?`（`{ name, code, reason? }`） |

> 注意时间字段叫 **`time`**（不在 `data` 里，在信封上），不是 `timestamp`。

注意 `tool/result` 上**没有 `name` 字段、只有 `id`**——这决定了通知插件必须做两阶段关联，见 4.3。

### 2.3 该接哪个事件：取决于 DSH 怎么实现

DSH 里没有「万能事件」。**具体该监听哪个事件，取决于你要通知的事情由 DSH 的哪一部分产出**——
也就是取决于 DSH 的实现方式。本 demo 覆盖的是其中一条流（会话事件）：

```text
宿主（Agent / Tools）              事件总线                        插件
[ 工具开始执行 ]   ─ emit ─►  session/event (tool/call)    ─►  记下 id → 工具名
[ 工具返回/报错 ]  ─ emit ─►  session/event (tool/result)  ─►  取出工具名 → 过滤 → 投递
[ 一轮对话结束 ]   ─ emit ─►  session/event (turn/end)     ─►  过滤 → 投递
```

三条路径**共用同一个事件名** `session/event`，靠 `event.type` 区分——这就是"按 `event.type` 过滤"的由来。

| 你想通知的事 | 接哪个事件 | 过滤条件 |
| --- | --- | --- |
| 一轮对话结束 | `session/event` | `event.type === "turn/end"` |
| 工具执行失败 | `session/event` | `event.type === "tool/result"` 且结果带错误 |
| 模型回复完成 | `session/event` | `event.type === "assistant/message"` |

所以"任务完成就发通知"这类需求，接 `session/event` 再按 `event.type` 过滤即可。

另外两点容易混，单独点一下：

- **不要猜 `agent/turn-end`**：真实 DSH 里没有这个事件名，"一轮结束"是会话事件 `turn/end`；
- **`agent/turn-stopping` 不是会话事件**：它是拦截点（serial 派发的那种），用途不同，见 2.1。

### 2.4 服务：DSH 暴露的能力接口

除了事件，DSH 还以**服务**的形式暴露能力，插件通过 `inject` 声明后即可调用，例如：

| 服务 | 用途 |
| --- | --- |
| `ctx.tools` | 注册工具：`ctx.tools.register(defineTool({ ... }))` |
| `ctx.userQuestions` | 弹框问用户：`await ctx.userQuestions.ask({ questions: [...] })` |
| `ctx.sessions` | 读写会话与事件日志 |

**本文的插件做两件事**：用 `ctx.on` 旁听事件；用自己定义的服务 `ctx.notice` 发 HTTP。

---

## 第三章　原理：为什么这样分层

### 3.1 三层结构，各管一件事

```
┌──────────────────────────────────────────────┐
│ 宿主层（DSH / demo 的 main.ts）               │
│   • 组装应用：注册服务、安装插件              │
│   • 发出事件：app.emit("session/event", ...)  │
│   • 不知道通知插件存在                        │
└───────────────────┬──────────────────────────┘
                    │ 事件总线（ctx.on / ctx.emit）
                    ▼
┌──────────────────────────────────────────────┐
│ 插件层（plugin.ts）                           │
│   • 监听事件 → 决定"要不要发、发什么"          │
│   • 业务规则：事件订阅过滤、级别过滤          │
│   • 不碰 HTTP 细节                            │
└───────────────────┬──────────────────────────┘
                    │ ctx.notice.broadcast(...)
                    ▼
┌──────────────────────────────────────────────┐
│ 服务层（service.ts）                          │
│   • 只管"怎么发"：POST、超时、重试、错误吞掉   │
│   • 可被任意多个插件复用                      │
└──────────────────────────────────────────────┘
```

**分层的收益**：换通知渠道（钉钉/Slack/邮件）只改配置；换 HTTP 实现（fetch/axios/内网网关）只改服务层；
业务规则和传输细节互不污染。

### 3.2 Service 和普通插件差在哪

```ts
export class NoticeService extends Service {
  constructor(ctx: Context) {
    super(ctx, "notice")      // 注册名为 notice 的服务，挂到 ctx.notice
  }
}
```

`super(ctx, "notice")` 做了两件事：

1. 把实例挂到 **`ctx.notice`**，任何插件都能直接访问；
2. 让 `inject: ["notice"]` 能解析到它——**这就是"依赖"的来源**。

### 3.3 依赖注入真正解决的是"加载顺序"

如果插件先加载、服务后注册，`ctx.notice` 就是 `undefined`。
依赖注入把这件事交给框架：

```ts
export const inject = ["notice"]   // 我要 notice，就绪了再激活我
```

宿主只要把两者都注册上，**顺序由框架保证**，插件代码里不需要写任何等待逻辑。

### 3.4 为什么通知必须"失败不抛"

通知是**旁路**：它失败不代表业务失败。如果发通知抛异常冒泡到 agent loop，
一条 webhook 配错就能让整个会话崩掉。所以两个地方都要兜住：

- **服务层**：`send()` 内部 try/catch，失败只记日志、绝不抛出；
- **插件层**：`broadcast()` 是异步调用，用 `.catch()` 兜底，不 `await` 到主流程里。

### 3.5 发通知该用 `on` 而不是 `waterfall`

Cordis 有两类派发方式，用途完全不同：

| 方式 | 语义 | 适合 |
| --- | --- | --- |
| `ctx.emit` / `ctx.on` | 触发即忘，不等返回值 | **旁路通知、日志、审计** |
| `ctx.waterfall` | 洋葱模型，能包裹、能短路 | **拦截、鉴权、改参数** |

通知插件只是"知道了顺便报一声"，不改写任何结果，所以用 `on`。

### 3.6 真实插件还应处理生命周期

插件在 `apply` 里注册的资源（定时器、连接、监听器）应该用 `ctx.effect` 包起来，
这样插件卸载时自动回收——否则定时器会一直跑、连接会一直挂着：

```ts
ctx.effect(() => {
  const timer = setInterval(flush, 5000)   // flush 是占位函数，换成你自己的清理逻辑
  return () => clearInterval(timer)   // 卸载时自动执行
})
```

本文 demo 里也有一处真实用法：4.3 给 `toolNames` 加的兜底清理定时器。


---

## 第四章　业务实现（逐文件）

四个文件，职责单一：

```
src/
├── types.ts     类型：通知长什么样、配置长什么样
├── service.ts   服务：怎么把通知发出去（HTTP + 重试 + 容错）
├── plugin.ts    插件：什么时候发、发给谁（业务规则）
└── main.ts      宿主：组装服务与插件，模拟事件
```

### 4.1 `types.ts`：先把"词汇表"定下来

写代码前先定类型，等于先定接口契约。这里有一个设计决定：**`NoticeEventType` 直接用真实 DSH 的事件名**，
这样配置里写 `events: ["turn/end"]` 就和 DSH 日志里的词汇是同一套，读者不用做二次翻译：

```ts
// src/types.ts
import type { SessionEventType } from "@deepseek-ai/dsh-session"

/**
 * 通知事件类型 —— 直接取 DSH 会话事件词汇表（SessionEventType）的子集。
 * 这样配置里写 events: ["turn/end"] 与 DSH 会话日志里的词汇完全一致，读者不用做二次翻译。
 *
 * `SessionEventType = keyof SessionEventMap`，而 SessionEventMap 是**可被插件合并扩展**的，
 * 所以这里用 Extract 取子集而不是硬编码字符串。
 */
export type NoticeEventType = Extract<SessionEventType, "turn/end" | "tool/result">

export type NoticeLevel = "info" | "warning" | "error" | "critical"

export interface NoticePayload {
  type: NoticeEventType
  level: NoticeLevel
  title: string
  content: string
  /** 毫秒时间戳。DSH 的会话事件里这个字段叫 `time`，这里是我们自己 payload 的字段名。 */
  timestamp: number
  sessionId?: string
  metadata?: Record<string, unknown>
}

export interface WebhookConfig {
  url: string
  /** 订阅哪些事件；不写 = 全订阅 */
  events?: NoticeEventType[]
  /** 超时毫秒，默认 5000 */
  timeout?: number
  /** 重试次数，默认 2 */
  retries?: number
  headers?: Record<string, string>
}

export interface NoticeWebhookConfig {
  webhooks: WebhookConfig[]
  enabled?: boolean
  /** 全局级别闸门 */
  minLevel?: NoticeLevel
}
```

**类型从哪来：DSH 提供，插件不用手写。** `session/event` 的签名和整套事件类型都由
**`@deepseek-ai/dsh-session`** 声明（它内部做了 `declare module '@deepseek-ai/cordis'`），
所以本插件**不需要**自己声明事件——`ctx.on("session/event", (session, event) => ...)` 里的
`session` 和 `event` 从一开始就是有类型的。

插件唯一要自己补的增强是**自己的服务**：把 `NoticeService` 挂到 `Context.notice` 上，
这样 `ctx.notice.broadcast(...)` 才能通过类型检查（见文件末尾）。

`NoticeEventType` 则直接取 DSH 词汇表的子集：`Extract<SessionEventType, "turn/end" | "tool/result">`
——用 `Extract` 而不是硬编码字符串，是因为 `SessionEventMap` 允许插件合并扩展。

登记之后，监听器参数才有类型：**`session: Session`、`event: SessionEvent`**；再靠 `event.type` 判断，
TS 还能把 `event` 收窄到具体事件：

```ts
// 把 NoticeService 挂到 Context 上，插件里 ctx.notice 才有类型。
// 用内联 import 而不是顶层 import，避免 types.ts 与 service.ts 互相 import 成环。
declare module "@deepseek-ai/cordis" {
  interface Context {
    notice: import("./service").NoticeService
  }
}
```

注意 `tool/result` 上**没有 `name` 字段、只有 `id`**——这就是 4.3 需要"两阶段关联"的原因。

> 📌 关于模块增强：文件末尾那段 `declare module "@deepseek-ai/cordis"` 就是**模块增强**——
> 它把本插件的 `notice` 服务挂到 `Context` 上。增强要写在**一个**地方（这里就是 `types.ts`），
> **不要散到各个文件**，否则读者得翻半天才知道这个插件往宿主上加了什么。
> 这里 `Context.notice` 用**内联 import**（`import("./service").NoticeService`）而不是顶层 `import`，
> 是为了避开 `types.ts ↔ service.ts` 的循环依赖。

> 💡 **要把它发布成 npm 包时**：模块增强必须随类型声明一起交付，否则宿主和其他插件感知不到 `ctx.notice`。
> 两个前提：
>
> 1. **承载它的文件必须是模块**（有 `import` 或 `export`）。`types.ts` 里有 `export`，符合要求；
>    如果它变成无 import/export 的"脚本"，TS 会把 `declare module` 当作**整模块声明**而不是增强，
>    直接**覆盖 `@deepseek-ai/cordis` 的真实类型**——症状是 `Service` 找不到、`ctx.on` 不存在（实测可复现）。
> 2. **保证它进入最终 `.d.ts`**：打包工具（tsup / tsc）的类型入口要能引用到它，
>    例如让入口 `.d.ts` `import "./types"`，或把 `types.ts` 单列为一个 dts 入口。


### 4.2 `service.ts`：只管"怎么发"

```ts
// src/service.ts
import { Context, Service } from '@deepseek-ai/cordis'
import type { NoticePayload, WebhookConfig } from './types'

/** HTTP 发送结果 */
interface SendResult {
  success: boolean
  statusCode?: number
  error?: string
  duration: number
}

/**
 * NoticeService：通知发送服务
 * 
 * 职责：
 * 1. 发送 HTTP POST 到 Webhook
 * 2. 重试逻辑（失败自动重试）
 * 3. 错误容错（绝不抛异常到调用方）
 * 4. 性能监控（记录耗时）
 */
export class NoticeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'notice')
  }

  /**
   * 发送通知到单个 Webhook
   * 
   * @param webhook Webhook 配置
   * @param payload 通知内容
   * @returns 发送结果（永远返回，不抛异常）
   */
  async send(webhook: WebhookConfig, payload: NoticePayload): Promise<SendResult> {
    const started = Date.now()
    const timeout = webhook.timeout ?? 5000
    const maxRetries = webhook.retries ?? 2

    // 尝试发送（带重试）
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'dsh-notice-webhook/1.0',
            ...webhook.headers,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        const duration = Date.now() - started
        
        if (response.ok) {
          return { success: true, statusCode: response.status, duration }
        } else {
          // HTTP 错误状态码
          const error = `HTTP ${response.status}: ${response.statusText}`
          if (attempt < maxRetries) {
            console.warn(`[NoticeService] 发送失败 (尝试 ${attempt + 1}/${maxRetries + 1}): ${error}`)
            await this.delay(1000 * 2 ** attempt)  // 指数退避：1s、2s、4s
            continue
          }
          return { success: false, statusCode: response.status, error, duration }
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err)
        
        if (attempt < maxRetries) {
          console.warn(`[NoticeService] 发送异常 (尝试 ${attempt + 1}/${maxRetries + 1}): ${error}`)
          await this.delay(1000 * 2 ** attempt)
          continue
        }
        
        const duration = Date.now() - started
        return { success: false, error, duration }
      }
    }

    // 理论上不会到这里（循环会 return）
    return { success: false, error: 'Unknown error', duration: Date.now() - started }
  }

  /**
   * 批量发送到多个 Webhook（并发）
   * 
   * @param webhooks Webhook 配置列表
   * @param payload 通知内容
   */
  async broadcast(webhooks: WebhookConfig[], payload: NoticePayload): Promise<void> {
    const promises = webhooks.map(webhook => this.send(webhook, payload))
    const results = await Promise.all(promises)

    // 记录结果（但不影响主流程）
    results.forEach((result, index) => {
      const webhook = webhooks[index]
      if (result.success) {
        console.log(`[NoticeService] ✅ 通知发送成功: ${webhook.url} (${result.duration}ms)`)
      } else {
        console.error(`[NoticeService] ❌ 通知发送失败: ${webhook.url} - ${result.error}`)
      }
    })
  }

  /** 延迟工具（用于重试退避） */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Context.notice 的类型增强统一在 types.ts 里声明（见该文件末尾），此处不重复
```

三个设计决定，都在前面原理章解释过：

1. **`send` 永远返回结果对象、绝不抛异常**（旁路不该拖垮主流程）；
2. **`broadcast` 用 `Promise.all` 并发**（多个 webhook 不串行等待）；
3. **`declare module` 补类型**：两处增强（`Events` 与 `Context`）集中声明在 `types.ts`（见 4.1），让 `ctx.notice` 和 `ctx.on("session/event", ...)` 都通过类型检查。

### 4.3 `plugin.ts`：业务规则都在这里

这是**最值得复制的一段**——它只监听一个宿主事件，其余全是业务规则：

```ts
// src/plugin.ts
import { Context } from "@deepseek-ai/cordis"
import type { NoticeWebhookConfig, NoticePayload } from "./types"

export const name = "notice-webhook"
export const inject = ["notice"]        // 依赖注入：等 notice 服务就绪

export function apply(ctx: Context, config: NoticeWebhookConfig): void {
  if (config.enabled === false) return
  const webhooks = config.webhooks ?? []
  if (webhooks.length === 0) {
    console.warn("[notice-webhook] 未配置 webhook，插件空转")
    return
  }
  console.log("[notice-webhook] 已加载 " + webhooks.length + " 个 webhook")

  // tool/result 只带 message.toolCallId、不带工具名，所以先用 tool/call 把名字记下来。
  // 记 { name, at } 而不是只记 name：正常情况 tool/call 与 tool/result 成对，
  // 但会话中断、事件丢失时只会留下一半，不做兜底就会一直涨。
  const TOOL_NAME_TTL_MS = 10 * 60 * 1000
  const toolNames = new Map<string, { name: string; at: number }>()

  // 兜底清理：每分钟扫一次，清掉超过 TTL 还没等到 result 的记录。
  // 用 ctx.effect 注册，插件卸载时定时器自动回收。
  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [id, entry] of toolNames) {
        if (now - entry.at > TOOL_NAME_TTL_MS) toolNames.delete(id)
      }
    }, 60_000)
    timer.unref?.()        // 别让清理定时器拖住进程退出（浏览器环境没有 unref，故用可选调用）
    return () => clearInterval(timer)
  })

  // 业务规则：事件订阅过滤 + 级别闸门 + 失败不影响主流程
  function sendNotice(payload: NoticePayload): void {
    const targets = webhooks.filter((w) => {
      if (w.events === undefined || w.events.length === 0) return true
      return w.events.includes(payload.type)
    })
    if (targets.length === 0) return

    if (config.minLevel) {
      const order: NoticePayload["level"][] = ["info", "warning", "error", "critical"]
      if (order.indexOf(payload.level) < order.indexOf(config.minLevel)) return
    }

    ctx.notice.broadcast(targets, payload).catch((err) => {
      console.error("[notice-webhook] 广播失败:", err)
    })
  }

  // ============ 只监听这一个宿主事件：会话事件总线 ============
  // 签名由 @deepseek-ai/dsh-session 声明：'session/event'(session: Session, event: SessionEvent)
  // 注意第一个参数是 Session 对象（id 在 session.header.id），不是 sessionId 字符串。
  ctx.on("session/event", (session, event) => {
    const sessionId = session.header.id

    // 1) 工具调用：先记住 callId -> 工具名
    if (event.type === "tool/call") {
      toolNames.set(event.data.callId, { name: event.data.name, at: Date.now() })
      return
    }

    // 2) 工具结果：只有失败才通知；关联 id 在 message.toolCallId 里
    if (event.type === "tool/result") {
      const callId = event.data.message.toolCallId
      const entry = toolNames.get(callId)
      toolNames.delete(callId)   // 先取再删：消费掉这条记录，重复到达的同 id 结果只能回退到 "unknown"
      if (event.data.message.isError !== true) return
      const toolName = entry?.name ?? "unknown"
      const reason = event.data.error?.reason ?? event.data.error?.name ?? "未提供原因"
      sendNotice({
        type: "tool/result",
        level: "error",
        title: "❌ 工具执行失败",
        content: "工具 " + toolName + " 执行失败：" + reason,
        timestamp: event.time,
        sessionId,
        metadata: { toolName, callId, errorCode: event.data.error?.code },
      })
      return
    }

    // 3) 一轮对话结束：reason.kind 决定级别
    if (event.type === "turn/end") {
      const kind = event.data.reason.kind
      const ok = kind === "completed"
      sendNotice({
        type: "turn/end",
        level: ok ? "info" : "warning",
        title: ok ? "✅ 一轮对话结束" : "⚠️ 一轮对话中断（" + kind + "）",
        content: "会话 " + sessionId + " 的第 " + event.data.turn + " 轮结束",
        timestamp: event.time,
        sessionId,
        metadata: { turn: event.data.turn, reason: kind },
      })
    }
  })

  console.log("[notice-webhook] 已监听 session/event")
}
```

**业务规则一览**（这就是"业务实现"的全部，只有五条）：

| 规则 | 代码位置 | 作用 |
| --- | --- | --- |
| 两阶段关联工具名 | `toolNames.set` / `toolNames.get` | 真实 `tool/result` 只有 `id`，靠 `tool/call` 补名字 |
| 兜底清理 | `{ name, at }` + TTL 扫描 + `ctx.effect` | 异常路径漏下的记录不会一直攒着 |
| 事件订阅过滤 | `w.events.includes(payload.type)` | 每个 webhook 只收自己关心的事件 |
| 级别闸门 | `order.indexOf(...)` 比较 | 生产环境只看 error 以上 |
| 失败不影响主流程 | 服务层不抛 + `.catch()` | webhook 挂了，Agent 照常干活 |

> 关于 `toolNames` 的清理：正常路径下 `tool/call` 与 `tool/result` 成对，`result` 分支里已经 `delete`。
> 但**异常路径确实会漏**——会话中途被中断、进程被杀、事件丢失，都会留下"只有 call 没有 result"的记录，
> 只靠成对删除迟早会涨起来。所以 demo 里存的是 `{ name, at }`，并用 `ctx.effect` 注册了一个
> 每分钟扫一遍、清掉超过 TTL（10 分钟）记录的定时器：**兜底清理不依赖成对假设**。
> 定时器还调了 `unref()`，避免它拖住进程退出。

### 4.4 `main.ts`：宿主怎么把两者装起来

```ts
// src/main.ts —— 本地演练脚本（不属于插件本体，也不是 DSH 的加载路径）
// 真实运行时：插件由 DSH 的 Loader 装进 profile，会话事件由 SessionService 广播。
// 这里伪造一个 Session 和几条会话事件，让 demo 能离线把完整逻辑跑一遍。
import { Context } from "@deepseek-ai/cordis"
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session"
import { NoticeService } from "./service"
import { apply as noticeWebhook, inject, name } from "./plugin"
import type { NoticeWebhookConfig } from "./types"

// 用假的 fetch 顶替真实网络：demo 离线也能看到 webhook 收到了什么
const received: any[] = []
globalThis.fetch = (async (url: any, init: any) => {
  const body = JSON.parse(String(init?.body ?? "{}"))
  received.push({ url: String(url), body })
  console.log("  📨 " + String(url) + " 收到：" + body.title)
  console.log("     正文：" + String(body.content))
  return new Response("{\"ok\":true}", { status: 200 })
}) as typeof fetch

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const app = new Context()

  // 第一步：注册服务（能力提供者）
  await app.plugin(NoticeService)

  // 第二步：安装插件（能力消费者），插件自己声明 inject: ["notice"]
  const config: NoticeWebhookConfig = {
    webhooks: [
      { url: "https://dingtalk.example.com/robot/send", events: ["turn/end"] },
      { url: "https://slack.example.com/hooks/xxx", events: ["tool/result"] },
    ],
    minLevel: "info",
  }
  await app.plugin({ name, inject, apply: noticeWebhook }, config)

  // 第三步：伪造 DSH 的 Session 与会话事件（仅本地演练用）
  // DSH 的事件信封是 { type, seq, time, data }，负载在 data 里。
  const session = { header: { id: "session-001", cwd: process.cwd() } } as unknown as Session
  let seq = 1
  const emit = (type: string, data: unknown) =>
    app.emit("session/event", session, { type, seq: seq++, time: Date.now(), data } as SessionEvent)

  console.log("")
  console.log("▶ 模拟一轮对话：工具失败 → 一轮结束")

  emit("tool/call", { turn: 1, step: 1, callId: "call-1", name: "write_file", arguments: "{\"path\":\"/root/x\"}" })
  await delay(20)
  emit("tool/result", {
    turn: 1,
    step: 1,
    message: { role: "tool", toolCallId: "call-1", isError: true, content: [] },
    error: { name: "EPERM", code: "EPERM", reason: "Permission denied" },
  })
  await delay(20)
  emit("turn/end", { turn: 1, reason: { kind: "completed" } })
  await delay(20)

  console.log("")
  console.log("累计发出 " + received.length + " 条通知")
}

main().catch(console.error)
```

**这就是"嵌入"的完整样子**：`app.plugin(服务)` → `app.plugin(插件, 配置)`。
宿主不 import 插件内部，插件也不 import 宿主代码，两者只靠 `inject` 和事件名连接。

> 换成真实 DSH 时，第三步整段删掉即可——那些事件本来就会由 DSH 自己广播出来。

### 4.5 跑起来

四个文件要跑起来，还需要一份 `package.json`（这是仓库里的全文，逐字一致）：

```json
{
  "name": "blog-notice-webhook",
  "version": "1.0.0",
  "description": "DSH 插件教学：Webhook 通知插件",
  "type": "module",
  "scripts": {
    "dev": "tsx src/main.ts"
  },
  "dependencies": {
    "@deepseek-ai/cordis": "4.0.4"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-session": "0.2.0-rc.2",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

三处值得说明：

- **`@deepseek-ai/cordis` 是 DSH 用的框架包**（`4.0.4`），不是公开的 `@cordisjs/core`——
  换包名是 DSH 插件与普通 Cordis 项目最容易踩的差别；
- **`@deepseek-ai/dsh-session` 只放 devDependencies**：它提供 `session/event` 的签名与事件类型
  （类型是编译期的事，运行时由 DSH 自己装载这个包）；
- **实测版本**：

| 包 | package.json 里声明 | 本文实测 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.4` | 4.0.4 |
| `@deepseek-ai/dsh-session` | `0.2.0-rc.2` | 0.2.0-rc.2 |
| `tsx` | `^4.19.2` | 4.21.0 |
| `typescript` | `^5.7.2` | 5.9.3 |
| `@types/node` | `^22.0.0` | 22.19.10 |

> `dsh-session` 的 npm `latest` 标签是旧的 `0.0.1-rc.1`，与桌面版同版本的 `0.2.0-rc.2` 挂在 `next` 上，
> 所以要写 `@deepseek-ai/dsh-session@next`。实测环境 Node **v25.6.1**。

然后：

```
$ pnpm install && pnpm dev

[notice-webhook] 已加载 2 个 webhook
[notice-webhook] 已监听 session/event

▶ 模拟一轮对话：工具失败 → 一轮结束
  📨 https://slack.example.com/hooks/xxx 收到：❌ 工具执行失败
     正文：工具 write_file 执行失败：Permission denied
[NoticeService] ✅ 通知发送成功: https://slack.example.com/hooks/xxx (1ms)
  📨 https://dingtalk.example.com/robot/send 收到：✅ 一轮对话结束
     正文：会话 session-001 的第 1 轮结束
[NoticeService] ✅ 通知发送成功: https://dingtalk.example.com/robot/send (0ms)

累计发出 2 条通知
```

逐条对照业务规则：

| 现象 | 对应规则 |
| --- | --- |
| 三条事件（`tool/call`、`tool/result`、`turn/end`）只发出 2 条通知 | `tool/call` 只用来关联工具名，不在 `NoticeEventType` 里，不发通知 |
| 通知里出现了 `write_file` | 两阶段关联：`tool/call` 存 `callId → name`，`tool/result` 用 `message.toolCallId` 取回 |
| 工具失败只到 slack | slack 配了 `events: ["tool/result"]` |
| 一轮结束只到 dingtalk | dingtalk 配了 `events: ["turn/end"]` |
| 级别是 error / info | `tool/result` 固定 error；`turn/end` 按 `reason.kind === "completed"` 判 info |

> `main.ts` 是**本地演练脚本**：它伪造 `Session` 与事件信封，只为让你离线跑一遍。
> 真实运行时这些都由 DSH 提供。

> 线上没收到通知时的排查顺序：见附录 **Q3**。

---

## 第五章　小结

### 三个问题，三句话

1. **插件怎么嵌进 DSH**：插件是 Cordis 插件（对象/类），宿主一行 `app.plugin(插件, 配置)` 加载；
   框架负责解析 `inject`、调用 `apply`、把 `ctx.on` 注册的监听器挂到事件总线上。
2. **用了 DSH 的什么**：三大块——拦截点（`tools/pre-execute` 等，能插手）、
   会话事件（`session/event`，能旁听）、服务（`ctx.tools`、`ctx.userQuestions` 等，能调用）。
   通知类插件该接哪个事件，取决于 DSH 把这件事放在哪条流里（见 2.3）。
3. **业务为什么这样实现**：两阶段关联工具名、订阅过滤避免刷屏、级别闸门区分环境、
   失败不抛保证旁路不影响主流程、指数退避提高投递成功率。

### 一个生产级的开源实现

本文的 demo 是**教学简化版**。想看真实的通知插件长什么样，可以读这个开源实现——
1.4 的装载层、2.2 的 `session/event` 入口、4.3 的两阶段关联、4.6 的排查点，都是照着它的思路抽出来的：

**`dsh-notice-webhook`** —— <https://github.com/kakaCat/dsh-notice-webhook>

它把「会话完成 / 等待授权 / 等待回答」三类事件推送到你配置的 webhook。与本文 demo 的对照：

| 本文 demo | 那个实现里 |
| --- | --- |
| `src/service.ts`：投递 + 重试 | `src/deliver.js`：超时、重试、**不跟随重定向（3xx 视为失败）**、日志只记 host（脱敏） |
| `src/plugin.ts`：按 `event.type` 分支 | `src/classify.js`：把会话事件判成 `complete` / `interrupt` / `approval` / `question` 四类意图 |
| 一份全局 `webhooks` 配置 | **每个会话窗口可绑定不同目标**（`bindings.json`）+ 目标清单（`targets.json`） |
| 只有 Host 半 | **Host 半 + Web 客户端半**：`dsh.client` 声明 + `settings.section` 插槽做设置页 |
| 没有投递记录 | 设置页展示每个目标**最近 5 条投递结果**（内存态）；另有 `skipReasons`（默认 `["aborted"]`）、`cooldownMs` 等可查点 |
| 直接 `console.log` | 提供 `dshNoticeWebhook` 服务（`ctx.provide`）供其他插件消费 |
| `src/main.ts` 本地演练脚本 | 34 个测试文件（`node --test`）+ 完整的 `cordis.patch.yml` 装载层 |

> 它同时是 **1.4 / Q2 那套装载机制的真实用例**：`package.json` 里 `dsh.bundle.patch` 指向包内的
> `cordis.patch.yml`，其中的 `insert` 条目就是"往 profile 根上追加一条 Loader 条目"。

---

## 附录：常见问题 FAQ

正文（第 1～4 章）只走主线；把"装对了没、撞车了怎么办、收不到怎么查"这类**排障与边界问题**集中放到这里，需要时再翻。

### Q1　怎么确认插件真的装进去了？

1.4 讲了"放在哪"，这里讲"怎么知道放对了"。**分三层查**，每层都有明确的观察点。

**第 1 层：装没装（文件层，不用启动应用）**

```bash
# dependencies 里有它、dsh.profile.bundles 也列出它 —— 两处必须同时有
cat ~/.dsh/profiles/<profile>/package.json

# 命令行查（dsh plugin 会把参数原样转发给 profile 目录里的 pnpm）
dsh plugin --profile desktop list
```

如果只在 `dependencies` 里、`dsh.profile.bundles` 里没有，**它不会被装载**。

桌面版内置的插件管理在安装时留了日志，装失败时看这里：

```bash
ls -t ~/.dsh/profiles/<profile>/.plugin-manager/logs/ | head -1
# operation-xxxxx/pnpm.log 记着这次装了什么、成功没有
```

**第 2 层：装载没装载（运行时）**

重启 Host 后，在 **Host 日志**里找插件自己打的那行——通知类插件都该有这么一行：

```text
[dsh-notice-webhook] 已激活：目标 2 个，绑定 1 条，总开关 开
```

没看到这行，基本是两种原因：`dsh.profile.bundles` 里没登记，或者**没重启**（Host 半只在启动时加载）。

> ⚠️ 别去 `$DSH_HOME/logs/startup-*.log` 找它：那个目录是**启动失败报告**（启动审计失败时才写一份），不是日志流。

**第 3 层：客户端半（界面）**

刷新页面后，设置里应该出现插件自己的面板。本插件声明了：

```json
"client": { "platform": "web", "immediately": true,
            "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
```

它挂在 `settings.section` 插槽上，所以确认点就是「设置 → 通知推送」这个页面有没有出现。

**口诀：`package.json` 看装没装，Host 日志看活没活，设置页看界面有没有。**


### Q2　多个 bundle 都 insert 同一个 id 会怎样（命名与冲突）？

DSH 的 Loader 把插件树里每一项都按 `id` 索引（`@deepseek-ai/dsh-app-boot` 的 `applyEntryPatches` 建 `entryMap`、
`cordis-plugin-loader` 的 `EntryTree` 建 `store`）。记住三条规则，命名就不会踩坑：

| 情况 | Loader 的实际行为 |
| --- | --- |
| 两个 bundle `insert` **同一个 `id`** | **不报错、也不会加载两次**：`store[id] ??= new Entry()` 复用同一条，配置又按 id 收敛（`Object.fromEntries` 同名后者胜）→ **后者静默覆盖前者** |
| **不写 `id`** | Loader 自动生成随机 id，并用 `while (this.store[id])` **循环避让**已存在的 → 反而安全 |
| 同 `name`、不同 `id` | 两条独立加载、互不影响；`name` 只在 patch 校验时用到 |

**所以写死 `id` 才有撞车风险，而撞车是静默的。**最典型的症状是：

> 我在 profile 的 `cordis.patch.yml` 里按 id 改了 config，但没生效。

那多半是同一个 id 有两条，你的 patch 命中的不是你改的那条。

命名建议：用**带前缀的全局唯一 id**（`dsh-notice-webhook`），别用 `notice`、`webhook` 这种通用词——
你撞的不一定是自己的插件，可能是别人 bundle 里的条目。

**patch 没命中时 Loader 只 warn、不报错**，所以这几条 warn 值得直接去 Host 日志里搜：

```text
patch: entry %C not found
patch insert: entry %C not found
patch insert: entry %C is not a group
patch: name mismatch for %C (expected %C, got %C), skipping
patch: id is required for non-insert patches
```

> 还有一条容易踩：`insert` **带 `id`** 时，目标必须是 group（能挂 `config` 数组的条目），
> 否则 warn `is not a group` 后跳过；**不带 `id`** 的 `insert` 才是"往根上追加"——本插件的 patch 属于后者。



### Q3　webhook 没收到通知，该从哪几个点排查？

这是通知类插件最高频的用户问题。**顺着数据流从上游往下游查**，能一次定位到环节，而不是到处试：

| 环节 | 观察点 | 本 demo 的对应代码 |
| --- | --- | --- |
| 1. 插件活了吗 | Host 日志里的激活行（见 Q1） | `[notice-webhook] 已加载 N 个 webhook` |
| 2. 事件来了吗 | 监听器里打日志；临时把 `session/event` 全量打印 | `ctx.on("session/event", ...)` |
| 3. 被规则挡了吗 | 事件是否在 `events` 订阅里；级别是否 ≥ `minLevel` | 4.3 的两条过滤 |
| 4. 发出去了吗 | 服务层会打 `✅ 发送成功` / `❌ 发送失败` | `broadcast()` 的结果日志 |
| 5. 出站被拦了吗 | 超时、3xx 被当成失败、接收端只认特定 Content-Type | `send()` 的超时与重试 |
| 6. 接收端认了吗 | 用本地接收端把"发出去了"和"被接受了"分开 | —— |

**第 6 步最值钱**：先证明插件确实发出去了，再去怀疑群机器人的规则。本地接收端用 Python 3 自带库就能起：

```bash
python3 - <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        print("收到:", self.rfile.read(n).decode("utf-8", "replace"))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", 8787), H).serve_forever()
PY
```

把 webhook 地址临时指向 `http://127.0.0.1:8787` 跑一轮：

- **有打印** → 插件侧没问题，去查真实接收端（token、关键词、签名、IP 白名单）；
- **没打印** → 问题在插件侧，回到第 2～4 步。

真实的通知插件在这条链路上还该提供几个**可查点**，值得照抄进你自己的实现（本节 demo 为了短没做）：

| 可查点 | 为什么重要 |
| --- | --- |
| 投递历史（每目标最近 N 条，含状态码） | 直接回答第 4 步，不用翻日志 |
| 跳过原因白名单（如 `skipReasons: ["aborted"]`） | 被"主动跳过"的终态很容易被误判成"丢了" |
| 冷却窗口（如 `cooldownMs`） | 非 0 时高频事件会被压掉，现象就是"少了通知" |
| 脱敏日志（只记 host，不记 query/headers） | token 常在 query 里；这同时解释了"日志里看不到完整 URL" |

---

## 引用本文

- **标题**：从零给 DSH 写一个 Webhook 通知插件
- **作者**：learn-dh
- **最后更新**：2026-10-08
- **代码**：见正文第 4 章（四个文件 + `package.json` 全文）
- **事实来源**（便于引用与核查）：
  - `session/event` 签名与事件字段：`@deepseek-ai/dsh-session@0.2.0-rc.2` 的 `lib/types/index.d.ts`、`lib/types/types.d.ts`
  - Loader 的 patch 合并语义（`insert` / 同 id 覆盖）：桌面版 `app.asar` 内的 `@deepseek-ai/dsh-app-boot`、`@deepseek-ai/cordis-plugin-loader`
