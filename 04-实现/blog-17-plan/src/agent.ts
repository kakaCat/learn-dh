/**
 * Agent + AgentFactory（dsh: @deepseek-ai/dsh-agent 的简化）
 *
 * Plan 域需要 Agent 来：接收 /plan 命令的 steer、在 pre-step 应用 pending
 * 选择、经 userQuestions 审批 exit_plan_mode。这里做最小实现。
 */

import { Context, Service } from '@cordisjs/core'
import { Session } from './session.ts'

export interface ContentBlock { type: 'text'; text: string }

declare module '@cordisjs/core' {
  interface Context {
    agents: AgentFactory
  }
}

export class Agent {
  readonly id: string
  readonly session: Session
  readonly ctx: Context

  constructor(ctx: Context, id: string) {
    this.ctx = ctx
    this.id = id
    this.session = new Session(id)
  }

  /** 当前 turn 号（dsh: 从日志找最后一个 turn/start） */
  get turn(): number {
    for (let i = this.session.events.length - 1; i >= 0; i--) {
      const e = this.session.events[i]!
      if (e.type === 'turn/start') return e.turn
    }
    return 0
  }
}

export class AgentFactory extends Service {
  private agents = new Map<string, Agent>()
  constructor(ctx: Context) { super(ctx, 'agents') }
  create(id: string): Agent {
    const agent = new Agent(this.ctx, id)
    this.agents.set(id, agent)
    return agent
  }
  get(id: string): Agent | undefined { return this.agents.get(id) }
}
