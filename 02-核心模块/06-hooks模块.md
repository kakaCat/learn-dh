# Hooks 模块（未实现）

## 什么是 Hooks？

Hooks 是**外部扩展点**，允许：
- 🔌 外部进程接管某些功能
- ⚙️ 动态修改配置
- 🎯 在特定时机执行自定义逻辑

## deepseek-harness 的 Hooks

查看 `packages/hooks/`:
- `hook-protocol` - Hook 协议定义
- `hooks-claude-code` - Claude Code 的 hooks
- `hooks-codex` - Codex 的 hooks

## Hook 类型

### 1. 工具 Hook

外部进程提供工具实现：

```typescript
interface ToolHook {
  // 列出可用工具
  listTools(): Promise<ToolDefinition[]>
  
  // 执行工具
  executeTool(name: string, args: any): Promise<any>
}
```

**用例**: 
- IDE 提供文件操作工具
- 外部服务提供 API 工具

### 2. 配置 Hook

动态修改 Cordis 配置：

```typescript
interface ConfigHook {
  // 修改配置
  patchConfig(config: CordisConfig): Promise<CordisConfig>
}
```

**用例**:
- 根据项目类型调整插件
- 注入项目特定规则

### 3. 事件 Hook

监听和修改事件：

```typescript
interface EventHook {
  // 拦截事件
  onEvent(event: SessionEvent): Promise<SessionEvent | null>
}
```

**用例**:
- 外部日志记录
- 事件审计
- 实时通知

### 4. 审批 Hook

控制工具执行权限：

```typescript
interface ApprovalHook {
  // 请求审批
  requestApproval(tool: string, args: any): Promise<boolean>
}
```

**用例**:
- IDE 弹窗确认
- 基于规则自动审批

## Hook 协议

### 进程通信

通过 stdin/stdout JSON-RPC：

```typescript
// Hook 进程接收请求
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tool.execute",
  "params": {
    "name": "read_file",
    "args": { "path": "file.txt" }
  }
}

// Hook 进程返回响应
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": "File content"
  }
}
```

### Hook 注册

在配置中注册：

```yaml
hooks:
  - type: tool
    command: ["node", "my-tool-hook.js"]
  - type: approval
    command: ["python", "approval-hook.py"]
```

## 实现 Hook Service

```typescript
class HooksService extends Service {
  private hooks = new Map<string, HookProcess>()
  
  constructor(ctx: Context) {
    super(ctx, 'hooks')
  }
  
  // 注册 hook
  register(type: string, command: string[]): void {
    const process = spawn(command[0], command.slice(1))
    this.hooks.set(type, new HookProcess(process))
  }
  
  // 调用 hook
  async call(type: string, method: string, params: any): Promise<any> {
    const hook = this.hooks.get(type)
    if (!hook) return null
    
    return hook.request(method, params)
  }
}

class HookProcess {
  private id = 0
  private pending = new Map<number, {resolve, reject}>()
  
  constructor(private process: ChildProcess) {
    // 监听 stdout
    this.process.stdout.on('data', (data) => {
      const response = JSON.parse(data.toString())
      const { resolve, reject } = this.pending.get(response.id)!
      this.pending.delete(response.id)
      
      if (response.error) {
        reject(response.error)
      } else {
        resolve(response.result)
      }
    })
  }
  
  async request(method: string, params: any): Promise<any> {
    const id = this.id++
    
    // 发送请求
    this.process.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    }) + '\n')
    
    // 等待响应
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }
}
```

## 工具 Hook 示例

### Node.js Hook

```javascript
// tool-hook.js
const readline = require('readline')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.on('line', async (line) => {
  const request = JSON.parse(line)
  
  if (request.method === 'tool.list') {
    // 返回工具列表
    respond(request.id, [
      {
        name: 'custom_tool',
        description: 'My custom tool',
        parameters: { /* ... */ }
      }
    ])
  } else if (request.method === 'tool.execute') {
    // 执行工具
    const { name, args } = request.params
    const result = await executeCustomTool(name, args)
    respond(request.id, result)
  }
})

function respond(id, result) {
  console.log(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result
  }))
}
```

### 使用 Hook

```typescript
// 注册 hook
ctx.hooks.register('tool', ['node', 'tool-hook.js'])

// 列出外部工具
const tools = await ctx.hooks.call('tool', 'tool.list', {})

// 执行外部工具
const result = await ctx.hooks.call('tool', 'tool.execute', {
  name: 'custom_tool',
  args: { foo: 'bar' }
})
```

## 与 Agent Loop 集成

```typescript
// 在 tools/execute 事件中检查 hook
ctx.on('tools/execute', async (call, next) => {
  // 先检查是否有 hook 提供此工具
  if (ctx.hooks.has('tool')) {
    try {
      const result = await ctx.hooks.call('tool', 'tool.execute', {
        name: call.name,
        args: call.args
      })
      return { id: call.id, result }
    } catch (error) {
      // Hook 执行失败，继续常规流程
    }
  }
  
  return await next()
})
```

## 审批 Hook 集成

```typescript
// 在 tools/pre-execute 中请求审批
ctx.on('tools/pre-execute', async (call, next) => {
  if (ctx.hooks.has('approval')) {
    const approved = await ctx.hooks.call('approval', 'approval.request', {
      tool: call.name,
      args: call.args
    })
    
    if (!approved) {
      throw new Error('Tool execution not approved')
    }
  }
  
  await next()
})
```

## 关键要点

1. ✅ **进程隔离** - Hook 在独立进程中运行
2. ✅ **JSON-RPC** - 标准化的通信协议
3. ✅ **异步通信** - 请求-响应模式
4. ✅ **多语言支持** - 任何语言都可以实现 hook
5. ✅ **热插拔** - 动态注册和卸载

## deepseek-harness 的实现

查看源码了解完整实现：
- `packages/hooks/hook-protocol` - 协议定义
- `packages/hooks/hooks-claude-code` - 实际例子

## 下一步

- 实现简单的 hook 协议
- 创建示例 hook 进程
- 集成到 agent loop
- 添加错误处理和超时
