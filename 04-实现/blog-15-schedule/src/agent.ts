/**
 * Agent + AgentFactory（dsh: @deepseek-ai/dsh-agent 的简化）
 *
 * Schedule 域需要 Agent 来接收提醒：定时器触发时 `agent.followup(消息)`
 * 把提醒投递到 agent 的 inbox，作为一条用户消息进入下一轮。
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
  private inbox: ContentBlock[] = []
  private running = false
  private idleResolvers: Array<() => void> = []

  constructor(ctx: Context, id: string) {
    this.ctx = ctx
    this.id = id
    this.session = new Session(id)
  }

  /** 投递一条用户消息（dsh: followup）——提醒就靠它进入 agent 下一轮 */
  followup(message: ContentBlock): void {
    this.inbox.push(message)
    void this.drain()
  }

  /** 等到本代理空闲（dsh: whenIdle）——调度循环在 agent 空闲时触发 */
  whenIdle(): Promise<void> {
    if (!this.running && this.inbox.length === 0) return Promise.resolve()
    return new Promise((resolve) => { this.idleResolvers.push(resolve) })
  }

  /** 执行循环（简化：真实是 agent-loop + LLM，blog-07） */
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.inbox.length > 0) {
      const msg = this.inbox.shift()!
      this.session.append({ type: 'user/message', text: msg.text })
      // 模拟 LLM 处理耗时——这期间新 followup 的提醒在 inbox 排队
      const reply = await this.process(msg.text)
      this.session.append({ type: 'assistant/message', text: reply })
    }
    this.running = false
    const resolvers = this.idleResolvers
    this.idleResolvers = []
    for (const r of resolvers) r()
  }

  /** 模拟一次 LLM 调用（真实是模型回复；这里加延迟让"忙时排队"可见） */
  private async process(text: string): Promise<string> {
    await new Promise(r => setTimeout(r, 200))
    return `[${this.id}] 收到提醒并处理: ${text.slice(0, 40)}...`
  }

  /** 当前是否正在执行（忙）——dsh: agent.status === 'busy' 的简化 */
  get busy(): boolean {
    return this.running
  }

  /**
   * 模拟一个正在执行的 turn（dsh: agent 驱动当前 turn）。
   * 期间 followup 的提醒进 inbox 排队，等本 turn 收敛到 idle 才被处理。
   */
  async runTurn(prompt: string, delayMs: number): Promise<void> {
    if (this.running) throw new Error('agent already busy')
    this.running = true
    this.session.append({ type: 'user/message', text: prompt })
    await new Promise(r => setTimeout(r, delayMs))
    this.session.append({ type: 'assistant/message', text: `[${this.id}] 完成 turn: ${prompt.slice(0, 20)}...` })
    this.running = false
    const resolvers = this.idleResolvers
    this.idleResolvers = []
    for (const r of resolvers) r()
    // turn 结束后处理排队中的提醒
    void this.drain()
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
