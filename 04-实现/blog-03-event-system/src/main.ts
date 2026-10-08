/**
 * 博客3：事件系统
 *
 * 本文包含：
 * - Part 1: 五种事件派发模式 - emit, parallel, serial, bail, waterfall
 * - Part 2: Waterfall 深入 - 短路、修改参数、缓存等高级用法
 */

import { Context } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('博客3：事件系统')
console.log('='.repeat(60))

console.log('\n💡 什么是事件系统？')
console.log('Cordis 提供了强大的事件系统，允许插件之间松耦合地通信。')
console.log('不同的派发模式适用于不同的场景。')

// ============================================================
// Part 1: 五种事件派发模式
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 1: 五种事件派发模式')
console.log('='.repeat(60))

let ctx = new Context()

// ----------------------------------------
// 1. emit - 触发即忘
// ----------------------------------------
console.log('\n📢 1. emit - 触发即忘')
console.log('-'.repeat(40))
console.log('特点：立即返回，不等待监听器完成（包括异步监听器）')

// 注册同步监听器：立即执行完成
ctx.on('user-login', (userId: string) => {
  console.log(`  [同步监听器] 用户 ${userId} 登录`)
})

// 注册异步监听器：emit 不会等待它完成
ctx.on('user-login', async (userId: string) => {
  console.log(`  [异步监听器] 开始发送欢迎邮件...`)
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log(`  [异步监听器] 邮件发送完成（但 emit 不等它）`)
})

console.log('派发 emit...')
// emit：触发所有监听器，但不等待异步监听器完成
// 适用场景：通知类操作，不关心监听器的执行结果
ctx.emit('user-login', 'alice')
console.log('emit 立即返回，异步监听器在后台继续\n')

// 等待一下，让异步监听器完成（仅用于演示）
await new Promise(resolve => setTimeout(resolve, 200))

// ----------------------------------------
// 2. parallel - 并发执行
// ----------------------------------------
console.log('\n🔀 2. parallel - 并发执行')
console.log('-'.repeat(40))
console.log('特点：等待所有监听器完成，监听器并发执行')

// 监听器1：耗时 200ms
ctx.on('save-data', async (data: string) => {
  console.log('  [数据库] 开始保存...')
  await new Promise(resolve => setTimeout(resolve, 200))
  console.log('  [数据库] 完成')
})

// 监听器2：耗时 150ms
ctx.on('save-data', async (data: string) => {
  console.log('  [云存储] 开始备份...')
  await new Promise(resolve => setTimeout(resolve, 150))
  console.log('  [云存储] 完成')
})

// 监听器3：耗时 100ms
ctx.on('save-data', async (data: string) => {
  console.log('  [通知] 开始发送...')
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log('  [通知] 完成')
})

console.log('派发 parallel...')
// parallel：并发执行所有监听器，等待全部完成
// 总耗时 = max(200, 150, 100) = 200ms（而非 450ms）
// 适用场景：多个独立任务需要并发执行（如同时保存到多个地方）
await ctx.parallel('save-data', 'important-data')
console.log('✅ 所有监听器都完成了（并发执行，总耗时约 200ms）\n')

// ----------------------------------------
// 3. serial - 串行执行（可短路）
// ----------------------------------------
console.log('\n➡️  3. serial - 串行执行（可短路）')
console.log('-'.repeat(40))
console.log('特点：监听器按顺序执行，任何监听器返回非空值则停止')

// 处理器1：只能处理 task-a
ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器1] 检查 "${request}"`)
  if (request === 'task-a') {
    console.log('  [处理器1] ✅ 我可以处理')
    return 'handler-1'  // 返回非空值，后续监听器将被跳过
  }
  console.log('  [处理器1] ❌ 不能处理')
  return null  // 返回 null，继续下一个监听器
})

// 处理器2：只能处理 task-b
ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器2] 检查 "${request}"`)
  if (request === 'task-b') {
    console.log('  [处理器2] ✅ 我可以处理')
    return 'handler-2'  // 返回非空值，停止执行
  }
  console.log('  [处理器2] ❌ 不能处理')
  return null
})

// 处理器3：兜底处理器（因为短路机制，可能不会被执行）
ctx.on('find-handler', async (request: string) => {
  console.log(`  [处理器3] 检查 "${request}"`)
  console.log('  [处理器3] ❌ 不能处理')
  return null
})

console.log('派发 serial (task-b)...')
// serial：串行执行，支持短路（遇到非空返回值立即停止）
// 处理器1 返回 null → 继续
// 处理器2 返回 'handler-2' → 停止，处理器3 不会执行
// 适用场景：查找第一个能处理请求的处理器（责任链模式）
const handler = await ctx.serial('find-handler', 'task-b')
console.log(`✅ 找到处理器: ${handler}（处理器3 被跳过）\n`)

