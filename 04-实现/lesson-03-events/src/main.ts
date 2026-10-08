/**
 * 第3课：事件系统
 *
 * 学习五种事件派发模式
 */

import { Context } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('第3课：事件系统')
console.log('='.repeat(60))

const ctx = new Context()

// ============================================================
// 1. emit - 触发即忘
// ============================================================
console.log('\n📢 1. emit - 触发即忘')
console.log('-'.repeat(40))

ctx.on('user-login', (userId: string) => {
  console.log(`  [同步] 用户 ${userId} 登录`)
})

ctx.on('user-login', async (userId: string) => {
  console.log(`  [异步] 开始发送欢迎邮件...`)
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log(`  [异步] 邮件发送完成（但 emit 不等它）`)
})

console.log('派发 emit...')
ctx.emit('user-login', 'alice')
console.log('emit 立即返回，异步监听器在后台继续\n')

await new Promise(resolve => setTimeout(resolve, 200))

// ============================================================
// 2. parallel - 并发执行
// ============================================================
console.log('\n🔀 2. parallel - 并发执行')
console.log('-'.repeat(40))

ctx.on('save-data', async (data: string) => {
  console.log('  [数据库] 开始保存...')
  await new Promise(resolve => setTimeout(resolve, 200))
  console.log('  [数据库] 完成')
})

ctx.on('save-data', async (data: string) => {
  console.log('  [云存储] 开始备份...')
  await new Promise(resolve => setTimeout(resolve, 150))
  console.log('  [云存储] 完成')
})

ctx.on('save-data', async (data: string) => {
  console.log('  [通知] 开始发送...')
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log('  [通知] 完成')
})

console.log('派发 parallel...')
await ctx.parallel('save-data', 'important-data')
console.log('所有监听器都完成了\n')

// ============================================================
// 3. serial - 串行执行（可短路）
// ============================================================
console.log('\n➡️  3. serial - 串行执行（可短路）')
console.log('-'.repeat(40))

ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器1] 检查 "${request}"`)
  if (request === 'task-a') {
    console.log('  [处理器1] ✅ 我可以处理')
    return 'handler-1'
  }
  console.log('  [处理器1] ❌ 不能处理')
  return null
})

ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器2] 检查 "${request}"`)
  if (request === 'task-b') {
    console.log('  [处理器2] ✅ 我可以处理')
    return 'handler-2'
  }
  console.log('  [处理器2] ❌ 不能处理')
  return null
})

ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器3] 检查 "${request}"`)
  console.log('  [处理器3] ❌ 不能处理')
  return null
})

console.log('派发 serial (task-b)...')
const handler = await ctx.serial('find-handler', 'task-b')
console.log(`找到处理器: ${handler}（处理器3 被跳过）\n`)

// ============================================================
// 4. bail - 同步短路
// ============================================================
console.log('\n🛑 4. bail - 同步短路')
console.log('-'.repeat(40))

ctx.on('check-permission', (action: string) => {
  if (action === 'read') return null
  return null
})

ctx.on('check-permission', (action: string) => {
  if (action === 'write') {
    console.log('  [检查2] 拒绝写入操作')
    return 'denied'
  }
  return null
})

ctx.on('check-permission', (action: string) => {
  console.log('  [检查3] 默认允许')
  return 'allowed'
})

console.log('派发 bail (write)...')
const permission = ctx.bail('check-permission', 'write')
console.log(`结果: ${permission}（检查3 被跳过）\n`)

// ============================================================
// 5. waterfall - 洋葱模型
// ============================================================
console.log('\n🧅 5. waterfall - 洋葱模型')
console.log('-'.repeat(40))

ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('  [缓存层] 进入 → 检查缓存')
  console.log('  [缓存层] 未命中，调用 next()')
  const result = await next()
  console.log('  [缓存层] 返回 ← 保存到缓存')
  return result
})

ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('    [认证层] 进入 → 验证用户')
  console.log('    [认证层] 通过，调用 next()')
  const result = await next()
  console.log('    [认证层] 返回 ← 清理信息')
  return result
})

ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('      [日志层] 进入 → 记录开始')
  console.log('      [日志层] 调用 next()')
  const result = await next()
  console.log('      [日志层] 返回 ← 记录完成')
  return result
})

console.log('派发 waterfall...')
const result = await ctx.waterfall('process-request', { url: '/api/data' }, async () => {
  console.log('        [核心] 处理请求')
  return { status: 200, data: 'response' }
})
console.log(`最终结果: ${JSON.stringify(result)}\n`)

console.log('='.repeat(60))
console.log('✅ 完成！')
console.log('='.repeat(60))
