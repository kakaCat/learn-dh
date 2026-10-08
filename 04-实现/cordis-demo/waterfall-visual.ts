/**
 * Waterfall（洋葱模型）可视化演示
 *
 * 更清晰地展示请求如何穿过中间件层
 */

import { Context } from '@cordisjs/core'

console.log('='.repeat(70))
console.log('Waterfall (洋葱模型) 可视化')
console.log('='.repeat(70))

const ctx = new Context()

// 定义一个请求对象
interface Request {
  url: string
  method: string
  startTime?: number
  userId?: string
  cached?: boolean
}

// ==================== 中间件1: 缓存层 ====================
ctx.on('http/request', async (req: Request, next: () => any) => {
  console.log('\n┌─────────────────────────────────────┐')
  console.log('│  [缓存层] 进入                      │')
  console.log('└─────────────────────────────────────┘')
  console.log(`  检查缓存: ${req.url}`)

  // 模拟缓存检查
  const cacheKey = `${req.method}:${req.url}`
  const cached = null // 假设没有缓存

  if (cached) {
    console.log(`  ✅ 缓存命中！直接返回`)
    req.cached = true
    return cached
  }

  console.log(`  ❌ 缓存未命中，继续向内层...`)
  console.log('  ↓')

  // 调用下一层
  const result = await next()

  console.log('  ↑')
  console.log('┌─────────────────────────────────────┐')
  console.log('│  [缓存层] 返回                      │')
  console.log('└─────────────────────────────────────┘')
  console.log(`  保存到缓存: ${cacheKey}`)
  console.log(`  返回结果\n`)

  return result
})

// ==================== 中间件2: 认证层 ====================
ctx.on('http/request', async (req: Request, next: () => any) => {
  console.log('  ┌─────────────────────────────────────┐')
  console.log('  │  [认证层] 进入                      │')
  console.log('  └─────────────────────────────────────┘')
  console.log('    检查用户认证...')

  // 模拟认证
  const token = 'valid-token'
  if (!token) {
    console.log('    ❌ 认证失败！拒绝请求')
    throw new Error('Unauthorized')
  }

  console.log('    ✅ 认证通过')
  req.userId = 'user-123'
  console.log('    ↓')

  // 调用下一层
  const result = await next()

  console.log('    ↑')
  console.log('  ┌─────────────────────────────────────┐')
  console.log('  │  [认证层] 返回                      │')
  console.log('  └─────────────────────────────────────┘')
  console.log('    清理认证信息')
  console.log('    返回结果\n')

  return result
})

// ==================== 中间件3: 日志层 ====================
ctx.on('http/request', async (req: Request, next: () => any) => {
  console.log('    ┌─────────────────────────────────────┐')
  console.log('    │  [日志层] 进入                      │')
  console.log('    └─────────────────────────────────────┘')

  req.startTime = Date.now()
  console.log(`      📝 请求开始: ${req.method} ${req.url}`)
  console.log(`      👤 用户: ${req.userId}`)
  console.log('      ↓')

  // 调用下一层
  const result = await next()

  console.log('      ↑')
  console.log('    ┌─────────────────────────────────────┐')
  console.log('    │  [日志层] 返回                      │')
  console.log('    └─────────────────────────────────────┘')

  const duration = Date.now() - req.startTime!
  console.log(`      📝 请求完成: 耗时 ${duration}ms`)
  console.log(`      📊 状态: ${result.status}\n`)

  return result
})

// ==================== 中间件4: 限流层 ====================
ctx.on('http/request', async (req: Request, next: () => any) => {
  console.log('      ┌─────────────────────────────────────┐')
  console.log('      │  [限流层] 进入                      │')
  console.log('      └─────────────────────────────────────┘')
  console.log('        检查请求频率...')

  // 模拟限流检查
  const rateOk = true
  if (!rateOk) {
    console.log('        ❌ 请求过于频繁！')
    throw new Error('Rate limit exceeded')
  }

  console.log('        ✅ 限流检查通过')
  console.log('        ↓')

  // 调用核心逻辑
  const result = await next()

  console.log('        ↑')
  console.log('      ┌─────────────────────────────────────┐')
  console.log('      │  [限流层] 返回                      │')
  console.log('      └─────────────────────────────────────┘')
  console.log('        更新请求计数\n')

  return result
})

// ==================== 执行请求 ====================
console.log('\n🚀 开始处理 HTTP 请求')
console.log('='.repeat(70))

const request: Request = {
  url: '/api/users/123',
  method: 'GET'
}

console.log(`请求: ${request.method} ${request.url}`)

try {
  const response = await ctx.waterfall('http/request', request, async () => {
    // 这是最内层的核心逻辑
    console.log('        ┌─────────────────────────────────────┐')
    console.log('        │  [核心逻辑] 执行                    │')
    console.log('        └─────────────────────────────────────┘')
    console.log('          🔍 查询数据库...')

    // 模拟异步操作
    await new Promise(resolve => setTimeout(resolve, 100))

    console.log('          ✅ 数据已找到')
    console.log('          📦 构建响应\n')

    return {
      status: 200,
      data: { id: 123, name: 'Alice' }
    }
  })

  console.log('='.repeat(70))
  console.log('✅ 请求成功完成')
  console.log('响应:', JSON.stringify(response, null, 2))

} catch (error: any) {
  console.log('='.repeat(70))
  console.log('❌ 请求失败')
  console.log('错误:', error.message)
}

// ==================== 流程图 ====================
console.log('\n' + '='.repeat(70))
console.log('流程图')
console.log('='.repeat(70))
console.log(`
┌─────────────┐
│  缓存层     │ → 检查缓存
└──────┬──────┘
       ↓ next()
┌─────────────┐
│  认证层     │ → 验证用户
└──────┬──────┘
       ↓ next()
┌─────────────┐
│  日志层     │ → 记录开始
└──────┬──────┘
       ↓ next()
┌─────────────┐
│  限流层     │ → 检查频率
└──────┬──────┘
       ↓ next()
┌─────────────┐
│  核心逻辑   │ → 处理请求
└──────┬──────┘
       ↓ return
┌─────────────┐
│  限流层     │ ← 更新计数
└──────┬──────┘
       ↓ return
┌─────────────┐
│  日志层     │ ← 记录完成
└──────┬──────┘
       ↓ return
┌─────────────┐
│  认证层     │ ← 清理信息
└──────┬──────┘
       ↓ return
┌─────────────┐
│  缓存层     │ ← 保存缓存
└─────────────┘
       ↓
    最终响应
`)

console.log('='.repeat(70))
console.log('关键点:')
console.log('  1. 每层都可以短路（不调用 next）')
console.log('  2. 请求从外到内穿过所有层')
console.log('  3. 响应从内到外返回所有层')
console.log('  4. 每层都可以修改请求/响应')
console.log('  5. 清理逻辑自动按相反顺序执行')
console.log('='.repeat(70))