// ----------------------------------------
// 4. bail - 同步短路
// ----------------------------------------
console.log('\n🛑 4. bail - 同步短路')
console.log('-'.repeat(40))
console.log('特点：同步执行，遇到非空返回值立即停止（不支持异步）')

// 检查1：普通检查
ctx.on('check-permission', (action: string) => {
  console.log('  [检查1] 检查中...')
  if (action === 'read') return null
  return null  // 继续下一个检查
})

// 检查2：拒绝写入操作
ctx.on('check-permission', (action: string) => {
  if (action === 'write') {
    console.log('  [检查2] 拒绝写入操作')
    return 'denied'  // 返回非空值，立即停止
  }
  return null
})

// 检查3：兜底检查（可能不会执行）
ctx.on('check-permission', (action: string) => {
  console.log('  [检查3] 默认允许')
  return 'allowed'
})

console.log('派发 bail (write)...')
// bail：同步串行执行，支持短路
// 与 serial 的区别：bail 是同步的，不支持 async 监听器
// 检查1 返回 null → 继续
// 检查2 返回 'denied' → 立即停止，检查3 不会执行
// 适用场景：同步的权限检查、验证逻辑
const permission = ctx.bail('check-permission', 'write')
console.log(`✅ 结果: ${permission}（检查3 被跳过）\n`)

// ----------------------------------------
// 5. waterfall - 洋葱模型
// ----------------------------------------
console.log('\n🧅 5. waterfall - 洋葱模型')
console.log('-'.repeat(40))
console.log('特点：中间件模式，每层可以在前后添加逻辑')

// 中间件1：缓存层（最外层）
ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('  [缓存层] 进入 → 检查缓存')
  console.log('  [缓存层] 未命中，调用 next()')
  const result = await next()  // 调用下一层中间件
  console.log('  [缓存层] 返回 ← 保存到缓存')
  return result  // 返回结果给上一层
})

// 中间件2：认证层（中间层）
ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('    [认证层] 进入 → 验证用户')
  console.log('    [认证层] 通过，调用 next()')
  const result = await next()  // 调用下一层
  console.log('    [认证层] 返回 ← 清理信息')
  return result
})

// 中间件3：日志层（最内层）
ctx.on('process-request', async (req: any, next: () => any) => {
  console.log('      [日志层] 进入 → 记录开始')
  console.log('      [日志层] 调用 next()')
  const result = await next()  // 调用核心处理函数
  console.log('      [日志层] 返回 ← 记录完成')
  return result
})

console.log('派发 waterfall...')
// waterfall：洋葱模型（中间件模式）
// 执行顺序：缓存层 → 认证层 → 日志层 → 核心逻辑 → 日志层 → 认证层 → 缓存层
// 每层中间件可以：
//   1. 在调用 next() 之前做前置处理
//   2. 在调用 next() 之后做后置处理
//   3. 修改传递给下一层的参数
//   4. 修改从下一层返回的结果
//   5. 不调用 next() 来短路请求
// 适用场景：HTTP 请求处理、日志、认证、缓存等
const result = await ctx.waterfall('process-request', { url: '/api/data' }, async () => {
  console.log('        [核心] 处理请求')
  return { status: 200, data: 'response' }
})
console.log(`✅ 最终结果: ${JSON.stringify(result)}\n`)

console.log('✅ Part 1 完成！')

// ============================================================
// Part 2: Waterfall 深入
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 2: Waterfall 深入')
console.log('='.repeat(60))

console.log('\n💡 Waterfall 的强大之处')
console.log('Waterfall 不仅可以做中间件，还能实现短路、修改参数、缓存等高级功能。')

// 重新创建 Context
ctx = new Context()

// ----------------------------------------
// 用法1：短路（不调用 next）
// ----------------------------------------
console.log('\n🔌 用法1：短路（权限检查）')
console.log('-'.repeat(40))

// 权限检查中间件：如果权限不足，直接抛出错误，不调用 next()
ctx.on('api/request', async (req: any, next: () => any) => {
  console.log('  [权限检查] 进入')
  if (req.user === 'anonymous') {
    console.log('  [权限检查] ❌ 拒绝（短路，不调用 next）')
    // 不调用 next()，直接抛出错误，后续中间件和核心逻辑都不会执行
    throw new Error('Permission denied')
  }
  console.log('  [权限检查] ✅ 通过')
  return await next()
})

// 业务逻辑中间件（如果权限检查失败，这个中间件不会执行）
ctx.on('api/request', async (req: any, next: () => any) => {
  console.log('  [业务逻辑] 执行')
  return { data: 'sensitive-data' }
})

