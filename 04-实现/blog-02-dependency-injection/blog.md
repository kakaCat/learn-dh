---
title: "DeepSeek Harness 从 0 开始：依赖注入与服务管理"
description: "基于 Cordis 框架从 0 开始实现简略版 DeepSeek Harness 的第二篇：用 Service 基类和 inject 声明依赖，让 Cordis 自动按依赖顺序激活服务，以及可选依赖（? 前缀）的用法。"
keywords: [Cordis, DeepSeek Harness, 依赖注入, Service, inject, 可选依赖, TypeScript, Agent 框架, 教学]
tags: [Cordis, DeepSeek Harness, Agent, 依赖注入, TypeScript]
author: "learn-dh"
date: "2026-08-19"
lang: "zh-CN"
og:
  title: "DeepSeek Harness 从 0 开始：依赖注入与服务管理"
  description: "当插件变多，「插件 B 要用插件 A 的服务」怎么声明？inject 如何让 Cordis 自动处理依赖顺序？"
  type: "article"
---

# DeepSeek Harness 从 0 开始：依赖注入与服务管理

> 本系列从 0 开始，基于 Cordis 框架一步步实现一个简略版本的 DeepSeek Harness（loop、session、tool、system prompt 等）。上一篇我们认识了 Context 和插件的三种形态，这一篇解决一个更现实的问题：**当插件变多，服务之间互相依赖怎么办？**
>
> 配套代码：[blog-02-dependency-injection](./)，运行 `pnpm install && pnpm dev` 即可复现本文全部输出。

## 上一篇留下的问题

在上一篇里，每个插件都是独立的：`ctx.provide('logger', ...)`、`ctx.provide('counter', ...)`，谁都不依赖谁。

但真实的 Agent 框架不是这样。想想我们的目标架构：

```
Session 模块 ──依赖──▶ Tools 模块 ──依赖──▶ LLM 适配器
     ▲                                          │
     └────────────── Agent Loop ◀───────────────┘
```

Tools 执行完要通知 Session 记录日志，Agent Loop 要调用 LLM……**服务之间互相依赖才是常态**。

如果全靠手动注册，我们会陷入「先有鸡还是先有蛋」的困境：

```ts
// ❌ 手动管理的痛苦：必须先创建 database，再创建 cache……
const database = new DatabaseService()
const cache = new CacheService(database)
const api = new ApiService(database, cache)
// 服务一多，构造顺序全靠人脑记，改一个就要连带改一片
```

Cordis 的答案是**依赖注入（Dependency Injection）**：你只需要声明「我需要什么」，框架负责「按什么顺序给你」。

## 项目目录结构

```
blog-02-dependency-injection/
├── package.json          # 项目配置：依赖、启动脚本
├── pnpm-lock.yaml        # 依赖锁定文件
├── tsconfig.json         # TypeScript 编译配置
├── README.md             # 项目说明
├── docs/
│   ├── di-patterns.md       # 依赖注入的几种方式（参考）
│   └── file-organization.md # 项目文件组织方式（参考）
└── src/
    └── main.ts           # 代码入口，pnpm dev 运行它
```

## 核心概念

| 概念 | 一句话理解 |
| --- | --- |
| **Service 基类** | 服务类的基类，`super(ctx, 'name', true)` 把自己注册到 Context |
| **inject 静态属性** | 声明「我依赖哪些服务」，Cordis 据此计算加载顺序 |
| **可选依赖** | 依赖名加 `?` 前缀，服务有就用，没有也能活 |

## Part 1：依赖注入基础

### 第一步：类型扩展

要给 Context 挂服务，先告诉 TypeScript 这些服务的类型：

```ts
// 告诉 TypeScript 我们要给 Context 添加哪些服务
declare module '@cordisjs/core' {
  interface Context {
    database: DatabaseService
    cache: CacheService
    api: ApiService
    analytics: AnalyticsService
  }
}
```

这样 `ctx.database`、`ctx.cache` 就有类型提示了，写错服务名编译器会直接报错。

### 第二步：定义服务类

每个服务都继承 `Service` 基类：

