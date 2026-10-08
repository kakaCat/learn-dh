---
title: "DeepSeek Harness 从 0 开始：Persistence 模块（会话持久化）"
description: "基于 Cordis 框架从 0 开始实现简略版 DeepSeek Harness 的补充篇：Persistence 模块——按 dsh 源码实现会话持久化：SessionPersistence 抽象、JSONL 文件后端、崩溃恢复（平衡不完整尾部）、订阅自动落盘、增量读取。"
keywords: [Cordis, DeepSeek Harness, Persistence, 持久化, SessionPersistence, JSONL, 崩溃恢复, 事件溯源, readFrom, TypeScript]
tags: [Cordis, DeepSeek Harness, Agent, Persistence, 持久化, JSONL, TypeScript]
author: "learn-dh"
date: "2026-08-19"
lang: "zh-CN"
og:
  title: "DeepSeek Harness 从 0 开始：Persistence 模块（会话持久化）"
  description: "JSONL 文件后端 + 崩溃恢复 + 订阅落盘——Session 日志落盘，进程重启后数据还在。"
  type: "article"
---

# DeepSeek Harness 从 0 开始：Persistence 模块（会话持久化）

> 本系列从 0 开始，基于 Cordis 框架一步步实现一个简略版本的 DeepSeek Harness（loop、session、tool、system prompt 等）。前十一篇覆盖了核心 Agent 模块，这一篇解决最后一个现实问题：**会话持久化**——Session 日志落盘，进程重启后数据还在。
>
> 配套代码：[blog-12-persistence](./)，运行 `pnpm install && pnpm dev` 即可复现本文全部输出。

## 上一篇留下的问题

Session（blog-04）记录了一切，但**只在内存里**——进程一退出，Map 清空，所有会话消失。这严重限制了：

- **重启恢复**：Agent 干到一半进程崩了，历史全丢；
- **多进程共享**：两个进程要访问同一个会话，内存不互通；
- **审计留存**：会话记录是宝贵的资产，不能随进程消失。

dsh 的答案是 **Persistence 模块**（`packages/session/session-persistence*`）：把 Session 的**事件日志落盘**——append-only 写入文件，重启后重放恢复。因为事件溯源（Session 篇）的设计，**持久化只需存日志，surface 和消息派生都可重放重建**。

> 💡 dsh 的持久化分多个包：`session-persistence`（抽象类 + 协调器）、`session-persistence-jsonl`（JSONL 文件后端，支持 zstd 压缩）、`session-persistence-sqlite`（SQLite 后端）。本文实现 JSONL 后端的核心机制。

## 项目目录结构

```
blog-12-persistence/
├── package.json          # 项目配置：依赖、启动脚本
├── pnpm-lock.yaml        # 依赖锁定文件
└── src/
    └── main.ts           # 代码入口，pnpm dev 运行它
```

## 核心概念

| 概念 | 一句话理解 |
| --- | --- |
| **SessionPersistence** | 持久化抽象：create / append / load / list / readFrom |
| **JSONL 后端** | 每会话一个 `.jsonl` 文件，每行一条事件，append-only |
| **崩溃恢复** | load 时检测不完整尾部，补 `step/end` + `turn/end`（reason: interrupted） |
| **订阅落盘** | 监听 `session/event` 自动把新事件写入后端（write-behind 简化版） |
| **增量读取** | `readFrom(id, fromSeq)` 只读 seq ≥ N 的部分（投影缓存恢复用） |

## Part 1：SessionPersistence——抽象类

```ts
/**
 * 持久化后端抽象：append-only 会话存储。
 * append 在 durability 之后 resolve（写入磁盘才算完成）；
 * load 平衡不完整的尾部，不重写已提交事件。
 */
abstract class SessionPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /** 注册新会话的元数据（可延迟物化：没 append 过的会话不留痕） */
  abstract create(meta: SessionHeader): Promise<void>

  /** 持久化一批事件（首个事件 seq 必须等于存储的 next-seq） */
  abstract append(id: string, events: readonly SessionEvent[]): Promise<void>

  /** 加载会话（返回 header + 事件；平衡不完整尾部） */
  abstract load(id: string): Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /** 列出所有已物化的会话 */
  abstract list(): Promise<SessionHeader[]>

  /** 从指定 seq 读取（增量读取，dsh: readFrom） */
  abstract readFrom(id: string, fromSeq: number): Promise<SessionEvent[]>
}
```

