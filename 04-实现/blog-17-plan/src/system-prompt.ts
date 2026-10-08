/**
 * 简化 systemPrompt 服务（dsh: @deepseek-ai/dsh-system-prompt 的简化，blog-09 讲过）
 *
 * Plan 域用它注册 plan:policy 片段（order 50）：
 * - section(): 注册有序提示片段（order 升序拼接）
 * - assemble(): 组装完整 system prompt——所有片段按 order 排序、text 按 agent 求值、拼接
 */

import { Context, Service } from '@cordisjs/core'
import type { Agent } from './agent.ts'

declare module '@cordisjs/core' {
  interface Context {
    systemPrompt: SystemPromptService
  }
}

/** 组装上下文（简化：只要 agent——plan:policy 按它的状态求值） */
export interface AssembleContext {
  agent?: Agent
}

/** 一段提示词片段（dsh: PromptSection） */
export interface PromptSection {
  name: string
  order: number   // 升序拼接；-100 harness 身份，0 persona，50 plan:policy...
  text: string | ((context: AssembleContext) => string)
}

export class SystemPromptService extends Service {
  private sections = new Map<string, PromptSection>()

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
    // 内置两个片段：harness 身份 + persona（简化）
    this.section({ name: 'harness', order: -100, text: 'You are DeepSeek Harness, an agentic coding tool.' })
    this.section({ name: 'persona', order: 0, text: 'You are a helpful engineering assistant.' })
  }

  /** 注册一个有序提示片段（dsh: section） */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    if (this.sections.has(section.name)) {
      throw new Error(`prompt section "${section.name}" is already registered`)
    }
    this.sections.set(section.name, section)
    return () => { this.sections.delete(section.name) }
  }

  /**
   * 组装完整 system prompt（dsh: assemble）：
   * 1. 所有片段按 order 升序
   * 2. text 若是函数，按 context（agent）求值
   * 3. 拼接成最终提示词
   */
  assemble(context: AssembleContext = {}): string {
    const ordered = [...this.sections.values()].sort((a, b) => a.order - b.order)
    const parts = ordered.map((s) => {
      const text = typeof s.text === 'function' ? s.text(context) : s.text
      return text.trim() === '' ? null : `${s.name}:\n${text}`
    }).filter((p): p is string => p !== null)
    return parts.join('\n\n')
  }

  /** 组装时各片段贡献了什么（调试/教学用） */
  assembleDetail(context: AssembleContext = {}): Array<{ name: string; order: number; text: string }> {
    const ordered = [...this.sections.values()].sort((a, b) => a.order - b.order)
    return ordered.map((s) => ({
      name: s.name,
      order: s.order,
      text: typeof s.text === 'function' ? s.text(context) : s.text,
    }))
  }
}
