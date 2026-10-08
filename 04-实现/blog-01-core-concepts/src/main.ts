/**
 * 博客1：Cordis 核心概念入门
 *
 * 本文包含：
 * - Part 1: Hello World - 最简单的 Cordis 程序
 * - Part 2: 插件的三种形态 - 函数、对象、类
 */

import { Context } from '@cordisjs/core'

// ============================================================
// Part 1: Hello World
// ============================================================

console.log('='.repeat(60))
console.log('Part 1: Hello World')
console.log('='.repeat(60))

/**
 * 插件就是一个函数，接收一个 Context 参数
 *
 * Context 是 Cordis 的核心概念，可以理解为一个"容器"：
 * - 它里面可以存放各种服务
 * - 插件可以向里面添加服务
 * - 其他插件可以从里面获取服务
 */
function helloPlugin(ctx: Context) {
  console.log('🎉 Hello from plugin!')

  // 向 Context 注册一个服务（使用 ctx.provide()）
  // 这样其他插件就可以通过 ctx.hello 访问它
  ctx.provide('hello', {
    // 对外提供的方法：打招呼
    say(name: string) {
      return `Hello, ${name}!`
    }
  })
}

console.log('\n1️⃣  创建 Context...')
let ctx = new Context()

console.log('2️⃣  注册插件...')
// 注意：ctx.plugin() 是异步的，需要 await
await ctx.plugin(helloPlugin)

console.log('3️⃣  使用服务...')
const message = ctx.hello.say('World')
console.log(message)

console.log('4️⃣  Part 1 完成！')

// ============================================================
// Part 2: 插件的三种形态
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 2: 插件的三种形态')
console.log('='.repeat(60))

// 重新创建 Context 用于演示
ctx = new Context()

// ----------------------------------------
// 形态1：函数插件（Part 1 的方式）
// ----------------------------------------

function loggerPlugin(ctx: Context) {
  console.log('✅ 函数插件 logger 已激活')

  // 插件的内部状态（私有数据，外部无法直接访问）
  const logs: string[] = []

  // 注册服务：'logger' 是服务名（自定义），会挂载到 ctx.logger
  // 函数插件没有 name 属性，所以服务名完全由 provide() 的第一个参数决定
  ctx.provide('logger', {
    // 对外提供的方法：记录日志
    log(message: string) {
      const entry = `[${new Date().toLocaleTimeString()}] ${message}`
      logs.push(entry)
      console.log(entry)
    },
    // 对外提供的方法：获取所有日志
    getLogs() {
      return [...logs]
    }
  })
}

// ----------------------------------------
// 形态2：对象插件（可以携带 name 等元信息）
// ----------------------------------------

const counterPlugin = {
  name: 'counter',
  apply(ctx: Context) {
    console.log('✅ 对象插件 counter 已激活')

    // 插件的内部状态
    let count = 0

    // 注册服务：'counter' 是服务名（自定义），会挂载到 ctx.counter
    // 第二个参数是服务对象，包含自定义的方法
    ctx.provide('counter', {
      // 对外提供的方法：递增计数器并返回新值
      increment() {
        return ++count
      },
      // 对外提供的方法：获取当前计数
      getCount() {
        return count
      }
    })
  }
}

// ----------------------------------------
// 形态3：类插件（适合有内部状态的插件）
// ----------------------------------------

class TokenBucket {
  private tokens: number

  constructor(ctx: Context, config: { capacity: number }) {
    console.log(`✅ 类插件 tokenBucket 已激活（容量: ${config.capacity}）`)
    this.tokens = config.capacity

    // 注册服务：'tokenBucket' 是服务名（自定义），会挂载到 ctx.tokenBucket
    ctx.provide('tokenBucket', {
      // 对外提供的方法：尝试取一个令牌，成功返回 true，令牌不足返回 false
      take: () => this.take(),
      // 对外提供的方法：返回剩余令牌数
      remaining: () => this.tokens
    })
  }

  private take(): boolean {
    if (this.tokens <= 0) return false
    this.tokens--
    return true
  }
}

console.log('\n📦 注册三种形态的插件...')
await ctx.plugin(loggerPlugin)
await ctx.plugin(counterPlugin)
// 第二个参数是插件的配置，会传给构造函数
await ctx.plugin(TokenBucket, { capacity: 3 })

console.log('\n🎯 使用服务...')
// 调用 logger 服务的 log 方法（服务名和方法都是自定义的）
ctx.logger.log('这是一条日志')

// 调用 counter 服务的 increment 方法（每次调用计数器 +1）
console.log('Counter:', ctx.counter.increment())  // 1
console.log('Counter:', ctx.counter.increment())  // 2

// 调用 tokenBucket 服务的 take 和 remaining 方法
console.log('取令牌:', ctx.tokenBucket.take())     // true
console.log('取令牌:', ctx.tokenBucket.take())     // true
console.log('取令牌:', ctx.tokenBucket.take())     // true
console.log('取令牌:', ctx.tokenBucket.take())     // false，已取完
console.log('剩余令牌:', ctx.tokenBucket.remaining())

console.log('\n✅ Part 2 完成！')

console.log('\n' + '='.repeat(60))
console.log('🎊 博客1 全部完成！')
console.log('='.repeat(60))

