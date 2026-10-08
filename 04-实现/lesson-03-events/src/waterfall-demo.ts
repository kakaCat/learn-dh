/**
 * Waterfall 深入演示
 *
 * 展示 waterfall 的更多用法
 */

import { Context } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('Waterfall 深入演示')
console.log('='.repeat(60))

const ctx = new Context()

// ============================================================
// 用法1：短路（不调用 next）
// ============================================================
console.log('\n🔌 用法1：短路（权限检查）')
console.log('-'.repeat(40))

ctx.on('api/request', async (req: any, next: () => any) => {
  console.log('  [权限检查] 进入')
  if (req.user === 'anonymous') {
    console.log('  [权限检查] ❌ 拒绝（短路，不调用 next）')
    throw new Error('Permission denied')
  }
  console.log('  [权限检查] ✅ 通过')
  return await next()
})

ctx.on('api/request', async (req: any, next: () => any) => {
  console.log('  [业务逻辑] 执行')
  return { data: 'sensitive-data' }
})

try {
  await ctx.waterfall('api/request', { user: 'anonymous' }, async () => {
    console.log('  [核心] 这行不会执行')
    return {}
  })
} catch (error: any) {
  console.log(`  错误被捕获: ${error.message}`)
}

// ============================================================
// 用法2：修改参数
// ============================================================
console.log('\n📝 用法2：修改参数')
console.log('-'.repeat(40))

ctx.on('transform', async (data: string, next: () => any) => {
  console.log(`  [转换1] 输入: "${data}"`)
  const modified = data.toUpperCase()
  console.log(`  [转换1] 修改后: "${modified}"`)
  const result = await next()
  return result + ' [layer1]'
})

ctx.on('transform', async (data: string, next: () => any) => {
  console.log(`  [转换2] 输入: "${data}"`)
  const modified = data + ' [transformed]'
  console.log(`  [转换2] 修改后: "${modified}"`)
  const result = await next()
  return result + ' [layer2]'
})

const transformed = await ctx.waterfall('transform', 'hello', async () => {
  console.log('    [核心] 处理')
  return 'result'
})
console.log(`  最终结果: "${transformed}"`)

// ============================================================
// 用法3：缓存
// ============================================================
console.log('\n💾 用法3：缓存')
console.log('-'.repeat(40))

const cache = new Map<string, any>()

ctx.on('expensive-operation', async (input: string, next: () => any) => {
  const key = `op:${input}`
  if (cache.has(key)) {
    console.log(`  [缓存] 命中: ${input}`)
    return cache.get(key)
  }

  console.log(`  [缓存] 未命中: ${input}`)
  const result = await next()
  cache.set(key, result)
  console.log(`  [缓存] 已保存: ${input}`)
  return result
})

// 第一次调用（未命中）
console.log('第一次调用:')
const r1 = await ctx.waterfall('expensive-operation', 'task-1', async () => {
  console.log('  [核心] 执行耗时操作...')
  await new Promise(resolve => setTimeout(resolve, 100))
  return { result: 'computed' }
})
console.log(`  结果: ${JSON.stringify(r1)}`)

// 第二次调用（命中）
console.log('\n第二次调用:')
const r2 = await ctx.waterfall('expensive-operation', 'task-1', async () => {
  console.log('  [核心] 执行耗时操作...')
  await new Promise(resolve => setTimeout(resolve, 100))
  return { result: 'computed' }
})
console.log(`  结果: ${JSON.stringify(r2)}`)

console.log('\n' + '='.repeat(60))
console.log('✅ 完成！')
console.log('='.repeat(60))
