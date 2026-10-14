# DSH Workflow 深度解析：Agent 执行编排的艺术

## 引言

在 DeepSeek Harness (DSH) 中，**workflow** 不是一个独立的代码模块，而是一种**执行编排理念**和**工具组合使用模式**。它描述了 AI Agent 如何在一个回合（round）内通过工具调用、子代理派发、并行执行等手段完成复杂任务。

本文将深入剖析 DSH 的 workflow 机制，帮助你理解：

1. **Workflow 是什么**：概念、定位、与 Goal/Plan 的关系
2. **核心能力**：`run_code`、subagent、并行执行
3. **实现原理**：从工具调用到执行编排的完整链路
4. **最佳实践**：如何设计高效的 workflow

---

## 一、Workflow 概念解析

### 1.1 什么是 Workflow？

在 DSH 的语境中，**workflow** 是指：

> **某一轮次（round）内的执行编排器**：模型通过编写 TypeScript 程序、调用工具、派发子代理等方式，将复杂任务分解并编排执行。

**关键特征**：
- ⏱️ **单轮生命周期**：一次 `run_code` 调用，一次执行，无持久状态
- 🎯 **任务导向**：解决"这步怎么干"的问题
- 🔧 **工具组合**：`run_code` + `subagent` + `bash` + `tools.*`
- 🚫 **无状态**：不跨轮保存状态，依赖 session 事件日志

### 1.2 Workflow vs Goal vs Plan

DSH 中有三个容易混淆的概念，它们的关系是：

```
┌─────────────────────────────────────────────────┐
│                    Goal                         │  ← 持久目标 + 自动续跑
│  "整个任务要完成什么、还能跑几轮、谁有权改它"    │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │              Plan (Round 1)               │ │  ← 协作模式
│  │  "当前轮次怎么走：先设计再执行"           │ │
│  │                                           │ │
│  │  ┌─────────────────────────────────────┐ │ │
│  │  │         Workflow (Step 3)           │ │ │  ← 执行编排
│  │  │  "这步怎么干：fan-out 子代理"       │ │ │
│  │  └─────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**对比表格**：

| 维度 | Goal | Plan | Workflow |
|------|------|------|----------|
| **生命周期** | 跨多轮，持久化 | 单轮，log-only | 单步，一次执行 |
| **职责** | "任务往哪走" | "当前轮怎么走" | "这步怎么干" |
| **状态** | 持久（id/revision） | 提示词引导 | 无状态 |
| **工具** | `create_goal` | `exit_plan_mode` | `run_code` |
| **依赖** | 独立 | 独立 | 可运行在 Goal 的一轮内 |

**关键引用**（来自 blog-20-goal）：
> goal 是"总目标的状态机 + 自动续跑"（跨轮、持久、带预算、带授权）；workflow 是"某一轮次里的执行编排器"（模型写脚本 fan-out 子代理，一次 run，无持久状态）。配合方式：**workflow 跑在 goal 的一轮续跑里**——goal 管"任务往哪走"，workflow 管"这步怎么干"。

---

## 二、Workflow 核心能力

### 2.1 `run_code`：执行编排的核心

`run_code` 是 DSH 提供的最强大的工具，允许模型编写 TypeScript 程序来编排复杂的执行流程。

#### 2.1.1 基本用法

```typescript
// 模型调用示例
await tools.run_code({
  description: "并行检查三个文件是否存在",
  code: `
    const results = await Promise.all([
      tools.bash({ command: "test -f file1.txt", description: "检查文件1" }),
      tools.bash({ command: "test -f file2.txt", description: "检查文件2" }),
      tools.bash({ command: "test -f file3.txt", description: "检查文件3" })
    ]);
    
    return results.map((r, i) => ({
      file: \`file\${i+1}.txt\`,
      exists: r.exitCode === 0
    }));
  `
});
```

#### 2.1.2 核心特性

**1. 并行执行**

```typescript
// ✅ 正确：独立的只读调用可以并行
const [files, content, status] = await Promise.all([
  tools.glob({ pattern: "*.ts" }),
  tools.read({ file_path: "README.md" }),
  tools.bash({ command: "git status", description: "检查状态" })
]);

