---
title: "DeepSeek Harness 从 0 开始：Guard 模块（策略守卫）"
description: "基于 Cordis 框架从 0 开始实现简略版 DeepSeek Harness 的第十二篇：Guard 模块——按 dsh 源码实现策略守卫：工具调用超时（TOOL_TIMEOUT 结构化结果）、重复调用提醒（连续相同调用检测 + 参数规范化 + 用户插话重置）。"
keywords: [Cordis, DeepSeek Harness, Guard, 守卫, 超时, TOOL_TIMEOUT, 重复调用, 策略, 拦截点, TypeScript]
tags: [Cordis, DeepSeek Harness, Agent, Guard, 守卫, 策略, TypeScript]
author: "learn-dh"
date: "2026-08-19"
lang: "zh-CN"
og:
  title: "DeepSeek Harness 从 0 开始：Guard 模块（策略守卫）"
  description: "超时 + 重复调用提醒——挂在拦截点事件上的策略插件，不改框架不改工具。"
  type: "article"
---

# DeepSeek Harness 从 0 开始：Guard 模块（策略守卫）

> 本系列从 0 开始，基于 Cordis 框架一步步实现一个简略版本的 DeepSeek Harness（loop、session、tool、system prompt 等）。前几篇我们有了完整的 Agent 闭环（Loop + LLM + Tools + Session + Persistence），这一篇解决**运行中的策略问题**：**Guard 模块**——超时、重复调用等「守卫」。
>
> 配套代码：[blog-12-guard](./)，运行 `pnpm install && pnpm dev` 即可复现本文全部输出。

## 上一篇留下的问题

Agent 跑起来了，但**运行中会出各种问题**：

- **工具卡死**：`bash` 跑了个无限循环，Agent 永远等不到结果——谁掐断它？
- **模型死循环**：模型反复调用同一个工具、同样参数，每次结果都一样——怎么让它停下来？
- **策略与机制混杂**：超时逻辑写进工具？重复检测写进 Loop？——代码会越来越乱。

dsh 的答案是 **Guard 模块**（`packages/guard/`）：把「运行策略」做成**挂在拦截点事件上的插件**——**不改框架、不改工具，只监听事件**。这就是 blog-10「框架发事件、插件收」模式的策略层应用。

> 💡 dsh 的 `packages/guard/` 有两个包：`timeout-policy`（工具调用超时守卫）、`repeat-tool-reminder`（重复调用提醒）。它们都挂在 `tools/execute` / `tools/post-execute` / `agent/pre-step` 拦截点上。本文实现这两个守卫。

## 项目目录结构

```
blog-12-guard/
├── package.json          # 项目配置：依赖、启动脚本
├── pnpm-lock.yaml        # 依赖锁定文件
└── src/
    └── main.ts           # 代码入口，pnpm dev 运行它
```

## 核心概念

| 概念 | 一句话理解 |
| --- | --- |
| **Guard（守卫）** | 挂在拦截点事件上的策略插件——超时、重复检测等 |
| **TimeoutPolicy** | 工具调用超时守卫：包裹 tools/execute，到期替换 TOOL_TIMEOUT 结果 |
| **RepeatToolReminder** | 重复调用提醒：检测连续相同调用，达到阈值向模型注入提醒 |
| **参数规范化** | 深排序参数 JSON——`{b,a}` 和 `{a,b}` 视为相同调用 |
| **链重置** | 用户插话改变上下文 → 重复链重置（跨用户消息的重复不是循环） |

## Part 1：TimeoutPolicy——工具调用超时守卫

工具声明 `timeoutMs` 并承诺尊重 `exec.signal`；守卫包装这个期限，到期用**结构化 TOOL_TIMEOUT 结果**替换——不竞速、不抛弃工具 promise：

