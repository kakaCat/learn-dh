---
description: "以 workflow 的执行编排为轴讲清 DeepSeek Harness 的 run_code：沙箱执行、Tools SDK 注入、只读并发与写独占调度、超时预算四个关键节点；含可运行代码与真实运行输出，可与 dsh 运行时契约逐条对照。"
date: 2026-08-21
updated: 2026-10-09
author: learn-dh
title: "DeepSeek Harness 从 0 开始：24 workflow执行编排"
slug: deepseek-harness-24-workflow
keywords: [DeepSeek Harness, workflow 执行编排, run_code, 并行调度, ToolCallError, Cordis]
tags: [DeepSeek Harness, Agent, TypeScript, Cordis, workflow]
categories: [人工智能, AI Agent]
image: ""
image_alt: ""
og_type: article
twitter_card: summary
summary: "核心问题：AI Agent 如何把「这一步怎么干」从多轮 tool-call 往返，压缩成模型自己写一段程序、在单次执行里编排完。解决方案：workflow 以 run_code 为唯一入口——把模型写的 async 函数体放进全新执行上下文，注入 tools SDK（失败统一为 ToolCallError），只读调用并发重叠、写调用独占按序，timeoutMs 做整段预算且程序永不自动重放。适用场景：批量计算、并行扇出、多步数据处理这类直接调用工具做不了的事。"
topics: [AI Agent 框架, 执行编排, 沙箱执行, 读写调度, 超时预算]
entities: [DeepSeek Harness, Cordis, workflow, run_code, ToolCallError, RwScheduler]
content_type: tutorial
target_audience: 想理解或实现 AI Agent「单轮执行编排 / 编程式工具组合」机制的工程师
expertise_level: intermediate
canonical: https://github.com/kakaCat/learn-dh/blob/main/04-%E5%AE%9E%E7%8E%B0/blog-24-workflow/blog.md
noindex: false
nofollow: false
sitemap_priority: 0.8
sitemap_changefreq: monthly
lang: zh-CN
reading_time: 15 min
featured: false
draft: false
related_posts: ["[[DeepSeek Harness 从 0 开始：20 goal模式]]", "[[DeepSeek Harness 从 0 开始：Loop 模块（Agent 执行循环）]]"]
series: DeepSeek Harness 从 0 开始
series_order: 24
toc: true
---

# DeepSeek Harness 从 0 开始：24 workflow执行编排

> 本系列从 0 开始，基于 Cordis 框架实现一个简略版 DeepSeek Harness。本篇讲 **workflow**：模型在某一轮里手写 TS 程序、编排工具与子代理的执行模式。
>
> **一句话**：**workflow 不是一个独立的包，它是一种执行编排模式，唯一的实现入口是 `run_code` 工具**。模型把「这一步怎么干」写成一段 async 函数体交给 `run_code`；`run_code` 在一份全新的执行上下文里跑它，把工具面投影成 `tools.<name>(args)`，只读调用并发重叠、写调用独占按序，超时就拒、程序永不自动重放。
>
> **怎么读**：**只想先建立直觉**——读「速览」+ 四个节点标题 + 「小结」即可，代码、调用轨迹、运行输出都按需回看；**想跟实现**——每个节点固定四段：谁触发 → 做了什么 → 关键代码 → 输入输出与分叉。代码在 [blog-24-workflow](./)（`pnpm install && pnpm dev`），完整运行输出见文末**附录**。

## 速览（TL;DR）

- **workflow 是什么**：某一轮次（round）内的执行编排器——模型写一段 TypeScript 程序，把多轮 tool-call 往返压缩成单次执行。**单轮生命周期、无持久状态**。
- **唯一入口是 `run_code`**：`code`（async 函数体）+ `description` + `timeoutMs`（默认 120s，上限 600s）。
- **四个关键节点**：① 沙箱执行（全新上下文、顶层 `await`/`return`）→ ② Tools SDK 注入（失败 = `ToolCallError`）→ ③ 并行调度（只读重叠、写独占按序）→ ④ 超时预算与输出契约（只有 `return`/`console.log` 进对话，程序不自动重放）。
- **最容易误解的两点**：① workflow **没有自己的状态**——跨轮持久是 goal 的事；② `Promise.all` 的并行不是模型的一厢情愿——**只有只读调用真的重叠，写调用会被调度器拦下来单独执行**。
- **可复现**：可运行代码 + 真实运行输出，事实与 dsh 运行时契约逐条对照。

## workflow 到底提供了什么：一个定位

