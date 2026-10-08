/**
 * Effect 演示
 *
 * 展示 ctx.effect() 的强大之处
 */

import { Context } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('Effect 演示')
console.log('='.repeat(60))

const ctx = new Context()

console.log('\n🔧 注册多个 effect...')

// Effect 1: 定时器
ctx.effect(() => {
  console.log('  [Effect 1] 设置定时器')
  const timer = setInterval(() => {}, 1000)
  return () => {
    console.log('  [Effect 1] 清理定时器')
    clearInterval(timer)
  }
})

// Effect 2: 事件监听
ctx.effect(() => {
  console.log('  [Effect 2] 注册事件监听')
  const handler = () => {}
  return () => {
    console.log('  [Effect 2] 移除事件监听')
  }
})

// Effect 3: 文件监听
ctx.effect(() => {
  console.log('  [Effect 3] 打开文件')
  return () => {
    console.log('  [Effect 3] 关闭文件')
  }
})

console.log('\n🗑️  销毁 Context...')
console.log('（Effect 会按 LIFO 顺序清理）\n')

// 直接挂在 Context 上的 effect 属于根 Fiber
// 销毁根 Fiber 即可触发所有清理
await ctx.fiber.dispose()

console.log('\n✅ 所有资源已清理！')