```ts
// 数据库服务：没有依赖，最先激活
class DatabaseService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'database', true)  // 把自己注册为 ctx.database
    console.log('  ✅ DatabaseService 已激活')
  }

  query(sql: string): string {
    return `DB result for: ${sql}`
  }
}

// 缓存服务：依赖 database
class CacheService extends Service {
  private data = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'cache', true)
    console.log('  ✅ CacheService 已激活（依赖 database）')

    // 依赖通过 ctx 访问：此时 database 一定已经激活了
    const result = ctx.database.query('SELECT * FROM config')
    console.log(`     初始化时查询数据库: ${result}`)
  }

  set(key: string, value: string) {
    this.data.set(key, value)
  }

  get(key: string): string | undefined {
    return this.data.get(key)
  }
}
// 声明依赖：CacheService 依赖 database
// Cordis 会确保 DatabaseService 在 CacheService 之前激活
CacheService.inject = ['database']

// API 服务：依赖 database + cache
class ApiService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'api', true)
    console.log('  ✅ ApiService 已激活（依赖 database + cache）')

    const dbResult = ctx.database.query('SELECT * FROM users')
    console.log(`     数据库查询: ${dbResult}`)

    ctx.cache.set('users', 'cached-data')
    console.log(`     缓存设置: ${ctx.cache.get('users')}`)
  }

  fetch(endpoint: string): string {
    const cached = this.ctx.cache.get(endpoint)
    if (cached) return `Cache hit: ${cached}`
    return this.ctx.database.query(`SELECT * FROM ${endpoint}`)
  }
}
ApiService.inject = ['database', 'cache']
```

关键点：

- **`super(ctx, 'name', true)`**：`Service` 构造函数接收 `(ctx, name)` 两个参数——`ctx` 是上下文，`name` 是服务名（`'database'` 对应 `ctx.database`）。**第三个参数 `true` 是旧版 Cordis v3 / Koishi 的 legacy 写法（`immediate` 参数），在 Cordis v4 中会被忽略**，写不写都不影响行为；保留它只是为了兼容旧代码习惯。服务名也可以不传，改用类的静态属性 `static provide = 'database'` 声明（见下文 FAQ）；
- **`ClassName.inject = ['database']`**：静态属性，声明依赖。注意它写在类外面，因为它是类的元信息而不是实例属性；
- **依赖通过 `ctx` 访问**：`ctx.database.query(...)`——你不需要保存依赖引用，Cordis 保证在构造函数执行时依赖已就绪。

### 第三步：注册（顺序随意）

```ts
const ctx = new Context()

// 注意：注册顺序是乱的！
// 注册顺序: ApiService → CacheService → DatabaseService
// 预期激活: DatabaseService → CacheService → ApiService
ctx.plugin(ApiService)
ctx.plugin(CacheService)
ctx.plugin(DatabaseService)

// 等待服务激活（注册是异步的，稍等一帧）
await new Promise(resolve => setImmediate(resolve))

// 使用服务
const result = ctx.api.fetch('/users')
console.log(`  API 结果: ${result}`)
```

运行输出：

```
📦 注册插件（注意：顺序随意）
  注册顺序: ApiService → CacheService → DatabaseService
  预期激活: DatabaseService → CacheService → ApiService

  ✅ DatabaseService 已激活
  ✅ CacheService 已激活（依赖 database）
     初始化时查询数据库: DB result for: SELECT * FROM config
  ✅ ApiService 已激活（依赖 database + cache）
     数据库查询: DB result for: SELECT * FROM users
     缓存设置: cached-data

🎯 使用服务...
  API 结果: DB result for: SELECT * FROM /users
```

**注册顺序是 `Api → Cache → Database`，激活顺序却是 `Database → Cache → Api`**——Cordis 根据 `inject` 声明自动做了拓扑排序。这正是依赖注入的价值：你声明「要什么」，框架处理「先后」。

## Part 2：可选依赖

有时候一个服务有依赖能用更好，没有也能工作。比如「埋点统计」服务：有缓存就用缓存，没缓存就直接查库。

```ts
class AnalyticsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'analytics', true)
    console.log('  ✅ AnalyticsService 已激活（可选依赖 cache）')

    if (ctx.cache) {
      console.log('     发现 cache 服务，使用缓存')
    } else {
      console.log('     没有 cache 服务，直接查询')
    }
  }
}
// 依赖名加 ? 前缀 = 可选依赖
AnalyticsService.inject = ['?cache']
```

注意 `if (ctx.cache)` 的判断——可选依赖在运行时可能不存在，用前必须判空。

两个场景验证：

