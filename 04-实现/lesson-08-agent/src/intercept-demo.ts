/**
 * 拦截点演示
 *
 * 展示 agent/pre-step、agent/request、agent/turn-stopping
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('拦截点演示')
console.log('='.repeat(60))

interface Agent {
  sessionId: string
  ctx: Context
  status: string
}

declare module '@cordisjs/core' {
  interface Events {
    'agent/pre-step': (messages: any[], next: () => Promise<void>) => Promise<void>
    'agent/request': (request: any, next: () => Promise<any>) => Promise<any>
    'agent/turn-stopping': (agent: Agent) => Promise<void>
  }
}

const ctx = new Context()

// ============================================================
// 拦截点1: pre-step
// ============================================================

console.log('\n🔍 拦截点1: agent/pre-step')
console.log('-'.repeat(40))

// 安全过滤
ctx.on('agent/pre-step', async (messages, next) => {
  console.log('  [安全过滤] 检查消息...')
  for (const msg of messages) {
    if (msg.content?.includes('bad')) {
      console.log('  [安全过滤] ❌ 拒绝消息')
      throw new Error('Message rejected')
    }
  }
  console.log('  [安全过滤] ✅ 通过')
  await next()
})

// 添加上下文
ctx.on('agent/pre-step', async (messages, next) => {
  console.log('  [上下文] 添加系统信息...')
  messages.unshift({
    role: 'system',
    content: `Current time: ${new Date().toISOString()}`,
  })
  console.log('  [上下文] ✅ 已添加')
  await next()
})

// ============================================================
// 拦截点2: request
// ============================================================

console.log('\n🔍 拦截点2: agent/request')
console.log('-'.repeat(40))

// 缓存
const cache = new Map<string, any>()

ctx.on('agent/request', async (request, next) => {
  const key = JSON.stringify(request.messages)
  if (cache.has(key)) {
    console.log('  [缓存] 命中！直接返回')
    return cache.get(key)
  }
  console.log('  [缓存] 未命中，调用 LLM...')
  const result = await next()
  cache.set(key, result)
  console.log('  [缓存] 已保存')
  return result
})

// 修改请求
ctx.on('agent/request', async (request, next) => {
  console.log('  [修改] 设置 temperature = 0.7')
  request.temperature = 0.7
  return await next()
})

// 日志
ctx.on('agent/request', async (request, next) => {
  console.log(`  [日志] 请求消息数: ${request.messages.length}`)
  const result = await next()
  console.log(`  [日志] 响应内容长度: ${result.content?.length ?? 0}`)
  return result
})

// ============================================================
// 拦截点3: turn-stopping
// ============================================================

console.log('\n🔍 拦截点3: agent/turn-stopping')
console.log('-'.repeat(40))

// 统计
ctx.on('agent/turn-stopping', async (agent) => {
  console.log('  [统计] Turn 即将结束')
  console.log(`    Session: ${agent.sessionId}`)
  console.log(`    状态: ${agent.status}`)
})

// 检查目标
ctx.on('agent/turn-stopping', async (agent) => {
  console.log('  [目标检查] 检查是否完成...')
  console.log('  [目标检查] ✅ 可以继续')
})

console.log('\n✅ 拦截点已设置')
console.log('\n这些拦截点会在 Agent Loop 中被调用')