**为什么抽象类？** 持久化可以有很多实现（JSONL / SQLite / Redis），但使用方（Agent Loop、session-query）只依赖这个接口——**换后端不改业务代码**（依赖注入篇的「接口与实现分离」）。`ctx.sessionPersistence` 就是这个抽象的 Service 挂载点。

**两个关键语义**（dsh 源码注释）：
- **`append` 在 durability 之后 resolve**——返回时数据已在磁盘，不是「提交到缓冲区」；
- **`load` 平衡不完整尾部，不重写已提交事件**——崩溃恢复是「追加合成关闭事件」，不是「改历史」。

## Part 2：JsonlPersistence——JSONL 文件后端

```ts
/**
 * JSONL 后端：每会话一个 <id>.jsonl 文件，每行一条事件。
 * - append-only：只追加，不修改
 * - 文件系统即存储：进程重启后数据还在
 * - 崩溃恢复：load 时检测不完整尾部
 */
class JsonlPersistence extends SessionPersistence {
  private root: string

  constructor(ctx: Context, root: string) {
    super(ctx)
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  /** 会话文件路径 */
  private pathOf(id: string): string {
    return join(this.root, `${id}.jsonl`)
  }

  /** 会话头也存一个文件（<id>.meta.json） */
  private metaPathOf(id: string): string {
    return join(this.root, `${id}.meta.json`)
  }

  async create(meta: SessionHeader): Promise<void> {
    // 写 meta 文件（头）；事件文件延迟到第一次 append
    writeFileSync(this.metaPathOf(meta.id), JSON.stringify(meta, null, 2))
  }

  async append(id: string, events: readonly SessionEvent[]): Promise<void> {
    // append-only：追加写，不动已有内容
    const lines = events.map(e => this.serialize(e)).join('\n') + (events.length > 0 ? '\n' : '')
    writeFileSync(this.pathOf(id), lines, { flag: 'a' })  // 'a' = append
  }

  async load(id: string): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    // 读 meta + 逐行解析事件 + 平衡尾部
  }

  async list(): Promise<SessionHeader[]> {
    // 扫描 *.meta.json 文件
  }

  async readFrom(id: string, fromSeq: number): Promise<SessionEvent[]> {
    const { events } = await this.load(id)
    return events.filter(e => e.seq >= fromSeq)
  }
}
```

**JSONL 的设计**：`JSONL` = JSON Lines——每行一个 JSON 对象。会话的每个事件序列化成一行追加到 `<id>.jsonl`，会话头（id/版本/血缘）单独存 `<id>.meta.json`。

- **append-only**：`writeFileSync(path, lines, { flag: 'a' })`——只追加不修改，和事件日志语义一致；
- **延迟物化**：`create` 只写 meta，事件文件到第一次 `append` 才建——**建了没用的会话不留痕**（dsh: "created-but-never-appended session is absent from list — abandoned sessions leave nothing behind"）；
- **文件系统即存储**：进程重启后文件还在——这就是持久化的全部。

## Part 3：崩溃恢复——平衡不完整尾部

这是持久化最精巧的部分。**进程可能在 turn 中途崩溃**——文件最后一条事件是不完整的边界（有 `turn/start` 没 `turn/end`）。重启后 `load` 要处理：

```ts
/**
 * 崩溃恢复（dsh: load balances a complete interrupted tail）：
 * 进程可能在 turn 中途崩溃——最后一条事件是不完整的 turn/step 边界。
 * load 时检测并「平衡」：补上缺失的 step/end 和 turn/end（reason: interrupted）。
 * 绝不重写已提交事件——只追加合成关闭事件。
 */
private balanceTail(meta: SessionHeader, events: SessionEvent[]): SessionEvent[] {
  if (events.length === 0) return events
  const balanced = [...events]
  let last: SessionEvent = events[events.length - 1]!

  // 找最新的 step 编号
  const lastStep = [...events].reverse().find(e => e.type === 'step/start') as
    | { type: 'step/start'; step: number; turn: number }
    | undefined

  // 检查是否需要补 step/end
  if (last.type === 'user/message' || last.type === 'assistant/message'
    || last.type === 'tool/call' || last.type === 'tool/result'
    || last.type === 'step/start') {
    if (lastStep) {
      balanced.push({
        type: 'step/end', seq: balanced.length, turn: lastStep.turn, step: lastStep.step,
        timestamp: Date.now(),
      })
    }
  }

  // 检查是否需要补 turn/end
  last = balanced[balanced.length - 1]!
  const lastTurn = [...events].reverse().find(e => e.type === 'turn/start') as
    | { type: 'turn/start'; turn: number }
    | undefined
  if (lastTurn && last.type !== 'turn/end') {
    balanced.push({
      type: 'turn/end', seq: balanced.length, turn: lastTurn.turn,
      reason: 'interrupted',  // 崩溃中断标记（dsh: TurnEndReasonMap.interrupted）
      timestamp: Date.now(),
    })
  }

  // 如果补了事件，把它们持久化（合成关闭，不改已提交）
  if (balanced.length > events.length) {
    this.append(meta.id, balanced.slice(events.length)).catch(() => {})
  }

  return balanced
}
```

