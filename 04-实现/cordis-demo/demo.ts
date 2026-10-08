/**
 * Cordis 控制流演示
 *
 * 演示五种派发模式的实际工作方式
 */

import { Context } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('Cordis 控制流演示')
console.log('='.repeat(60))

const ctx = new Context()

// ==================== 1. emit - 触发即忘 ====================
console.log('\n📢 1. emit - 触发即忘')
console.log('-'.repeat(60))

ctx.on('user-login', (userId: string) => {
  console.log(`  监听器1: 用户 ${userId} 登录`)
})

ctx.on('user-login', async (userId: string) => {
  console.log(`  监听器2: 发送欢迎邮件...`)
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log(`  监听器2: 邮件已发送（但 emit 不会等待）`)
})

ctx.on('user-login', (userId: string) => {
  console.log(`  监听器3: 记录日志`)
})

console.log('派发 emit...')
ctx.emit('user-login', 'user123')
console.log('emit 立即返回（不等待异步监听器）\n')

// ==================== 2. parallel - 并发执行 ====================
console.log('\n🔀 2. parallel - 并发执行')
console.log('-'.repeat(60))

ctx.on('save-data', async (data: string) => {
  console.log(`  监听器1: 开始保存到数据库...`)
  await new Promise(resolve => setTimeout(resolve, 200))
  console.log(`  监听器1: 数据库保存完成`)
})

ctx.on('save-data', async (data: string) => {
  console.log(`  监听器2: 开始备份到云存储...`)
  await new Promise(resolve => setTimeout(resolve, 150))
  console.log(`  监听器2: 云存储备份完成`)
})

ctx.on('save-data', async (data: string) => {
  console.log(`  监听器3: 开始发送通知...`)
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log(`  监听器3: 通知已发送`)
})

console.log('派发 parallel...')
await ctx.parallel('save-data', 'important-data')
console.log('所有监听器都完成了\n')

// ==================== 3. serial - 串行执行（可短路）====================
console.log('\n➡️  3. serial - 串行执行（可短路）')
console.log('-'.repeat(60))

ctx.on('find-handler', async (request: string) => {
  console.log(`  监听器1: 检查能否处理 "${request}"`)
  if (request === 'task-a') {
    console.log(`  监听器1: ✅ 我可以处理！`)
    return 'handler-1'
  }
  console.log(`  监听器1: ❌ 我不能处理`)
  return null
})

ctx.on('find-handler', async (request: string) => {
  console.log(`  监听器2: 检查能否处理 "${request}"`)
  if (request === 'task-b') {
    console.log(`  监听器2: ✅ 我可以处理！`)
    return 'handler-2'
  }
  console.log(`  监听器2: ❌ 我不能处理`)
  return null
})

ctx.on('find-handler', async (request: string) => {
  console.log(`  监听器3: 检查能否处理 "${request}"`)
  if (request === 'task-c') {
    console.log(`  监听器3: ✅ 我可以处理！`)
    return 'handler-3'
  }
  console.log(`  监听器3: ❌ 我不能处理`)
  return null
})

console.log('派发 serial (task-b)...')
const handler = await ctx.serial('find-handler', 'task-b')
console.log(`找到处理器: ${handler}（监听器3 不会执行）\n`)

// ==================== 4. waterfall - 洋葱模型 ====================
console.log('\n🧅 4. waterfall - 洋葱模型')
console.log('-'.repeat(60))

ctx.on('process-request', async (request: any, next: () => any) => {
  console.log('  [外层] 监听器1 - 进入（缓存层）')
  const cached = null // 假设没有缓存
  if (cached) {
    console.log('  [外层] 监听器1 - 返回缓存')
    return cached
  }

  console.log('  [外层] 监听器1 - 调用 next()')
  const result = await next()
  console.log('  [外层] 监听器1 - 返回，保存缓存')
  return result
})

ctx.on('process-request', async (request: any, next: () => any) => {
  console.log('  [中层] 监听器2 - 进入（日志层）')
  console.log('  [中层] 监听器2 - 调用 next()')
  const result = await next()
  console.log('  [中层] 监听器2 - 返回，记录日志')
  return result
})

