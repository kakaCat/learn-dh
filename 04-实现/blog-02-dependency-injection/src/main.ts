/**
 * 博客2：依赖注入与服务管理
 * 演示 Cordis 的依赖注入机制
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 1. 类型扩展
// ============================================================
// 告诉 TypeScript 我们要给 Context 添加哪些服务
declare module '@cordisjs/core' {
  interface Context {
    database: DatabaseService
    cache: CacheService
    api: ApiService
    analytics: AnalyticsService
    a: ServiceA
    b: ServiceB
    c: ServiceC
    d: ServiceD
    e: ServiceE
  }
}

// ============================================================
// 2. 定义服务类
// ============================================================

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
    console.log('  ✅ CacheService 已激活（依赖 database）')

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
// 声明依赖：CacheService 依赖 database
// Cordis 会确保 DatabaseService 在 CacheService 之前激活
CacheService.inject = ['database']

class ApiService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'api', true)
    console.log('  ✅ ApiService 已激活（依赖 database + cache）')

    const dbResult = ctx.database.query('SELECT * FROM users')
    console.log(`     数据库查询: ${dbResult}`)

    ctx.cache.set('users', 'cached-data')
    console.log(`     缓存设置: ${ctx.cache.get('users')}`)
  }

  fetch(endpoint: string): string {
    const cached = this.ctx.cache.get(endpoint)
    if (cached) return `Cache hit: ${cached}`
    return this.ctx.database.query(`SELECT * FROM ${endpoint}`)
  }
}
ApiService.inject = ['database', 'cache']

class AnalyticsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'analytics', true)
    console.log('  ✅ AnalyticsService 已激活（可选依赖 cache）')

    if (ctx.cache) {
      console.log('     发现 cache 服务，使用缓存')
    } else {
      console.log('     没有 cache 服务，直接查询')
    }
  }
}
AnalyticsService.inject = ['?cache']

// ============================================================
// 3. Part 1: 依赖注入基础
// ============================================================

async function part1() {
  console.log('='.repeat(60))
  console.log('Part 1: 依赖注入基础')
  console.log('='.repeat(60))

  console.log('\n💡 声明依赖后，Cordis 自动按依赖顺序激活服务\n')

  const ctx = new Context()

  console.log('📦 注册插件（注意：顺序随意）')
  console.log('  注册顺序: ApiService → CacheService → DatabaseService')
  console.log('  预期激活: DatabaseService → CacheService → ApiService\n')

  ctx.plugin(ApiService)
  ctx.plugin(CacheService)
  ctx.plugin(DatabaseService)

  // 等待服务激活
  await new Promise(resolve => setImmediate(resolve))

  console.log('\n🎯 使用服务...')
  const result = ctx.api.fetch('/users')
  console.log(`  API 结果: ${result}`)

  console.log('\n✅ Part 1 完成！\n')
}

// ============================================================
// 4. Part 2: 可选依赖
// ============================================================

async function part2() {
  console.log('='.repeat(60))
  console.log('Part 2: 可选依赖')
  console.log('='.repeat(60))

  console.log('\n💡 可选依赖用 ? 前缀，服务可有可无\n')

  const ctx = new Context()

  console.log('📦 场景1: cache 服务存在')
  ctx.plugin(CacheService)
  ctx.plugin(DatabaseService)
  ctx.plugin(AnalyticsService)

  await new Promise(resolve => setImmediate(resolve))

  console.log('\n📦 场景2: cache 服务不存在')
  const ctx2 = new Context()
  ctx2.plugin(AnalyticsService)

  await new Promise(resolve => setImmediate(resolve))

  console.log('\n✅ Part 2 完成！\n')
}

// ============================================================
// 5. Part 3: 复杂依赖图
// ============================================================

class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a', true)
    console.log('  [1] A 激活')
  }
}

class ServiceB extends Service {
  constructor(ctx: Context) {
    super(ctx, 'b', true)
    console.log('  [2] B 激活（依赖 A）')
  }
}
ServiceB.inject = ['a']

class ServiceC extends Service {
  constructor(ctx: Context) {
    super(ctx, 'c', true)
    console.log('  [3] C 激活（依赖 B）')
  }
}
ServiceC.inject = ['b']

class ServiceD extends Service {
  constructor(ctx: Context) {
    super(ctx, 'd', true)
    console.log('  [4] D 激活（依赖 A + C）')
  }
}
ServiceD.inject = ['a', 'c']

class ServiceE extends Service {
  constructor(ctx: Context) {
    super(ctx, 'e', true)
    console.log('  [5] E 激活（依赖 D）')
  }
}
ServiceE.inject = ['d']

async function part3() {
  console.log('='.repeat(60))
  console.log('Part 3: 复杂依赖图')
  console.log('='.repeat(60))

  console.log('\n依赖关系：')
  console.log('  A ← 无依赖')
  console.log('  B ← A')
  console.log('  C ← B')
  console.log('  D ← A, C')
  console.log('  E ← D')

  console.log('\n📦 注册顺序（故意打乱）：E, C, B, D, A\n')

  const ctx = new Context()

  ctx.plugin(ServiceE)
  ctx.plugin(ServiceC)
  ctx.plugin(ServiceB)
  ctx.plugin(ServiceD)
  ctx.plugin(ServiceA)

  await new Promise(resolve => setImmediate(resolve))

  console.log('\n✅ Cordis 自动按依赖关系排序！')
  console.log('✅ Part 3 完成！\n')
}

// ============================================================
// 6. 主流程
// ============================================================

async function main() {
  await part1()
  await part2()
  await part3()

  console.log('='.repeat(60))
  console.log('🎊 全部完成！')
  console.log('='.repeat(60))
  console.log('\n📝 总结：')
  console.log('  1. 使用 Service 类 + inject 静态属性声明依赖')
  console.log('  2. Cordis 自动计算依赖顺序，无需手动管理')
  console.log('  3. 可选依赖用 ? 前缀，让服务更灵活')
  console.log('  4. 依赖注入让代码更模块化，测试更容易\n')
}

// 执行主流程
main().catch(console.error)
