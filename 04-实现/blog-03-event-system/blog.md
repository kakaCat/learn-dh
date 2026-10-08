---
title: "DeepSeek Harness 从 0 开始：事件系统"
description: "基于 Cordis 框架从 0 开始实现简略版 DeepSeek Harness 的第三篇：Cordis 事件系统的五种派发模式（emit / parallel / serial / bail / waterfall）、waterfall 洋葱模型高级用法，以及 ctx.effect() 资源清理。"
keywords: [Cordis, DeepSeek Harness, 事件系统, emit, parallel, serial, bail, waterfall, 中间件, effect, TypeScript]
tags: [Cordis, DeepSeek Harness, Agent, 事件系统, TypeScript]
author: "learn-dh"
date: "2026-08-19"
lang: "zh-CN"
og:
  title: "DeepSeek Harness 从 0 开始：事件系统"
  description: "五种事件派发模式 + 洋葱模型中间件 + effect 资源清理，用事件让 Agent 模块松耦合地通信。"
  type: "article"
---

# DeepSeek Harness 从 0 开始：事件系统

> 本系列从 0 开始，基于 Cordis 框架一步步实现一个简略版本的 DeepSeek Harness（loop、session、tool、system prompt 等）。上一篇我们用依赖注入解决了「服务之间怎么互相使用」，这一篇解决「服务之间怎么互相**通知**」——事件系统。
>
> 配套代码：[blog-03-event-system](./)，运行 `pnpm install && pnpm dev` 即可复现本文全部输出。

## 上一篇留下的问题

依赖注入解决了「A 要调用 B 的方法」，但还有一类需求它处理不好：

- **Session 记录了一条新消息，谁想知道？** 可能是 Tools 模块、可能是 Agent Loop、可能是日志插件——它们都要知道，而且数量不固定；
- **LLM 返回了一个结果，谁要处理？** 现在只有 Loop 关心，明天可能加一个审计插件也关心。

如果让 Session 直接调用每个关心者的方法，就产生了**紧耦合**：Session 得知道「有哪些人关心、以什么顺序调用」。插件一多，Session 的代码里全是别人的调用。

事件系统把这件事反转过来：**Session 只负责广播「发生了什么」，关心的人自己注册监听**。发的人不认识收的人，收的人也不影响发的人。

```
紧耦合：Session ──调用──▶ Tools / Loop / 日志插件（Session 必须认识所有人）

事件系统：Session ──emit('message')──▶ ⋯⋯ 谁关心谁监听
           Tools ◀─on('message')──┘
           Loop  ◀─on('message')──┘
           日志  ◀─on('message')──┘
```

## 项目目录结构

```
blog-03-event-system/
├── package.json          # 项目配置：依赖、启动脚本
├── package-lock.json     # 依赖锁定文件
├── tsconfig.json         # TypeScript 编译配置
├── README.md             # 项目说明
└── src/
    └── main.ts           # 代码入口，pnpm dev 运行它
```

## 核心概念

Cordis 的事件系统有一个关键设定：**一个事件有五种派发模式**，每种模式解决一类问题。

| 模式 | 是否等待 | 执行方式 | 能否短路 | 典型场景 |
| --- | :-: | :-: | :-: | --- |
| **emit** | 不等 | 全部触发（异步监听器不阻塞） | ❌ | 通知、日志、触发即忘 |
| **parallel** | 等 | 并发执行 | ❌ | 多个独立任务（如同时多端备份） |
| **serial** | 等 | 串行，返回非空即停 | ✅ | 责任链：找第一个能处理的处理器 |
| **bail** | 同步 | 串行，返回非空即停 | ✅ | 同步校验：权限检查、验证链 |
| **waterfall** | 等 | 洋葱模型，`next()` 包裹 | ✅ | 中间件：请求处理管道、缓存 |

## Part 1：五种事件派发模式

### 1. emit —— 触发即忘

```ts
// 注册同步监听器：立即执行完成
ctx.on('user-login', (userId: string) => {
  console.log(`  [同步监听器] 用户 ${userId} 登录`)
})

// 注册异步监听器：emit 不会等待它完成
ctx.on('user-login', async (userId: string) => {
  console.log(`  [异步监听器] 开始发送欢迎邮件...`)
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log(`  [异步监听器] 邮件发送完成（但 emit 不等它）`)
})

// emit：触发所有监听器，但不等待异步监听器完成
ctx.emit('user-login', 'alice')
```

