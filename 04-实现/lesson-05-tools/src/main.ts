/**
 * 第5课：Tools 模块
 *
 * 实现工具注册和执行
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 类型定义
// ============================================================

interface Tool {
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, JSONSchema>
    required?: string[]
  }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

interface JSONSchema {
  type: string
  description?: string
  enum?: string[]
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

// 扩展 Cordis 类型
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

// ============================================================
// Tools Service 实现
// ============================================================

class ToolsService extends Service {
  private tools = new Map<string, Tool>()

  constructor(ctx: Context) {
    super(ctx, 'tools', true)
    this.setupDefaultExecutor()
  }

  /**
   * 注册工具
   */
  register(name: string, tool: Tool) {
    return this.ctx.effect(() => {
      this.tools.set(name, tool)
      console.log(`  🔧 注册工具: ${name}`)
      return () => {
        this.tools.delete(name)
        console.log(`  🗑️  移除工具: ${name}`)
      }
    })
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /**
   * 列出所有工具
   */
  list(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * 生成 OpenAI 格式的 schemas
   */
  getSchemas(): OpenAITool[] {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      type: 'function',
      function: {
        name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
  }

  /**
   * 执行工具（通过管道）
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      await this.ctx.waterfall('tools/pre-execute', call)
      const result = await this.ctx.waterfall('tools/execute', call)
      await this.ctx.waterfall('tools/post-execute', result)
      return result
    } catch (error: any) {
      return { id: call.id, error: error.message }
    }
  }

  /**
   * 设置默认执行器
   */
  private setupDefaultExecutor() {
    this.ctx.on('tools/execute', async (call, next) => {
      const tool = this.tools.get(call.name)
      if (!tool) {
        throw new Error(`Tool ${call.name} not found`)
      }
      try {
        const result = await tool.execute(call.args)
        return { id: call.id, result }
      } catch (error: any) {
        return { id: call.id, error: error.message }
      }
    })
  }
}

// ============================================================
// 主程序
// ============================================================

console.log('='.repeat(60))
console.log('第5课：Tools 模块')
console.log('='.repeat(60))

const ctx = new Context()
ctx.plugin(ToolsService)

// 注册工具
console.log('\n📦 注册工具...')

ctx.tools.register('echo', {
  description: 'Echo back the input text',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to echo' },
    },
    required: ['text'],
  },
  async execute(args) {
    return `Echo: ${args.text}`
  },
})

ctx.tools.register('add', {
  description: 'Add two numbers',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
  async execute(args) {
    return (args.a as number) + (args.b as number)
  },
})

ctx.tools.register('multiply', {
  description: 'Multiply two numbers',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
  async execute(args) {
    return (args.a as number) * (args.b as number)
  },
})

console.log(`  ✅ 已注册工具: ${ctx.tools.list().join(', ')}`)

// 查看 schemas
console.log('\n📋 工具 Schemas:')
const schemas = ctx.tools.getSchemas()
for (const schema of schemas) {
  console.log(`  - ${schema.function.name}: ${schema.function.description}`)
}

// 执行工具
console.log('\n🚀 执行工具...')

const r1 = await ctx.tools.execute({
  id: '1',
  name: 'echo',
  args: { text: 'Hello, World!' },
})
console.log(`  echo 结果: ${r1.result}`)

const r2 = await ctx.tools.execute({
  id: '2',
  name: 'add',
  args: { a: 10, b: 20 },
})
console.log(`  add 结果: ${r2.result}`)

const r3 = await ctx.tools.execute({
  id: '3',
  name: 'multiply',
  args: { a: 5, b: 6 },
})
console.log(`  multiply 结果: ${r3.result}`)

// 错误处理
console.log('\n❌ 错误处理...')
const r4 = await ctx.tools.execute({
  id: '4',
  name: 'unknown',
  args: {},
})
console.log(`  unknown 结果: ${r4.error}`)

console.log('\n✅ 完成！')