```ts
/** 超时结果：模型看到的错误（dsh: toolTimeoutResult） */
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  const message = `tool call timed out after ${timeoutMs}ms`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } },
  }
}

/** 简单的超时信号（dsh 用 @deepseek-ai/dsh-timeout 的 deadline，这里简化） */
function withDeadline(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean } {
  const controller = new AbortController()
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  return {
    signal: controller.signal,
    timedOut: () => { clearTimeout(timer); return fired },
  }
}

/**
 * 安装超时守卫：包裹 tools/execute。
 * - 工具声明 timeoutMs → 设置期限，替换 exec.signal，委托，恢复
 * - 自己的期限触发 → 用结构化 TOOL_TIMEOUT 替换结果
 * - 工具没声明 → 原样委托
 */
export function applyTimeoutPolicy(ctx: Context): () => void {
  return ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = toolRegistry.get(exec.name)?.timeoutMs
    if (timeoutMs === undefined) return next()  // 无预算：直接委托

    // 设置期限，替换 exec.signal 用于分发
    const { signal, timedOut } = withDeadline(exec.signal, timeoutMs)
    const upstream = exec.signal
    ;(exec as { signal: AbortSignal }).signal = signal

    try {
      const result = await next()
      // 自己的期限触发 → 用结构化 TOOL_TIMEOUT 替换
      if (timedOut()) return toolTimeoutResult(timeoutMs)
      return result
    } finally {
      ;(exec as { signal: AbortSignal }).signal = upstream  // 恢复调用方信号
    }
  })
}
```

**关键设计**（都来自 dsh 源码）：

1. **无超时声明 → 原样委托**：`timeoutMs === undefined` 直接 `next()`——守卫对没声明超时的工具零影响；
2. **信号替换与恢复**：临时把 `exec.signal` 换成带期限的信号（工具遵守 `exec.signal` 就会在超时被 abort），`finally` 里恢复调用方信号——**post-execute 监听器看不到守卫的（可能已 abort 的）超时信号**；
3. **结构化错误**：`TOOL_TIMEOUT` 作为 `error.code`——重试/沙箱插件（和重放）能据此路由（dsh: "a retry/sandbox plugin (and replay) can route on it"）。

运行验证（Part 1 输出）：

```
🚀 执行 fast-tool（无超时声明）:
  ✅ 快速完成 (isError: false)

🚀 执行 slow-tool（声明 100ms 超时，实际 500ms）:
  ❌ Error: tool call timed out after 100ms
  🔍 error.code: TOOL_TIMEOUT（模型可据此路由）
```

**fast-tool 无声明 → 原样执行**；**slow-tool 声明 100ms → 500ms 实际执行被掐断**，返回结构化的 `TOOL_TIMEOUT` 错误——模型看到的是「工具超时了」，不是「请求挂起」。

## Part 2：RepeatToolReminder——重复调用提醒

模型陷入死循环（反复调同一个工具、同样参数）是 Agent 最常见的故障。守卫检测**连续相同调用**，达到阈值时**向模型注入提醒**：

```ts
// 温和的第一档提醒（dsh: GENTLE_REMINDER）
const GENTLE_REMINDER =
  'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: ...'

// 详细的后续档提醒（dsh: detailedReminder）
function detailedReminder(toolName: string, count: number, args: string): string {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${args}\n`
    + 'The repeated calls are not making progress. ...'
}

/** 一个 agent 的连续重复链：最后调用身份键 + 运行长度（dsh: Chain） */
interface Chain {
  key: string
  count: number
}

export function applyRepeatToolReminder(ctx: Context, config: RepeatConfig = {}): () => void {
  const thresholds = [...(config.thresholds ?? [3, 5, 8])].sort((a, b) => a - b)
  const thresholdSet = new Set(thresholds)
  const includePatterns = (config.include ?? []).map(wildcardToRegExp)
  const excludePatterns = (config.exclude ?? []).map(wildcardToRegExp)
  const previewCap = config.argumentsPreviewChars ?? 500

  const chains = new Map<string, Chain>()  // agent id → chain

  /** 推进链并返回提醒（达到阈值时）——计数发生在 post-execute */
  function observe(exec: ToolExecution): string | undefined {
    if (!exec.agent) return undefined       // 直接调用无 model 可提醒
    if (!tracked(exec.name)) return undefined
    const key = JSON.stringify([exec.name, canonicalize(exec.arguments)])
    const chain = chains.get(exec.agent)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    chains.set(exec.agent, { key, count })
    if (!thresholdSet.has(count)) return undefined
    if (count === thresholds[0]) return GENTLE_REMINDER
    return detailedReminder(exec.name, count, previewArguments(key, previewCap))
  }

  // post-execute：观察 + 委托 + 折叠提醒（不否决）
  const post = ctx.on('tools/post-execute', async (exec, result, next): Promise<ToolExecutionResult> => {
    const reminder = observe(exec)
    const downstream = await next()
    if (!reminder) return downstream
    return { ...downstream, content: [...downstream.content, { type: 'text', text: `\n[guard] ${reminder}` }] }
  })

  // pre-step：用户插话重置链（跨用户消息的重复不是循环）
  const pre = ctx.on('agent/pre-step', async ({ agent, hasUserMessage }, next) => {
    if (hasUserMessage) chains.delete(agent)
    return next()
  })

  return () => { post(); pre() }
}
```

**关键设计**：

1. **计数在 post-execute**（dsh 源码注释原文）："Counting happens here — in post-execute — because **denied calls also flow through this waterfall**"——被拒绝的调用也走管道，模型反复打被拒的调用正是要打破的循环；
2. **观察并丰富，从不否决**：守卫只**注入提醒**（`additionalContexts`），不阻止调用——它「建议」模型换策略，但决定权在模型；
3. **分级提醒**：第一阈值（默认 3）用温和提醒，后续（5、8）用详细提醒（工具名 + 次数 + 参数）——**先礼后兵**；
4. **用户插话重置链**：跨用户消息的重复**不是**循环——用户改了需求，重复调用就是合理的。

运行验证（Part 2 输出）：

```
🚀 Agent 连续 6 次调用 probe（相同参数 {query:"x"}）:
  调用 #1: probe result for {"query":"x"}
  调用 #2: probe result for {"query":"x"}
  调用 #3: probe result for {"query":"x"}