运行输出：

```
派发 emit...
  [同步监听器] 用户 alice 登录
  [异步监听器] 开始发送欢迎邮件...
emit 立即返回，异步监听器在后台继续

  [异步监听器] 邮件发送完成（但 emit 不等它）
```

**特点**：`ctx.emit()` 立即返回，同步监听器当场执行完，异步监听器在后台继续跑，**不阻塞**。适合「通知类」场景——发出消息就算完成任务，不关心监听器做了什么、做没做完。

### 2. parallel —— 并发执行

```ts
// 监听器1：耗时 200ms
ctx.on('save-data', async (data: string) => {
  console.log('  [数据库] 开始保存...')
  await new Promise(resolve => setTimeout(resolve, 200))
  console.log('  [数据库] 完成')
})

// 监听器2：耗时 150ms
ctx.on('save-data', async (data: string) => {
  console.log('  [云存储] 开始备份...')
  await new Promise(resolve => setTimeout(resolve, 150))
  console.log('  [云存储] 完成')
})

// 监听器3：耗时 100ms
ctx.on('save-data', async (data: string) => {
  console.log('  [通知] 开始发送...')
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log('  [通知] 完成')
})

// parallel：并发执行所有监听器，等待全部完成
// 总耗时 = max(200, 150, 100) = 200ms（而非 450ms）
await ctx.parallel('save-data', 'important-data')
```

运行输出：

```
派发 parallel...
  [数据库] 开始保存...
  [云存储] 开始备份...
  [通知] 开始发送...
  [通知] 完成
  [云存储] 完成
  [数据库] 完成
✅ 所有监听器都完成了（并发执行，总耗时约 200ms）
```

**特点**：所有监听器**并发**执行，`await` 等到全部完成才继续。注意完成顺序（通知 → 云存储 → 数据库）与注册顺序无关，取决于各自耗时——这就是并发的标志。适合「多个独立任务」：同时保存到数据库、云存储、发通知。

### 3. serial —— 串行执行（可短路）

```ts
// 处理器1：只能处理 task-a
ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器1] 检查 "${request}"`)
  if (request === 'task-a') {
    console.log('  [处理器1] ✅ 我可以处理')
    return 'handler-1'  // 返回非空值，后续监听器将被跳过
  }
  console.log('  [处理器1] ❌ 不能处理')
  return null  // 返回 null，继续下一个监听器
})

// 处理器2：只能处理 task-b
ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器2] 检查 "${request}"`)
  if (request === 'task-b') {
    console.log('  [处理器2] ✅ 我可以处理')
    return 'handler-2'  // 返回非空值，停止执行
  }
  console.log('  [处理器2] ❌ 不能处理')
  return null
})

// 处理器3：兜底处理器（因为短路机制，可能不会被执行）
ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器3] 检查 "${request}"`)
  console.log('  [处理器3] ❌ 不能处理')
  return null
})

// serial：串行执行，支持短路（遇到非空返回值立即停止）
const handler = await ctx.serial('find-handler', 'task-b')
```

运行输出：

```
派发 serial (task-b)...
  [处理器1] 检查 "task-b"
  [处理器1] ❌ 不能处理
  [处理器2] 检查 "task-b"
  [处理器2] ✅ 我可以处理
✅ 找到处理器: handler-2（处理器3 被跳过）
```

**特点**：监听器**按注册顺序**一个个执行，支持异步；任何监听器**返回非空值**（非 `null`/`undefined`）就停止，后续监听器被跳过。这就是经典的责任链模式——**找到第一个能处理的人**。

### 4. bail —— 同步短路

```ts
// 检查1：普通检查
ctx.on('check-permission', (action: string) => {
  console.log('  [检查1] 检查中...')
  if (action === 'read') return null
  return null  // 继续下一个检查
})

// 检查2：拒绝写入操作
ctx.on('check-permission', (action: string) => {
  if (action === 'write') {
    console.log('  [检查2] 拒绝写入操作')
    return 'denied'  // 返回非空值，立即停止
  }
  return null
})

// 检查3：兜底检查（可能不会执行）
ctx.on('check-permission', (action: string) => {
  console.log('  [检查3] 默认允许')
  return 'allowed'
})

// bail：同步串行执行，支持短路
const permission = ctx.bail('check-permission', 'write')
```

运行输出：

```
派发 bail (write)...
  [检查1] 检查中...
  [检查2] 拒绝写入操作
