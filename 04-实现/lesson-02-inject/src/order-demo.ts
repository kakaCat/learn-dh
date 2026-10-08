/**
 * 加载顺序演示
 *
 * 展示 Cordis 如何自动计算依赖顺序
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('加载顺序演示')
console.log('='.repeat(60))

// 追踪激活顺序
const activationOrder: string[] = []

function track(name: string) {
  activationOrder.push(name)
  console.log(`  [${activationOrder.length}] ${name} 激活`)
}

// A 无依赖
class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a', true)
    track('A')
  }
}

// B 依赖 A
class ServiceB extends Service {
  constructor(ctx: Context) {
    super(ctx, 'b', true)
    track('B')
  }
}
ServiceB.inject = ['a']

// C 依赖 B
class ServiceC extends Service {
  constructor(ctx: Context) {
    super(ctx, 'c', true)
    track('C')
  }
}
ServiceC.inject = ['b']

// D 依赖 A 和 C
class ServiceD extends Service {
  constructor(ctx: Context) {
    super(ctx, 'd', true)
    track('D')
  }
}
ServiceD.inject = ['a', 'c']

// E 依赖 D
class ServiceE extends Service {
  constructor(ctx: Context) {
    super(ctx, 'e', true)
    track('E')
  }
}
ServiceE.inject = ['d']

console.log('\n依赖关系：')
console.log('  A ← 无依赖')
console.log('  B ← A')
console.log('  C ← B')
console.log('  D ← A, C')
console.log('  E ← D')

console.log('\n注册顺序（随意）：E, C, B, D, A')
const ctx = new Context()
ctx.plugin(ServiceE)
ctx.plugin(ServiceC)
ctx.plugin(ServiceB)
ctx.plugin(ServiceD)
ctx.plugin(ServiceA)

console.log('\n实际激活顺序：', activationOrder.join(' → '))
console.log('（Cordis 自动按依赖关系排序）')
