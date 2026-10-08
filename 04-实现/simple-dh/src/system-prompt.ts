/**
 * System Prompt 模块
 *
 * 组装提示词片段和工具 schemas
 */

import { Context, Service } from '@cordisjs/core'

// ==================== 类型定义 ====================

export interface PromptSection {
  name: string
  content: string
  priority?: number
  condition?: () => boolean
}

// ==================== 扩展 Cordis 类型 ====================

declare module '@cordisjs/core' {
  interface Context {
    systemPrompt: SystemPromptService
  }
}

// ==================== SystemPrompt Service ====================

export class SystemPromptService extends Service {
  private sections = new Map<string, PromptSection>()

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt', true)
  }

  /**
   * 添加提示词片段
   */
  addSection(section: PromptSection) {
    return this.ctx.effect(() => {
      this.sections.set(section.name, section)

      return () => {
        this.sections.delete(section.name)
      }
    })
  }

  /**
   * 移除片段
   */
  removeSection(name: string): void {
    this.sections.delete(name)
  }

  /**
   * 构建完整的 system prompt
   */
  build(): string {
    const sections = Array.from(this.sections.values())

    // 过滤条件片段
    const active = sections.filter(s => !s.condition || s.condition())

    // 按优先级排序
    active.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))

    // 拼接内容
    return active.map(s => s.content).join('\n\n')
  }

  /**
   * 获取工具 schemas（委托给 tools 服务）
   */
  getToolSchemas() {
    if (this.ctx.tools) {
      return this.ctx.tools.getSchemas()
    }
    return []
  }
}

/**
 * 应用插件
 */
export function apply(ctx: Context) {
  ctx.plugin(SystemPromptService)

  // 注册基础片段
  ctx.systemPrompt.addSection({
    name: 'identity',
    content: 'You are a helpful AI assistant.',
    priority: 0,
  })

  ctx.systemPrompt.addSection({
    name: 'tools-instruction',
    content: 'You have access to tools. Use them when appropriate to help the user.',
    priority: 20,
    condition: () => ctx.tools?.list().length > 0,
  })

  ctx.systemPrompt.addSection({
    name: 'safety',
    content: 'Always be helpful, harmless, and honest.',
    priority: 90,
  })
}