**崩溃恢复的语义**（dsh 文档原文）：
- **完整的已提交事件保持原样**——绝不重写；
- **不完整的尾部被「平衡」**——补 `step/end` + `turn/end`（reason: `interrupted`）；
- **合成关闭也持久化**——下次加载时尾部就是完整的；
- **`interrupted` 标记**（dsh: `TurnEndReasonMap.interrupted`）——「崩溃关闭的 turn」，loop 从不主动发这个标记，只有持久化后端在 reload 时补。

运行验证（Part 3 输出）：

```
🔧 加载崩溃会话: crash-1787316011353
  事件数: 5
  #0 turn/start
  #1 step/start
  #2 user/message
  #3 step/end        ← 合成的
  #4 turn/end (reason: interrupted)   ← 合成的
```

**3 条 → 5 条**：崩溃时的 3 条事件原样保留，补了 2 条合成关闭事件——**历史无损，尾部闭合**。

## Part 4：订阅落盘——write-behind 简化版

Session 是内存对象，怎么让它「自动」落盘？dsh 的思路（Session 篇提过）：**持久化不侵入 Session——订阅 `session/event` 事件，把新事件写到后端**：

```ts
/**
 * 订阅器：监听 session/event 事件，把新事件批量写入持久化后端。
 * 简化版：每次事件立即写；dsh 是批量 + 延迟（write-behind.ts）。
 */
class PersistenceSubscriber {
  constructor(
    private ctx: Context,
    private backend: SessionPersistence,
  ) {
    // 监听会话事件：每来一条就追加到持久化
    ctx.on('session/event', (sessionId: string, event: any) => {
      void this.persistOne(sessionId, event).catch(err => {
        console.error(`  ❌ 持久化失败: ${err.message}`)
      })
    })
  }

  private async persistOne(sessionId: string, event: any): Promise<void> {
    const { seq, ...rest } = event as SessionEvent
    const persisted: SessionEvent = { seq, ...rest } as SessionEvent
    await this.backend.append(sessionId, [persisted])
  }
}
```

**这是事件驱动的持久化**——Session 每次 `append()` 广播 `session/event`（blog-04 讲过），订阅器收到就写盘。**Session 不知道持久化的存在，持久化也不改 Session**——纯事件解耦（blog-03 的思想）。

dsh 真实实现更精细（`write-behind.ts`）：**批量 + 延迟**——事件先积累，定时批量写入（减少 IO）；还有 `session/flush` 事件强制落盘。简化版每次立即写，语义一致。

## Part 5：演示——写入、重启、崩溃、增量

### 创建会话并写入

```ts
let ctx = new Context()
await ctx.plugin(JsonlPersistence, PERSIST_DIR)
new PersistenceSubscriber(ctx, ctx.sessionPersistence)

const sessionId = `session-${Date.now()}`
await ctx.sessionPersistence.create({
  version: 0, id: sessionId, createdAt: Date.now(), cwd: '/workspace/blog-12',
})

// 模拟会话事件（dsh: session/event 广播）
function appendEvent(sessionId, event, seq) {
  ctx.emit('session/event', sessionId, { seq, ...event })
}
// 写入一轮完整对话（6 条事件）
appendEvent(sessionId, { type: 'turn/start', turn: 1, timestamp: Date.now() }, 0)
// ... turn/end
```

运行输出（Part 1）：

```
📄 已写入文件: /tmp/dsh-blog12-60250/session-1787316011299.jsonl
  文件行数: 6
  内容预览: {"seq":0,"type":"turn/start","turn":1,"timestamp":1787316011299}
```

**6 条事件已落盘**——`/tmp/.../session-xxx.jsonl`，每行一条 JSON。

### 模拟重启（新 Context 读同一目录）