✅ 结果: denied（检查3 被跳过）
```

**特点**：和 serial 一样是「串行 + 短路」，但**只支持同步监听器**（不能是 async）。适合同步的校验链：权限检查、参数验证——每个检查都能一票否决。

> serial vs bail 怎么选：监听器是异步的用 serial，纯同步的用 bail（更轻量）。

### 5. waterfall —— 洋葱模型（中间件模式）

```ts
// 中间件1：缓存层（最外层）
ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('  [缓存层] 进入 → 检查缓存')
  console.log('  [缓存层] 未命中，调用 next()')
  const result = await next()  // 调用下一层中间件
  console.log('  [缓存层] 返回 ← 保存到缓存')
  return result  // 返回结果给上一层
})

// 中间件2：认证层（中间层）
ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('    [认证层] 进入 → 验证用户')
  console.log('    [认证层] 通过，调用 next()')
  const result = await next()  // 调用下一层
  console.log('    [认证层] 返回 ← 清理信息')
  return result
})

// 中间件3：日志层（最内层）
ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('      [日志层] 进入 → 记录开始')
  console.log('      [日志层] 调用 next()')
  const result = await next()  // 调用核心处理函数
  console.log('      [日志层] 返回 ← 记录完成')
  return result
})

// waterfall：最后一个参数是核心逻辑，最内层执行
const result = await ctx.waterfall('process-request', { url: '/api/data' }, async () => {
  console.log('        [核心] 处理请求')
  return { status: 200, data: 'response' }
})
```

运行输出：

```
派发 waterfall...
  [缓存层] 进入 → 检查缓存
  [缓存层] 未命中，调用 next()
    [认证层] 进入 → 验证用户
    [认证层] 通过，调用 next()
      [日志层] 进入 → 记录开始
      [日志层] 调用 next()
        [核心] 处理请求
      [日志层] 返回 ← 记录完成
    [认证层] 返回 ← 清理信息
  [缓存层] 返回 ← 保存到缓存
✅ 最终结果: {"status":200,"data":"response"}
```

**特点**：每个监听器接收 `(参数, next)`，`next()` 调用下一层。执行顺序像洋葱——**一层层进，再一层层出**：

```
缓存层 → 认证层 → 日志层 → 核心 → 日志层 → 认证层 → 缓存层
```

每层中间件可以：
1. `next()` 之前做**前置处理**（检查缓存、验证用户）
2. `next()` 之后做**后置处理**（保存缓存、记录完成）
3. **不调用 `next()`** 短路请求
4. 修改传入/返回的数据

这就是 HTTP 框架（Express/Koa）的中间件模型，也是我们后续 Agent Loop 拦截点（pre-step、request、turn-stopping）的底层机制。

#### 换个角度看：洋葱模型 = AOP（面向切面编程）

如果你学过 Spring / NestJS 的 AOP，会发现洋葱模型本质就是一种**显式的、函数式的 AOP**——把横切逻辑（日志、鉴权、缓存）从业务代码里抽出来，织入到业务执行的前后，业务本身保持纯净：

| AOP 术语 | 对应洋葱模型 |
| --- | --- |
| 切面（Aspect） | 中间件层（缓存层、认证层、日志层） |
| 前置通知（Before） | `next()` 之前的逻辑（检查缓存、验证用户） |
| 后置通知（After） | `next()` 之后的逻辑（保存缓存、记录完成） |
| 切入点（Pointcut） | 事件名（`'process-request'`） |
| 织入（Weaving） | `ctx.on()` 注册监听器 |
| 目标（Target） | 核心处理函数（waterfall 最后一个参数） |

```ts
// ❌ 没有 AOP：每个业务方法都要手写日志、鉴权、缓存
async function getData(id: string) {
  console.log('开始')                      // 日志
  if (!checkAuth()) throw new Error()      // 鉴权
  if (cache.has(id)) return cache.get(id)  // 缓存
  const data = await db.query(id)          // 真正业务
  cache.set(id, data)
  console.log('结束')
  return data
}

// ✅ AOP / 中间件：横切逻辑抽成独立层，业务只剩业务
ctx.on('process-request', async (req, next) => {
  console.log('开始')          // 日志切面
  return await next()
})
ctx.on('process-request', async (req, next) => {
  if (!checkAuth()) throw new Error()  // 鉴权切面
  return await next()
})
ctx.on('process-request', async (req, next) => {
  if (cache.has(req.id)) return cache.get(req.id)  // 缓存切面
  const result = await next()
  cache.set(req.id, result)
  return result
})