```ts
// 场景1: cache 服务存在
const ctx = new Context()
ctx.plugin(CacheService)
ctx.plugin(DatabaseService)
ctx.plugin(AnalyticsService)
await new Promise(resolve => setImmediate(resolve))

// 场景2: cache 服务不存在（单独一个 Context）
const ctx2 = new Context()
ctx2.plugin(AnalyticsService)
await new Promise(resolve => setImmediate(resolve))
```

运行输出：

```
📦 场景1: cache 服务存在
  ✅ DatabaseService 已激活
  ✅ CacheService 已激活（依赖 database）
     初始化时查询数据库: DB result for: SELECT * FROM config
  ✅ AnalyticsService 已激活（可选依赖 cache）
     发现 cache 服务，使用缓存

📦 场景2: cache 服务不存在
  ✅ AnalyticsService 已激活（可选依赖 cache）
     没有 cache 服务，直接查询
```

同一个 `AnalyticsService`，在两种环境下都能正常启动——可选依赖让服务对环境的适应性更强。

## Part 3：复杂依赖图

当服务多起来，依赖关系会变成一张图。Cordis 照样能自动算出正确的激活顺序。

```ts
class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a', true)
    console.log('  [1] A 激活')
  }
}

class ServiceB extends Service {
  constructor(ctx: Context) {
    super(ctx, 'b', true)
    console.log('  [2] B 激活（依赖 A）')
  }
}
ServiceB.inject = ['a']

class ServiceC extends Service {
  constructor(ctx: Context) {
    super(ctx, 'c', true)
    console.log('  [3] C 激活（依赖 B）')
  }
}
ServiceC.inject = ['b']

class ServiceD extends Service {
  constructor(ctx: Context) {
    super(ctx, 'd', true)
    console.log('  [4] D 激活（依赖 A + C）')
  }
}
ServiceD.inject = ['a', 'c']

class ServiceE extends Service {
  constructor(ctx: Context) {
    super(ctx, 'e', true)
    console.log('  [5] E 激活（依赖 D）')
  }
}
ServiceE.inject = ['d']
```

依赖图长这样：

```
A ← 无依赖
B ← A
C ← B
D ← A, C
E ← D
```

注册时故意打乱顺序：

```ts
const ctx = new Context()

// 注册顺序（故意打乱）：E, C, B, D, A
ctx.plugin(ServiceE)
ctx.plugin(ServiceC)
ctx.plugin(ServiceB)
ctx.plugin(ServiceD)
ctx.plugin(ServiceA)

await new Promise(resolve => setImmediate(resolve))
```

运行输出：

```
依赖关系：
  A ← 无依赖
  B ← A
  C ← B
  D ← A, C
  E ← D

📦 注册顺序（故意打乱）：E, C, B, D, A

  [1] A 激活
  [2] B 激活（依赖 A）
  [3] C 激活（依赖 B）
  [4] D 激活（依赖 A + C）
  [5] E 激活（依赖 D）

✅ Cordis 自动按依赖关系排序！
```

五个服务，注册顺序 `E, C, B, D, A`，激活顺序却是 `A, B, C, D, E`——完美符合依赖关系。如果存在循环依赖（A 依赖 B 同时 B 依赖 A），Cordis 会直接报错，帮你尽早发现问题。

## 常见问题 FAQ

**Q: Cordis 框架有几种依赖注入方式？**

A: 核心就一种：**Context 注入**——所有服务通过 `ctx` 访问依赖。在此基础上衍生出三种声明/使用方式：

1. **构造函数注入**：`constructor(ctx: Context)` 拿到 Context，构造函数里直接 `ctx.database.query(...)` 使用依赖；
2. **声明式依赖（inject）**：`ClassName.inject = ['database', 'cache']` 静态属性声明「我依赖谁」，Cordis 据此自动排序激活顺序；
3. **可选依赖**：`inject = ['?cache']` 加 `?` 前缀，配合 `if (ctx.cache)` 判空，依赖可有可无。

对比其他框架（装饰器注入的 NestJS/Angular、容器绑定的 InversifyJS、函数参数注入的函数式风格），Cordis 的做法最朴素：**不引入新语法，依赖就是 ctx 上的属性，inject 只是给自动排序提供信息**。类型安全靠 TypeScript 的 `declare module` 扩展保证。

**Q: `super(ctx, 'name', true)` 的第三个参数是什么？false 是什么场景？**

