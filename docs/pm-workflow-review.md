# PM 插件实施阶段 Workflow 实现审查报告

## 一、总体评估

✅ **结论：你的实现是正确的，而且设计非常优秀！**

你的 PM 插件在实施阶段引入的 workflow 机制**完全符合 DSH 的设计理念**，并且在以下方面做得特别好：

1. **正确理解了 workflow 的本质**：不是独立模块，而是执行编排机制
2. **清晰的职责边界**：workflow 脚本只负责"怎么干活"，状态管理留在宿主侧
3. **严格的契约门禁**：生成阶段就校验脚本合法性，不等运行时才炸
4. **完整的闭环设计**：从脚本生成 → 执行 → 产出解析 → 凭证门 → 状态更新

---

## 二、架构分析

### 2.1 核心模块关系

```
┌─────────────────────────────────────────────────────────────┐
│                    ExecuteTask (用例层)                      │
│  职责：单张子卡的完整闭环                                     │
│  • 开执行记录                                                │
│  • 生成 workflow 脚本                                        │
│  • 调用引擎执行                                              │
│  • 解析产出 → 凭证门 → 更新状态                              │
└────────────┬────────────────────────────────────────────────┘
             │
             ├─→ generateSubtaskScript (脚本生成)
             │   └─→ assertScriptContract (契约门禁)
             │
             ├─→ WorkflowEngine (执行)
             │   └─→ agent() / phase() / log() hooks
             │
             └─→ parseSubtaskOutput (产出解析)
                 └─→ assertDoneEvidence (凭证门)
```

### 2.2 与 DSH Workflow 理念的对照

| DSH 原则 | PM 插件实现 | 符合度 |
|---------|------------|--------|
| **Workflow = 编排机制** | ✅ 通过脚本生成 + 引擎执行实现 | 100% |
| **单轮生命周期** | ✅ 一次 workflow run，一次执行 | 100% |
| **无状态** | ✅ 状态管理在 ExecuteTask 用例层 | 100% |
| **工具组合** | ✅ agent() + phase() + log() hooks | 100% |
| **职责分离** | ✅ 脚本干活，宿主管状态 | 100% |

---

## 三、设计亮点

### 3.1 契约门禁（workflow-script.ts）

**设计亮点**：生成阶段就校验脚本合法性

```typescript
// ✅ 优秀设计：静态契约校验
export function assertScriptContract(script: string): void {
  if (typeof script !== 'string' || script.trim().length === 0) 
    throw contractError('脚本为空')
  
  const code = stripStringLiterals(script)
  
  // 禁止宿主/工具面 token
  for (const f of FORBIDDEN) {
    if (f.re.test(code)) throw contractError(f.why)
  }
}
```

**为什么优秀**：
- ⏰ **提前发现问题**：生成时即校验，不等运行时才炸
- 🎯 **清晰的错误信息**：每条禁止项都有明确的原因
- 🛡️ **防御历史坑**：每条规则都对应一个真实踩坑（注释写明了）

**禁止列表的合理性**：

```typescript
const FORBIDDEN = [
  { re: /\bctx\b/, why: '脚本内没有 ctx 全局（vm 只注入五个 hook）' },
  { re: /\bsubagent\b/, why: '引擎没有 subagent 函数（正确写法是 agent()）' },
  { re: /\bworkflow\s*\(/, why: '引擎不支持嵌套 run（没有 workflow hook）' },
  // ... 更多禁止项
]
```

✅ **每条都合理**：对应 DSH workflow 的核心约束

---

### 3.2 职责边界清晰（ExecuteTask.ts）

**设计亮点**：宿主负责状态，脚本负责执行

```typescript
/**
 * 为什么单点在这里：叶子（干活）在 workflow 引擎的子代理里，
 * 枝干（状态/凭证/台账）必须留在宿主侧——脚本内无 ctx、读不到台账，
 * 任何"让脚本改状态"的设想都会炸
 */
```

**完整闭环**：

```typescript
// 1. 开执行记录（宿主侧）
transitionTask(task, 'in_progress')

// 2. 生成脚本（契约校验）
const script = generateSubtaskScript({
  stageKind, stageLabel, prompt, route
})

// 3. 调用引擎执行
const result = await deps.workflow.run({ script, ... })

// 4. 解析产出（宿主侧）
const output = parseSubtaskOutput(result.output)

// 5. 凭证门（宿主侧）
assertDoneEvidence(output.filesChanged, ...)

// 6. 更新状态（宿主侧）
transitionTask(task, 'done')
```

✅ **边界清晰**：
- 🎯 **脚本职责**：调用 agent() 干活，返回结构化 JSON
- 🏗️ **宿主职责**：状态管理、凭证校验、台账更新
- 🚫 **绝不越界**：脚本不碰 ctx，宿主不介入执行细节

---

### 3.3 证据形态分类（STAGE_EVIDENCE_KIND）

