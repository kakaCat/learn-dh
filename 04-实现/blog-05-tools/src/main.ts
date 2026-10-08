/**
 * 博客5：Tools 模块 - 工具注册和执行
 *
 * 本文包含：
 * - Part 1: Tools 基础 - 工具注册和管理
 * - Part 2: Schema 生成 - OpenAI 格式
 * - Part 3: 执行管道 - pre/execute/post 钩子
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('博客5：Tools 模块')
console.log('='.repeat(60))

// ============================================================
// Part 1: Tools 基础 - 工具注册和管理
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 1: Tools 基础')
console.log('='.repeat(60))

console.log('\n💡 什么是 Tools 模块？')
console.log('Tools 模块管理工具的注册、Schema 生成、执行等功能。')
console.log('支持通过事件钩子扩展工具执行流程。')

// ----------------------------------------
// 类型定义
// ----------------------------------------

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
    // 工具管道：三段 waterfall（与 dsh 一致，洋葱模型）
    // pre-execute：允许/拒绝/询问，返回 'allow' | 'deny' | 'ask'
    'tools/pre-execute': (call: ToolCall, next: () => Promise<string>) => Promise<string>
    // execute：执行工具（可被包装：超时、重试、指标）
    'tools/execute': (call: ToolCall, next: () => Promise<ToolResult>) => Promise<ToolResult>
    // post-execute：接受/替换/丰富结果
    'tools/post-execute': (call: ToolCall, result: ToolResult, next: () => Promise<ToolResult>) => Promise<ToolResult>
  }

  interface Context {
    tools: ToolsService
  }
}

// ----------------------------------------
// Tools Service 实现
// ----------------------------------------

class ToolsService extends Service {
  private tools = new Map<string, Tool>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /**
   * 注册工具（接收完整定义，使用 effect 实现自动清理）
   * 与 dsh 的 register(definition) 一致：name 在定义里
   */
  register(definition: ToolDefinition) {
    const name = definition.name
    return this.ctx.effect(() => {
      this.tools.set(name, definition)
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
   * 执行工具（三段 waterfall 管道，与 dsh 一致）
   * pre-execute → execute → post-execute，每段都可用中间件包装
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      // 1. pre-execute：允许/拒绝/询问（洋葱最外层）
      //    监听器可拦截：返回非 'allow' 则拒绝执行
      const decision = await this.ctx.waterfall('tools/pre-execute', call, async () => 'allow')
      if (decision !== 'allow') {
        return { id: call.id, error: `工具被拒绝: ${decision}` }
      }

      // 2. execute：核心执行（可被包装：超时、重试、指标）
      const result = await this.ctx.waterfall('tools/execute', call, async () => {
        const tool = this.tools.get(call.name)
        if (!tool) {
          throw new Error(`Tool ${call.name} not found`)
        }
        const value = await tool.execute(call.args)
        return { id: call.id, result: value }
      })

      // 3. post-execute：接受/替换/丰富结果（洋葱最内层返回后逐层包装）
      return await this.ctx.waterfall('tools/post-execute', call, result, async () => result)
    } catch (error: any) {
      return { id: call.id, error: error.message }
    }
  }
}

// ----------------------------------------
// 简化版 defineTool：参数 schema 写在工具定义上，自动生成 JSON Schema + 执行前校验
// （dsh 用 schemastery 的类型推导，这里用简化实现展示同样的思路）
// ----------------------------------------

// 参数 spec：声明式描述，挂在工具定义上（不用手写完整 JSON Schema）
interface ParameterSpec {
  type: string
  description?: string
  required?: boolean
}

// 工具定义：name 也在定义里（与 dsh 的 ToolDefinition 一致）
interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, JSONSchema>
    required?: string[]
  }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