A: 在 **Cordis v4** 里，`Service` 构造函数签名是 `constructor(ctx: Context, name: string)`——**只有两个参数**，第三个参数会被 JavaScript 直接忽略（多余实参不报错）。所以 `super(ctx, 'database', true)` 里的 `true` 没有任何效果，写不写都一样。

这个写法是 **Cordis v3 / Koishi 时代的 legacy API**：那时构造函数支持三个参数 `super(ctx, name, immediate)`：

| immediate | 行为 | 适用场景 |
| --- | --- | --- |
| `true` | 构造后**立即**注册到所有上下文 | 服务无需异步初始化，一创建就能用 |
| `false`（默认） | 先等 ready 事件，调用可选的 `start()` 方法后**才**注册 | 服务需要异步初始化（如连接数据库、加载配置），确保就绪后才暴露给其他插件 |

如果你在旧代码/旧教程里看到 `super(ctx, 'xxx', true)`，那是为了「不需要等 ready、立即提供服务」。**在 Cordis v4 中不需要也不应该传这个参数**；如果想让服务名不写在 `super()` 里，可以用静态属性声明：

```ts
class MetricsService extends Service {
  static provide = 'metrics'   // 等价于 super(ctx, 'metrics')
  static inject = ['llm']      // 声明依赖

  constructor(ctx: Context) {
    super(ctx)                 // 不再传 name，v4 会回退到 static provide
  }
}
```

**Q: 什么是循环依赖？Cordis 检测到它会怎样？**

A: 循环依赖指两个（或多个）服务互相需要对方：A 依赖 B，同时 B 依赖 A。

```ts
class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a', true)
    // 想在构造函数里用 B？但 B 还没激活，这里会出问题
  }
}
ServiceA.inject = ['b']

class ServiceB extends Service {
  constructor(ctx: Context) {
    super(ctx, 'b', true)
  }
}
ServiceB.inject = ['a']
```

Cordis 检测到 `A ←→ B` 的循环后，会直接报错「circular dependency」并拒绝启动——这是**好事**，它把问题暴露在启动期，而不是运行期莫名崩溃。循环依赖本身往往意味着设计有问题。

**Q: 如何解决循环依赖？**

A: 四种由浅入深的解法：

**解法 1：重构拆分（最推荐）**——循环依赖通常说明「公共的部分」没有被抽出来。把 A 和 B 共同依赖的东西提取成独立的 C：

```
改造前：A ←→ B
改造后：A → C ← B（C 独立存在，A、B 都只依赖 C）
```

```ts
// 公共部分抽成独立服务 C
class SharedService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shared', true)
  }

  notify(msg: string) {
    console.log(`  [shared] ${msg}`)
  }
}

class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a', true)
  }
}
ServiceA.inject = ['shared']

class ServiceB extends Service {
  constructor(ctx: Context) {
    super(ctx, 'b', true)
  }
}
ServiceB.inject = ['shared']
```

**什么时候用**：A 和 B 确实共享同一份数据或逻辑。这是根治方案。

**解法 2：延迟访问（构造时不碰依赖）**——循环依赖的报错发生在**构造函数阶段**，因为激活服务时必须先构造它。但如果 A 只在**方法调用时**才用 B，就不存在「构造期依赖」：

```ts
class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a', true)
    // 构造函数里完全不碰 ctx.b
  }

  // 需要 B 时，在方法运行时才通过 ctx 访问
  doSomething() {
    const b = this.ctx.b
    // 此时所有服务都已激活，ctx.b 一定可用
    return b.help()
  }
}
ServiceA.inject = ['b']
```

注意 `this.ctx.b` 的访问时机：**从构造函数移到方法体内**。服务全部激活后，`ctx.b` 随时可取。这样即使 A、B 互相声明依赖，只要不在构造函数里互取，就能绕过报错。

**什么时候用**：依赖只在运行期需要、且两个服务确实互相调用（如回调、通知），但不符合解法 1 的重构条件时。

**解法 3：事件驱动解耦（推荐）**——如果 A 需要 B 做的事其实是「通知类」的，可以用事件系统解耦：A 不发「调 B 的方法」，而是广播一个事件，由 B（或任何关心的人）监听处理。

