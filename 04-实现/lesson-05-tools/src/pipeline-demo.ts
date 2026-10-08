/**
 * 工具执行管道演示
 *
 * 展示 pre-execute、execute、post-execute 的完整流程
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('工具执行管道演示')
console.log('='.repeat(60))

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
  private tools = new Map<string, any>()

  constructor(ctx: Context) {
    super(ctx, 'tools', true)
  }

  register(name: string, tool: any) {
    this.tools.set(name, tool)
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    await this.ctx.waterfall('tools/pre-execute', call)
    const result = await this.ctx.waterfall('tools/execute', call)
    await this.ctx.waterfall('tools/post-execute', result)
    return result
  }
}

const ctx = new Context()
ctx.plugin(ToolsService)

// ============================================================
// 添加管道监听器
// ============================================================

console.log('\n📦 设置管道监听器...\n')

// pre-execute: 权限检查
ctx.on('tools/pre-execute', async (call, next) => {
  console.log('  [pre-execute] 权限检查...')
  if (call.name === 'dangerous') {
    console.log('  [pre-execute] ❌ 拒绝执行危险工具')
    throw new Error('Permission denied')
  }
  console.log('  [pre-execute] ✅ 权限通过')
  await next()
})

// pre-execute: 参数验证
ctx.on('tools/pre-execute', async (call, next) => {
  console.log('  [pre-execute] 参数验证...')
  if (!call.args || Object.keys(call.args).length === 0) {
    console.log('  [pre-execute] ❌ 参数为空')
    throw new Error('Invalid arguments')
  }
  console.log('  [pre-execute] ✅ 参数有效')
  await next()
})

// execute: 实际执行
ctx.on('tools/execute', async (call, next) => {
  console.log('  [execute] 开始执行工具')
  const tool = ctx.tools['tools'].get(call.name) // 简化获取
  if (!tool) {
    throw new Error('Tool not found')
  }
  const result = await tool.execute(call.args)
  console.log('  [execute] 执行完成')
  return { id: call.id, result }
})

// post-execute: 记录日志
ctx.on('tools/post-execute', async (result, next) => {
  console.log('  [post-execute] 记录结果到日志')
  console.log(`    工具ID: ${result.id}`)
  console.log(`    结果: ${result.result}`)
  await next()
})

// post-execute: 记录到 session
ctx.on('tools/post-execute', async (result, next) => {
  console.log('  [post-execute] 保存到 session')
  await next()
})

// ============================================================
// 执行工具
// ============================================================

console.log('\n🚀 执行正常工具...')

ctx.tools.register('safe-tool', {
  description: 'A safe tool',
  parameters: {},
  async execute(args) {
    return `Executed with args: ${JSON.stringify(args)}`
  },
})

const result1 = await ctx.tools.execute({
  id: '1',
  name: 'safe-tool',
  args: { input: 'test' },
})
console.log(`  结果: ${result1.result}\n`)

console.log('\n🚀 执行被拒绝的工具...')

try {
  await ctx.tools.execute({
    id: '2',
    name: 'dangerous',
    args: {},
  })
} catch (error: any) {
  console.log(`  错误: ${error.message}`)
}

console.log('\n✅ 完成！')