// 核心函数里只剩真正的业务
const data = await ctx.waterfall('process-request', req, coreLogic)
```

与经典 AOP（Spring AOP 的代理、注解）相比，洋葱模型的差异是：**没有代理和注解魔法，切面就是普通函数，`next()` 就是织入点**——可读性更强，顺序由注册顺序决定。

对 Agent 框架的意义：后续的 Agent Loop 会用洋葱模型把**日志 / 审计 / 限流 / 安全检查**全部做成中间件层，核心循环保持纯净——这正是 AOP 的价值。

## Part 2：Waterfall 深入

waterfall 不只是「洋葱」，还能实现短路、修改参数、缓存等高级功能。

### 用法 1：短路（权限检查）

```ts
// 权限检查中间件：权限不足直接抛错，不调用 next()
ctx.on('api/request', async (req: any, next: () => any) => {
  console.log('  [权限检查] 进入')
  if (req.user === 'anonymous') {
    console.log('  [权限检查] ❌ 拒绝（短路，不调用 next）')
    throw new Error('Permission denied')  // 后续中间件和核心逻辑都不执行
  }
  console.log('  [权限检查] ✅ 通过')
  return await next()
})

// 业务逻辑中间件（权限检查失败时不会执行）
ctx.on('api/request', async (req: any, next: () => any) => {
  console.log('  [业务逻辑] 执行')
  return { data: 'sensitive-data' }
})

try {
  await ctx.waterfall('api/request', { user: 'anonymous' }, async () => {
    console.log('  [核心] 这行不会执行')
    return {}
  })
} catch (error: any) {
  console.log(`  ✅ 错误被捕获: ${error.message}`)
}
```

运行输出：

```
  [权限检查] 进入
  [权限检查] ❌ 拒绝（短路，不调用 next）
  ✅ 错误被捕获: Permission denied
```

**不调用 `next()`（或抛错）= 短路**，外层在 `next()` 返回前就拿到结果，后续中间件和核心逻辑全部跳过。

### 用法 2：修改参数与结果

```ts
// 转换层1
ctx.on('transform', async (data: string, next: () => any) => {
  console.log(`  [转换1] 输入: "${data}"`)
  const modified = data.toUpperCase()
  console.log(`  [转换1] 修改后: "${modified}"`)
  const result = await next()
  return result + ' [layer1]'  // 修改返回结果，加层级标记
})

// 转换层2
ctx.on('transform', async (data: string, next: () => any) => {
  console.log(`  [转换2] 输入: "${data}"`)
  const modified = data + ' [transformed]'
  console.log(`  [转换2] 修改后: "${modified}"`)
  const result = await next()
  return result + ' [layer2]'
})

const transformed = await ctx.waterfall('transform', 'hello', async () => {
  console.log('    [核心] 处理')
  return 'result'
})
```

运行输出：

```
  [转换1] 输入: "hello"
  [转换1] 修改后: "HELLO"
  [转换2] 输入: "hello"
  [转换2] 修改后: "hello [transformed]"
    [核心] 处理
  ✅ 最终结果: "result [layer2] [layer1]"
```

**注意一个易错点**：waterfall 的**入参对所有中间件原样传递**——两个转换层收到的都是 `"hello"`，内层的修改不影响外层（`[转换1]` 的 `HELLO` 没传给 `[转换2]`）。但**返回结果会逐层被包裹**：核心返回 `'result'` → 转换2 加 `[layer2]` → 转换1 加 `[layer1]`。想修改传给下一层的数据，需要用别的机制（比如共享的可变对象）。

### 用法 3：缓存

```ts
// 缓存中间件：最外层拦截请求
const cache = new Map<string, any>()

ctx.on('expensive-operation', async (input: string, next: () => any) => {
  const key = `op:${input}`

  // 缓存命中：直接返回，不调用 next()（短路，核心逻辑不执行）
  if (cache.has(key)) {
    console.log(`  [缓存] ✅ 命中: ${input}`)
    return cache.get(key)
  }

  // 未命中：调 next() 执行核心逻辑，再保存结果
  console.log(`  [缓存] ❌ 未命中: ${input}`)
  const result = await next()
  cache.set(key, result)
  console.log(`  [缓存] 💾 已保存: ${input}`)
  return result
})