```ts
class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a', true)
  }

  trigger() {
    // 不直接调 B，而是广播事件
    ctx.emit('a:something-happened', { at: Date.now() })
  }
}
// A 不再依赖 B，循环依赖自然消失
// ServiceA.inject = []  不需要声明

class ServiceB extends Service {
  constructor(ctx: Context) {
    super(ctx, 'b', true)

    // 监听 A 的事件，异步处理
    ctx.on('a:something-happened', (payload) => {
      console.log(`  B 收到通知: ${payload.at}`)
    })
  }
}
```

**什么时候用**：依赖关系是「单向通知」（A 通知 B，B 不需要回传结果给 A）时。这也是我们后续实现 Agent 事件系统的核心思路——解耦的同时还能让多个服务各自响应同一事件。

**解法 4：可选依赖 + 判空（治标）**——如果循环依赖来自「初始化时互相探测」，可以把其中一个依赖标成可选的，配合 `if` 判空：

```ts
// A 声明 B 为可选依赖
ServiceA.inject = ['?b']

class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a', true)
    // 启动时 B 可能还没就绪，但代码不会崩
    if (ctx.b) {
      // 用 B 初始化一些东西
    }
  }

  // 运行时再真正使用 B
  run() {
    if (this.ctx.b) return this.ctx.b.help()
    return 'b 不可用'
  }
}
```

**什么时候用**：作为临时缓解，或者依赖确实可有可无时。它没有消除循环，只是让循环「不致命」，长期看还是应该回归解法 1。

**Q: 四种解法怎么选？**

A: 看这张对比表：

| 解法 | 消除循环？ | 侵入性 | 适用场景 |
| --- | :-: | :-: | --- |
| 重构拆分 | ✅ 根治 | 中 | A、B 共享数据/逻辑 |
| 延迟访问 | ✅ 绕过 | 低 | 只在运行期互相调用 |
| 事件驱动 | ✅ 根治 | 中 | 单向通知场景 |
| 可选依赖 + 判空 | ❌ 缓解 | 低 | 临时过渡 / 依赖可有可无 |

一句话建议：先问「它俩真的需要互相依赖吗？」——多数循环依赖都能靠重构拆分或事件驱动彻底消除；确实无法消除的，用延迟访问在运行期取依赖。

## 更广阔的背景：依赖注入的几种方式

`inject` 只是依赖注入的一种实现。`docs/di-patterns.md` 里对比了 7 种常见方式：

| 方式 | 代表框架 | 注入方式 | 自动解析 |
| --- | --- | --- | --- |
| 构造函数注入 | **Cordis**、手动 | 构造参数 / 声明式 | ✅ |
| 属性注入 | 手动 | 属性赋值 | ❌ |
| 方法注入 | 手动 | 方法参数 | ❌ |
| 装饰器注入 | NestJS、Angular | `@Injectable()` | ✅ |
| 服务定位器 | 手动 | 动态查找 | ❌（反模式） |
| DI 容器 | InversifyJS、TSyringe | 容器绑定 | ✅ |
| 函数式注入 | 无框架 | 闭包 / 高阶函数 | ❌ |

Cordis 选择的是**「构造函数 + 声明式 inject」**：既有构造函数注入的类型安全和明确性，又通过 `inject` 静态属性获得自动排序的能力，学习曲线还很低。

另外 `docs/file-organization.md` 还介绍了代码组织的三种方式：单文件（本博客所用，适合学习）、多文件（每服务一个文件，适合实际项目）、插件式（每服务一个插件目录，适合大型项目/开源插件）。

## 小结

1. **Service 基类**：`super(ctx, 'name', true)` 把服务注册到 Context，之后通过 `ctx.name` 访问；
2. **inject 声明依赖**：`ClassName.inject = ['database', 'cache']`，Cordis 自动拓扑排序，注册顺序随意；
3. **可选依赖**：`inject = ['?cache']`，配合 `if (ctx.cache)` 判空，让服务适应不同环境；
4. **复杂依赖图**：再多服务、再乱的注册顺序，Cordis 都能算出正确的激活顺序；循环依赖会直接报错。

依赖注入让我们的 Agent 框架可以自由组合模块：Session、Tools、LLM 适配器各自声明依赖，框架负责装配——这正是后续博客的架构基础。

**下一篇预告**：事件系统——五种派发模式（emit / parallel / serial / bail / waterfall），Agent 的每一步执行如何通过事件广播出去？

---

*本文代码已验证可运行（Node.js + tsx，@cordisjs/core v4.0.0-beta.5）。完整源码见同目录 `src/main.ts`，扩展阅读见 `docs/`。*