// defineTool：spec → JSON Schema + 包装 execute（执行前自动校验参数）
function defineTool(options: {
  name: string
  description: string
  parameters: Record<string, ParameterSpec>
  execute: (args: Record<string, unknown>) => Promise<unknown>
}): ToolDefinition {
  // 1. 从参数 spec 生成 JSON Schema
  const properties: Record<string, JSONSchema> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(options.parameters)) {
    properties[key] = { type: spec.type, description: spec.description }
    if (spec.required) required.push(key)
  }
  const parameters = {
    type: 'object' as const,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }

  // 2. 校验函数：执行前检查参数是否合法
  const validate = (args: Record<string, unknown>): string[] => {
    const violations: string[] = []
    for (const key of required) {
      if (args[key] === undefined) violations.push(`缺少必填参数: ${key}`)
    }
    for (const [key, spec] of Object.entries(properties)) {
      const value = args[key]
      if (value === undefined) continue
      if (spec.type === 'number' && typeof value !== 'number') violations.push(`参数 ${key} 必须是 number`)
      if (spec.type === 'string' && typeof value !== 'string') violations.push(`参数 ${key} 必须是 string`)
      if (spec.type === 'boolean' && typeof value !== 'boolean') violations.push(`参数 ${key} 必须是 boolean`)
    }
    return violations
  }

  return {
    name: options.name,
    description: options.description,
    parameters,
    // 3. 包装 execute：先校验，不合法直接抛错（dsh 抛 ToolArgsError）
    async execute(args) {
      const violations = validate(args)
      if (violations.length > 0) {
        throw new Error(`参数校验失败: ${violations.join('; ')}`)
      }
      return options.execute(args)
    },
  }
}

// ----------------------------------------
// 工具插件：每个工具是一个插件，apply 时用 defineTool 注册自己
// ----------------------------------------

// 工具插件：echo —— schema 写在工具定义上，不手写 JSON
function echoTool(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo back the input text',
    parameters: {
      text: { type: 'string', description: 'Text to echo', required: true },
    },
    async execute(args) {
      return `Echo: ${args.text}`
    },
  }))
}
echoTool.inject = ['tools']

// 工具插件：add
function addTool(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'add',
    description: 'Add two numbers',
    parameters: {
      a: { type: 'number', description: 'First number', required: true },
      b: { type: 'number', description: 'Second number', required: true },
    },
    async execute(args) {
      return (args.a as number) + (args.b as number)
    },
  }))
}
addTool.inject = ['tools']

// 工具插件：multiply
function multiplyTool(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'multiply',
    description: 'Multiply two numbers',
    parameters: {
      a: { type: 'number', description: 'First number', required: true },
      b: { type: 'number', description: 'Second number', required: true },
    },
    async execute(args) {
      return (args.a as number) * (args.b as number)
    },
  }))
}
multiplyTool.inject = ['tools']

// ----------------------------------------
// 自动注入：声明工具插件清单，批量自动注入
// （dsh 的插件由 loader 按配置自动加载，这里是简化版：清单 + enabled 开关）
// ----------------------------------------

// 工具插件注册表：声明有哪些工具插件、是否启用
const toolPluginRegistry = [
  { name: 'echo', enabled: true, plugin: echoTool },
  { name: 'add', enabled: true, plugin: addTool },
  { name: 'multiply', enabled: true, plugin: multiplyTool },
]

// 自动注入：遍历注册表，只加载 enabled 的插件
async function autoMountToolPlugins(ctx: Context) {
  for (const entry of toolPluginRegistry) {
    if (!entry.enabled) {
      console.log(`  ⏭️  跳过工具插件: ${entry.name} (disabled)`)
      continue
    }
    await ctx.plugin(entry.plugin)
  }
}

// ----------------------------------------
// 演示：使用 Tools
// ----------------------------------------

let ctx = new Context()
// ctx.plugin() 是异步的，需要 await 等待服务激活
await ctx.plugin(ToolsService)

// 自动注入工具插件（不用手动一个个 plugin，声明清单即可）
console.log('\n📦 自动注入工具插件...')
await autoMountToolPlugins(ctx)

console.log(`  ✅ 已注册工具: ${ctx.tools.list().join(', ')}`)

console.log('\n✅ Part 1 完成！')

// ============================================================
// Part 2: Schema 生成 - OpenAI 格式
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 2: Schema 生成')
console.log('='.repeat(60))

console.log('\n💡 什么是 Schema？')
console.log('Schema 描述工具的参数类型，让 LLM 知道如何调用工具。')
console.log('我们使用 OpenAI 的函数调用格式。')

// 查看 schemas
console.log('\n📋 工具 Schemas (OpenAI 格式):')
const schemas = ctx.tools.getSchemas()
for (const schema of schemas) {
  console.log(`\n  工具: ${schema.function.name}`)
  console.log(`  描述: ${schema.function.description}`)
  console.log(`  参数: ${JSON.stringify(schema.function.parameters, null, 2).split('\n').join('\n  ')}`)
}

console.log('\n✅ Part 2 完成！')

// ============================================================
// Part 3: 执行工具
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 3: 执行工具')
console.log('='.repeat(60))

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