先把这个系列里最「不像模块」的模块定位清楚。dsh 里有三个容易混淆的概念：

```
┌─────────────────────────────────────────────────┐
│                    Goal                         │  ← 持久目标 + 自动续跑
│  "整个任务要完成什么、还能跑几轮、谁有权改它"    │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │              Plan (Round 1)               │ │  ← 协作模式
│  │  "当前轮次怎么走：先设计再执行"            │ │
│  │                                           │ │
│  │  ┌─────────────────────────────────────┐ │ │
│  │  │         Workflow (Step 3)           │ │ │  ← 执行编排
│  │  │  "这步怎么干：fan-out 子代理"       │ │ │
│  │  └─────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

| 维度 | Goal | Plan | Workflow |
| --- | --- | --- | --- |
| **生命周期** | 跨多轮，持久化 | 单轮，log-only | 单步，一次执行 |
| **职责** | 「任务往哪走」 | 「当前轮怎么走」 | 「这步怎么干」 |
| **状态** | 持久（id/revision） | 提示词引导 | **无状态** |
| **工具** | `create_goal` | `exit_plan_mode` | `run_code` |

goal 管「任务往哪走」，plan 管「当前轮怎么走」，**workflow 管「这步怎么干」**——三者正交，workflow 可以跑在 goal 的某一轮续跑里（见 [blog-20-goal](../blog-20-goal/blog.md)）。

那 workflow 到底**实现**了什么？一句话：**它把「这一步怎么干」从模型的多轮 tool-call 往返，压缩成模型自己写一段程序、在单次执行里编排完。**

| 层 | 实现的东西 | 运行时证据 |
| --- | --- | --- |
| 执行载体 | `run_code` = 把 `code`（async 函数体）在**全新执行上下文**里跑起来，顶层 `await`/`return` 可用 | 每次调用新进程；相对路径基于工作目录；`process.env` 起始为空 |
| 工具面 | Tools SDK：可用工具投影成 `tools.<name>(args)`；失败边给 `ToolCallError{toolName,message}`，可 `try/catch` 续跑 | SDK 声明 |
| 调度 | 只读调用可并发重叠；写调用单独执行、按提交顺序 | `Promise.all` 下只读重叠 |
| 隔离与预算 | 沙箱按**本次执行**生效；审批与嵌套等待都计入 `timeoutMs`（默认 120s / 上限 600s） | 授权不粘到后续调用 |
| 输出 | 只有 `return` 值 + `console.log` 进对话；图像型结果事后作附件回传 | 只有 print/return 被看见 |
| **不实现** | 无持久状态、不跨轮续跑（goal 的）、不做协作模式编排（plan 的）、**不是独立包** | 对比表 |

本文的余下部分就是把这五层逐个做出来：**沙箱执行 → SDK 注入 → 读写调度 → 超时与输出**。

> **诚实声明**：dsh 源码里并没有 `packages/workflow/` 这个包——「workflow」是概念口径。本文代码是**教学简化实现**：真实 dsh 每次 `run_code` 跑在**全新 Node 进程**里（进程级隔离），本文用 `new Function` + 显式沙箱全局对象演示同样的「无持久状态」语义；超时到处置方式在 dsh 侧未完全明文，本文选了「到时即拒、不重放」。

## 节点 ①：沙箱执行——把 code 变成 async 函数体

**谁触发**：模型在某一轮里判定「这步需要组合编排」（批量计算 / 并行扇出 / 多步数据整形），于是发起 `run_code` 工具调用。

**做了什么**：`run_code` 接收 `code` 字符串，包装成 async 函数，在一份**全新的沙箱全局对象**里执行——`tools`、`console`、`JSON`、`Promise` 这些都是现造的，执行完即弃，**跨调用互不污染**。

**关键代码**（[src/run-code.ts](./src/run-code.ts)）：

```typescript
// 每次执行一份全新的沙箱全局对象——无持久状态，跨调用互不污染
const sandbox = {
  tools: this.createToolsSDK(calls),
  console: {
    log: (...values: unknown[]) => {
      consoleLogs.push(values.map(String).join(' '))
    },
  },
  Promise, JSON, Object, Array, String, Number, Boolean, Math, Date, Error, setTimeout,
}

// 把 code 包装成 async 函数体：顶层 await/return 由此而来
const fn = new Function(
  ...Object.keys(sandbox),
  `return (async () => {\n${args.code}\n})()`,
) as (...values: unknown[]) => Promise<unknown>

