# Tools 模块

## 核心概念

Tools 模块提供：
- 🔧 **工具注册表** - 管理可用工具
- 📋 **Schema 生成** - 生成 OpenAI 格式的工具 schema
- 🔒 **执行管道** - 带权限控制的执行流程
- 🎯 **作用域隔离** - 不同 Agent 可以有不同的工具集

## 工具定义

### 基本工具接口

```typescript
interface Tool {
  // 工具描述（给模型看）
  description: string
  
  // 参数 schema（JSON Schema 格式）
  parameters: {
    type: 'object'
    properties: Record<string, JSONSchema>
    required?: string[]
  }
  
  // 执行函数
  execute: (args: Record<string, unknown>) => Promise<unknown>
}
```

### 示例：文件读取工具

```typescript
const readFileTool: Tool = {
  description: 'Read content from a file',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file'
      }
    },
    required: ['path']
  },
  async execute(args) {
    const { path } = args
    const content = await fs.readFile(path as string, 'utf-8')
    return content
  }
}
```

## OpenAI Tool Schema

需要转换为 OpenAI 的格式：

```typescript
interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JSONSchema
  }
}

function toOpenAISchema(name: string, tool: Tool): OpenAITool {
  return {
    type: 'function',
    function: {
      name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}
```

## Tools Service 接口

```typescript
class ToolsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  
  // 注册工具
  register(name: string, tool: Tool): Disposable
  
  // 获取工具
  get(name: string): Tool | undefined
  
  // 列出所有工具
  list(): string[]
  
  // 生成 OpenAI schema
  getSchemas(): OpenAITool[]
  
  // 执行工具（带管道）
  execute(call: ToolCall): Promise<ToolResult>
}

interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

interface ToolResult {
  id: string
  result?: unknown
  error?: string
}
```

## 工具执行管道

执行流程经过三个 waterfall 事件：

```
tools/pre-execute  (权限检查、参数验证)
    ↓
tools/execute      (实际执行)
    ↓
tools/post-execute (记录日志、格式化结果)
```

### 1. pre-execute - 前置检查

```typescript
// 权限检查插件
ctx.on('tools/pre-execute', async (call, next) => {
  if (!isApproved(call.name)) {
    throw new Error(`Tool ${call.name} requires approval`)
  }
  await next()
})

// 参数验证插件
ctx.on('tools/pre-execute', async (call, next) => {
  const tool = ctx.tools.get(call.name)
  if (!validateArgs(call.args, tool.parameters)) {
    throw new Error('Invalid arguments')
  }
  await next()
})
```

### 2. execute - 执行工具

```typescript
ctx.on('tools/execute', async (call, next) => {
  const tool = ctx.tools.get(call.name)
  if (!tool) {
    throw new Error(`Tool ${call.name} not found`)
  }
  
  try {
    const result = await tool.execute(call.args)
    return { id: call.id, result }
  } catch (error) {
    return { id: call.id, error: error.message }
  }
})
```

### 3. post-execute - 后处理

```typescript
// 记录日志
ctx.on('tools/post-execute', async (result, next) => {
  ctx.logger.log(`Tool executed: ${JSON.stringify(result)}`)
  await next()
})

// 记录到 session
ctx.on('tools/post-execute', async (result, next) => {
  ctx.sessions.append(currentSessionId, {
    type: 'tool/result',
    id: result.id,
    result: result.result,
    error: result.error,
    timestamp: Date.now()
  })
  await next()
})
```

## 作用域工具

不同 Agent 可以有不同的工具集：

```typescript
// 全局工具
ctx.tools.register('read', readTool)

// Agent 特定工具
function createAgentWithTools(ctx: Context) {
  const agentCtx = ctx.extend() // 创建子上下文
  
  // 只在这个 Agent 可用
  agentCtx.tools.register('dangerous', dangerousTool)
  
  return new Agent(agentCtx)
}
```

## 完整实现