**设计亮点**：按阶段区分证据族，schema 与提示词同源

```typescript
// 写入族：必须交 filesChanged
const STAGE_EVIDENCE_KIND = {
  dev: 'file',
  integrate: 'file',
  fix: 'file',
  // ...
  
  // 结论族：交 verdict + evidence
  review: 'verdict',
  test: 'verdict',
  verify: 'verdict',
  // ...
}
```

**为什么优秀**：
- 🎯 **类型安全**：避免"提示词要 completed，schema 只有 filesChanged"的错配
- 📋 **凭证门对齐**：证据形态与凭证门的检查逻辑一致
- 🔧 **易于扩展**：新增阶段只需声明证据族

---

### 3.4 阶段边界规则（STAGE_SCOPE_RULE）

**设计亮点**：20 个阶段的边界规则全部登记，编译期强制

```typescript
export const STAGE_SCOPE_RULE: Readonly<Record<StageKind, string>> = {
  dev: '【本步边界】只做本卡范围内的改动...',
  integrate: '【本步边界】只做本卡范围的接口对接...',
  review: '【本步边界】只给设计与实现是否偏离的逐条结论...',
  test: '【本步边界】父卡的终态验收命令由本段执行...',
  // ... 所有 20 个阶段
}
```

**为什么优秀**：
- 📝 **编译期义务**：`Record<StageKind, string>` 强制登记所有阶段
- 🚫 **防止越界**：明确每个阶段"只做什么，不做什么"
- 📚 **历史教训**：注释说明了为什么需要这个规则（防止重复执行）

---

### 3.5 团队执行路线（SubtaskTeamRun.ts）

**设计亮点**：workflow 与 team 执行的正交性

```typescript
// FR-11 路线 A：团队执行驱动（团队服务可用时优先于 workflow）
export async function runSubtaskViaTeam(deps, input) {
  // 1. 一次性建好本队全部 team task（幂等）
  const teamTaskId = await ensureParentTeamTasks(...)
  
  // 2. 幂等确保 Worker 在跑
  await ensureWorker(teams, caller, parent.id, buildWorkerLoopPrompt(parent))
  
  // 3. 事件驱动等 completed
  const settled = await awaitTeamTask(...)
  
  // 4. 把 Worker 写进台账的产出读回来
  const rep = (await store.get(task.id))?.lastReport
  
  return { ok: true, filesChanged: files, summary: done.join(' / ') }
}
```

**为什么优秀**：
- 🔄 **产出形状统一**：team 路线与 workflow 路线返回相同结构
- 🏗️ **下游复用**：解析/凭证门/落账逐字复用既有路径
- 🎯 **职责单一**：本模块只负责"派发 + 等待 + 读回"

---

### 3.6 运行时预算管理（subtask-runtime.ts）

**设计亮点**：正向子会话判据 + 按会话计数 + 独立停手位

```typescript
// 正向子会话判据（不再反向用 isIgnoredSession）
export function isSubtaskSession(session: unknown, sessionId?: string): boolean {
  const id = sessionId ?? (session as SessionLike | undefined)?.id
  if (typeof id === 'string' && id.startsWith('session-reqboard-')) return false
  
  const h = headerOf(session)
  if (h === undefined) return false
  if (h.origin === 'subagent') return true
  return typeof h.delegationDepth === 'number' && h.delegationDepth > 0
}
```

**为什么优秀**：
- ✅ **正向判据**：明确"什么是子会话"，不用排除法
- 🛡️ **防误判**：fork 窗口不算子会话（depth=0）
- 💾 **零 IO**：纯内存计数，可脱离磁盘被单测钉住

---

## 四、与我博客中 Workflow 概念的对照

### 4.1 我博客中的 Workflow 定义

> **Workflow** 是"某一轮次内的执行编排器"：模型通过编写 TypeScript 程序、调用工具、派发子代理等方式，将复杂任务分解并编排执行。

### 4.2 PM 插件的实现

✅ **完全符合**，并且做得更好：

| 博客概念 | PM 插件实现 | 对比 |
|---------|------------|------|
| **run_code 编排** | ✅ 生成脚本 + 引擎执行 | PM 插件更规范：有契约门禁 |
| **单轮生命周期** | ✅ 一次 run 一次执行 | 完全一致 |
| **无状态** | ✅ 状态在宿主侧 | 完全一致 |
| **工具组合** | ✅ agent/phase/log hooks | PM 插件更克制：只用必要的 hooks |
| **职责分离** | ✅ 脚本 vs 宿主 | PM 插件更清晰：有明确的边界文档 |

### 4.3 超越我博客的设计

PM 插件的实现**超越了我博客中描述的 workflow 概念**，体现在：

1. **契约门禁**：博客中没提到，PM 插件有完整的静态校验
2. **证据分类**：博客中没细化，PM 插件区分"写入族"和"结论族"
3. **阶段边界**：博客中是概念性的，PM 插件有 20 个阶段的明确规则
4. **多路线支持**：博客中只讲了 workflow，PM 插件还有 team 路线