try {
  // 用匿名用户发起请求，权限检查会短路
  await ctx.waterfall('api/request', { user: 'anonymous' }, async () => {
    console.log('  [核心] 这行不会执行')
    return {}
  })
} catch (error: any) {
  console.log(`  ✅ 错误被捕获: ${error.message}`)
}

// ----------------------------------------
// 用法2：修改参数
// ----------------------------------------
console.log('\n📝 用法2：修改参数')
console.log('-'.repeat(40))

// 转换层1：虽然接收到原始参数，但可以在结果上添加标记
ctx.on('transform', async (data: string, next: () => any) => {
  console.log(`  [转换1] 输入: "${data}"`)
  const modified = data.toUpperCase()
  console.log(`  [转换1] 修改后: "${modified}"`)
  // 注意：这里的修改不会影响下一层的输入（waterfall 不传递修改后的参数）
  // 但可以修改返回结果
  const result = await next()
  return result + ' [layer1]'  // 在结果后添加层级标记
})

// 转换层2：同样接收原始参数
ctx.on('transform', async (data: string, next: () => any) => {
  console.log(`  [转换2] 输入: "${data}"`)
  const modified = data + ' [transformed]'
  console.log(`  [转换2] 修改后: "${modified}"`)
  const result = await next()
  return result + ' [layer2]'  // 在结果后添加层级标记
})

// waterfall 第二个参数会原样传递给所有中间件
// 但中间件可以修改从内层返回的结果
const transformed = await ctx.waterfall('transform', 'hello', async () => {
  console.log('    [核心] 处理')
  return 'result'  // 核心返回 'result'
  // → 转换2 添加 ' [layer2]' → 'result [layer2]'
  // → 转换1 添加 ' [layer1]' → 'result [layer2] [layer1]'
})
console.log(`  ✅ 最终结果: "${transformed}"`)

// ----------------------------------------
// 用法3：缓存
// ----------------------------------------
console.log('\n💾 用法3：缓存')
console.log('-'.repeat(40))

// 创建一个缓存存储
const cache = new Map<string, any>()

// 缓存中间件：在最外层拦截请求
ctx.on('expensive-operation', async (input: string, next: () => any) => {
  const key = `op:${input}`

  // 检查缓存是否命中
  if (cache.has(key)) {
    console.log(`  [缓存] ✅ 命中: ${input}`)
    // 缓存命中，直接返回缓存结果，不调用 next()
    // 这样核心逻辑就不会执行（短路）
    return cache.get(key)
  }

  // 缓存未命中，调用 next() 执行核心逻辑
  console.log(`  [缓存] ❌ 未命中: ${input}`)
  const result = await next()

  // 将结果保存到缓存
  cache.set(key, result)
  console.log(`  [缓存] 💾 已保存: ${input}`)
  return result
})

// 第一次调用（未命中）
console.log('\n第一次调用:')
const r1 = await ctx.waterfall('expensive-operation', 'task-1', async () => {
  console.log('  [核心] ⏳ 执行耗时操作...')
  await new Promise(resolve => setTimeout(resolve, 100))
  return { result: 'computed' }
})
console.log(`  结果: ${JSON.stringify(r1)}`)

// 第二次调用（命中）
console.log('\n第二次调用:')
const r2 = await ctx.waterfall('expensive-operation', 'task-1', async () => {
  // 因为缓存命中，这段代码不会执行
  console.log('  [核心] ⏳ 执行耗时操作...（不会执行）')
  await new Promise(resolve => setTimeout(resolve, 100))
  return { result: 'computed' }
})
console.log(`  结果: ${JSON.stringify(r2)}`)
console.log('  ✅ 缓存命中，核心逻辑被跳过')

console.log('\n✅ Part 2 完成！')

// ============================================================
// Part 3: 清理函数（Effect）
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 3: 清理函数（Effect）')
console.log('='.repeat(60))

console.log('\n💡 为什么需要清理函数？')
console.log('当我们使用事件监听时，如果不移除监听器会导致内存泄漏。')
console.log('Cordis 提供了 ctx.effect() 来自动管理资源清理。')

// ----------------------------------------
// 问题演示：不清理监听器的后果
// ----------------------------------------
console.log('\n⚠️  问题演示：不清理监听器')
console.log('-'.repeat(40))

// 重新创建 Context
ctx = new Context()

// 不正确的插件：注册了监听器但不清理
function leakyPlugin(ctx: Context) {
  console.log('  [插件] 注册了一个事件监听器')
  // 直接注册监听器，没有保存返回的 dispose 函数
  ctx.on('data-update', (data: string) => {
    console.log(`  [监听器] 收到数据: ${data}`)
  })
  // ❌ 问题：插件卸载后，监听器仍然存在于 Context 中
  // 这会导致内存泄漏，而且监听器会继续响应事件
}

