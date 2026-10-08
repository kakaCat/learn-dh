/**
 * 简化工具注册表 + userQuestions 通道（dsh: dsh-tools + dsh-user-questions 的简化）
 *
 * Plan 域的 exit_plan_mode 工具注册在 ctx.tools；审批走 ctx.userQuestions
 * （blog-13 的提问服务，这里最小化为一个可注入的 answerer）。
 */

import { Context, Service } from '@cordisjs/core'
import type { Agent } from './agent.ts'

declare module '@cordisjs/core' {
  interface Context {
    tools: ToolRegistry
    userQuestions: UserQuestions
  }
}

export interface ToolDef {
  name: string
  description: string
  execute: (args: any, exec: { agent?: Agent; signal?: AbortSignal }) => Promise<any>
}

export class ToolRegistry extends Service {
  private tools = new Map<string, ToolDef>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(tool: ToolDef): void { this.tools.set(tool.name, tool) }
  async invoke(name: string, args: any, exec: { agent?: Agent; signal?: AbortSignal } = {}): Promise<any> {
    const tool = this.tools.get(name)
    if (tool === undefined) throw new Error(`tool "${name}" not registered`)
    return tool.execute(args, exec)
  }
}

/** 极简 userQuestions：一个可注入的回答者（真实 dsh 是 provider 模式，blog-13） */
export interface UserQuestion {
  id: string
  question: string
  detail?: string
  options: Array<{ label: string; description?: string }>
}
export interface UserQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

export class UserQuestions extends Service {
  private answerer: ((q: UserQuestion) => Promise<UserQuestionAnswer>) | null = null
  constructor(ctx: Context) { super(ctx, 'userQuestions') }
  setAnswerer(answerer: (q: UserQuestion) => Promise<UserQuestionAnswer>): void {
    this.answerer = answerer
  }
  async ask(request: { questions: UserQuestion[]; agent?: Agent; signal?: AbortSignal }): Promise<UserQuestionAnswer> {
    if (this.answerer === null) throw new Error('no user-questions answerer registered')
    if (request.questions.length !== 1) throw new Error('plan review requires exactly one question')
    return this.answerer(request.questions[0]!)
  }
}
