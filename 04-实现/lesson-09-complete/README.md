# 第9课：完整整合

## 目标

把所有模块整合成一个可用的 Agent 系统。

## 运行

```bash
cd lesson-09-complete
pnpm install

# 完整测试
pnpm run dev

# 交互式聊天
pnpm run chat
```

## 模块架构

```
┌─────────────────────────────────────────┐
│              User Input                  │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│           AgentLoop Service              │
│  • Turn 管理                             │
│  • Step 循环                             │
│  • 消息派生                              │
└──────┬──────────────┬───────────────────┘
       │              │
       ▼              ▼
┌─────────────┐ ┌─────────────┐
│SystemPrompt │ │   Session   │
│  • 组装提示词│ │  • 记录事件 │
│  • 工具列表  │ │  • 广播事件 │
└──────┬──────┘ └─────────────┘
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

## 完整流程

1. **用户输入** → `agentLoop.runTurn()`
2. **Turn 开始** → 记录 `turn/start`
3. **Pre-step** → 拦截点（可过滤/修改）
4. **记录消息** → `user/message`
5. **Step 循环**:
   - 派生消息 → 从 session 重建
   - 构建 prompt → systemPrompt.build()
   - 调用 LLM → `agent/request` 拦截点
   - 处理工具 → 执行并记录
   - 检查继续 → 有工具结果则继续
6. **Turn 结束** → `turn-stopping` 拦截点
7. **记录结束** → `turn/end`

## 已实现的模块

| 模块 | 功能 | 状态 |
|------|------|------|
| Session | 事件日志 | ✅ |
| SystemPrompt | 提示词组装 | ✅ |
| Tools | 工具注册执行 | ✅ |
| LLM | 模型调用 | ✅ |
| AgentLoop | 执行循环 | ✅ |

## 扩展方向

### 1. 真实 LLM

替换 Mock LLM 为真实 API：

```typescript
class OpenAILLM extends LLMService {
  async chat(request) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', ...)
    return parseResponse(response)
  }
}
```

### 2. 持久化

保存 Session 到文件：

```typescript
class PersistentSession extends SessionService {
  async save(sessionId: string) {
    const events = this.getEvents(sessionId)
    await fs.writeFile(`sessions/${sessionId}.json`, JSON.stringify(events))
  }
}
```

### 3. 压缩

实现上下文压缩：

```typescript
class CompactionService extends Service {
  async compact(messages: Message[]): Promise<Message[]> {
    // 摘要旧消息，保留新消息
  }
}
```

### 4. Hooks

添加外部扩展点：

```typescript
class HooksService extends Service {
  async callHook(name: string, args: any) {
    // 调用外部进程
  }
}
```

## 恭喜！

你已经完成了 Simple DH 的所有课程！

### 回顾

- 第0课: Hello World - 认识 Cordis
- 第1课: 插件系统 - Service 和 Effect
- 第2课: 依赖注入 - inject 声明
- 第3课: 事件系统 - 五种派发模式
- 第4课: Session - 事件日志
- 第5课: Tools - 工具系统
- 第6课: Prompt - 提示词组装
- 第7课: LLM - 模型适配
- 第8课: Agent Loop - 执行循环
- 第9课: 完整整合 - 整合所有模块

### 下一步

1. 阅读 deepseek-harness 源码
2. 实现真实的 LLM 适配器
3. 添加压缩和持久化
4. 构建 Web 界面