[guard] You are repeating the exact same tool call with identical arguments. ...
  调用 #4: probe result for {"query":"x"}
  调用 #5: probe result for {"query":"x"}
[guard] Repeated tool call detected:
- tool: probe
- consecutive_calls: 5
- arguments: ["probe","{\"query\":\"x\"}"]
...
  调用 #6: probe result for {"query":"x"}
```

**第 3 次温和提醒**（`You are repeating...`），**第 5 次详细提醒**（工具名 + 次数 + 参数）——模型被「提示」而不是被「阻止」。

## Part 3：参数规范化——怎么判断「相同调用」

「连续相同调用」的「相同」怎么定义？**参数深排序**——`{b:1, a:2}` 和 `{a:2, b:1}` 是同一个调用（JSON 属性顺序无关紧要）：

```ts
// 深排序 JSON 值：{b:1,a:2} 和 {a:2,b:1} 规范化相同（dsh: sortJsonValue）
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

// 参数的规范化字符串（深排序 + stringify）——检测「相同调用」的键
function canonicalize(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}
```

**链键 = `[工具名, 规范化参数]`**——`JSON.stringify([exec.name, canonicalize(args)])`。只有「工具名 + 参数完全相同」才算重复；参数变一点（哪怕换个 key 顺序）就是新调用。

运行验证（Part 3 输出）：

```
📋 参数键排序规范化（{b,a} vs {a,b} 视为相同）:
  key1: ["probe","{\"a\":2,\"b\":1}"]
  key2: ["probe","{\"a\":2,\"b\":1}"]
  相同: true
```

## Part 4：用户插话重置链

```ts
// pre-step：用户插话重置链（跨用户消息的重复不是循环）
const pre = ctx.on('agent/pre-step', async ({ agent, hasUserMessage }, next) => {
  if (hasUserMessage) chains.delete(agent)
  return next()
})
```

**为什么要重置？** 用户插话改变了上下文——用户说「换个方法」，模型重复调用可能就是**响应新指令**，不是死循环。dsh 源码注释原文："A user interjection changes the context; repetition across it is not a loop."

运行验证（Part 4 输出）：

```
🔄 模拟用户插话（pre-step 带 user 消息）:
  ✅ 链已重置（跨用户消息的重复不是循环）

🚀 用户插话后再调用 3 次:
  调用 #1: probe result for {"query":"x"}
  调用 #2: probe result for {"query":"x"}
  调用 #3: probe result for {"query":"x"}
[guard] You are repeating the exact same tool call with identical arguments. ...
```

**插话后链归零**——重新连续 3 次才再次触发提醒。

## Part 5：组合守卫——超时 + 重复同时生效

守卫是**独立插件**，可以叠加。一个又慢又会被重复调用的工具，两个守卫同时作用：

```ts
// 一个又慢又会被重复调用的工具
toolRegistry.set('slow-probe', {
  name: 'slow-probe',
  timeoutMs: 50,
  async execute() { await new Promise(r => setTimeout(r, 300)); return 'slow' },
})

// 连续调用 3 次：每次超时 + 第 3 次触发提醒
for (let i = 1; i <= 3; i++) {
  const result = await executeTool('slow-probe', { q: 1 }, 'agent-1')
}
```

运行验证（Part 5 输出）：

```
🚀 连续调用 slow-probe 3 次（每次超时 + 第 3 次触发提醒）:
  调用 #1: Error: tool call timed out after 50ms
  调用 #2: Error: tool call timed out after 50ms
  调用 #3: Error: tool call timed out after 50ms |