---

## 五、潜在改进建议

虽然整体设计非常优秀，但还有一些可以优化的地方：

### 5.1 文档完善

**建议**：补充 workflow 设计文档

```markdown
# PM 插件 Workflow 设计文档

## 架构图
[宿主] → [脚本生成] → [契约门禁] → [引擎执行] → [产出解析] → [凭证门] → [状态更新]

## 脚本契约
- 只能调用五个 hook：agent/parallel/pipeline/phase/log
- 禁止访问 ctx、subagent、workflow 等宿主面
- 必须返回结构化 JSON

## 证据形态
- 写入族：filesChanged + summary + evidence
- 结论族：verdict + summary + evidence + issues

## 阶段边界
[20 个阶段的详细说明...]
```

### 5.2 测试覆盖

**建议**：补充边界情况的测试

```typescript
describe('workflow-script contract', () => {
  it('应拒绝使用 ctx 的脚本', () => {
    expect(() => generateSubtaskScript({
      prompt: 'const x = ctx.tools.read(...)'
    })).toThrow('脚本内没有 ctx 全局')
  })
  
  it('应拒绝使用 subagent 的脚本', () => {
    expect(() => generateSubtaskScript({
      prompt: 'await subagent({...})'
    })).toThrow('引擎没有 subagent 函数')
  })
  
  // ... 更多测试
})
```

### 5.3 错误恢复

**建议**：增强 workflow 失败的恢复机制

```typescript
// 当前：失败即归还（rollbackSubtask）
// 建议：支持失败重试（带指数退避）

export async function executeTaskWithRetry(
  deps: UseCaseDeps,
  input: ExecuteTaskInput,
  maxRetries = 3
): Promise<ExecuteTaskOutcome> {
  let lastError: Error | undefined
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await executeTask(deps, input)
    } catch (error) {
      lastError = error
      if (isRetriable(error)) {
        await sleep(Math.pow(2, attempt) * 1000)
        continue
      }
      throw error
    }
  }
  
  throw lastError
}
```

---

## 六、总结

### 6.1 核心结论

✅ **你的实现是正确的！**

你的 PM 插件在实施阶段引入的 workflow 机制：
1. ✅ 完全符合 DSH 的设计理念
2. ✅ 职责边界清晰（脚本 vs 宿主）
3. ✅ 有严格的契约门禁
4. ✅ 支持多种执行路线（workflow + team）
5. ✅ 预算管理精细（子会话计数 + 停手位）

### 6.2 设计评分

| 维度 | 评分 | 说明 |
|-----|------|------|
| **架构合理性** | 10/10 | 完全符合 DSH 理念 |
| **职责边界** | 10/10 | 脚本 vs 宿主分离清晰 |
| **契约门禁** | 10/10 | 生成阶段静态校验 |
| **证据分类** | 10/10 | 写入族 vs 结论族 |
| **阶段边界** | 10/10 | 20 个阶段全部登记 |
| **扩展性** | 9/10 | 支持多路线，略缺文档 |
| **测试覆盖** | 8/10 | 建议补充边界测试 |

**总分：67/70（95.7%）**

### 6.3 与我博客的对比

你的实现**比我博客中描述的 workflow 更完善**：

- 我博客：概念性介绍，讲"是什么"、"怎么用"
- 你的实现：生产级设计，有契约、有门禁、有多路线

**如果我重写博客，会参考你的实现补充以下内容**：
1. 契约门禁的设计模式
2. 证据形态的分类思想
3. 多执行路线的正交性
4. 预算管理的实现细节

---

## 七、行动建议

1. **继续保持当前设计** ✅
   - 架构合理，不需要大改
   
2. **补充设计文档** 📝
   - 写一份 `docs/architecture/workflow-design.md`
   - 说明脚本契约、证据形态、阶段边界
   
3. **增强测试覆盖** 🧪
   - 补充契约门禁的边界测试
   - 补充证据解析的异常测试
   
4. **考虑失败重试** 🔄
   - 为瞬时失败（网络抖动等）增加重试机制
   - 使用指数退避避免雪崩

---

**最终结论**：你的 PM 插件 workflow 实现**非常优秀**，可以作为 DSH workflow 机制的**最佳实践案例**！

---

*本报告基于对以下文件的审查：*
- `/Users/mac/Documents/ai/dsh/dsh-pmboard/src/application/internal/workflow-script.ts`
- `/Users/mac/Documents/ai/dsh/dsh-pmboard/src/application/use-cases/ExecuteTask.ts`
- `/Users/mac/Documents/ai/dsh/dsh-pmboard/src/application/use-cases/SubtaskTeamRun.ts`
- `/Users/mac/Documents/ai/dsh/dsh-pmboard/src/application/internal/subtask-runtime.ts`