// 第一次调用（未命中）
const r1 = await ctx.waterfall('expensive-operation', 'task-1', async () => {
  console.log('  [核心] ⏳ 执行耗时操作...')
  await new Promise(resolve => setTimeout(resolve, 100))
  return { result: 'computed' }
})

// 第二次调用（命中，核心逻辑被跳过）
const r2 = await ctx.waterfall('expensive-operation', 'task-1', async () => {
  console.log('  [核心] ⏳ 执行耗时操作...（不会执行）')
  await new Promise(resolve => setTimeout(resolve, 100))
  return { result: 'computed' }
})
```

运行输出：

```
第一次调用:
  [缓存] ❌ 未命中: task-1
  [核心] ⏳ 执行耗时操作...
  [缓存] 💾 已保存: task-1
  结果: {"result":"computed"}

第二次调用:
  [缓存] ✅ 命中: task-1
  结果: {"result":"computed"}
  ✅ 缓存命中，核心逻辑被跳过
```

**缓存中间件是短路的最佳应用**：命中时不调 `next()`，核心逻辑整段跳过——昂贵操作只执行一次。这对 Agent 场景很有用：比如 LLM 响应的缓存、工具结果的缓存。

## Part 3：清理函数（Effect）——别让监听器泄漏

### 问题：不清理监听器的后果

```ts
// ❌ 不正确的插件：注册了监听器但不清理
function leakyPlugin(ctx: Context) {
  console.log('  [插件] 注册了一个事件监听器')
  // 直接注册监听器，没有保存返回的 dispose 函数
  ctx.on('data-update', (data: string) => {
    console.log(`  [监听器] 收到数据: ${data}`)
  })
  // ❌ 插件卸载后，监听器仍然存在于 Context 中 → 内存泄漏
}

const fork = ctx.plugin(leakyPlugin)
await fork

ctx.emit('data-update', 'test-1')

await fork.dispose()  // 卸载插件

ctx.emit('data-update', 'test-2')  // ❌ 监听器仍然被触发！
```

运行输出：

```
派发事件...
  [监听器] 收到数据: test-1

卸载插件...

再次派发事件...
  ❌ 监听器仍然被触发（内存泄漏）
```

插件虽然卸载了，但监听器还挂在 Context 上继续响应——内存泄漏，而且行为不可预期（幽灵监听器还在处理事件）。

### 解决方案：`ctx.effect()` 自动清理

```ts
// ✅ 正确的插件：使用 ctx.effect() 管理资源
function cleanPlugin(ctx: Context) {
  console.log('  [插件] 使用 ctx.effect() 注册监听器')

  // ctx.effect() 接收一个设置函数
  ctx.effect(() => {
    console.log('  [Effect] 设置事件监听器')

    // 注册监听器，保存返回的 dispose 函数
    const dispose = ctx.on('data-update', (data: string) => {
      console.log(`  [监听器] 收到数据: ${data}`)
    })

    // 返回清理函数：插件卸载或 Context 销毁时自动调用
    return () => {
      console.log('  [Effect] 移除事件监听器')
      dispose()  // 调用 dispose 移除监听器
    }
  })
}

const fork2 = ctx.plugin(cleanPlugin)
await fork2

ctx.emit('data-update', 'test-1')

await fork2.dispose()  // 自动调用 effect 的清理函数

ctx.emit('data-update', 'test-2')  // ✅ 监听器已被移除
```

运行输出：

```
派发事件...
  [监听器] 收到数据: test-1

卸载插件...
  [Effect] 移除事件监听器

再次派发事件...
  ✅ 监听器已被移除，不会触发
```

**`ctx.effect(setup)` 的模式**：setup 负责「打开资源」（注册监听器、建连接、开定时器），返回 cleanup 负责「关闭资源」。插件卸载或 Context 销毁时，框架自动执行所有 cleanup——**打开和关闭写在同一个地方，永远不会忘**。

### Effect 的通用性

effect 不只管监听器，任何需要清理的资源都可以：

```ts
// Effect 1: 定时器
ctx.effect(() => {
  console.log('  [Effect 1] 设置定时器')
  const timer = setInterval(() => console.log('  [定时器] tick'), 500)
  return () => {
    console.log('  [Effect 1] 清理定时器')
    clearInterval(timer)
  }
})

// Effect 2: 文件监听（模拟）
ctx.effect(() => {
  console.log('  [Effect 2] 打开文件监听')
  return () => console.log('  [Effect 2] 关闭文件监听')
})

