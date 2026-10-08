---
title: "DeepSeek Harness 从 0 开始：Cordis 核心概念入门"
description: "基于 Cordis 框架从 0 开始实现简略版 DeepSeek Harness 的第一篇：理解 Context 容器、插件的三种形态（函数 / 对象 / 类），以及如何用 ctx.provide() 注册服务。"
keywords: [Cordis, DeepSeek Harness, Context, 插件, 依赖注入, TypeScript, Agent 框架, 教学]
tags: [Cordis, DeepSeek Harness, Agent, 插件系统, TypeScript]
author: "learn-dh"
date: "2026-08-19"
lang: "zh-CN"
og:
  title: "DeepSeek Harness 从 0 开始：Cordis 核心概念入门"
  description: "从 Context 与插件开始，一步步用 Cordis 搭建你自己的 DeepSeek Harness。"
  type: "article"
---

# DeepSeek Harness 从 0 开始：Cordis 核心概念入门

> 本系列从 0 开始，基于 Cordis 框架一步步实现一个简略版本的 DeepSeek Harness（loop、session、tool、system prompt 等）。这是第一篇：在写任何 Agent 逻辑之前，先搞清楚 Cordis 的两个核心概念。
>


## 为什么是 Cordis？

我们要实现的 Agent 框架天然是模块化的：Session 管理、Tools 系统、System Prompt 组装、LLM 调用、Agent Loop……这些模块之间需要互相依赖、共享状态、响应事件，还要支持插件式扩展。

Cordis 就是为这种场景设计的框架（它也是 Koishi 的底层框架）。它的核心抽象只有两个：

| 概念 | 一句话理解 |
| --- | --- |
| **Context** | 一个容器，存放服务，管理插件生命周期 |
| **Plugin** | 向容器里装东西的功能单元，有三种形态 |

本文通过一个可以实际运行的示例，把这两个概念讲透。

## 准备工作

```bash
# 初始化 package.json
pnpm init

# 安装 Cordis 框架核心包（运行时依赖）
pnpm add @cordisjs/core

# 安装开发依赖：tsx 运行 TS、typescript 编译器、node 类型定义
pnpm add -D tsx typescript @types/node
```

`package.json` 中加一个启动脚本：

```jsonc
{
  "type": "module",                  // ES Module 语法（支持 import / export）
  "scripts": {
    "dev": "tsx src/main.ts"         // 用 tsx 直接运行 TypeScript 入口
  },
  "dependencies": {
    "@cordisjs/core": "^4.0.0-beta.5" // Cordis 框架核心包
  }
}
```

## Part 1：Hello World —— 认识 Context

先看一下项目目录结构：

```
blog-01-core-concepts/
├── package.json          # 项目配置：依赖、启动脚本
├── package-lock.json     # 依赖锁定文件（pnpm 自动生成）
├── tsconfig.json         # TypeScript 编译配置
├── README.md             # 项目说明
├── blog.md               # 本文档
└── src/
    └── main.ts           # 代码入口，pnpm dev 运行它
```

我们的所有代码都写在 `src/main.ts` 里，`pnpm dev` 会用 tsx 直接运行它。

先看最简单的 Cordis 程序：

```ts
import { Context } from '@cordisjs/core'

// 插件就是一个函数，接收一个 Context 参数
function helloPlugin(ctx: Context) {
  console.log('🎉 Hello from plugin!')

  // 向 Context 注册一个服务（使用 ctx.provide()）
  // 这样其他插件就可以通过 ctx.hello 访问它
  ctx.provide('hello', {
    // 对外提供的方法：打招呼
    say(name: string) {
      return `Hello, ${name}!`
    }
  })
}

// 1️⃣ 创建 Context
const ctx = new Context()

// 2️⃣ 注册插件（注意：ctx.plugin() 是异步的，需要 await）
await ctx.plugin(helloPlugin)

// 3️⃣ 使用服务
console.log(ctx.hello.say('World'))  // Hello, World!
```

运行输出：

```
1️⃣  创建 Context...
2️⃣  注册插件...
🎉 Hello from plugin!
3️⃣  使用服务...
Hello, World!
```

### 关键点

**Context 是一个容器。** 它里面可以存放各种服务；插件可以向里面添加服务；其他插件可以从里面获取服务。这就是 Cordis 世界的基本交互模式：

```
插件 A ──ctx.provide('hello', ...)──▶ Context ◀──ctx.hello.say(...)── 插件 B
```

**`ctx.provide(name, value)`** 把一个叫 `name` 的服务挂到 Context 上，之后任何拿到这个 Context 的代码都能通过 `ctx[name]` 访问它。服务可以是普通对象，也可以是我们后面会讲到的类实例。

**`ctx.plugin()` 是异步的。** 注册插件时别忘了 `await`，否则插件可能还没激活你就开始用它了。

## Part 2：插件的三种形态

插件的本质是"接收 Context 并做点什么"的东西，但 Cordis 允许三种写法，各有适用场景。

### 形态一：函数插件