// ❌ 错误：有依赖关系必须顺序执行
const files = await tools.glob({ pattern: "*.ts" });
const content = await tools.read({ file_path: files[0] }); // 依赖 files[0]
```

**2. 错误处理**

```typescript
try {
  const result = await tools.bash({ 
    command: "npm test", 
    description: "运行测试" 
  });
} catch (error) {
  if (error.name === 'ToolCallError') {
    console.log(`工具 ${error.toolName} 失败: ${error.message}`);
    // 可以继续执行其他逻辑
  }
}
```

**3. 数据处理**

```typescript
// 批量处理：检查多个文件的 TODO 数量
const files = await tools.glob({ pattern: "src/**/*.ts" });

const todoCount = await files.reduce(async (accPromise, file) => {
  const acc = await accPromise;
  const content = await tools.read({ file_path: file });
  const todos = content.lines.filter(l => l.text.includes('TODO')).length;
  return acc + todos;
}, Promise.resolve(0));

return `总共发现 ${todoCount} 个 TODO`;
```

#### 2.1.3 设计约束

根据 system prompt 中的指导原则：

> Reserve `run_code` for what a direct call cannot do — an async TypeScript body that reaches tools as `await tools.<name>({ ... })`, overlaps independent read-only calls under `Promise.all`, and catches `ToolCallError` to continue: **programmatic batch computation, wide fan-out, or multi-step data shaping**.

**使用原则**：
- ✅ **应该使用**：批量计算、并行扇出、多步数据处理
- ❌ **不应使用**：简单的单次工具调用（直接调用即可）

---

### 2.2 Subagent：任务委派

Subagent 是 workflow 中实现任务分解的关键机制。

#### 2.2.1 两种 Subagent

**1. `subagent`：独立上下文**

```typescript
// 适用场景：研究、独立实现、分析
const agent = await tools.subagent({
  description: "分析代码复杂度",
  prompt: `
    分析 src/ 目录下所有 TypeScript 文件的圈复杂度。
    
    要求：
    1. 使用 grep 查找所有 if/for/while 语句
    2. 统计每个文件的复杂度
    3. 返回 JSON 格式的报告
  `,
  run_in_background: true
});
```

**2. `subagent_fork`：继承上下文**

```typescript
// 适用场景：后续分析、审查、延续
const agent = await tools.subagent_fork({
  description: "继续优化代码",
  prompt: `
    基于刚才的复杂度分析结果，重构复杂度最高的 3 个函数。
  `,
  run_in_background: true
});
```

#### 2.2.2 Subagent 生命周期

```
┌─────────────────────────────────────────────┐
│  Parent Agent (运行 run_code)              │
│                                             │
│  const agent = await subagent({...})       │
│         │                                   │
│         ├─→ 创建子代理 (后台运行)          │
│         │                                   │
│         └─→ 返回 agent_id                  │
│                                             │
│  // 父代理继续执行其他任务...               │
│                                             │
│  ← 收到通知：子代理完成                     │
│                                             │
│  await send_message(agent_id, "继续...")   │
└─────────────────────────────────────────────┘
```

---

### 2.3 并行执行模式

Workflow 的强大之处在于能够**并行化独立任务**，大幅提升效率。

#### 2.3.1 文件操作并行

```typescript
// 场景：同时读取多个配置文件
const [pkg, tsconfig, readme] = await Promise.all([
  tools.read({ file_path: "package.json" }),
  tools.read({ file_path: "tsconfig.json" }),
  tools.read({ file_path: "README.md" })
]);

const config = {
  name: JSON.parse(pkg.content).name,
  typescript: JSON.parse(tsconfig.content).compilerOptions,
  description: readme.lines[0].text
};
```

#### 2.3.2 多任务派发并行

```typescript
// 场景：同时派发多个子代理处理不同模块
const agents = await Promise.all([
  tools.subagent({
    description: "分析前端代码",
    prompt: "分析 src/frontend/ 的代码质量",
    run_in_background: true
  }),
  tools.subagent({
    description: "分析后端代码",
    prompt: "分析 src/backend/ 的代码质量",
    run_in_background: true
  }),
  tools.subagent({
    description: "分析测试代码",
    prompt: "分析 tests/ 的覆盖率",
    run_in_background: true
  })
]);