```typescript
import { Context, Service } from '@cordisjs/core'

interface Tool {
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

interface ToolResult {
  id: string
  result?: unknown
  error?: string
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: any
  }
}

declare module '@cordisjs/core' {
  interface Events {
    'tools/pre-execute': (call: ToolCall, next: () => Promise<void>) => Promise<void>
    'tools/execute': (call: ToolCall, next: () => Promise<ToolResult>) => Promise<ToolResult>
    'tools/post-execute': (result: ToolResult, next: () => Promise<void>) => Promise<void>
  }
  
  interface Context {
    tools: ToolsService
  }
}

class ToolsService extends Service {
  private tools = new Map<string, Tool>()
  
  constructor(ctx: Context) {
    super(ctx, 'tools', true)
  }
  
  register(name: string, tool: Tool) {
    // 使用 effect 使注册可逆
    return this.ctx.effect(() => {
      this.tools.set(name, tool)
      
      // 返回 disposer
      return () => {
        this.tools.delete(name)
      }
    })
  }
  
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }
  
  list(): string[] {
    return Array.from(this.tools.keys())
  }
  
  getSchemas(): OpenAITool[] {
    const schemas: OpenAITool[] = []
    
    for (const [name, tool] of this.tools) {
      schemas.push({
        type: 'function',
        function: {
          name,
          description: tool.description,
          parameters: tool.parameters
        }
      })
    }
    
    return schemas
  }
  
  async execute(call: ToolCall): Promise<ToolResult> {
    // 执行管道
    try {
      // pre-execute
      await this.ctx.waterfall('tools/pre-execute', call)
      
      // execute
      const result = await this.ctx.waterfall('tools/execute', call)
      
      // post-execute
      await this.ctx.waterfall('tools/post-execute', result)
      
      return result
    } catch (error: any) {
      return {
        id: call.id,
        error: error.message
      }
    }
  }
}

// 默认执行器插件
function defaultExecutor(ctx: Context) {
  ctx.on('tools/execute', async (call) => {
    const tool = ctx.tools.get(call.name)
    if (!tool) {
      throw new Error(`Tool ${call.name} not found`)
    }
    
    const result = await tool.execute(call.args)
    return { id: call.id, result }
  })
}

// 使用示例
export function apply(ctx: Context) {
  ctx.plugin(ToolsService)
  ctx.plugin(defaultExecutor)
  
  // 注册工具
  ctx.tools.register('echo', {
    description: 'Echo the input',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo' }
      },
      required: ['text']
    },
    async execute(args) {
      return args.text
    }
  })
  
  // 添加权限检查
  const approvedTools = new Set(['echo'])
  ctx.on('tools/pre-execute', async (call, next) => {
    if (!approvedTools.has(call.name)) {
      throw new Error(`Tool ${call.name} not approved`)
    }
    await next()
  })
  
  // 执行工具
  const result = await ctx.tools.execute({
    id: '1',
    name: 'echo',
    args: { text: 'Hello' }
  })
  
  console.log(result) // { id: '1', result: 'Hello' }
}
```

## 工具分类

### 文件系统工具
```typescript
ctx.tools.register('read', readFileTool)
ctx.tools.register('write', writeFileTool)
ctx.tools.register('list', listDirectoryTool)
```

### Shell 工具
```typescript
ctx.tools.register('bash', bashTool)
ctx.tools.register('exec', execTool)
```

### 网络工具
```typescript
ctx.tools.register('fetch', fetchTool)
ctx.tools.register('search', searchTool)
```

## 关键要点

1. ✅ **工具 = 描述 + 参数 + 执行函数**
2. ✅ **Schema 转换** - 转为 OpenAI 格式
3. ✅ **执行管道** - pre → execute → post
4. ✅ **作用域隔离** - 不同 Agent 不同工具集
5. ✅ **可逆注册** - 使用 ctx.effect()

## 下一步

学习 [03-system-prompt模块.md](./03-system-prompt模块.md) 了解提示词组装。