const result = await Promise.race([fn(...Object.values(sandbox)), timeout])
```

三个值得停下来看的点：

1. **「顶层 `await`/`return` 可用」不是魔法**，就是 `return (async () => { ... })()` 这一层包装。模型的 `code` 是**函数体**，不是脚本。
2. **`console.log` 被替换了**。沙箱里的 `console.log` 不写 stdout，而是 push 进 `consoleLogs` 数组——这是「只有 return 和 console.log 进对话」的实现侧：模型在程序里 print 的每一行，都会随工具结果回传给它自己。
3. **沙箱里只有白名单全局**。`process`、`require`、文件系统都不在里面——模型想碰文件，只能走 `tools.*`。

**输入输出**：模型给出 `code` 字符串；`run_code` 返回 `{ kind: 'foreground', result, console, duration, calls }`。分叉在节点④（超时）与节点②（工具失败）。

## 节点 ②：Tools SDK 注入——失败统一为 ToolCallError

**谁触发**：沙箱里的用户代码执行到 `await tools.<name>(args)`。

**做了什么**：SDK 把调用转发给工具注册表；任何失败（工具不存在、底层异常）都**统一包装成 `ToolCallError`**——带 `toolName` 和 `message`——再 reject。用户代码可以 `try/catch` 它，**失败后继续跑**。

**关键代码**（[src/tools.ts](./src/tools.ts)）：

```typescript
export class ToolCallError extends Error {
  readonly name = 'ToolCallError'
  constructor(public toolName: string, message: string) {
    super(message)
  }
}

// ToolRegistry.invoke 的失败边：
} catch (error) {
  sink?.push({ tool: name, kind, start, end: performance.now(), ok: false })
  // 统一包装成 ToolCallError：用户代码可 try/catch 后续跑
  if (error instanceof ToolCallError) throw error
  throw new ToolCallError(name, error instanceof Error ? error.message : String(error))
}
```

为什么需要统一错误类型？因为 workflow 程序里**工具失败是常态分支而非灾难**——批量处理 100 个文件，3 个不存在，模型想要的是「记下来继续」，不是整段程序炸掉。`ToolCallError.toolName` 让它能区分「哪个工具挂了」，并决定是吞掉、重试还是上抛：

```typescript
// 模型写的典型错误边界（真实运行，见附录 Part 2）
try {
  await tools.read({ file_path: 'src/not-exist.ts' });
} catch (error) {
  if (error.name === 'ToolCallError') {
    results.push({ tool: error.toolName, ok: false, error: error.message });
  } else {
    throw error; // 非工具错误照样上抛
  }
}
```

**输入输出**（附录 Part 2 的真实输出，节选）：

```
console.log 输出： ["捕获: ToolCallError / tool=fail"]
return 值： [{"tool":"fail","ok":false},
             {"tool":"read","ok":false,"error":"ENOENT: no such file or directory, ..."},
             {"tool":"read","ok":true,"lines":128}]