// 等待所有子代理完成（系统会自动通知）
console.log(`已派发 ${agents.length} 个分析任务`);
```

#### 2.3.3 混合并行

```typescript
// 场景：同时执行搜索、命令、文件读取
const [searchResults, gitStatus, pkgInfo] = await Promise.all([
  tools.grep({ pattern: "TODO", path: "src" }),
  tools.bash({ command: "git status --short", description: "检查Git状态" }),
  tools.read({ file_path: "package.json" })
]);
```

---

## 三、Workflow 实现原理

### 3.1 架构层次

```
┌─────────────────────────────────────────────────┐
│              User Request                       │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│           Agent Loop (Turn)                     │
│  • 调用 LLM                                     │
│  • 解析 tool calls                              │
└──────────────┬──────────────────────────────────┘
               │
               ├─→ Direct Tool Call (简单工具)
               │   └─→ bash / read / write ...
               │
               └─→ run_code (Workflow 入口)
                   │
                   ├─→ TypeScript 执行环境
                   │   └─→ tools.* SDK
                   │
                   ├─→ 并行编排 (Promise.all)
                   │
                   ├─→ 错误处理 (try/catch)
                   │
                   └─→ Subagent 派发
                       └─→ 递归 Agent Loop
```

### 3.2 `run_code` 执行流程

```typescript
// 1. 模型生成 tool call
{
  tool: "run_code",
  args: {
    code: "return await tools.bash({...})",
    description: "执行命令"
  }
}

// 2. run_code 工具接收
async function execute(args) {
  // 3. 创建 TypeScript 执行上下文
  const fn = new Function('tools', `
    return (async () => {
      ${args.code}
    })()
  `);
  
  // 4. 注入 tools SDK
  const toolsSDK = createToolsSDK(ctx);
  
  // 5. 执行用户代码
  const result = await fn(toolsSDK);
  
  // 6. 返回结果
  return result;
}
```

### 3.3 Tools SDK 实现

```typescript
// run_code 内部的 tools 对象
const toolsSDK = {
  bash: async (args) => {
    // 调用真实的 bash 工具
    return await ctx.tools.execute({
      tool: 'bash',
      args
    });
  },
  
  read: async (args) => {
    return await ctx.tools.execute({
      tool: 'read',
      args
    });
  },
  
  subagent: async (args) => {
    // 创建子代理
    const agent = await ctx.agentLoop.createSubagent({
      prompt: args.prompt,
      background: args.run_in_background
    });
    return { subagentId: agent.id };
  },
  
  // ... 所有工具的包装
};
```

---

## 四、Workflow 最佳实践

### 4.1 设计原则

#### 1. **单一职责**

```typescript
// ❌ 错误：一个 run_code 做太多事
await tools.run_code({
  description: "分析、修复、测试、部署",
  code: `
    // 1. 分析代码
    const issues = await analyzeCode();
    // 2. 修复问题
    await fixIssues(issues);
    // 3. 运行测试
    await runTests();
    // 4. 部署
    await deploy();
  `
});

// ✅ 正确：拆分为多个步骤
// Step 1: 分析
const issues = await tools.run_code({
  description: "分析代码问题",
  code: `return await analyzeCode();`
});

// Step 2: 修复（根据分析结果）
await tools.run_code({
  description: "修复发现的问题",
  code: `await fixIssues(${JSON.stringify(issues)});`
});

// ... 后续步骤
```

#### 2. **优先并行**

```typescript
// ❌ 错误：顺序执行独立任务
const file1 = await tools.read({ file_path: "a.txt" });
const file2 = await tools.read({ file_path: "b.txt" });
const file3 = await tools.read({ file_path: "c.txt" });

// ✅ 正确：并行执行
const [file1, file2, file3] = await Promise.all([
  tools.read({ file_path: "a.txt" }),
  tools.read({ file_path: "b.txt" }),
  tools.read({ file_path: "c.txt" })
]);
```

#### 3. **错误边界**

```typescript
// ✅ 正确：为关键操作添加错误处理
await tools.run_code({
  description: "批量处理文件",
  code: `
    const results = [];
    for (const file of files) {
      try {
        const result = await tools.bash({ 
          command: \`process \${file}\`,
          description: \`处理 \${file}\`
        });
        results.push({ file, success: true, result });
      } catch (error) {
        results.push({ file, success: false, error: error.message });
      }
    }
    return results;
  `
});
```

### 4.2 性能优化

#### 1. **批量优于循环**

```typescript
// ❌ 低效：逐个文件处理
for (const file of files) {
  await tools.read({ file_path: file });
}

// ✅ 高效：批量并行
await Promise.all(
  files.map(file => tools.read({ file_path: file }))
);
```

#### 2. **延迟加载**

```typescript
// ✅ 只在需要时读取
const needsDetail = checkIfNeedsDetail();

