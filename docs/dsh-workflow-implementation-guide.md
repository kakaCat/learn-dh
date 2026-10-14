# DSH Workflow 完整实现指南：从概念到源码

## 目录

1. [引言](#引言)
2. [Workflow 架构总览](#workflow-架构总览)
3. [run_code 深度实现](#run_code-深度实现)
4. [Subagent 机制详解](#subagent-机制详解)
5. [并行执行引擎](#并行执行引擎)
6. [Tools SDK 内部实现](#tools-sdk-内部实现)
7. [实战案例：完整项目](#实战案例完整项目)
8. [性能优化与最佳实践](#性能优化与最佳实践)
9. [故障排查指南](#故障排查指南)

---

## 引言

本文是对 DSH Workflow 的**完整实现指南**，不仅涵盖概念和用法，还会深入到源码层面，帮助你理解：

- **Workflow 如何在 DSH 架构中工作**
- **`run_code` 的内部执行机制**
- **Subagent 的创建、通信和生命周期管理**
- **并行执行的实现原理**
- **如何设计和调试复杂的 workflow**

### 阅读建议

- 如果你是**初学者**：先阅读 `dsh-workflow-deep-dive.md` 了解基本概念
- 如果你想**深入实现**：本文会带你逐步解析源码
- 如果你要**实战开发**：直接跳到第 7 章查看完整案例

---

## Workflow 架构总览

### 核心组件关系图

```
┌────────────────────────────────────────────────────────┐
│                    DSH 架构层次                        │
└────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  User Layer                                             │
│  ┌─────────────────────────────────────────────────┐   │
│  │  用户请求 → Agent Loop → Tool Calls             │   │
│  └─────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Tool Layer (工具层)                                     │
│  ┌────────────┬────────────┬─────────────┬──────────┐  │
│  │  Direct    │  run_code  │  subagent   │  Goal/   │  │
│  │  Tools     │            │             │  Plan    │  │
│  │ (bash/read)│            │             │          │  │
│  └────────────┴────────────┴─────────────┴──────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Execution Layer (执行层)                                │
│  ┌──────────────────────────────────────────────────┐  │
│  │  TypeScript Runtime                              │  │
│  │  ┌────────────┬──────────────┬─────────────┐    │  │
│  │  │ Tools SDK  │ Promise.all  │ Error       │    │  │
│  │  │            │              │ Handling    │    │  │
│  │  └────────────┴──────────────┴─────────────┘    │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Service Layer (服务层)                                  │
│  ┌────────────┬────────────┬─────────────┬──────────┐  │
│  │  Session   │  Event Log │  Job Queue  │  State   │  │
│  │  Manager   │            │             │  Manager │  │
│  └────────────┴────────────┴─────────────┴──────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Workflow 在架构中的位置

Workflow **不是一个独立的包或模块**，而是：

1. **概念层**：一种执行编排的思想模式
2. **实现层**：通过 `run_code` 工具实现
3. **协作层**：与 Goal、Plan、Subagent 配合使用

**关键点**：
- Workflow 运行在 **Tool Layer**，由模型主动调用
- 通过 **Execution Layer** 的 TypeScript Runtime 执行
- 依赖 **Service Layer** 的 Session、Event Log 等基础设施

---

## run_code 深度实现

### 3.1 工具定义

`run_code` 是 DSH 中最复杂的工具之一，其核心定义如下：

```typescript
// packages/tools/src/tool-run-code.ts (简化版)

interface RunCodeArgs {
  code: string;           // TypeScript 代码体（async 函数体）
  description: string;    // 简短描述（5-10词）
  timeoutMs?: number;     // 超时时间（默认 120000ms）
  sandbox_permissions?: 'workspace-write' | 'danger-full-access';
  justification?: string; // 权限说明
}

interface RunCodeOutput {
  kind: 'foreground';
  result: JsonValue;      // 程序返回值
  console: string[];      // console.log 输出
  duration: number;       // 执行时长（ms）
}
```

### 3.2 执行流程详解

#### Step 1: 代码接收与验证

```typescript
// 当模型调用 run_code 时
async function executeRunCode(
  ctx: Context,
  args: RunCodeArgs
): Promise<RunCodeOutput> {
  // 1. 验证代码语法
  validateTypeScriptSyntax(args.code);
  
  // 2. 检查沙箱权限
  const sandboxMode = ctx.config.sandboxMode;
  if (requiresEscalation(args.code, sandboxMode)) {
    if (!args.sandbox_permissions) {
      throw new Error('需要更高权限，请设置 sandbox_permissions');
    }
    // 请求用户批准（如果启用了审批流程）
    await requestApproval(args.justification);
  }
  
  // 3. 创建执行环境
  const runtime = await createTypeScriptRuntime(ctx);
  
  return runtime.execute(args.code);
}
```

#### Step 2: TypeScript Runtime 创建

```typescript
// TypeScript 执行运行时
class TypeScriptRuntime {
  private ctx: Context;
  private toolsSDK: ToolsSDK;
  
  constructor(ctx: Context) {
    this.ctx = ctx;
    this.toolsSDK = createToolsSDK(ctx);
  }
  
  async execute(code: string): Promise<RunCodeOutput> {
    const startTime = Date.now();
    const consoleLogs: string[] = [];
    
    // 创建执行上下文
    const sandbox = {
      tools: this.toolsSDK,
      console: {
        log: (...args: any[]) => {
          consoleLogs.push(args.map(String).join(' '));
        }
      },
      Promise,
      JSON,
      // 其他全局对象...
    };
    
    try {
      // 将用户代码包装为 async 函数
      const wrappedCode = `
        return (async () => {
          ${code}
        })();
      `;
      
      // 使用 Function 构造器创建函数
      const fn = new Function(
        ...Object.keys(sandbox),
        wrappedCode
      );
      
      // 执行函数
      const result = await fn(...Object.values(sandbox));
      
      return {
        kind: 'foreground',
        result,
        console: consoleLogs,
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      // 错误处理
      throw new ToolExecutionError('run_code', error.message);
    }
  }
}
```

#### Step 3: Tools SDK 注入

```typescript
// 创建 tools 对象，供用户代码调用
function createToolsSDK(ctx: Context): ToolsSDK {
  const sdk: ToolsSDK = {};
  
  // 为每个可用工具创建包装函数
  for (const [toolName, toolDef] of ctx.tools.entries()) {
    sdk[toolName] = async (args: any) => {
      try {
        // 调用真实的工具
        const result = await ctx.tools.execute({
          tool: toolName,
          args,
          source: 'run_code'  // 标记来源
        });
        
        return result;
        
      } catch (error) {
        // 转换为 ToolCallError
        const err = new Error(error.message);
        err.name = 'ToolCallError';
        (err as any).toolName = toolName;
        throw err;
      }
    };
  }
  
  return sdk;
}
```

### 3.3 并行执行实现

`Promise.all` 的并行执行是在用户代码层面的，但 DSH 在底层做了优化：

```typescript
// 工具执行器识别并行调用
class ToolExecutor {
  private pendingCalls = new Map<string, Promise<any>>();
  
  async execute(call: ToolCall): Promise<any> {
    // 检查是否是只读工具
    const isReadOnly = this.isReadOnlyTool(call.tool);
    
    if (isReadOnly) {
      // 只读工具可以并行执行
      return this.executeParallel(call);
    } else {
      // 写操作必须串行
      await this.waitForPendingWrites();
      return this.executeSerial(call);
    }
  }
  
  private async executeParallel(call: ToolCall): Promise<any> {
    // 创建执行 Promise
    const promise = this.doExecute(call);
    
    // 记录到 pending 池
    const callId = generateCallId();
    this.pendingCalls.set(callId, promise);
    
    // 执行完成后移除
    promise.finally(() => {
      this.pendingCalls.delete(callId);
    });
    
    return promise;
  }
  
  private isReadOnlyTool(toolName: string): boolean {
    // 只读工具列表
    const readOnlyTools = [
      'read', 'glob', 'grep', 'bash' // bash 读操作
    ];
    return readOnlyTools.includes(toolName);
  }
}
```

### 3.4 错误处理机制

```typescript
// 用户代码中的错误处理示例
const code = `
  const results = [];
  
  for (const file of files) {
    try {
      const content = await tools.read({ file_path: file });
      results.push({ file, success: true, content });
    } catch (error) {
      // ToolCallError 会被捕获
      if (error.name === 'ToolCallError') {
        results.push({ 
          file, 
          success: false, 
          tool: error.toolName,
          error: error.message 
        });
      } else {
        throw error; // 其他错误向上传播
      }
    }
  }
  
  return results;
`;
```

---

## Subagent 机制详解

### 4.1 Subagent 架构

```
┌─────────────────────────────────────────────────────┐
│  Parent Agent Session                               │
│  ┌───────────────────────────────────────────────┐ │
│  │  Agent Loop (运行中)                          │ │
│  │                                               │ │
│  │  run_code {                                   │ │
│  │    const agent = await tools.subagent({      │ │
│  │      description: "分析代码",                │ │
│  │      prompt: "...",                          │ │
│  │      run_in_background: true                 │ │
│  │    });                                       │ │
│  │    // 返回 { subagentId: "agent-xxx" }      │ │
│  │  }                                            │ │
│  └───────────────┬───────────────────────────────┘ │
│                  │                                  │
│                  │ 创建子会话                       │
│                  ▼                                  │
│  ┌───────────────────────────────────────────────┐ │
│  │  Subagent Session (agent-xxx)                │ │
│  │  ┌─────────────────────────────────────────┐ │ │
│  │  │  独立的 Agent Loop                      │ │ │
│  │  │  - 独立的事件日志                       │ │ │
│  │  │  - 独立的工具上下文                     │ │ │
│  │  │  - 独立的状态管理                       │ │ │
│  │  └─────────────────────────────────────────┘ │ │
│  │                                               │ │
│  │  完成后 → 通知父代理                         │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 4.2 Subagent 创建流程

```typescript
// packages/tools/src/tool-subagent.ts

interface SubagentArgs {
  description: string;      // 3-5 词的简短描述
  prompt: string;          // 完整的任务描述
  run_in_background?: boolean; // 默认 true
}

async function createSubagent(
  ctx: Context,
  args: SubagentArgs
): Promise<SubagentOutput> {
  
  // 1. 创建子会话
  const subSession = await ctx.sessions.create({
    parentId: ctx.session.id,
    type: 'subagent',
    label: args.description
  });
  
  // 2. 初始化子会话的上下文
  await initializeSubagentContext(subSession, {
    // 继承父会话的部分配置
    model: ctx.config.model,
    temperature: ctx.config.temperature,
    // 但有独立的事件日志
    eventLog: createEventLog(subSession.id)
  });
  
  // 3. 向子会话发送初始消息
  await subSession.inbox.push({
    type: 'user-message',
    content: args.prompt,
    source: 'parent-agent'  // 标记来源
  });
  
  // 4. 启动子代理的 Agent Loop
  if (args.run_in_background) {
    // 后台运行，立即返回
    const job = ctx.jobs.schedule({
      type: 'subagent',
      sessionId: subSession.id,
      async execute() {
        await runAgentLoop(subSession);
      }
    });
    
    return {
      kind: 'background',
      jobId: job.id,
      subagentId: subSession.id
    };
    
  } else {
    // 前台运行，等待完成
    const result = await runAgentLoop(subSession);
    
    return {
      kind: 'foreground',
      runId: generateRunId(),
      output: result
    };
  }
}
```

### 4.3 Subagent 通信机制

```typescript
// 父子代理通信

// 1. 父代理向子代理发送消息
await tools.send_message({
  agent_id: subagentId,
  message: "请继续分析，重点关注性能问题"
});

// 2. 子代理完成后通知父代理
// 这是自动的，通过事件系统实现
ctx.on('subagent:completed', (event) => {
  const { subagentId, result } = event;
  console.log(`子代理 ${subagentId} 完成，结果：`, result);
  
  // 父代理可以继续处理
});

// 3. 父代理查询子代理状态
const agents = await tools.list_agents({ scope: 'children' });
// 返回：
// [
//   { id: 'agent-001', label: '分析代码', status: 'running' },
//   { id: 'agent-002', label: '生成文档', status: 'inactive' }
// ]
```

### 4.4 Subagent Fork 实现

`subagent_fork` 与 `subagent` 的区别在于**上下文继承**：

```typescript
async function createSubagentFork(
  ctx: Context,
  args: SubagentArgs
): Promise<SubagentOutput> {
  
  // 1. 创建子会话，继承父会话历史
  const subSession = await ctx.sessions.fork({
    parentId: ctx.session.id,
    forkPoint: 'latest-complete-turn', // 最近的完整回合
    label: args.description
  });
  
  // 2. 子会话已经有了父会话的历史事件
  // 事件日志包含：
  // - 所有已完成的用户-模型对话
  // - 所有工具调用结果
  // - 状态快照
  
  // 3. 添加新任务消息
  await subSession.inbox.push({
    type: 'user-message',
    content: args.prompt,
    source: 'parent-agent-fork'
  });
  
  // 4. 启动（同 subagent）
  return startSubagent(subSession, args.run_in_background);
}
```

**使用场景对比**：

```typescript
// ❌ 错误：需要上下文但用了 subagent
await tools.subagent({
  description: "优化刚才的代码",
  prompt: "基于之前的分析结果，优化性能最差的 3 个函数"
  // 子代理不知道"之前的分析结果"是什么！
});

// ✅ 正确：需要上下文用 subagent_fork
await tools.subagent_fork({
  description: "优化刚才的代码",
  prompt: "基于之前的分析结果，优化性能最差的 3 个函数"
  // 子代理继承了父会话历史，知道之前的分析结果
});
```

---

## 并行执行引擎

### 5.1 并行调度器实现

```typescript
// packages/core/src/parallel-scheduler.ts

class ParallelScheduler {
  private readOnlyTools = new Set([
    'read', 'glob', 'grep', 'bash', 'read_image'
  ]);
  
  private writingTools = new Set([
    'write', 'edit', 'bash'  // bash 可能写
  ]);
  
  async scheduleToolCalls(calls: ToolCall[]): Promise<any[]> {
    // 1. 分类工具调用
    const readCalls = calls.filter(c => this.isReadOnly(c));
    const writeCalls = calls.filter(c => !this.isReadOnly(c));
    
    // 2. 检测依赖关系
    const groups = this.groupByDependencies(calls);
    
    // 3. 并行执行每个组
    const results: any[] = [];
    
    for (const group of groups) {
      if (group.every(c => this.isReadOnly(c))) {
        // 全部只读，完全并行
        const groupResults = await Promise.all(
          group.map(c => this.executeToolCall(c))
        );
        results.push(...groupResults);
      } else {
        // 有写操作，串行执行
        for (const call of group) {
          const result = await this.executeToolCall(call);
          results.push(result);
        }
      }
    }
    
    return results;
  }
  
  private groupByDependencies(calls: ToolCall[]): ToolCall[][] {
    // 简单启发式：
    // 1. 连续的只读调用分为一组
    // 2. 写操作单独一组
    
    const groups: ToolCall[][] = [];
    let currentGroup: ToolCall[] = [];
    
    for (const call of calls) {
      if (this.isReadOnly(call)) {
        currentGroup.push(call);
      } else {
        // 遇到写操作，结束当前组
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
          currentGroup = [];
        }
        // 写操作单独一组
        groups.push([call]);
      }
    }
    
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    
    return groups;
  }
  
  private isReadOnly(call: ToolCall): boolean {
    if (this.readOnlyTools.has(call.tool)) {
      // bash 需要特殊判断
      if (call.tool === 'bash') {
        return this.isBashReadOnly(call.args.command);
      }
      return true;
    }
    return false;
  }
  
  private isBashReadOnly(command: string): boolean {
    // 启发式判断 bash 命令是否只读
    const writePatterns = [
      /rm\s/, /mv\s/, /cp\s/,
      />/, />>/, 
      /mkdir\s/, /touch\s/
    ];
    
    return !writePatterns.some(p => p.test(command));
  }
}
```

### 5.2 Promise.all 优化

用户代码中的 `Promise.all` 会触发并行调度：

```typescript
// 用户代码
await Promise.all([
  tools.read({ file_path: 'a.txt' }),
  tools.read({ file_path: 'b.txt' }),
  tools.read({ file_path: 'c.txt' })
]);

// 底层执行时序
/*
Time 0ms:  启动所有 3 个 read 调用
Time 10ms: read(a.txt) 完成
Time 15ms: read(b.txt) 完成
Time 20ms: read(c.txt) 完成
Time 20ms: Promise.all 返回

总耗时: 20ms (如果串行则需要 45ms)
*/
```

---

## Tools SDK 内部实现

### 6.1 完整 SDK 结构

```typescript
// packages/tools/src/tools-sdk.ts

interface ToolsSDK {
  // 文件操作
  read(args: { file_path: string }): Promise<ReadOutput>;
  write(args: { file_path: string; content: string }): Promise<WriteOutput>;
  edit(args: { file_path: string; old_string: string; new_string: string }): Promise<EditOutput>;
  
  // 搜索
  glob(args: { pattern: string }): Promise<GlobOutput>;
  grep(args: { pattern: string; path?: string }): Promise<GrepOutput>;
  
  // 执行
  bash(args: { command: string; description: string }): Promise<BashOutput>;
  run_code(args: { code: string; description: string }): Promise<RunCodeOutput>;
  
  // 子代理
  subagent(args: SubagentArgs): Promise<SubagentOutput>;
  subagent_fork(args: SubagentArgs): Promise<SubagentOutput>;
  
  // ... 所有其他工具
}

function createToolsSDK(ctx: Context): ToolsSDK {
  return new Proxy({}, {
    get(target, toolName: string) {
      return async (args: any) => {
        // 统一的工具调用入口
        return await ctx.tools.execute({
          tool: toolName,
          args,
          source: ctx.source || 'user'
        });
      };
    }
  }) as ToolsSDK;
}
```

### 6.2 工具调用生命周期

```typescript
// 单个工具调用的完整生命周期

async function executeToolCall(
  ctx: Context,
  call: ToolCall
): Promise<ToolOutput> {
  
  // 1. Pre-execution hooks
  await ctx.emit('tool:before-execute', { call });
  
  // 2. 权限检查
  await checkPermissions(ctx, call);
  
  // 3. 参数验证
  validateArgs(call.tool, call.args);
  
  // 4. 执行工具
  const startTime = Date.now();
  let result: any;
  
  try {
    result = await executeToolImpl(ctx, call);
    
    // 5. 记录成功
    await ctx.emit('tool:executed', {
      call,
      result,
      duration: Date.now() - startTime
    });
    
  } catch (error) {
    // 6. 记录失败
    await ctx.emit('tool:failed', {
      call,
      error,
      duration: Date.now() - startTime
    });
    
    throw error;
  }
  
  // 7. Post-execution hooks
  await ctx.emit('tool:after-execute', { call, result });
  
  // 8. 写入事件日志
  ctx.session.eventLog.append({
    type: 'tool-result',
    tool: call.tool,
    args: call.args,
    result,
    timestamp: Date.now()
  });
  
  return result;
}
```

---

## 实战案例：完整项目

### 7.1 案例：自动化 CI/CD Pipeline

这是一个完整的、生产级的 workflow 案例，展示如何使用 DSH 自动化 CI/CD 流程。

#### 需求分析

**目标**：创建一个 workflow，自动化以下流程：
1. 检查代码变更
2. 运行代码检查（lint）
3. 运行单元测试
4. 运行集成测试
5. 生成测试报告
6. 如果全部通过，自动部署到 staging

**挑战**：
- 步骤之间有依赖关系（测试依赖 lint 通过）
- 需要并行执行独立任务（单元测试和集成测试可以并行）
- 需要错误恢复（测试失败后重试）
- 需要生成详细报告

#### 实现代码

```typescript
// workflow-ci-cd.ts

async function runCICDPipeline() {
  await tools.run_code({
    description: "执行完整 CI/CD 流程",
    code: `
      // ==================== Phase 1: 准备阶段 ====================
      console.log('[Phase 1/5] 准备环境...');
      
      // 并行检查：Git 状态、依赖、环境变量
      const [gitStatus, deps, envCheck] = await Promise.all([
        tools.bash({ 
          command: "git status --porcelain",
          description: "检查 Git 状态"
        }),
        tools.bash({ 
          command: "npm list --depth=0",
          description: "检查依赖安装"
        }),
        tools.bash({ 
          command: "env | grep -E '(NODE_ENV|CI)'",
          description: "检查环境变量"
        })
      ]);
      
      // 解析变更文件
      const changedFiles = gitStatus.stdout.text
        .split('\\n')
        .filter(line => line.trim())
        .map(line => {
          const match = line.match(/^\\s*[A-Z?]+\\s+(.+)$/);
          return match ? match[1] : null;
        })
        .filter(Boolean);
      
      console.log(\`发现 \${changedFiles.length} 个变更文件\`);
      
      // ==================== Phase 2: 代码检查 ====================
      console.log('[Phase 2/5] 代码检查...');
      
      let lintPassed = false;
      let lintRetries = 3;
      
      while (!lintPassed && lintRetries > 0) {
        try {
          const lintResult = await tools.bash({
            command: "npm run lint -- --max-warnings=0",
            description: "运行 ESLint"
          });
          
          lintPassed = lintResult.exitCode === 0;
          console.log('✓ Lint 通过');
          
        } catch (error) {
          lintRetries--;
          console.log(\`✗ Lint 失败，剩余重试次数: \${lintRetries}\`);
          
          if (lintRetries === 0) {
            return {
              success: false,
              stage: 'lint',
              error: error.message
            };
          }
          
          // 尝试自动修复
          await tools.bash({
            command: "npm run lint -- --fix",
            description: "自动修复 lint 问题"
          });
        }
      }
      
      // ==================== Phase 3: 测试阶段 ====================
      console.log('[Phase 3/5] 运行测试...');
      
      // 派发两个子代理并行运行测试
      const [unitTestAgent, integrationTestAgent] = await Promise.all([
        tools.subagent({
          description: "运行单元测试",
          prompt: \`
            运行项目的单元测试套件：
            
            1. 执行 npm run test:unit
            2. 生成覆盖率报告
            3. 提取关键指标：
               - 总测试数
               - 通过/失败数
               - 覆盖率（行/分支/函数/语句）
            4. 返回 JSON 格式的结果
          \`,
          run_in_background: true
        }),
        
        tools.subagent({
          description: "运行集成测试",
          prompt: \`
            运行项目的集成测试套件：
            
            1. 启动测试数据库（如需要）
            2. 执行 npm run test:integration
            3. 提取关键指标：
               - 总测试数
               - 通过/失败数
               - 平均执行时间
            4. 返回 JSON 格式的结果
            5. 清理测试数据库
          \`,
          run_in_background: true
        })
      ]);
      
      console.log(\`已派发测试任务：\${unitTestAgent.subagentId}, \${integrationTestAgent.subagentId}\`);
      
      // ==================== Phase 4: 构建阶段 ====================
      console.log('[Phase 4/5] 构建项目...');
      
      const buildStartTime = Date.now();
      
      try {
        const buildResult = await tools.bash({
          command: "npm run build",
          description: "构建生产版本",
          timeoutMs: 300000  // 5分钟超时
        });
        
        const buildDuration = Date.now() - buildStartTime;
        console.log(\`✓ 构建完成，耗时: \${buildDuration}ms\`);
        
        // 检查构建产物
        const buildFiles = await tools.glob({ 
          pattern: "dist/**/*" 
        });
        
        console.log(\`生成 \${buildFiles.length} 个文件\`);
        
      } catch (error) {
        return {
          success: false,
          stage: 'build',
          error: error.message,
          duration: Date.now() - buildStartTime
        };
      }
      
      // ==================== Phase 5: 报告生成 ====================
      console.log('[Phase 5/5] 生成报告...');
      
      const reportAgent = await tools.subagent({
        description: "生成测试报告",
        prompt: \`
          生成完整的 CI/CD 报告：
          
          1. 读取测试结果（等待子代理完成）
          2. 汇总所有指标
          3. 生成 Markdown 报告，包含：
             - 执行摘要
             - 详细测试结果
             - 覆盖率图表
             - 失败原因（如有）
             - 建议改进点
          4. 保存到 reports/ci-cd-\${Date.now()}.md
          5. 返回报告路径
        \`,
        run_in_background: true
      });
      
      // 返回流程元数据
      return {
        success: true,
        changedFiles: changedFiles.length,
        agents: {
          unitTest: unitTestAgent.subagentId,
          integrationTest: integrationTestAgent.subagentId,
          report: reportAgent.subagentId
        },
        duration: Date.now() - startTime,
        nextStep: '等待测试完成，然后可以部署到 staging'
      };
    `
  });
}
```

#### 使用说明

```typescript
// 1. 直接运行
await runCICDPipeline();

// 2. 配合 Goal 使用（自动重试失败的步骤）
await tools.create_goal({
  objective: "完成 CI/CD 流程并部署到 staging",
  max_goal_rounds: 5
});

// 3. 查看子代理状态
const agents = await tools.list_agents();
// 返回所有正在运行的测试任务

// 4. 等待完成后，检查报告
const report = await tools.read({ 
  file_path: "reports/ci-cd-latest.md" 
});
```

### 7.2 案例：代码重构助手

这个案例展示如何使用 workflow 进行大规模代码重构。

```typescript
async function refactorCodebase() {
  await tools.run_code({
    description: "执行代码重构",
    code: `
      // Step 1: 分析代码库
      console.log('[Step 1/4] 分析代码库结构...');
      
      const [tsFiles, testFiles, configFiles] = await Promise.all([
        tools.glob({ pattern: "src/**/*.ts" }),
        tools.glob({ pattern: "tests/**/*.ts" }),
        tools.glob({ pattern: "*.config.{js,ts,json}" })
      ]);
      
      console.log(\`发现: \${tsFiles.length} 源文件, \${testFiles.length} 测试文件\`);
      
      // Step 2: 识别需要重构的模式
      console.log('[Step 2/4] 识别重构目标...');
      
      const analysisAgent = await tools.subagent({
        description: "分析代码问题",
        prompt: \`
          分析以下文件，识别需要重构的代码模式：
          
          文件列表：
          \${tsFiles.join('\\n')}
          
          重点关注：
          1. 重复代码（DRY 原则违反）
          2. 过长函数（>50 行）
          3. 圈复杂度高（>10）
          4. 缺少类型注解
          5. 不符合命名规范
          
          返回 JSON 格式的问题列表，每项包含：
          - file: 文件路径
          - line: 行号
          - issue: 问题类型
          - severity: high/medium/low
          - suggestion: 修复建议
        \`,
        run_in_background: true
      });
      
      // Step 3: 并行重构文件（按目录分组）
      console.log('[Step 3/4] 执行重构...');
      
      // 按目录分组文件
      const filesByDir = {};
      for (const file of tsFiles) {
        const dir = file.split('/').slice(0, -1).join('/');
        if (!filesByDir[dir]) {
          filesByDir[dir] = [];
        }
        filesByDir[dir].push(file);
      }
      
      // 为每个目录派发重构子代理
      const refactorAgents = await Promise.all(
        Object.entries(filesByDir).map(([dir, files]) => 
          tools.subagent({
            description: \`重构 \${dir}\`,
            prompt: \`
              重构以下文件：
              \${files.join('\\n')}
              
              根据分析结果（agent: \${analysisAgent.subagentId}）：
              1. 提取重复代码到共享函数
              2. 拆分过长函数
              3. 添加类型注解
              4. 统一命名风格
              5. 运行测试确保功能不变
              
              完成后报告：
              - 修改了哪些文件
              - 应用了哪些重构
              - 测试是否通过
            \`,
            run_in_background: true
          })
        )
      );
      
      console.log(\`已派发 \${refactorAgents.length} 个重构任务\`);
      
      // Step 4: 验证重构结果
      console.log('[Step 4/4] 验证重构...');
      
      const verifyAgent = await tools.subagent({
        description: "验证重构结果",
        prompt: \`
          等待所有重构任务完成，然后：
          
          1. 运行完整测试套件
          2. 检查代码覆盖率是否下降
          3. 运行 lint 检查新代码
          4. 生成 git diff 摘要
          5. 创建对比报告
          
          返回验证结果和建议是否提交。
        \`,
        run_in_background: true
      });
      
      return {
        success: true,
        totalFiles: tsFiles.length,
        refactorTasks: refactorAgents.length,
        agents: {
          analysis: analysisAgent.subagentId,
          refactor: refactorAgents.map(a => a.subagentId),
          verify: verifyAgent.subagentId
        }
      };
    `
  });
}
```

---

## 性能优化与最佳实践

### 8.1 性能优化清单

#### 1. 减少工具调用次数

```typescript
// ❌ 低效：多次调用
const file1 = await tools.read({ file_path: "a.txt" });
const file2 = await tools.read({ file_path: "b.txt" });
const file3 = await tools.read({ file_path: "c.txt" });

// ✅ 高效：批量并行
const [file1, file2, file3] = await Promise.all([
  tools.read({ file_path: "a.txt" }),
  tools.read({ file_path: "b.txt" }),
  tools.read({ file_path: "c.txt" })
]);
```

#### 2. 避免重复读取

```typescript
// ❌ 低效：重复读取同一文件
await tools.run_code({
  code: `
    for (let i = 0; i < 10; i++) {
      const config = await tools.read({ file_path: "config.json" });
      // 使用 config...
    }
  `
});

// ✅ 高效：缓存结果
await tools.run_code({
  code: `
    const config = await tools.read({ file_path: "config.json" });
    
    for (let i = 0; i < 10; i++) {
      // 使用缓存的 config...
    }
  `
});
```

#### 3. 使用流式处理大文件

```typescript
// ❌ 低效：一次性读取大文件
const largeFile = await tools.read({ file_path: "large-log.txt" });
const errors = largeFile.lines.filter(l => l.text.includes('ERROR'));

// ✅ 高效：使用 bash 管道
const errors = await tools.bash({
  command: "grep 'ERROR' large-log.txt | head -100",
  description: "提取错误日志"
});
```

#### 4. 限制并行度

```typescript
// ❌ 可能过载：无限制并行
const results = await Promise.all(
  files.map(file => processFile(file))  // 如果有 1000 个文件...
);

// ✅ 安全：控制并行度
async function processInBatches(items, batchSize = 10) {
  const results = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processFile(item))
    );
    results.push(...batchResults);
  }
  
  return results;
}

const results = await processInBatches(files);
```

### 8.2 最佳实践模式

#### 模式 1: 渐进式处理

```typescript
await tools.run_code({
  description: "渐进式处理大任务",
  code: `
    const totalItems = 1000;
    const batchSize = 50;
    let processed = 0;
    
    for (let i = 0; i < totalItems; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(item => processItem(item))
      );
      
      processed += batch.length;
      console.log(\`进度: \${processed}/\${totalItems}\`);
    }
    
    return { processed };
  `
});
```

#### 模式 2: 断点续传

```typescript
await tools.run_code({
  description: "支持断点续传的处理",
  code: `
    // 1. 检查上次处理进度
    let checkpoint = null;
    try {
      const data = await tools.read({ 
        file_path: ".checkpoint.json" 
      });
      checkpoint = JSON.parse(data.content);
    } catch {
      checkpoint = { processed: [], lastIndex: 0 };
    }
    
    // 2. 从断点继续
    const startIndex = checkpoint.lastIndex;
    console.log(\`从第 \${startIndex} 项继续...\`);
    
    for (let i = startIndex; i < items.length; i++) {
      try {
        await processItem(items[i]);
        
        checkpoint.processed.push(items[i]);
        checkpoint.lastIndex = i + 1;
        
        // 3. 定期保存进度
        if (i % 10 === 0) {
          await tools.write({
            file_path: ".checkpoint.json",
            content: JSON.stringify(checkpoint)
          });
        }
        
      } catch (error) {
        console.log(\`项 \${i} 失败: \${error.message}\`);
        // 保存进度并退出
        await tools.write({
          file_path: ".checkpoint.json",
          content: JSON.stringify(checkpoint)
        });
        throw error;
      }
    }
    
    // 4. 完成后删除断点
    await tools.bash({
      command: "rm .checkpoint.json",
      description: "清理断点文件"
    });
    
    return { processed: checkpoint.processed.length };
  `
});
```

#### 模式 3: 智能重试

```typescript
async function withRetry(
  fn: () => Promise<any>,
  maxRetries = 3,
  delayMs = 1000
): Promise<any> {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(`尝试 ${i + 1}/${maxRetries} 失败: ${error.message}`);
      
      if (i < maxRetries - 1) {
        // 指数退避
        const delay = delayMs * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

// 使用
await tools.run_code({
  code: `
    const result = await withRetry(async () => {
      return await tools.bash({
        command: "flaky-command",
        description: "不稳定的命令"
      });
    });
  `
});
```

---

## 故障排查指南

### 9.1 常见错误及解决方案

#### 错误 1: ToolCallError

```
Error: ToolCallError: bash
Command failed with exit code 1
```

**原因**：工具调用失败，但没有被捕获

**解决方案**：

```typescript
try {
  await tools.bash({ command: "...", description: "..." });
} catch (error) {
  if (error.name === 'ToolCallError') {
    console.log(`工具失败: ${error.toolName}`);
    console.log(`原因: ${error.message}`);
    // 决定是否继续
  }
}
```

#### 错误 2: 超时

```
Error: run_code execution timeout after 120000ms
```

**原因**：代码执行时间超过默认超时（120 秒）

**解决方案**：

```typescript
// 1. 增加超时时间
await tools.run_code({
  code: "...",
  description: "...",
  timeoutMs: 300000  // 5 分钟
});

// 2. 或者使用后台任务
const agent = await tools.subagent({
  prompt: "长时间运行的任务",
  run_in_background: true
});
```

#### 错误 3: 沙箱权限拒绝

```
Error: [sandbox: file access denied under read-only mode]
```

**原因**：尝试写文件但没有权限

**解决方案**：

```typescript
await tools.run_code({
  code: `
    await tools.write({
      file_path: "output.txt",
      content: "data"
    });
  `,
  description: "写入文件",
  sandbox_permissions: 'workspace-write',
  justification: '需要保存处理结果到文件'
});
```

### 9.2 调试技巧

#### 技巧 1: 添加详细日志

```typescript
await tools.run_code({
  description: "带调试日志的任务",
  code: `
    console.log('[DEBUG] 开始执行');
    console.log('[DEBUG] 变量状态:', JSON.stringify(variables));
    
    try {
      const result = await tools.bash({ ... });
      console.log('[DEBUG] 命令输出:', result.stdout.text);
    } catch (error) {
      console.log('[DEBUG] 错误:', error);
      throw error;
    }
    
    console.log('[DEBUG] 完成');
  `
});
```

#### 技巧 2: 使用断点和检查点

```typescript
await tools.run_code({
  description: "分步执行",
  code: `
    // Checkpoint 1
    console.log('[Checkpoint 1] 加载数据');
    const data = await loadData();
    
    // Checkpoint 2
    console.log('[Checkpoint 2] 处理数据');
    const processed = await processData(data);
    
    // Checkpoint 3
    console.log('[Checkpoint 3] 保存结果');
    await saveResults(processed);
    
    console.log('[Complete] 所有步骤完成');
  `
});
```

#### 技巧 3: 查看子代理状态

```typescript
// 列出所有子代理
const agents = await tools.list_agents({ scope: 'descendants' });

for (const agent of agents) {
  console.log(`Agent ${agent.id}:`);
  console.log(`  状态: ${agent.status}`);
  console.log(`  深度: ${agent.depth}`);
  
  if (agent.status === 'running') {
    // 可以发送消息查询进度
    await tools.send_message({
      agent_id: agent.id,
      message: "当前进度如何？"
    });
  }
}
```

### 9.3 性能分析

```typescript
await tools.run_code({
  description: "性能分析",
  code: `
    const metrics = {
      phases: [],
      totalDuration: 0
    };
    
    const startTime = Date.now();
    
    // Phase 1
    const phase1Start = Date.now();
    await phase1();
    metrics.phases.push({
      name: 'phase1',
      duration: Date.now() - phase1Start
    });
    
    // Phase 2
    const phase2Start = Date.now();
    await phase2();
    metrics.phases.push({
      name: 'phase2',
      duration: Date.now() - phase2Start
    });
    
    metrics.totalDuration = Date.now() - startTime;
    
    // 生成性能报告
    console.log('=== 性能报告 ===');
    for (const phase of metrics.phases) {
      const percentage = (phase.duration / metrics.totalDuration * 100).toFixed(1);
      console.log(\`\${phase.name}: \${phase.duration}ms (\${percentage}%)\`);
    }
    console.log(\`总耗时: \${metrics.totalDuration}ms\`);
    
    return metrics;
  `
});
```

---

## 总结与展望

### 核心要点回顾

1. **Workflow 是执行编排的艺术**
   - 通过 `run_code` 实现编程式控制
   - 使用 `subagent` 进行任务委派
   - 利用 `Promise.all` 实现并行

2. **深入理解实现机制**
   - TypeScript Runtime 的沙箱执行
   - Tools SDK 的 Proxy 实现
   - 并行调度器的智能分组

3. **实战经验积累**
   - CI/CD 自动化流程
   - 代码重构助手
   - 性能优化模式

4. **调试与优化**
   - 详细日志记录
   - 断点续传机制
   - 性能分析技巧

### 进阶方向

1. **深入 Goal 系统**
   - 理解持久化目标的状态机
   - 学习 goal-round-driver 的自动续跑
   - 掌握 Goal + Workflow 的组合模式

2. **探索 Plan 模式**
   - 协作式任务规划
   - Plan + Workflow 的配合

3. **研究 Subagent 通信**
   - 父子代理的消息传递
   - 状态同步机制
   - 错误传播链

4. **优化执行效率**
   - 智能并行调度
   - 资源池管理
   - 缓存策略

### 参考资源

- **DSH 源码**：`packages/` 目录
- **相关博客**：
  - `blog-20-goal`: Goal 系统详解
  - `blog-17-plan`: Plan 模式详解
  - `blog-14-subagent`: Subagent 机制详解
- **System Prompt**：DSH 内置指导原则

---

**作者注**：本文是对 DSH Workflow 的深度解析，涵盖了从概念到实现的完整链路。希望通过源码分析和实战案例，帮助读者掌握 workflow 的精髓，设计出高效、健壮的 AI Agent 执行流程。

如有疑问或建议，欢迎通过 Issue 讨论。

---

*最后更新：2024-10-09*