```

两次失败（一次工具内部错误、一次文件不存在）都被 catch 住，第三次 `read` 正常完成——**失败没有阻断程序**。

## 节点 ③：并行调度——只读重叠、写独占按序

**谁触发**：用户代码里的 `Promise.all`（或任何并发的 `tools.*` 调用）。

**做了什么**：这是最容易被误解的一层。`Promise.all` 只是**发起了**并发，真正决定能不能重叠的是工具侧调度器：**只读调用并发重叠；写调用单独执行、按提交顺序**——写调用不仅互斥，还不能插队到先提交的读之前。

本文用一把公平读写锁实现（[src/tools.ts](./src/tools.ts)）：

```typescript
class RwScheduler {
  private readers = 0
  private writing = false
  private queue: { kind: 'read' | 'write'; grant: () => void }[] = []

  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]
      if (head.kind === 'read') {
        if (this.writing) return          // 有写在跑，读等着
        this.queue.shift(); this.readers++; head.grant()   // 连续的读一起放行
      } else {
        if (this.writing || this.readers > 0) return       // 写必须独占
        this.queue.shift(); this.writing = true; head.grant()
      }
    }
  }
}
```

`pump()` 的语义值得读两遍：**队首是读就放（并顺手把后面连续的读一起放），队首是写就必须等到读写全空**。这把「提交顺序」编码进了调度——写调用不会插队，读调用也不会饿死在长写链后面。

**输入输出**：这是本文最有说服力的一段真实输出（附录 Part 1）。模型在程序里先 `Promise.all` 三个 `read`，然后一次 `write`，再一个 `glob`；每个工具都带 40ms 模拟延迟。调用轨迹（横轴是时间，每格 4ms）：

```
read   read  [   0 →   45] ok ███████████     ┐
read   read  [   0 →   45] ok ███████████     ├─ 三个读完全重叠：真并行
read   read  [   0 →   45] ok ███████████     ┘
write  write [  45 →  90] ok            ███████████   ← 写等所有读结束，独占执行
glob   read  [  90 →  134] ok                        ███████████  ← 写后面的读，等写结束
```

三行事实一次看清：

1. 三个 `read` 起止完全相同（0 → 45）——**只读调用确实重叠**，总耗时是一次而不是三次；
2. `write` 从 45ms 才开始——**它没有和任何读重叠**，哪怕模型把它写在了同一个程序里；
3. `glob` 排在写后面（90 → 134）——**先提交的写先执行**，后提交的读等它。

如果模型把三个 `read` 改成顺序 `await`，总时长会变成 45+45+45。这就是为什么 system prompt 里写「独立的只读调用可以在 `Promise.all` 下重叠」——**它是运行时保证，不是风格建议**。

## 节点 ④：超时预算与输出契约——到时即拒，不重放

**谁触发**：`run_code` 开始时启动计时；用户代码跑超 `timeoutMs`，或正常 `return`。

**做了什么**：两条契约合在一起管「这段程序的终点」：

- **超时**：`timeoutMs` 是**整段执行的预算**（默认 120s、上限 600s），嵌套工具调用和审批等待都计入。到时即 reject，**程序不会被自动重放**——想再跑，模型必须在下一轮显式再发一次 `run_code`。
- **输出**：只有 `return` 值和 `console.log` 行进入工具结果。中间工具返回的原始 JSON 留在程序内部，**模型要自己筛选想带回对话的东西**。

**关键代码**：

```typescript
const timeoutMs = Math.min(
  args.timeoutMs ?? RunCodeService.DEFAULT_TIMEOUT_MS,   // 默认 120s
  RunCodeService.MAX_TIMEOUT_MS,                          // 上限 600s
)

let timer: NodeJS.Timeout | undefined
const timeout = new Promise<never>((_, reject) => {
  timer = setTimeout(() => {
    reject(new Error(`run_code 超出执行预算（timeoutMs=${timeoutMs}），程序不会被自动重放`))
  }, timeoutMs)
})

const result = await Promise.race([fn(...Object.values(sandbox)), timeout])
```

**输入输出**（附录 Part 4）：一个 `timeoutMs: 200`、内部 `setTimeout 5000` 的程序，运行结果是：

```
run_code 拒绝： run_code 超出执行预算（timeoutMs=200），程序不会被自动重放
```

**分叉**：超时后模型有三条路——调大 `timeoutMs` 重发（不超 600s）、把长任务拆成几步、或改用 `bash` 的 `run_in_background` / `subagent` 把活派出去。**没有第四条「系统自动帮我重跑」的路**，这是 workflow 与 goal 的分界线：要跨轮续跑，请用 goal。

## 三个常见编排模式

节点③的 Map-Reduce 演示（附录 Part 3）其实已经给出了 workflow 的主力模式。按用途归三类：

**模式 1：Map-Reduce（fan-out / fan-in）**——先 glob 拿清单，并行读全部，再汇总：

```typescript
const files = (await tools.glob({ pattern: '*.ts' })).paths;
const contents = await Promise.all(files.map(f => tools.read({ file_path: 'src/' + f })));
const totalLines = contents.reduce((sum, c) => sum + c.totalLines, 0);
return { totalFiles: files.length, totalLines };
```

真实运行输出：`{"totalFiles":3,"totalLines":431,"totalTodos":1}`，其中 fan-out 的三个 `read` 同样完全重叠（附录 Part 3 轨迹）。

**模式 2：Pipeline（多步数据整形）**——提取 → 转换 → 过滤 → 落盘，一步一 `await`，中间数据不出程序。

**模式 3：Fan-out 委派（subagent）**——需要**独立上下文**的整块工作派给 `subagent`（默认后台，返回 `subagentId` 可续聊）；workflow 本体不新建 agent，它只是派发者。

三类共用一个判断标准：**凡是你能用「直接调用工具」一句话说清的事，都不该走 `run_code`**。system prompt 的原话是把 `run_code` 留给「编程式批量计算、宽扇出、多步数据整形」这些直接调用做不了的事。

## 什么时候用、什么时候不用

✅ **应该用 workflow（run_code）**：

- 需要并行执行多个独立的只读调用（真的快，见节点③轨迹）
- 批量处理：100 个文件里允许 3 个失败，`ToolCallError` catch 住继续
- 多步数据整形：中间结果不值得占对话上下文
- 宽扇出：一次派发多个子代理

❌ **不应该用**：

- 简单的单次工具调用（直接调，少一层包装）
- 需要跨轮持久化状态（用 goal）
- 长任务且不拆（会撞 600s 上限；改后台 job 或 subagent）
- 需要协作模式编排「这一轮先设计再执行」（那是 plan）

## 小结

- workflow **不是独立包**，是「模型手写 TS 程序编排工具」的执行模式；唯一入口 `run_code`。
- 四个节点：**沙箱执行**（async 函数体 + 全新上下文）→ **SDK 注入**（失败 = `ToolCallError`，可续跑）→ **读写调度**（只读重叠、写独占按序）→ **超时与输出**（预算到时即拒、不重放；只有 `return`/`console.log` 进对话）。
- 与 goal/plan 的分工一句话：**goal 管往哪走，plan 管怎么走，workflow 管这步怎么干**。
- 判断用不用它的尺子：**直接调用一句话能说完的事，别写程序**。

## 附录：完整运行输出

代码在 [blog-24-workflow](./)（`pnpm install && pnpm dev`，tsx 直跑 TypeScript）。以下为一次真实运行的完整输出（对 `src/` 下 3 个 TS 文件操作；`totalTodos: 1` 来自 `main.ts` 里「统计 TODO」那行代码自己包含字符串 `'TODO'`）：

```
> blog-24-workflow@0.1.0 dev
> tsx src/main.ts

