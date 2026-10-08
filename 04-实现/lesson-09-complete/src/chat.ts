/**
 * 交互式聊天
 *
 * 简单的命令行交互界面
 */

import { Context } from '@cordisjs/core'
import * as readline from 'readline'

// 这里复用 lesson-08 的代码结构
// 实际使用时可以直接 import

console.log('='.repeat(60))
console.log('交互式聊天')
console.log('='.repeat(60))
console.log('\n输入消息开始对话，输入 "exit" 退出\n')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '👤 You: ',
})

// 初始化系统（简化版）
const ctx = new Context()
// ... 注册服务（省略，参考 main.ts）

console.log('🤖 Assistant: Hello! How can I help you?')

rl.prompt()

rl.on('line', async (input) => {
  const trimmed = input.trim()

  if (trimmed === 'exit') {
    console.log('\n👋 Goodbye!')
    rl.close()
    return
  }

  if (trimmed === 'help') {
    console.log('\n可用命令:')
    console.log('  exit  - 退出')
    console.log('  help  - 显示帮助')
    console.log('  clear - 清屏')
    rl.prompt()
    return
  }

  if (trimmed === 'clear') {
    console.clear()
    rl.prompt()
    return
  }

  // 处理用户输入
  console.log(`\n🤖 Assistant: I received "${trimmed}"`)
  console.log('   (这里是简化的回复，实际应该调用 LLM)\n')

  rl.prompt()
})

rl.on('close', () => {
  process.exit(0)
})