console.log('\n✅ Part 3 完成！')

// ============================================================
// Part 4: 执行管道 - pre/post 钩子
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 4: 执行管道')
console.log('='.repeat(60))

console.log('\n💡 什么是执行管道？')
console.log('工具执行分为多个阶段，每个阶段都可以添加中间件。')
console.log('实现权限检查、日志记录、参数验证等功能。')

// 重新创建 Context
ctx = new Context()
await ctx.plugin(ToolsService)

// ----------------------------------------
// 添加管道监听器
// ----------------------------------------

console.log('\n📦 设置管道监听器...\n')

// pre-execute: 权限检查（返回决策，不调 next 相当于短路拒绝）
ctx.on('tools/pre-execute', async (call, next) => {
  console.log('  [pre-execute] 权限检查...')
  if (call.name === 'dangerous') {
    console.log('  [pre-execute] ❌ 拒绝执行危险工具')
    return 'deny'  // 不调 next()，直接短路，返回拒绝决策
  }
  console.log('  [pre-execute] ✅ 权限通过')
  return next()  // 委托给下一层
})

// pre-execute: 参数验证
ctx.on('tools/pre-execute', async (call, next) => {
  console.log('  [pre-execute] 参数验证...')
  if (!call.args || Object.keys(call.args).length === 0) {
    console.log('  [pre-execute] ❌ 参数为空')
    return 'deny'
  }
  console.log('  [pre-execute] ✅ 参数有效')
  return next()
})

// post-execute: 记录日志（结果逐层包裹）
ctx.on('tools/post-execute', async (call, result, next) => {
  console.log('  [post-execute] 记录结果到日志')
  console.log(`    工具ID: ${result.id}`)
  console.log(`    结果: ${result.result}`)
  const final = await next()
  console.log('  [post-execute] 日志完成（结果已返回）')
  return final
})

// post-execute: 保存到 session
ctx.on('tools/post-execute', async (call, result, next) => {
  console.log('  [post-execute] 保存到 session')
  const final = await next()
  console.log('  [post-execute] session 已更新')
  return final
})

// ----------------------------------------
// 执行工具
// ----------------------------------------

console.log('\n🚀 执行正常工具...')

// 工具插件：safe-tool（权限检查放行）
function safeTool(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'safe-tool',
    description: 'A safe tool',
    parameters: {
      input: { type: 'string', description: 'Input text', required: true },
    },
    async execute(args) {
      return `Executed with args: ${JSON.stringify(args)}`
    },
  }))
}
safeTool.inject = ['tools']
await ctx.plugin(safeTool)

const result1 = await ctx.tools.execute({
  id: '1',
  name: 'safe-tool',
  args: { input: 'test' },
})
console.log(`  ✅ 最终结果: ${result1.result}\n`)

console.log('\n🚀 执行参数校验失败的工具...')

// 故意传类型错误的参数：safe-tool 的 input 是 string，defineTool 会拦截
const resultBad = await ctx.tools.execute({
  id: '1b',
  name: 'safe-tool',
  args: { input: 123 },  // 类型错误：应该是 string
})
console.log(`  ❌ 参数校验: ${resultBad.error}\n`)

console.log('\n🚀 执行被拒绝的工具...')

// 工具插件：dangerous（权限检查会拒绝）
function dangerousTool(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'dangerous',
    description: 'A dangerous tool',
    parameters: {},
    async execute(args) {
      return 'SHOULD NOT RUN'
    },
  }))
}
dangerousTool.inject = ['tools']
await ctx.plugin(dangerousTool)

const result2 = await ctx.tools.execute({
  id: '2',
  name: 'dangerous',
  args: { foo: 'bar' },
})
console.log(`  ❌ 错误: ${result2.error}`)

console.log('\n✅ Part 4 完成！')

// ============================================================
// 总结
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('🎊 博客5 完成！')
console.log('='.repeat(60))
console.log('\n📝 核心概念：')
console.log('  1. 工具注册 - 使用 effect 实现自动清理')
console.log('  2. Schema 生成 - OpenAI 函数调用格式')
console.log('  3. 工具执行 - 统一的执行接口')
console.log('  4. 执行管道 - pre/post 钩子扩展功能')
console.log('\n💡 实际应用：')
console.log('  - 扩展 Agent 能力（API 调用、文件操作等）')
console.log('  - 权限控制和安全检查')
console.log('  - 日志记录和审计')
console.log('  - 参数验证和错误处理')