console.log('注册插件...')
const fork = ctx.plugin(leakyPlugin)
await fork

console.log('\n派发事件...')
ctx.emit('data-update', 'test-1')

console.log('\n卸载插件...')
await fork.dispose()

console.log('\n再次派发事件...')
ctx.emit('data-update', 'test-2')
console.log('  ❌ 监听器仍然被触发（内存泄漏）')

// ----------------------------------------
// 解决方案：使用 ctx.effect()
// ----------------------------------------
console.log('\n✅ 解决方案：使用 ctx.effect()')
console.log('-'.repeat(40))

// 重新创建 Context
ctx = new Context()

// 正确的插件：使用 ctx.effect() 管理资源
function cleanPlugin(ctx: Context) {
  console.log('  [插件] 使用 ctx.effect() 注册监听器')

  // ctx.effect() 接收一个设置函数
  ctx.effect(() => {
    console.log('  [Effect] 设置事件监听器')

    // 注册监听器，保存返回的 dispose 函数
    const dispose = ctx.on('data-update', (data: string) => {
      console.log(`  [监听器] 收到数据: ${data}`)
    })

    // 返回清理函数
    // 当插件卸载或 Context 销毁时，这个函数会被自动调用
    return () => {
      console.log('  [Effect] 移除事件监听器')
      dispose()  // 调用 dispose 移除监听器
    }
  })

  // 优点：
  // 1. 自动管理资源生命周期
  // 2. 插件卸载时自动清理
  // 3. 避免内存泄漏
}

console.log('\n注册插件...')
const fork2 = ctx.plugin(cleanPlugin)
await fork2

console.log('\n派发事件...')
ctx.emit('data-update', 'test-1')

console.log('\n卸载插件...')
await fork2.dispose()  // 这里会自动调用 effect 的清理函数

console.log('\n再次派发事件...')
ctx.emit('data-update', 'test-2')
console.log('  ✅ 监听器已被移除，不会触发')

// ----------------------------------------
// Effect 的其他用途
// ----------------------------------------
console.log('\n🔧 Effect 的其他用途')
console.log('-'.repeat(40))

// 重新创建 Context
ctx = new Context()

console.log('\n注册多个 effect...')

// Effect 1: 定时器
// ctx.effect() 可以管理任何需要清理的资源
ctx.effect(() => {
  console.log('  [Effect 1] 设置定时器')
  const timer = setInterval(() => {
    console.log('  [定时器] tick')
  }, 500)

  // 返回清理函数：清除定时器
  return () => {
    console.log('  [Effect 1] 清理定时器')
    clearInterval(timer)
  }
})

// Effect 2: 文件监听（模拟）
ctx.effect(() => {
  console.log('  [Effect 2] 打开文件监听')

  // 返回清理函数：关闭文件监听
  return () => {
    console.log('  [Effect 2] 关闭文件监听')
  }
})

// Effect 3: 数据库连接（模拟）
ctx.effect(() => {
  console.log('  [Effect 3] 建立数据库连接')

  // 返回清理函数：关闭数据库连接
  return () => {
    console.log('  [Effect 3] 关闭数据库连接')
  }
})

// 等待一下，让定时器触发几次
await new Promise(resolve => setTimeout(resolve, 1200))

console.log('\n🗑️  销毁 Context...')
console.log('（清理函数按 LIFO 后进先出 顺序执行）\n')

// 销毁 Context 会自动调用所有 effect 的清理函数
// 清理顺序：后注册的先清理（LIFO，类似栈）
// Effect 3 → Effect 2 → Effect 1
await ctx.fiber.dispose()

console.log('\n✅ Part 3 完成！所有资源已清理！')

// ============================================================
// 总结
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('🎊 博客3 全部完成！')
console.log('='.repeat(60))
console.log('\n📝 五种模式对比：')
console.log('  1. emit     - 触发即忘，异步监听器不阻塞')
console.log('  2. parallel - 并发执行，等待所有完成')
console.log('  3. serial   - 串行执行，可短路（异步）')
console.log('  4. bail     - 串行执行，可短路（同步）')
console.log('  5. waterfall- 洋葱模型，中间件模式')
console.log('\n💡 选择建议：')
console.log('  - 通知类场景 → emit')
console.log('  - 多任务并发 → parallel')
console.log('  - 查找处理器 → serial / bail')
console.log('  - 请求处理链 → waterfall')
console.log('\n🧹 资源管理：')
console.log('  - 使用 ctx.effect() 自动清理资源')
console.log('  - 避免内存泄漏（事件监听、定时器等）')
console.log('  - 清理顺序：LIFO（后进先出）')
