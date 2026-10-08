# Simple DH

一个简化的 deepseek-harness 实现，用于学习其核心架构。

## 项目结构

```
learn-dh/
├── 大纲.md                           # 学习大纲
├── 01-cordis基础/                    # Cordis 框架基础
│   ├── 01-插件系统.md
│   ├── 02-依赖注入.md
│   ├── 03-事件系统.md
│   └── 04-控制流实现.md             # 深度解析
├── 02-核心模块/                      # 核心模块详解
│   ├── 01-session模块.md
│   ├── 02-tools模块.md
│   ├── 03-system-prompt模块.md
│   └── 04-agent-loop模块.md
├── 03-执行流程/                      # 完整执行流程
│   └── 01-turn-flow.md
└── 04-实现/                          # 实际代码实现
    ├── README.md
    └── simple-dh/
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts              # 入口
            ├── session.ts            # Session 模块
            ├── tools.ts              # Tools 模块
            ├── system-prompt.ts      # System Prompt 模块
            ├── llm.ts                # LLM 适配器
            ├── agent-loop.ts         # Agent Loop 模块
            └── example.ts            # 使用示例
```

## 快速开始

### 1. 阅读学习笔记

按顺序阅读：

1. **Cordis 基础** (01-cordis基础/)
   - 理解插件系统
   - 理解依赖注入
   - 理解事件系统

2. **核心模块** (02-核心模块/)
   - Session - 事件日志
   - Tools - 工具系统
   - System Prompt - 提示词组装
   - Agent Loop - 执行循环

3. **执行流程** (03-执行流程/)
   - Turn Flow - 完整流程图

### 2. 运行代码

```bash
cd 04-实现/simple-dh
pnpm install
pnpm run dev
```

### 3. 探索代码

查看 `src/example.ts` 了解如何使用各个模块。

## 核心概念

### Cordis 插件系统

```typescript
// 插件就是服务
class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myService')
  }
}

// 声明依赖
MyService.inject = ['otherService']

// 使用
ctx.plugin(MyService)
ctx.myService.doSomething()
```

### Session 事件日志

```typescript
// 所有交互都记录为事件
ctx.sessions.append(sessionId, {
  type: 'user/message',
  content: 'Hello',
  timestamp: Date.now()
})

// 从事件重建状态
const events = ctx.sessions.getEvents(sessionId)
const messages = deriveMessages(events)
```

### Tools 工具系统

```typescript
// 注册工具
ctx.tools.register('echo', {
  description: 'Echo text',
  parameters: { /* JSON Schema */ },
  async execute(args) { return args.text }
})

// 执行工具（通过管道）
const result = await ctx.tools.execute(call)
```

### Agent Loop 循环

```typescript
// 创建 agent
const agent = ctx.agentLoop.create(sessionId)

// 运行 turn
await ctx.agentLoop.runTurn(agent, 'Hello')

// 自动处理：
// - 调用 LLM
// - 执行工具
// - 记录日志
// - 多轮循环
```

## 架构图

```
┌──────────────────────────────────────────┐
│              User Input                   │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│          AgentLoop Service                │
│  • Turn 管理                              │
│  • Step 循环                              │
│  • 消息派生                               │
└──────┬───────────────┬───────────────────┘
       │               │
       ▼               ▼
┌─────────────┐  ┌─────────────┐
│ SystemPrompt│  │   Session   │
│  • 组装提示词│  │  • 记录事件 │
│  • 工具列表  │  │  • 广播事件 │
└──────┬──────┘  └─────────────┘
       │
       ▼
┌─────────────┐
│    LLM      │
│  • 调用模型 │
│  • 解析响应 │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Tools     │
│  • 执行工具 │
│  • 权限检查 │
└─────────────┘
```

## 与 deepseek-harness 的对比

### 保留的核心

✅ Cordis 插件架构
✅ 事件驱动设计
✅ Session 事件日志
✅ 工具执行管道
✅ Turn/Step 循环
✅ 消息派生逻辑

### 简化的部分

- Session: 仅内存存储（无持久化）
- Tools: 简化权限控制
- LLM: Mock 实现（无真实 API）
- 压缩: 未实现
- Hooks: 未实现
- UI: 未实现

## 下一步

### 扩展功能

1. **实现真实 LLM 适配器**
   - OpenAI API
   - Anthropic API
   - 流式输出

2. **添加压缩算法**
   - Token 计数
   - 消息摘要
   - 上下文窗口管理

3. **实现 Hooks**
   - 外部进程通信
   - 配置覆盖

4. **添加持久化**
   - Session 保存/加载
   - SQLite/文件存储

5. **构建 UI**
   - 命令行界面
   - Web 界面

### 深入学习

1. 阅读 deepseek-harness 源码
   - `packages/core/session`
   - `packages/core/tools`
   - `packages/core/agent-loop`

2. 研究 Cordis 框架
   - [Cordis 文档](https://github.com/cordiverse/cordis)
   - [设计论文](https://github.com/cordiverse/paper)

3. 理解设计模式
   - 插件模式
   - 事件驱动
   - CQRS（命令查询分离）
   - Event Sourcing（事件溯源）

## 贡献

欢迎提交 Issue 和 PR！

## 许可证

MIT
