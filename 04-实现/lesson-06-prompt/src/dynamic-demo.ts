/**
 * 动态 Prompt 演示
 *
 * 展示条件片段和动态内容
 */

import { Context, Service } from '@cordisjs/core'

console.log('='.repeat(60))
console.log('动态 Prompt 演示')
console.log('='.repeat(60))

interface PromptSection {
  name: string
  content: string
  priority?: number
  condition?: () => boolean
}

class SystemPromptService extends Service {
  private sections = new Map<string, PromptSection>()

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt', true)
  }

  addSection(section: PromptSection) {
    this.sections.set(section.name, section)
  }

  build(): string {
    const sections = Array.from(this.sections.values())
    const active = sections.filter(s => !s.condition || s.condition())
    active.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
    return active.map(s => s.content).join('\n\n')
  }
}

declare module '@cordisjs/core' {
  interface Context {
    systemPrompt: SystemPromptService
    env: { mode: string; user?: string }
  }
}

const ctx = new Context()
ctx.plugin(SystemPromptService)

// 模拟环境
ctx.env = { mode: 'development', user: 'alice' }

// ============================================================
// 条件片段演示
// ============================================================

console.log('\n📋 场景1: 开发模式')
ctx.env.mode = 'development'

ctx.systemPrompt.addSection({
  name: 'identity',
  content: 'You are a helpful assistant.',
  priority: 0,
})

ctx.systemPrompt.addSection({
  name: 'debug-mode',
  content: 'Debug mode is enabled. Provide verbose output with detailed explanations.',
  priority: 10,
  condition: () => ctx.env.mode === 'development',
})

ctx.systemPrompt.addSection({
  name: 'production-mode',
  content: 'Production mode. Be concise and efficient.',
  priority: 10,
  condition: () => ctx.env.mode === 'production',
})

ctx.systemPrompt.addSection({
  name: 'user-context',
  content: `Current user: ${ctx.env.user || 'anonymous'}`,
  priority: 20,
})

ctx.systemPrompt.addSection({
  name: 'safety',
  content: 'Always be helpful and honest.',
  priority: 90,
})

console.log(ctx.systemPrompt.build())

console.log('\n' + '-'.repeat(60))

// ============================================================
// 场景2: 生产模式
// ============================================================

console.log('\n📋 场景2: 生产模式')
ctx.env.mode = 'production'
console.log(ctx.systemPrompt.build())

console.log('\n' + '-'.repeat(60))

// ============================================================
// 场景3: 无用户
// ============================================================

console.log('\n📋 场景3: 无用户')
ctx.env.mode = 'development'
ctx.env.user = undefined
console.log(ctx.systemPrompt.build())

console.log('\n✅ 完成！')
