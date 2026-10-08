/**
 * Agent + AgentFactory（dsh: @deepseek-ai/dsh-agent 的简化）
 *
 * goal 主题需要：live-agent 校验（assertLive）、当前回合窗口（turn/start
 * 边界）、roots（直接人类输入只认顶层 agent）。status 用于简化 authority
 * 检查（running/idle）。
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
  status: 'running' | 'idle' = 'idle'

  constructor(ctx: Context, id: string) {
    this.ctx = ctx
    this.id = id
    this.session = new Session(id)
  }

  /** 开一轮（简化：标记 running + 写 turn/start，用于 authority 与续跑演示） */
  startTurn(): void {
    this.status = 'running'
    this.session.append({ type: 'turn/start', turn: this.turnCount() + 1 })
  }

  /** 关一轮（写 turn/end） */
  endTurn(reason = 'completed'): void {
    this.session.append({ type: 'turn/end', turn: this.turnCount(), reason: { kind: reason } })
    this.status = 'idle'
  }

  private turnCount(): number {
    return this.session.events.filter(e => e.type === 'turn/start').length
  }
}

export class AgentFactory extends Service {
  private agents = new Map<string, Agent>()
  private created: Agent[] = []
  constructor(ctx: Context) { super(ctx, 'agents') }

  create(id: string): Agent {
    const agent = new Agent(this.ctx, id)
    this.agents.set(id, agent)
    this.created.push(agent)
    this.ctx.emit('agent/session-start', { agent })
    return agent
  }

  get(id: string): Agent | undefined { return this.agents.get(id) }

  /** 顶层 agent（简化：全部已创建 agent 视为 root） */
  roots(): Agent[] { return this.created }
}

declare module '@cordisjs/core' {
  interface Events {
    'agent/session-start'(payload: { agent: Agent }): void
  }
}