ctx.on('process-request', async (request: any, next: () => any) => {
  console.log('  [内层] 监听器3 - 进入（权限层）')
  console.log('  [内层] 监听器3 - 检查权限...')
  console.log('  [内层] 监听器3 - 调用 next()')
  const result = await next()
  console.log('  [内层] 监听器3 - 返回')
  return result
})

console.log('派发 waterfall...')
const result = await ctx.waterfall('process-request', { data: 'test' }, async () => {
  console.log('  [核心] 实际处理逻辑执行')
  return { success: true, data: 'processed' }
})
console.log(`最终结果: ${JSON.stringify(result)}\n`)

// ==================== 5. 依赖注入演示 ====================
console.log('\n🔌 5. 依赖注入演示')
console.log('-'.repeat(60))

// 定义扩展类型
declare module '@cordisjs/core' {
  interface Context {
    database: DatabaseService
    cache: CacheService
    api: ApiService
  }
}

class DatabaseService {
  constructor(private ctx: Context) {
    console.log('  ✅ DatabaseService 已创建')
  }

  query(sql: string) {
    return `DB result for: ${sql}`
  }
}

class CacheService {
  constructor(private ctx: Context) {
    console.log('  ✅ CacheService 已创建（依赖 database）')
  }

  get(key: string) {
    // 可以使用 database
    return this.ctx.database.query(`SELECT * FROM cache WHERE key='${key}'`)
  }
}
// 声明依赖
(CacheService as any).inject = ['database']

class ApiService {
  constructor(private ctx: Context) {
    console.log('  ✅ ApiService 已创建（依赖 database 和 cache）')
  }

  fetch(endpoint: string) {
    // 可以使用 database 和 cache
    const cached = this.ctx.cache.get(endpoint)
    return cached || this.ctx.database.query(`SELECT * FROM api WHERE endpoint='${endpoint}'`)
  }
}
// 声明依赖
(ApiService as any).inject = ['database', 'cache']

console.log('注册插件（顺序随意）...')
ctx.plugin(ApiService as any)       // 依赖 database, cache
ctx.plugin(CacheService as any)     // 依赖 database
ctx.plugin(DatabaseService as any)  // 无依赖

console.log('\nCordis 自动按依赖顺序激活：')
console.log('  1. DatabaseService（无依赖）')
console.log('  2. CacheService（等待 database）')
console.log('  3. ApiService（等待 database 和 cache）\n')

// ==================== 6. 作用域隔离演示 ====================
console.log('\n🔐 6. 作用域隔离演示')
console.log('-'.repeat(60))

// 全局配置
const globalCtx = new Context()

declare module '@cordisjs/core' {
  interface Context {
    config?: { theme: string }
  }
}

globalCtx.config = { theme: 'light' }
console.log(`全局配置: theme = ${globalCtx.config.theme}`)

// 子上下文1 - 继承
const child1 = globalCtx.extend()
console.log(`子上下文1: theme = ${child1.config?.theme}（继承自父级）`)

// 子上下文2 - 覆盖
const child2 = globalCtx.extend({ config: { theme: 'dark' } })
console.log(`子上下文2: theme = ${child2.config?.theme}（覆盖）`)

// 验证父级不受影响
console.log(`全局配置: theme = ${globalCtx.config.theme}（未改变）\n`)

// ==================== 7. Effect 生命周期演示 ====================
console.log('\n♻️  7. Effect 生命周期演示')
console.log('-'.repeat(60))

const tempCtx = new Context()

console.log('注册 effects...')
tempCtx.effect(() => {
  console.log('  ⚙️  Effect 1 setup')
  return () => console.log('  🧹 Effect 1 cleanup')
})

tempCtx.effect(() => {
  console.log('  ⚙️  Effect 2 setup')
  return () => console.log('  🧹 Effect 2 cleanup')
})

tempCtx.effect(() => {
  console.log('  ⚙️  Effect 3 setup')
  return () => console.log('  🧹 Effect 3 cleanup')
})

console.log('\n销毁上下文（LIFO 顺序）...')
tempCtx.dispose()

console.log('\n' + '='.repeat(60))
console.log('演示完成！')
console.log('='.repeat(60))
