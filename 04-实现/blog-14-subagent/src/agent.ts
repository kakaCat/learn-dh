/**
 * Agent 类 + AgentFactory（dsh: @deepseek-ai/dsh-agent 的简化）
 *
 * 每个 Agent 有：自己的 Session + 自己的 systemPrompt + 消息收发 + 执行循环。
 * 父代理和子代理是同一个类——"子代理"只是"在委托时被创建的新 Agent"。
 */

import { Context, Service } from '@cordisjs/core'
import { Session } from './session.ts'
import type { ContentBlock } from './types.ts'

declare module '@cordisjs/core' {
  interface Context {
    agents: AgentFactory
  }
}

// ---- Agent：同进程代理（dsh: Agent）----
export class Agent {
  readonly id: string
  readonly session: Session
  /** 创建它的 context（dsh: agent.ctx——agents.create 绑定） */
  readonly ctx: Context
  /** 组装好的 system prompt（own system prompt，dsh: systemPrompt 域） */
  systemPrompt: string[] = []
  private inbox: ContentBlock[] = []                 // 简化 inbox（dsh: agent inbox）
  private running = false
  private idleResolvers: Array<() => void> = []

  constructor(ctx: Context, id: string) {
    this.ctx = ctx
    this.id = id
    this.session = new Session(id)
  }

  /** 父 → 子：投递一条用户消息（dsh: followup）——FIFO 入队 + 唤醒执行 */
  followup(message: ContentBlock): void {
    this.inbox.push(message)
    void this.drain()
  }

  /** 等到本代理空闲（dsh: whenIdle）——父等待子代理跑完用 */
  whenIdle(): Promise<void> {
    if (!this.running && this.inbox.length === 0) return Promise.resolve()
    return new Promise((resolve) => { this.idleResolvers.push(resolve) })
  }

  /** 执行循环（简化：真实是 agent-loop + LLM，blog-07）——模拟模型按 system prompt 回复 */
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.inbox.length > 0) {
      const msg = this.inbox.shift()!
      this.session.append({ type: 'user/message', text: msg.text })
      const reply = this.reply(msg.text)
      this.session.append({ type: 'assistant/message', text: reply })
    }
    this.running = false
    const resolvers = this.idleResolvers
    this.idleResolvers = []
    for (const r of resolvers) r()
  }

  /** 模拟模型回复：体现 system prompt 的影响（persona + delegation 声明） */
  private reply(text: string): string {
    const persona = this.systemPrompt.find(p => p.startsWith('Persona:'))?.slice(8).trim()
    const isDelegated = this.systemPrompt.some(p => p.includes('delegated subagent'))
    const head = persona ? `[${persona}]` : `[${this.id}]`
    return `${head} 收到任务「${text.slice(0, 20)}...」，${isDelegated ? '按固定权限' : ''}完成并返回结果。`
  }
}

// ---- Agent 工厂（dsh: ctx.agents.create）----
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