// Effect 3: 数据库连接（模拟）
ctx.effect(() => {
  console.log('  [Effect 3] 建立数据库连接')
  return () => console.log('  [Effect 3] 关闭数据库连接')
})

await new Promise(resolve => setTimeout(resolve, 1200))

// 销毁 Context，自动调用所有 effect 的清理函数
await ctx.fiber.dispose()
```

运行输出：

```
注册多个 effect...
  [Effect 1] 设置定时器
  [Effect 2] 打开文件监听
  [Effect 3] 建立数据库连接
  [定时器] tick
  [定时器] tick

🗑️  销毁 Context...
（清理函数按 LIFO 后进先出 顺序执行）

  [Effect 3] 关闭数据库连接
  [Effect 2] 关闭文件监听
  [Effect 1] 清理定时器
```

清理顺序是 **LIFO（后进先出）**——像栈一样，后注册的先清理。这符合常识：后打开的资源往往依赖先打开的资源，先关后开的、再关先开的。

## 常见问题 FAQ

**Q: emit 和 parallel 有什么区别？**

A: 关键在「等不等」。`emit` 触发后**立即返回**，异步监听器在后台继续跑，调用方不等结果；`parallel` 会 **`await` 所有监听器执行完**才返回。选型看调用方是否需要确认「大家都处理完了」：通知类（发完就算）用 emit；多端同步类（必须都成功才算完成）用 parallel。

**Q: serial 和 bail 有什么区别？**

A: 两者都是「串行 + 短路」（返回非空值即停），区别是 `serial` 支持**异步**监听器（`async` 函数，返回 Promise），`bail` 只支持**同步**监听器。异步的责任链（如处理器可能要做 IO）用 serial；纯同步校验链（权限、参数检查）用 bail，更轻量。

**Q: waterfall 和 serial 的区别？**

A: 完全不同的模型。`serial` 是「**第一个返回非空值的赢**」——短路后结果直接冒泡，后续监听器不再执行；`waterfall` 是「**所有监听器都参与、层层包裹**」——每层都有机会在前/后处理，`next()` 决定是否继续深入。serial 适合「找一个处理器」，waterfall 适合「请求处理管道」（每层都处理一遍）。

**Q: 洋葱模型和 AOP 是什么关系？**

A: 洋葱模型本质就是一种**显式的、函数式的 AOP（面向切面编程）**。AOP 把横切逻辑（日志、鉴权、缓存）从业务代码里抽出来织入前后；洋葱模型里中间件层就是「切面」，`next()` 之前是「前置通知」、之后是「后置通知」，`ctx.on()` 注册就是「织入」。区别只在于经典 AOP 用代理/注解实现，洋葱模型用普通函数 + `next()` 显式实现——后者更直白，没有魔法。

**Q: `ctx.on()` 返回什么？为什么要保存它？**

A: 返回一个 `dispose` 函数（取消监听器）。保存它是为了在插件卸载时能手动移除监听器；更推荐的做法是把注册放进 `ctx.effect()` 里，让框架在卸载时自动调用 dispose——两条路都能防止监听器泄漏。

**Q: 五种模式我该用哪个？**

A: 看场景：
- **通知/日志**（不关心结果）→ emit
- **多个独立任务并发**（必须都完成）→ parallel
- **找第一个能处理的**（异步）→ serial
- **同步校验链** → bail
- **请求处理管道/中间件** → waterfall

## 小结

1. **五种派发模式**：emit（触发即忘）/ parallel（并发等待）/ serial（异步责任链）/ bail（同步校验链）/ waterfall（洋葱中间件）；
2. **waterfall 最强大**：前置/后置处理、短路（不调 next）、结果包裹、缓存拦截——它就是 Agent Loop 拦截点的底层机制；
3. **`ctx.effect()` 防泄漏**：setup 返回 cleanup，卸载自动执行，LIFO 顺序清理；
4. **事件让模块松耦合**：发事件的人不认识监听的人，监听的人也不影响发的人——这正是 Session、Tools、Loop 之间通信的方式。

**下一篇预告**：Session 模块——用事件日志（append-only）记录 Agent 的每一步，事件如何派生成发给 LLM 的消息？

---

*本文代码已验证可运行（Node.js + tsx，@cordisjs/core v4.0.0-beta.5）。完整源码见同目录 `src/main.ts`。*
