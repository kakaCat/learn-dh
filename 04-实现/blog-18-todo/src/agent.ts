/**
 * Agent + AgentFactory（dsh: @deepseek-ai/dsh-agent 的简化）
 *
 * Todo 域需要 exec.agent 来决定"列表属于哪个 session"（单 owner）。
 */

import { Context, Service } from '@cordisjs/core'
import { Session } from './session.ts'

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