```ts
// 模拟：新 Context + 新后端实例（读同一个目录 = 重启）
let ctx2 = new Context()
await ctx2.plugin(JsonlPersistence, PERSIST_DIR)

const loaded = await ctx2.sessionPersistence.load(sessionId)
console.log(`  事件数: ${loaded.events.length}（进程重启后数据还在！）`)
```

运行输出（Part 2）：

```
📂 加载会话: session-1787316011299
  事件数: 6（进程重启后数据还在！）
  #0 turn/start
  #1 step/start
  #2 user/message
  #3 assistant/message
  #4 step/end
  #5 turn/end (reason: completed)
```

**进程重启后 6 条事件完整恢复**——这就是持久化的意义。

### 崩溃恢复

```ts
// 直接写文件（不走事件，模拟「写了一半崩了」）
writeFileSync(crashFile, [
  JSON.stringify({ type: 'turn/start', seq: 0, turn: 1, ... }),
  JSON.stringify({ type: 'step/start', seq: 1, ... }),
  JSON.stringify({ type: 'user/message', seq: 2, content: '崩溃前的消息', ... }),
  // ← 没有 step/end 和 turn/end（进程在这里崩了）
].join('\n') + '\n')
```

运行输出（Part 3）：见上文——3 条 → 5 条，补 `step/end` + `turn/end (reason: interrupted)`。

### 列出会话 + 增量读取

```ts
const sessions = await ctx3.sessionPersistence.list()
const tail = await ctx3.sessionPersistence.readFrom(sessionId, 3)
```

运行输出（Part 4）：

```
📋 已持久化的会话: 2
  - crash-1787316011353 (...)
  - session-1787316011299 (...)

🔢 增量读取（seq >= 3）: 3 条
  #3 assistant/message
  #4 step/end
  #5 turn/end
```

**`readFrom` 是投影缓存的恢复基石**（dsh 用法）：投影缓存存了「已折叠到 seq N」，恢复时只读 `seq >= N` 的尾部重新折叠——不用全量重读。这正是 blog-08 FAQ 里「deriveMessages 缓存 + 代数失效」的持久化搭档。

## 常见问题 FAQ

**Q: 持久化和 Session 什么关系？**

A: Session 是**内存日志**（事件 + surface 投影），持久化是**磁盘日志**（同一个事件流落盘）。两者通过事件解耦：Session 每次 `append()` 广播 `session/event`，持久化订阅器收到就写盘。**Session 不知道持久化存在，持久化也不改 Session**——事件溯源让「日志是唯一真源，落盘只是它的镜像」。

**Q: 为什么用 JSONL 而不是一个 JSON 文件？**

A: **append-only 的天然匹配**：JSONL 每行一条事件，追加就是 `flag: 'a'` 写一行——不用读整个文件再写回（JSON 数组追加要改结构）。另外：流式读取（读一行处理一行）、崩溃时只丢最后一行、grep 方便。dsh 的 JSONL 后端还支持 zstd 压缩（`.jsonl.zstd`）省空间。

**Q: 崩溃恢复为什么「补」而不是「删」？**

A: 因为**已提交的事件不可变**（append-only 铁律）。崩溃时的 3 条事件是真实发生的（turn 开了、用户消息进了），删掉就丢了事实。正确做法是**追加合成关闭事件**（`step/end` + `turn/end reason: interrupted`）——历史完整，且日志有「这次 turn 是崩溃结束的」标记（可审计）。

**Q: 并发写入怎么办？怎么保证同一个会话的写不会乱？**

A: **per-id 串行链（promise chain）——不是传统锁，是「同一个会话的操作排队执行」**。dsh 的 `PersistenceCoordinator` 里：

```ts
// Per-session serialization: every operation chains onto the prior one for the
// same id, so writes for one session never interleave. Keyed by session id.
private chains = new Map<SessionId, Promise<unknown>>()

private serialize<T>(id: SessionId, op: () => Promise<T> | T): Promise<T> {
  const prior = this.chains.get(id) ?? Promise.resolve()
  const next = prior.then(run, run)   // 排到上一个操作后面
  const tail = next.then(() => undefined, () => undefined)  // 吞掉 rejection，不污染链
  this.chains.set(id, tail)
  void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id) })
  return next
}
```