```ts
// 形态1：函数插件（Part 1 的方式）
function loggerPlugin(ctx: Context) {
  console.log('✅ 函数插件 logger 已激活')

  // 插件的内部状态（私有数据，外部无法直接访问）
  const logs: string[] = []

  // 注册服务：'logger' 是服务名（自定义），会挂载到 ctx.logger
  // 函数插件没有 name 属性，所以服务名完全由 provide() 的第一个参数决定
  ctx.provide('logger', {
    // 对外提供的方法：记录日志
    log(message: string) {
      const entry = `[${new Date().toLocaleTimeString()}] ${message}`
      logs.push(entry)
      console.log(entry)
    },
    // 对外提供的方法：获取所有日志
    getLogs() {
      return [...logs]
    }
  })
}
```

最简单直接，适合逻辑不复杂的插件。注意 `logs` 数组是闭包里的私有状态——外部只能通过 `ctx.logger` 暴露的方法间接访问，这就是天然的封装。

### 形态二：对象插件

```ts
// 形态2：对象插件（可以携带 name 等元信息）
const counterPlugin = {
  // 插件的名字，用于日志、调试、依赖声明等元信息
  name: 'counter',
  // 核心逻辑写在 apply 方法里
  apply(ctx: Context) {
    console.log('✅ 对象插件 counter 已激活')

    // 插件的内部状态
    let count = 0

    // 注册服务：'counter' 是服务名（自定义），会挂载到 ctx.counter
    ctx.provide('counter', {
      // 对外提供的方法：递增计数器并返回新值
      increment() {
        return ++count
      },
      // 对外提供的方法：获取当前计数
      getCount() {
        return count
      }
    })
  }
}
```

对象插件比函数插件多了 `name` 等元信息。核心逻辑写在 `apply` 方法里。适合需要在插件注册表里留名字（便于日志、调试、依赖声明）的场景。

### 形态三：类插件

```ts
// 形态3：类插件（适合有内部状态的插件）
class TokenBucket {
  private tokens: number

  // 构造函数接收 Context 和配置，配置来自 ctx.plugin() 的第二个参数
  constructor(ctx: Context, config: { capacity: number }) {
    console.log(`✅ 类插件 tokenBucket 已激活（容量: ${config.capacity}）`)
    this.tokens = config.capacity

    // 注册服务：'tokenBucket' 是服务名（自定义），会挂载到 ctx.tokenBucket
    ctx.provide('tokenBucket', {
      // 对外提供的方法：尝试取一个令牌，成功返回 true，令牌不足返回 false
      take: () => this.take(),
      // 对外提供的方法：返回剩余令牌数
      remaining: () => this.tokens
    })
  }

  private take(): boolean {
    if (this.tokens <= 0) return false
    this.tokens--
    return true
  }
}
```

类插件有两个独门优势：

1. **构造函数可以接收配置**：`ctx.plugin(TokenBucket, { capacity: 3 })` 的第二个参数会传给构造函数；
2. **适合有复杂内部状态的插件**：令牌桶这种带状态的对象，用类来表达最自然。

### 组装运行

```ts
// 创建 Context
const ctx = new Context()

// 注册三种形态的插件
await ctx.plugin(loggerPlugin)
await ctx.plugin(counterPlugin)
// 第二个参数是插件的配置，会传给构造函数
await ctx.plugin(TokenBucket, { capacity: 3 })

// 使用服务：调用 logger 的 log 方法（服务名和方法都是自定义的）
ctx.logger.log('这是一条日志')

// 调用 counter 的 increment 方法（每次调用计数器 +1）
console.log('Counter:', ctx.counter.increment())  // 1
console.log('Counter:', ctx.counter.increment())  // 2

// 调用 tokenBucket 的 take 和 remaining 方法
console.log('取令牌:', ctx.tokenBucket.take())     // true
console.log('取令牌:', ctx.tokenBucket.take())     // true
console.log('取令牌:', ctx.tokenBucket.take())     // true
console.log('取令牌:', ctx.tokenBucket.take())     // false，已取完
console.log('剩余令牌:', ctx.tokenBucket.remaining())  // 0
```

运行输出：

```
📦 注册三种形态的插件...
✅ 函数插件 logger 已激活
✅ 对象插件 counter 已激活
✅ 类插件 tokenBucket 已激活（容量: 3）

🎯 使用服务...
[7:30:09 PM] 这是一条日志
Counter: 1
Counter: 2
取令牌: true
取令牌: true
取令牌: true
取令牌: false
剩余令牌: 0
```

### 三种形态怎么选？

| 形态 | 元信息 | 配置 | 复杂状态 | 适用场景 |
| --- | :-: | :-: | :-: | --- |
| 函数插件 | ✗ | ✗ | 一般（闭包） | 简单逻辑、快速原型 |
| 对象插件 | ✓ | ✗ | 一般（闭包） | 需要名字/元信息的插件 |
| 类插件 | ✓ | ✓ | 擅长 | 有状态、需配置的插件 |

三种形态殊途同归：都是通过 `ctx.provide()` 把服务挂到 Context 上。选哪种只是代码组织问题。

## 小结

这一篇我们建立了 Cordis 的心智模型：

1. **Context 是容器**：`ctx.provide()` 存服务，`ctx.xxx` 取服务，插件之间通过它协作；
2. **插件有三种形态**：函数、对象、类，按需选择，最终都是向 Context 提供服务。

这两块拼图看起来简单，但它们组合起来就是整个 Agent 框架的地基——后续我们要实现的 Session、Tools、Agent Loop，每一个都会是 Context 里的服务，每一个都会用到插件形态。

