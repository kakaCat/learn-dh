/**
 * 第0课：Hello World
 *
 * 这是最简单的 Cordis 程序。
 * 我们创建一个 Context，注册一个插件，然后运行它。
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 第一步：创建一个插件
// ============================================================

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

  // 向 Context 注册一个服务（Cordis 4 使用 ctx.provide()）
  // 这样其他插件就可以通过 ctx.hello 访问它
  ctx.provide('hello', {
    say(name: string) {
      return `Hello, ${name}!`
    }
  })
}

// ============================================================
// 第二步：创建 Context 并注册插件
// ============================================================

console.log('1️⃣  创建 Context...')
const ctx = new Context()

console.log('2️⃣  注册插件...')
// 注意：Cordis 4 中 ctx.plugin() 是异步的，需要 await
await ctx.plugin(helloPlugin)

// ============================================================
// 第三步：使用服务
// ============================================================

console.log('3️⃣  使用服务...')
const message = ctx.hello.say('World')
console.log(message)

console.log('4️⃣  完成！')
