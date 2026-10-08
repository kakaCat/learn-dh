/**
 * 使用示例
 */

import { create } from './index'

async function main() {
  console.log('='.repeat(60))
  console.log('Simple DH - Example')
  console.log('='.repeat(60))

  // 创建 Context
  const ctx = create()

  // 注册一些示例工具
  console.log('\n📦 Registering tools...')

  ctx.tools.register('echo', {
    description: 'Echo back the input text',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo' },
      },
      required: ['text'],
    },
    async execute(args) {
      return `Echo: ${args.text}`
    },
  })

  ctx.tools.register('add', {
    description: 'Add two numbers',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
    async execute(args) {
      return (args.a as number) + (args.b as number)
    },
  })

  console.log(`✅ Registered tools: ${ctx.tools.list().join(', ')}`)

  // 监听 session 事件
  console.log('\n👂 Setting up event listeners...')

  ctx.on('session/event', (sessionId, event) => {
    console.log(`[${sessionId.slice(0, 6)}] ${event.type}`, event)
  })

  // 创建 Session
  console.log('\n🎯 Creating session...')
  const session = ctx.sessions.create()
  console.log(`✅ Session created: ${session.id}`)

  // 创建 Agent
  console.log('\n🤖 Creating agent...')
  const agent = ctx.agentLoop.create(session.id)
  console.log(`✅ Agent created for session: ${agent.sessionId}`)

  // 测试1: 普通对话
  console.log('\n' + '='.repeat(60))
  console.log('Test 1: Normal conversation')
  console.log('='.repeat(60))

  await ctx.agentLoop.runTurn(agent, 'Hello!')

  // 测试2: 调用工具 - echo
  console.log('\n' + '='.repeat(60))
  console.log('Test 2: Tool call - echo')
  console.log('='.repeat(60))

  await ctx.agentLoop.runTurn(agent, 'Can you echo something?')

  // 测试3: 调用工具 - add
  console.log('\n' + '='.repeat(60))
  console.log('Test 3: Tool call - add')
  console.log('='.repeat(60))

  await ctx.agentLoop.runTurn(agent, 'Can you add some numbers?')

  // 打印最终的 session 事件
  console.log('\n' + '='.repeat(60))
  console.log('Final Session Events')
  console.log('='.repeat(60))

  const events = ctx.sessions.getEvents(session.id)
  console.log(`Total events: ${events.length}`)

  // 打印统计
  const eventTypes = events.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  console.log('\nEvent statistics:')
  for (const [type, count] of Object.entries(eventTypes)) {
    console.log(`  ${type}: ${count}`)
  }

  console.log('\n' + '='.repeat(60))
  console.log('Done!')
  console.log('='.repeat(60))
}

main().catch(console.error)