[guard] You are repeating the exact same tool call with identical arguments. ...
```

**每次调用都被超时守卫掐断**（`TOOL_TIMEOUT`），**第 3 次还被重复守卫提醒**（`[guard] You are repeating...`）——两个守卫在**不同的拦截点**（`tools/execute` 超时、`tools/post-execute` 重复）独立工作、互不干扰。这就是「守卫 = 可组合的策略插件」。

## 常见问题 FAQ

**Q: Guard 和 blog-10 的 Hooks 什么关系？**

A: 都是「挂在拦截点事件上的策略插件」。区别：**Hooks 是外部命令**（hooks.json 配置，跑 shell 命令）；**Guard 是内部代码**（`ctx.on` 监听器，直接写逻辑）。Guard 挂在 `tools/execute` / `tools/post-execute` / `agent/pre-step` 这些 dsh 原生拦截点上，用代码实现策略——比外部命令更精细（能访问内部状态、参数规范化等）。

**Q: 超时守卫怎么保证不误杀？**

A: 两个保障：**工具没声明 timeoutMs → 原样委托**（守卫零影响）；**自己的期限触发才替换**——`timedOut()` 检查的是**自己的定时器**是否触发，嵌套的外层超时（另一个 wrapper 的）读作普通上游取消，不会误判成自己的超时（dsh: "a nested outer deadline reads as an ordinary upstream cancel"）。

**Q: 重复检测为什么在 post-execute 计数而不是 pre-execute？**

A: dsh 源码注释：**被拒绝的调用也走 post-execute 管道**。模型反复调用被拒绝的工具（比如权限不足还一直试）正是最需要打破的循环——如果在 pre-execute 计数，被拒的调用不计数，就漏掉了这种死循环。

**Q: 守卫为什么不直接阻止重复调用？**

A: 因为「重复」不总是错误——**模型可能需要多次尝试才成功**（比如网络重试）。守卫是**观察并丰富，从不否决**：注入提醒让模型知道「你在重复」，但决定权在模型。这是「软策略」——提醒而非强制。

**Q: 参数规范化为什么深排序？**

A: JSON 对象的属性顺序是**无意义**的——`{b:1, a:2}` 和 `{a:2, b:1}` 是同一个参数。不排序的话，模型换了个 key 顺序写参数就被误判为「新调用」，检测就失效了。深排序保证：**语义相同 = 检测相同**。

**Q: GuardService 是什么？dsh 有吗？**

A: 教学聚合。dsh 的 `packages/guard/` **没有 GuardService**——`timeout-policy` 和 `repeat-tool-reminder` 是**两个独立插件**（各自 `apply(ctx)` + `ctx.on`），通过 cordis.yml 或代码注册。我用 GuardService 做教学容器，但真正的工作都在 `applyTimeoutPolicy()` / `applyRepeatToolReminder()` 这两个**函数插件**里——和 dsh 一致。

## 小结

1. **Guard = 挂在拦截点事件上的策略插件**：不改框架、不改工具——超时、重复检测都是 `ctx.on` 监听器；
2. **TimeoutPolicy**：包裹 `tools/execute`，工具声明超时 → 到期替换结构化 `TOOL_TIMEOUT` 结果（模型可路由）；
3. **RepeatToolReminder**：`post-execute` 计数 + 参数规范化 + 分级提醒（温和/详细）——观察并丰富，从不否决；
4. **链重置**：用户插话改变上下文 → 重复链归零（跨用户消息的重复不是循环）；
5. **守卫可组合**：多个守卫在不同拦截点独立工作、互不干扰——策略层像插件一样自由叠加。

至此，系列 12 篇正式篇覆盖了 dsh 的核心（另有补充篇 Persistence）：**Cordis 基础（01-03）→ Session（04）→ Tools（05）→ Inbox（06）→ Loop（07）→ Compaction（08）→ System Prompt（09）→ Hooks（10）→ LLM（11）→ Guard（12）**——一个能思考、能行动、能记忆、能压缩、有提示词、有钩子、有守卫的简略版 DeepSeek Harness。

**后续可选方向**：Scope 作用域（工具隔离）、Subagent 子代理、Schedule 定时调度、Sandbox 沙箱。

---

*本文代码已验证可运行（Node.js + tsx，@cordisjs/core v4.0.0-beta.5）。完整源码见同目录 `src/main.ts`，实现结构对应 dsh 的 `packages/guard/*`。*
