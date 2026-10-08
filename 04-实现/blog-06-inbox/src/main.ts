/**
 * 博客6：Inbox 模块 - 消息队列与任务管理
 *
 * 本文包含：
 * - Part 1: Inbox 基础 - 消息队列
 * - Part 2: 优先级处理 - 按优先级排序
 * - Part 3: 失败重试 - 自动重试机制
 * - Part 4: 批量处理 - 自动处理循环
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('博客6：Inbox 模块')
console.log('='.repeat(60))

// ============================================================
// Part 1: Inbox 基础 - 消息队列
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 1: Inbox 基础')
console.log('='.repeat(60))

console.log('\n💡 什么是 Inbox？')
console.log('Inbox 是一个消息队列系统，用于管理异步任务、延迟执行、优先级处理等。')
console.log('支持消息的入队、出队、过滤、批量处理等功能。')

// ----------------------------------------
// 类型定义
// ----------------------------------------

interface InboxMessage<T = any> {
  id: string
  type: string
  payload: T
  priority: number
  timestamp: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  retries: number
  maxRetries: number
  error?: string
}

interface InboxOptions {
  maxSize?: number
  defaultPriority?: number
  defaultMaxRetries?: number
}

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Events {
    'inbox/message': (message: InboxMessage) => void
    'inbox/processed': (message: InboxMessage) => void
    'inbox/failed': (message: InboxMessage, error: Error) => void
  }

  interface Context {
    inbox: InboxService
  }
}

// ----------------------------------------
// Inbox Service 实现
// ----------------------------------------

class InboxService extends Service {
  private messages: InboxMessage[] = []
  private counter = 0  // 自增计数器，生成唯一消息 ID
  private processing = false
  private options: Required<InboxOptions>

  constructor(ctx: Context, options: InboxOptions = {}) {
    super(ctx, 'inbox')
    this.options = {
      maxSize: options.maxSize ?? 1000,
      defaultPriority: options.defaultPriority ?? 0,
      defaultMaxRetries: options.defaultMaxRetries ?? 3,
    }
  }

  /** 生成唯一消息 ID：自增 msg-<n> */
  private mintId(): string {
    return `msg-${++this.counter}`
  }

  /**
   * 发送消息到 inbox
   */
  send<T = any>(type: string, payload: T, priority?: number): InboxMessage<T> {
    if (this.messages.length >= this.options.maxSize) {
      throw new Error('Inbox is full')
    }

    const message: InboxMessage<T> = {
      id: this.mintId(),
      type,
      payload,
      priority: priority ?? this.options.defaultPriority,
      timestamp: Date.now(),
      status: 'pending',
      retries: 0,
      maxRetries: this.options.defaultMaxRetries,
    }

    this.messages.push(message)
    this.messages.sort((a, b) => b.priority - a.priority) // 按优先级排序

    console.log(`  📨 收到消息: ${type} (优先级: ${message.priority})`)
    this.ctx.emit('inbox/message', message)

    return message
  }

  /**
   * 获取下一条待处理的消息
   */
  next(): InboxMessage | undefined {
    return this.messages.find(m => m.status === 'pending')
  }

  /**
   * 按类型过滤消息
   */
  filter(type: string): InboxMessage[] {
    return this.messages.filter(m => m.type === type)
  }

  /**
   * 获取所有消息
   */
  list(): InboxMessage[] {
    return [...this.messages]
  }

  /**
   * 标记消息为已完成
   */
  complete(messageId: string): void {
    const message = this.messages.find(m => m.id === messageId)
    if (message) {
      message.status = 'completed'
      console.log(`  ✅ 消息已完成: ${message.type}`)
      this.ctx.emit('inbox/processed', message)
    }
  }

  /**
   * 标记消息为失败
   */
  fail(messageId: string, error: Error): void {
    const message = this.messages.find(m => m.id === messageId)
    if (!message) return

    message.retries++
    message.error = error.message

    if (message.retries >= message.maxRetries) {
      message.status = 'failed'
      console.log(`  ❌ 消息失败（已达最大重试次数）: ${message.type}`)
      this.ctx.emit('inbox/failed', message, error)
    } else {
      message.status = 'pending'
      console.log(`  🔄 消息重试 (${message.retries}/${message.maxRetries}): ${message.type}`)
    }
  }

  /**
   * 处理消息（手动处理单条）
   */
  async process(
    messageId: string,
    handler: (message: InboxMessage) => Promise<void>
  ): Promise<void> {
    const message = this.messages.find(m => m.id === messageId)
    if (!message || message.status !== 'pending') return

    message.status = 'processing'

    try {
      await handler(message)
      this.complete(messageId)
    } catch (error: any) {
      this.fail(messageId, error)
    }
  }

  /**
   * 启动自动处理循环
   */
  async startProcessing(
    handler: (message: InboxMessage) => Promise<void>
  ): Promise<void> {
    if (this.processing) return
    this.processing = true

    console.log('  🔄 启动自动处理循环...')

    while (this.processing) {
      const message = this.next()
      if (message) {
        await this.process(message.id, handler)
      } else {
        // 没有待处理消息，等待一段时间
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }

  /**
   * 停止自动处理
   */
  stopProcessing(): void {
    this.processing = false
    console.log('  ⏹️  停止自动处理')
  }

  /**
   * 清理已完成和失败的消息
   */
  cleanup(): void {
    const before = this.messages.length
    this.messages = this.messages.filter(
      m => m.status !== 'completed' && m.status !== 'failed'
    )
    const removed = before - this.messages.length
    console.log(`  🗑️  清理了 ${removed} 条消息`)
  }

  /**
   * 获取统计信息
   */
  stats(): Record<string, number> {
    return {
      total: this.messages.length,
      pending: this.messages.filter(m => m.status === 'pending').length,
      processing: this.messages.filter(m => m.status === 'processing').length,
      completed: this.messages.filter(m => m.status === 'completed').length,
      failed: this.messages.filter(m => m.status === 'failed').length,
    }
  }
}

// ----------------------------------------
// 演示：使用 Inbox
// ----------------------------------------

let ctx = new Context()
// ctx.plugin() 是异步的，需要 await 等待服务激活
await ctx.plugin(InboxService, { maxSize: 100 })

// 监听 inbox 事件
console.log('\n👂 设置 Inbox 事件监听...')
ctx.on('inbox/message', (message) => {
  console.log(`  [事件] 新消息: ${message.type} (ID: ${message.id})`)
})

ctx.on('inbox/processed', (message) => {
  console.log(`  [事件] 消息已处理: ${message.type}`)
})

ctx.on('inbox/failed', (message, error) => {
  console.log(`  [事件] 消息失败: ${message.type} - ${error.message}`)
})

// 发送消息
console.log('\n📨 发送消息...')

ctx.inbox.send('user/message', { text: 'Hello!' }, 1)
ctx.inbox.send('tool/call', { name: 'calculator', args: { a: 1, b: 2 } }, 5)
ctx.inbox.send('system/notification', { message: 'System update' }, 0)
ctx.inbox.send('user/message', { text: 'How are you?' }, 1)

// 查看统计
console.log('\n📊 Inbox 统计:')
const stats1 = ctx.inbox.stats()
for (const [key, value] of Object.entries(stats1)) {
  console.log(`  ${key}: ${value}`)
}

console.log('\n✅ Part 1 完成！')

// ============================================================
// Part 2: 优先级处理
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 2: 优先级处理')
console.log('='.repeat(60))

console.log('\n💡 优先级队列')
console.log('消息按优先级排序，优先级高的消息先处理。')

// 手动处理消息
console.log('\n🔧 手动处理消息（按优先级）...')

const nextMsg = ctx.inbox.next()
if (nextMsg) {
  console.log(`  处理: ${nextMsg.type} (优先级: ${nextMsg.priority})`)
  await ctx.inbox.process(nextMsg.id, async (msg) => {
    console.log(`  执行: ${JSON.stringify(msg.payload)}`)
    // 模拟处理
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

// 按类型过滤
console.log('\n🔍 按类型过滤消息...')
const userMessages = ctx.inbox.filter('user/message')
console.log(`  找到 ${userMessages.length} 条 user/message`)
for (const msg of userMessages) {
  console.log(`    - ${msg.payload.text} (优先级: ${msg.priority})`)
}

console.log('\n✅ Part 2 完成！')

// ============================================================
// Part 3: 失败重试
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 3: 失败重试')
console.log('='.repeat(60))

console.log('\n💡 自动重试机制')
console.log('消息处理失败后会自动重试，最多重试 3 次。')

// 模拟失败和重试
console.log('\n❌ 测试失败重试...')

const failMsg = ctx.inbox.send('test/fail', { value: 'test' })
let attempts = 0

// 第一次尝试
await ctx.inbox.process(failMsg.id, async () => {
  attempts++
  console.log(`  尝试 ${attempts}...`)
  throw new Error('模拟失败')
})

// 第二次尝试
const retry1Msg = ctx.inbox.next()
if (retry1Msg && retry1Msg.id === failMsg.id) {
  await ctx.inbox.process(retry1Msg.id, async () => {
    attempts++
    console.log(`  尝试 ${attempts}...`)
    throw new Error('模拟失败')
  })
}

// 第三次尝试
const retry2Msg = ctx.inbox.next()
if (retry2Msg && retry2Msg.id === failMsg.id) {
  await ctx.inbox.process(retry2Msg.id, async () => {
    attempts++
    console.log(`  尝试 ${attempts}...`)
    throw new Error('模拟失败')
  })
}

// 查看最终状态
console.log('\n📊 重试后统计:')
const stats2 = ctx.inbox.stats()
for (const [key, value] of Object.entries(stats2)) {
  console.log(`  ${key}: ${value}`)
}

console.log('\n✅ Part 3 完成！')

// ============================================================
// Part 4: 批量处理和清理
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('Part 4: 批量处理和清理')
console.log('='.repeat(60))

console.log('\n💡 批量处理')
console.log('可以启动自动处理循环，持续处理队列中的消息。')

// 清理已完成和失败的消息
console.log('\n🗑️  清理消息...')
ctx.inbox.cleanup()

console.log('\n📊 清理后统计:')
const stats3 = ctx.inbox.stats()
for (const [key, value] of Object.entries(stats3)) {
  console.log(`  ${key}: ${value}`)
}

// 演示批量处理
console.log('\n🔄 批量处理演示...')

// 发送一批消息
for (let i = 1; i <= 5; i++) {
  ctx.inbox.send('batch/task', { taskId: i }, Math.floor(Math.random() * 10))
}

console.log('\n  开始批量处理...')
let processedCount = 0

// 处理所有待处理的消息
while (ctx.inbox.next()) {
  const msg = ctx.inbox.next()
  if (msg) {
    await ctx.inbox.process(msg.id, async (message) => {
      processedCount++
      console.log(`  处理任务 ${message.payload.taskId}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    })
  }
}

console.log(`\n  ✅ 批量处理完成，共处理 ${processedCount} 条消息`)

console.log('\n📊 最终统计:')
const stats4 = ctx.inbox.stats()
for (const [key, value] of Object.entries(stats4)) {
  console.log(`  ${key}: ${value}`)
}

console.log('\n✅ Part 4 完成！')

// ============================================================
// 总结
// ============================================================

console.log('\n' + '='.repeat(60))
console.log('🎊 博客6 完成！')
console.log('='.repeat(60))
console.log('\n📝 核心概念：')
console.log('  1. 消息队列 - 发送、接收、过滤')
console.log('  2. 优先级处理 - 高优先级消息先处理')
console.log('  3. 失败重试 - 自动重试最多 3 次')
console.log('  4. 批量处理 - 自动处理循环')
console.log('  5. 状态管理 - pending/processing/completed/failed')
console.log('\n💡 实际应用：')
console.log('  - 异步任务管理')
console.log('  - 消息队列和延迟执行')
console.log('  - 后台任务调度')
console.log('  - 事件驱动架构')