if (needsDetail) {
  const detail = await tools.read({ file_path: "large-file.json" });
}
```

#### 3. **结果过滤**

```typescript
// ✅ 在工具层过滤，不要返回大量数据再过滤
await tools.bash({ 
  command: "grep 'ERROR' app.log | head -10",
  description: "获取最近10条错误日志"
});

// ❌ 避免
const allLogs = await tools.bash({ 
  command: "cat app.log",
  description: "读取所有日志"
});
// 然后在 run_code 里过滤...
```

### 4.3 常见模式

#### 模式 1：Map-Reduce

```typescript
// 场景：统计多个文件的代码行数
await tools.run_code({
  description: "统计所有 TS 文件的总行数",
  code: `
    // Map: 并行读取所有文件
    const files = await tools.glob({ pattern: "src/**/*.ts" });
    const contents = await Promise.all(
      files.map(f => tools.read({ file_path: f }))
    );
    
    // Reduce: 汇总行数
    const totalLines = contents.reduce((sum, content) => {
      return sum + content.totalLines;
    }, 0);
    
    return { totalFiles: files.length, totalLines };
  `
});
```

#### 模式 2：Pipeline

```typescript
// 场景：数据处理流水线
await tools.run_code({
  description: "处理数据流水线",
  code: `
    // Stage 1: 提取
    const rawData = await tools.bash({ 
      command: "cat data.csv",
      description: "读取原始数据"
    });
    
    // Stage 2: 转换
    const lines = rawData.stdout.text.split('\\n');
    const parsed = lines.map(line => {
      const [name, value] = line.split(',');
      return { name, value: parseFloat(value) };
    });
    
    // Stage 3: 过滤
    const filtered = parsed.filter(item => item.value > 100);
    
    // Stage 4: 保存
    await tools.write({
      file_path: "output.json",
      content: JSON.stringify(filtered, null, 2)
    });
    
    return { processed: filtered.length };
  `
});
```

#### 模式 3：Fan-out/Fan-in

```typescript
// 场景：分布式任务处理
await tools.run_code({
  description: "并行处理多个模块",
  code: `
    // Fan-out: 派发多个子任务
    const modules = ['auth', 'api', 'database'];
    const agents = await Promise.all(
      modules.map(mod => tools.subagent({
        description: \`测试 \${mod} 模块\`,
        prompt: \`运行 \${mod} 模块的单元测试并报告结果\`,
        run_in_background: true
      }))
    );
    
    // Fan-in: 等待所有结果（通过系统通知机制）
    console.log(\`已派发 \${agents.length} 个测试任务\`);
    return { agents: agents.map(a => a.subagentId) };
  `
});
```

---

## 五、实战案例

### 案例 1：代码审查 Workflow

```typescript
// 完整的代码审查流程
await tools.run_code({
  description: "执行完整代码审查",
  code: `
    // 1. 并行收集信息
    const [changedFiles, testCoverage, lintResults] = await Promise.all([
      tools.bash({ 
        command: "git diff --name-only HEAD~1",
        description: "获取变更文件"
      }),
      tools.bash({ 
        command: "npm run test:coverage",
        description: "运行测试覆盖率"
      }),
      tools.bash({ 
        command: "npm run lint",
        description: "运行代码检查"
      })
    ]);
    
    // 2. 解析变更文件
    const files = changedFiles.stdout.text
      .split('\\n')
      .filter(f => f.endsWith('.ts'));
    
    // 3. 派发详细审查（每个文件一个子代理）
    const reviews = await Promise.all(
      files.map(file => tools.subagent({
        description: \`审查 \${file}\`,
        prompt: \`
          详细审查 \${file} 的变更：
          1. 代码质量
          2. 潜在bug
          3. 性能问题
          4. 安全隐患
        \`,
        run_in_background: true
      }))
    );
    
    // 4. 返回审查报告
    return {
      filesReviewed: files.length,
      testCoverageOk: testCoverage.exitCode === 0,
      lintPassed: lintResults.exitCode === 0,
      reviewAgents: reviews.map(r => r.subagentId)
    };
  `
});
```

### 案例 2：文档生成 Workflow

```typescript
// 自动生成项目文档
await tools.run_code({
  description: "生成项目文档",
  code: `
    // 1. 分析项目结构
    const structure = await tools.bash({
      command: "tree -L 3 -I 'node_modules|dist'",
      description: "获取目录结构"
    });
    
    // 2. 并行读取关键文件
    const [pkg, readme, tsconfig] = await Promise.all([
      tools.read({ file_path: "package.json" }),
      tools.read({ file_path: "README.md" }).catch(() => null),
      tools.read({ file_path: "tsconfig.json" })
    ]);
    
    // 3. 提取API文档（派发子代理）
    const apiAgent = await tools.subagent({
      description: "生成API文档",
      prompt: "分析 src/ 下所有导出的函数和类，生成API文档",
      run_in_background: true
    });
    
    // 4. 生成架构图（派发子代理）
    const archAgent = await tools.subagent({
      description: "生成架构图",
      prompt: "分析模块依赖关系，生成 Mermaid 架构图",
      run_in_background: true
    });
    
    return {
      structure: structure.stdout.text,
      hasReadme: !!readme,
      documentationAgents: [apiAgent.subagentId, archAgent.subagentId]
    };
  `
});
```

---

## 六、调试与监控

### 6.1 日志记录

```typescript
await tools.run_code({
  description: "带日志的任务处理",
  code: `
    console.log('[Workflow] 开始处理...');
    
    const files = await tools.glob({ pattern: "*.ts" });
    console.log(\`[Workflow] 发现 \${files.length} 个文件\`);
    
    for (const file of files) {
      console.log(\`[Workflow] 处理: \${file}\`);
      await tools.bash({ 
        command: \`process \${file}\`,
        description: \`处理 \${file}\`
      });
    }
    
    console.log('[Workflow] 完成');
    return { processed: files.length };
  `
});
```

### 6.2 性能追踪

```typescript
await tools.run_code({
  description: "性能追踪示例",
  code: `
    const startTime = Date.now();
    
    const result = await tools.bash({ 
      command: "npm run build",
      description: "构建项目"
    });
    
    const duration = Date.now() - startTime;
    console.log(\`构建耗时: \${duration}ms\`);
    
    return { success: result.exitCode === 0, duration };
  `
});
```

---

## 七、局限性与注意事项

### 7.1 状态管理

⚠️ **Workflow 无状态**：`run_code` 执行完毕后不保留任何状态，所有状态必须：
- 写入文件系统
- 通过 session 事件日志传递
- 存储在外部数据库

### 7.2 超时控制

⚠️ **默认超时**：`run_code` 有默认超时限制（通常 120 秒），长任务应：
- 拆分为多个步骤
- 使用 background subagent
- 设置合理的 `timeoutMs`

### 7.3 错误传播

⚠️ **工具失败不自动重试**：需要显式处理：

```typescript
// 建议模式：关键操作带重试
let retries = 3;
while (retries > 0) {
  try {
    await tools.bash({ command: "flaky-command", description: "执行" });
    break;
  } catch (error) {
    retries--;
    if (retries === 0) throw error;
    console.log(\`重试剩余: \${retries}\`);
  }
}
```

---

## 八、总结

### 核心要点

1. **Workflow 是概念，不是模块**：通过 `run_code` + 工具组合实现执行编排
2. **与 Goal/Plan 正交**：Goal 管"往哪走"，Plan 管"怎么走"，Workflow 管"怎么干"
3. **核心能力三件套**：
   - `run_code`：编程式编排
   - `subagent`：任务委派
   - `Promise.all`：并行执行
4. **设计原则**：单一职责、优先并行、错误边界
5. **适用场景**：批量计算、扇出任务、多步处理

### 何时使用 Workflow？

✅ **应该使用**：
- 需要并行执行多个独立任务
- 需要批量处理数据
- 需要复杂的条件分支和错误处理
- 需要派发多个子代理

❌ **不应使用**：
- 简单的单次工具调用
- 顺序执行的线性任务（直接多步调用即可）
- 需要跨轮持久化状态（应使用 Goal）

### 延伸学习

1. **深入 `run_code`**：研究 TypeScript 沙箱执行环境
2. **Subagent 机制**：理解子代理的生命周期和通信
3. **Goal 系统**：学习长任务的持久化管理
4. **Tools 系统**：了解工具注册、权限、管道

---

**参考资料**：
- DSH 源码：`packages/workflow/` (概念性包，无独立实现)
- Goal 博客：`04-实现/blog-20-goal/blog.md`
- System Prompt：DSH 内置指导原则

---

*本文基于 DSH 架构分析编写，代码示例均为演示用途。实际使用时请参考 DSH 官方文档和源码。*