============================================================
Part 1：Promise.all 下只读重叠、写调用独占
============================================================
  console.log 输出： ["三个文件行数: 128, 113, 190"]
  return 值： {"files":["src/tools.ts","src/run-code.ts","src/main.ts"],"globbed":3}
  duration: 135ms
  调用轨迹（相对首个调用，ms）：
    read   read  [   0 →   45] ok ███████████
    read   read  [   0 →   45] ok ███████████
    read   read  [   0 →   45] ok ███████████
    write  write [  45 →   90] ok            ███████████
    glob   read  [  90 →  134] ok                        ███████████

============================================================
Part 2：工具失败 = ToolCallError，try/catch 续跑
============================================================
  console.log 输出： ["捕获: ToolCallError / tool=fail"]
  return 值： [{"tool":"fail","ok":false},{"tool":"read","ok":false,"error":"ENOENT: no such file or directory, open 'src/not-exist.ts'"},{"tool":"read","ok":true,"lines":128}]
  duration: 92ms

============================================================
Part 3：Map-Reduce —— 统计 src/ 下所有 TS 文件
============================================================
  console.log 输出： ["扫描 3 个文件"]
  return 值： {"totalFiles":3,"totalLines":431,"totalTodos":1}
  duration: 95ms
  调用轨迹（相对首个调用，ms）：
    glob   read  [   0 →   45] ok ███████████
    read   read  [  45 →   94] ok            ████████████
    read   read  [  45 →   94] ok            ████████████
    read   read  [  45 →   94] ok            ████████████

============================================================
Part 4：timeoutMs 到时即拒，程序不自动重放
============================================================
  run_code 拒绝： run_code 超出执行预算（timeoutMs=200），程序不会被自动重放
```

### 文件清单

```
blog-24-workflow/
├── package.json      # pnpm dev = tsx src/main.ts
├── tsconfig.json
└── src/
    ├── tools.ts      # ToolRegistry + RwScheduler（公平读写锁）+ ToolCallError
    ├── run-code.ts   # RunCodeService：沙箱执行 + Tools SDK 注入 + 超时预算
    └── main.ts       # 四个 Part 的演示入口 + 调用轨迹打印
```

## 参考资料

- 深度解析（概念与模式）：[docs/dsh-workflow-deep-dive.md](../../docs/dsh-workflow-deep-dive.md)
- 流程图（8 张 Mermaid，覆盖调度与选型）：[docs/dsh-workflow-flowchart.md](../../docs/dsh-workflow-flowchart.md)
- 实现指南（示意实现伪码）：[docs/dsh-workflow-implementation-guide.md](../../docs/dsh-workflow-implementation-guide.md)
- 前篇：[blog-20-goal](../blog-20-goal/blog.md)（workflow 跑在 goal 的一轮续跑里）

---

*本文代码为教学简化实现：真实 dsh 的 `run_code` 每次调用跑在全新 Node 进程（进程级隔离），本文以 `new Function` + 白名单沙箱演示同等语义；事实口径以 dsh 运行时契约为准。*
