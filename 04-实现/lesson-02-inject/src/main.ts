/**
 * 第2课：依赖注入
 *
 * 学习如何声明依赖，让 Cordis 自动管理加载顺序
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 定义服务
// ============================================================

// 扩展 Context 类型，让 TypeScript 知道我们的服务
declare module '@cordisjs/core' {
  interface Context {
    database: DatabaseService
    cache: CacheService
    api: ApiService
  }
}

class DatabaseService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'database', true)
    console.log('  ✅ DatabaseService 已激活')
  }

  query(sql: string): string {
    return `DB result for: ${sql}`
  }
}

class CacheService extends Service {
  private data = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'cache', true)
    console.log('  ✅ CacheService 已激活（使用 database）')

    // 可以直接使用依赖的服务
    const result = ctx.database.query('SELECT * FROM config')
    console.log(`     初始化时查询数据库: ${result}`)
  }

  set(key: string, value: string) {
    this.data.set(key, value)
  }

  get(key: string): string | undefined {
    return this.data.get(key)
  }
}
// 声明依赖：CacheService 需要 database
CacheService.inject = ['database']

class ApiService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'api', true)
    console.log('  ✅ ApiService 已激活（使用 database 和 cache）')

    // 使用多个依赖
    const dbResult = ctx.database.query('SELECT * FROM users')
    console.log(`     数据库查询: ${dbResult}`)

    ctx.cache.set('users', 'cached-data')
    console.log(`     缓存设置: ${ctx.cache.get('users')}`)
  }

  fetch(endpoint: string): string {
    // 组合使用依赖
    const cached = this.ctx.cache.get(endpoint)
    if (cached) return `Cache hit: ${cached}`

    return this.ctx.database.query(`SELECT * FROM ${endpoint}`)
  }
}
// 声明依赖：ApiService 需要 database 和 cache
ApiService.inject = ['database', 'cache']

// ============================================================
// 可选依赖演示
// ============================================================

class AnalyticsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'analytics', true)
    console.log('  ✅ AnalyticsService 已激活')

    // 检查可选依赖是否存在
    if (ctx.cache) {
      console.log('     发现 cache 服务，使用缓存')
    } else {
      console.log('     没有 cache 服务，直接查询')
    }
  }
}
// 声明可选依赖：AnalyticsService 可以使用 cache，但不是必须的
AnalyticsService.inject = ['?cache']

// ============================================================
// 主程序
// ============================================================

console.log('='.repeat(60))
console.log('第2课：依赖注入')
console.log('='.repeat(60))

const ctx = new Context()

console.log('\n📦 注册插件（注意顺序：随意）')
console.log('  注册顺序: ApiService → CacheService → DatabaseService')
console.log('  实际激活: DatabaseService → CacheService → ApiService')
console.log('')

ctx.plugin(ApiService)
ctx.plugin(CacheService)
ctx.plugin(DatabaseService)

console.log('\n🎯 使用服务...')
const result = ctx.api.fetch('/users')
console.log(`  API 结果: ${result}`)

console.log('\n📦 注册带可选依赖的插件...')
ctx.plugin(AnalyticsService)

console.log('\n✅ 完成！')