**关键设计**：① **按会话 id 排队**——不同会话并行，同一会话严格串行（A 写完才执行 B，写文件不交错）；② **错误不污染链**——一个操作失败，下一个照常执行；③ **链空即删**——没有排队操作就释放。**为什么不用互斥锁？** Node 单线程下真正的风险是**异步交错**（两个 `append` 的 `writeFile` 交错会写坏文件），promise chain 让同一会话的写操作 FIFO 排队，比锁更轻量且无死锁。

**Q: 怎么保证不丢失数据？**

A: 多层保障，从「写入时」到「崩溃后」：

| 层 | 机制 | 说明 |
| --- | --- | --- |
| ① 写入即持久 | `append` resolve 前完成磁盘写入 | 返回 = 数据已在磁盘，不是「提交到缓冲区」 |
| ② seq 连续性 | append 校验首事件 seq == next-seq | 跳号说明丢失，直接拒绝——「完整」可验证 |
| ③ 崩溃半行 | torn-tail 检测 → **截断丢弃**半行 | 半行不是完整事件，无法解析 |
| ④ 崩溃未闭合 turn | **合成关闭**（`step/end` + `turn/end interrupted`） | 完整事件原样保留，补语义不丢字节 |
| ⑤ 版本/未知事件 | 读时**拒绝**（防读错） | 新版本日志旧版本读不懂就拒绝，不静默跳过 |

**最精妙的是 ③④ 的区分**：进程崩溃时文件末尾可能是**半行**（写到一半断电）——物理损坏，**截断丢弃**；也可能是**完整但未闭合的 turn**（有 `turn/start` 没 `turn/end`）——逻辑未完成，**补关闭事件**。一个丢字节，一个补语义——**已提交的完整事件永远原样保留**。

**Q: `interrupted` 是什么？**

A: dsh 的 `TurnEndReasonMap` 里的一个 reason：**「持久化后端 reload 时关闭了崩溃遗留的 turn」**。关键：**loop 从不主动发这个标记**——只有 `load` 时由持久化后端补上。所以看日志能区分「正常结束」（completed）和「崩溃被关闭」（interrupted）。

**Q: 为什么订阅 `session/event` 而不是直接让 Session 落盘？**

A: **解耦**（还是这个）。如果 Session 直接落盘，Session 就要知道后端类型（JSONL/SQLite？）——违背依赖注入的「接口与实现分离」。订阅事件让持久化成为**旁观者**：Session 只广播，持久化决定怎么存、何时存（立即/批量）、存到哪。dsh 的 write-behind 就是在订阅器里做批量延迟。

**Q: 持久化目录在哪？重启怎么找？**

A: 由后端构造参数决定（演示用 `/tmp`，真实项目用数据目录）。`load(id)` 按 id 找 `<id>.jsonl`，`list()` 扫描 `*.meta.json`。**进程重启后只要指向同一个目录，会话就能恢复**——这就是「文件系统即存储」。

## 小结

1. **Persistence = 事件日志落盘**：SessionPersistence 抽象（create/append/load/list/readFrom），JSONL 后端 append-only 写文件；
2. **崩溃恢复**：load 时平衡不完整尾部——补 `step/end` + `turn/end`（reason: interrupted），已提交事件不动；
3. **事件驱动落盘**：订阅 `session/event` 自动写盘（write-behind 简化版）——Session 与持久化解耦；
4. **增量读取**：`readFrom(id, fromSeq)` 只读尾部——投影缓存恢复的基石；
5. **重启恢复**：进程重启后指向同一目录，会话事件完整重放——「日志是唯一真源」。

这是系列的一个**补充篇**（Persistence 属于 dsh 的 session 域，不算独立包，故不计入正式编号）。正式篇 12 篇覆盖 dsh 核心：**Cordis 基础（01-03）→ Session（04）→ Tools（05）→ Inbox（06）→ Loop（07）→ Compaction（08）→ System Prompt（09）→ Hooks（10）→ LLM（11）→ Guard（12）**——一个基于 Cordis 的简略版 DeepSeek Harness：能思考（Loop+LLM）、能行动（Tools）、能记忆（Session+Persistence）、能压缩（Compaction）、有提示词（System Prompt）、有钩子（Hooks）、有守卫（Guard）。

**后续可选方向**：Sandbox 沙箱（安全执行）、Subagent 子代理、Schedule 定时调度、Web/CLI 界面——按兴趣继续。

---

*本文代码已验证可运行（Node.js + tsx，@cordisjs/core v4.0.0-beta.5）。完整源码见同目录 `src/main.ts`，实现结构对应 dsh 的 `packages/session/session-persistence*`。*
