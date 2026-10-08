/**
 * 博客7：Loop 模块 - Agent 执行循环（ReactLoopAgent）
 *
 * 按 dsh 源码（packages/core/agent-loop）结构实现：
 * - ReactLoopAgent: kick() → while(turn()) → turn 内多个 step
 * - step: LLM 请求 → assistant 消息 → 有工具调用则执行 → 循环直到完成
 * - Inbox: next-turn / next-step 双队列，preStep 时 claim
 * - 所有事件写入 Session（turn/start、step/start、tool/call ...）
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 1. Session：简化版（事件日志 + 消息投影）
// ============================================================

// 事件日志：Agent 循环的每一步都是事件（每个事件带 seq 单调序列号）
type SessionEvent =
  | { type: 'turn/start'; seq: number; turn: number; timestamp: number }                    // 一轮对话开始
  | { type: 'turn/end'; seq: number; turn: number; reason: TurnEndReason; timestamp: number }  // 一轮对话结束（带原因）
  | { type: 'step/start'; seq: number; turn: number; step: number; timestamp: number }      // 一个步骤开始
  | { type: 'step/end'; seq: number; turn: number; step: number; timestamp: number }        // 一个步骤结束
  | { type: 'user/message'; seq: number; content: string; timestamp: number }               // 用户消息
  | { type: 'assistant/message'; seq: number; content: string; toolCalls?: ToolCall[]; timestamp: number }  // 助手消息（可带工具调用）
  | { type: 'tool/call'; seq: number; turn: number; step: number; callId: string; name: string; arguments: string; timestamp: number }  // 工具调用
  | { type: 'tool/result'; seq: number; turn: number; step: number; callId: string; content: string; isError: boolean; timestamp: number }  // 工具结果

// 追加事件时不需要填 seq，由 append 自动分配
type SessionEventInput = SessionEvent extends infer E ? Omit<E, 'seq'> : never

interface Session {
  id: string
  events: SessionEvent[]
  append(input: SessionEventInput): SessionEvent
  deriveMessages(): Message[]
}

// 模型发出的工具调用：id + 工具名 + 参数 JSON 字符串
interface ToolCall {
  id: string
  name: string
  arguments: string
}

// turn 为什么结束：completed 正常完成 / blocked 无输入被拒 / error 出错 / aborted 取消 / max-tokens 超上限
type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'blocked' }
  | { kind: 'error'; error: string }
  | { kind: 'aborted' }
  | { kind: 'max-tokens' }

// OpenAI 风格消息（Surface 投影）
interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

// 简化版 Session：事件日志 + 消息投影
class SimpleSession implements Session {
  readonly id: string
  readonly events: SessionEvent[] = []  // 事件数组（append-only，只追加）

  constructor(id: string) {
    this.id = id
  }

  // 追加事件：自动分配 seq（等于当前事件数，从 0 连续递增）
  append(input: SessionEventInput): SessionEvent {
    const event = { seq: this.events.length, timestamp: Date.now(), ...input } as SessionEvent
    this.events.push(event)
    return event
  }

  /** 从事件流投影模型消息（Surface）：user/message → user，assistant/message → assistant（含 tool_calls），tool/result → tool */
  deriveMessages(): Message[] {
    const messages: Message[] = []
    for (const event of this.events) {
      switch (event.type) {
        case 'user/message':
          messages.push({ role: 'user', content: event.content })
          break
        case 'assistant/message':
          messages.push({
            role: 'assistant',
            content: event.content,
            // 有工具调用时附带 tool_calls（OpenAI 函数调用格式）
            ...(event.toolCalls ? {
              tool_calls: event.toolCalls.map(c => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            } : {}),
          })
          break
        case 'tool/result':
          messages.push({ role: 'tool', tool_call_id: event.callId, content: event.content })
          break
      }
    }
    return messages
  }
}

// ============================================================
// 2. Inbox：next-turn / next-step 双队列（dsh 的 Inbox 投影）
// ============================================================

// 队列目标：next-turn 下一轮输入 / next-step 下一步输入
type InboxTarget = 'next-turn' | 'next-step'

// 待处理消息：id + 内容
interface InboxMessage {
  id: string
  content: string
}

// Inbox：两个待处理队列
class Inbox {
  // 状态：两个队列，各存待处理消息
  private state: Record<InboxTarget, InboxMessage[]> = { 'next-turn': [], 'next-step': [] }

  get nextTurn(): readonly InboxMessage[] { return this.state['next-turn'] }
  get nextStep(): readonly InboxMessage[] { return this.state['next-step'] }
  // 是否有待处理消息（任一队列非空）
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /** 追加消息到目标队列（followup → next-turn，steer → next-step） */
  append(target: InboxTarget, message: InboxMessage): void {
    this.state[target].push(message)
  }

  /** claim：移除并返回本轮 step 的消息批次（先清 next-step，再按需取 next-turn 一条） */
  claim(target: InboxTarget): InboxMessage[] {
    const claimed = this.state['next-step'].splice(0)
    if (target === 'next-turn') {
      claimed.push(...this.state['next-turn'].splice(0, 1))
    }
    return claimed
  }
}

// ============================================================
// 3. Mock LLM：模拟模型流式响应
// ============================================================

interface MockLlmOptions {
  provider: string
  model: string
  maxTokens?: number
}

interface LlmChunk {
  type: 'text' | 'tool-call'
  text?: string
  call?: ToolCall
}

/**
 * Mock 适配器：根据消息历史模拟模型决策（dsh 的真实适配器是 llm.stream）
 * 三步决策：先调 calculator，再调 weather，最后输出总结
 */
class MockLlm {
  constructor(readonly options: MockLlmOptions) {}

  stream(messages: Message[]): AsyncIterable<LlmChunk> {
    return (async function* () {
      // 按顺序检查工具结果（从旧到新）
      const toolResults = messages.filter(m => m.role === 'tool')

      if (toolResults.length === 2) {
        // calculator 和 weather 的结果都回来了：输出最终总结
        const calc = toolResults[0]?.content
        const weather = toolResults[1]?.content
        yield { type: 'text', text: `最终回答: ${calc}；${weather}` }
        return
      }

      if (toolResults.length === 1) {
        // calculator 结果已回：再调 weather
        yield {
          type: 'tool-call',
          call: { id: 'weather-1', name: 'weather', arguments: JSON.stringify({ city: 'Shanghai' }) },
        }
        return
      }

      // 初始用户输入：先调 calculator
      yield {
        type: 'tool-call',
        call: { id: 'calc-1', name: 'calculator', arguments: JSON.stringify({ expression: '2 + 2' }) },
      }
    })()
  }
}

// ============================================================
// 4. ReactLoopAgent：turn/step 状态机（dsh 核心）
// ============================================================

// Agent 的模型路由配置（dsh: AgentOptions）
interface AgentOptions {
  provider?: string   // 提供方路由（必须有注册的适配器）
  model?: string      // 模型 id
  maxTokens?: number  // 最大输出 token
}

// Phase 状态机：idle（空闲，零开销）| running（驱动循环运行中）
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; turn: number; step: number; aborted: boolean }

// ReactLoopAgent：turn/step 状态机驱动的 Agent 执行循环（dsh 核心）
class ReactLoopAgent {
  readonly inbox: Inbox
  readonly session: SimpleSession
  private phase: Phase
  private tools = new Map<string, (args: Record<string, unknown>) => Promise<string>>()

  constructor(
    readonly id: string,
    readonly options: AgentOptions,
    private llm: MockLlm,
  ) {
    this.session = new SimpleSession(id)
    this.inbox = new Inbox()
    this.phase = { kind: 'idle', lastTurn: 0 }
  }

  get status(): 'idle' | 'running' {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  /** 注册 Agent 可用的工具 */
  registerTool(name: string, handler: (args: Record<string, unknown>) => Promise<string>): this {
    this.tools.set(name, handler)
    return this
  }

  /** followup：排入下一轮并唤醒驱动（dsh: send + wakeDriver） */
  followup(content: string): void {
    this.inbox.append('next-turn', { id: `m-${Date.now()}`, content })
    if (this.phase.kind === 'idle') this.wakeDriver()
  }

  /** steer：排入下一步边界（dsh: send target=next-step） */
  steer(content: string): void {
    this.inbox.append('next-step', { id: `m-${Date.now()}`, content })
    if (this.phase.kind === 'idle') this.wakeDriver()
  }

  /** 唤醒驱动：进入 running 状态并启动 kick 循环（dsh: wakeDriver → kick） */
  private wakeDriver(): void {
    this.setPhase({ kind: 'running', turn: this.phase.lastTurn, step: 0, aborted: false })
    void this.kick().finally(() => {
      if (this.phase.kind === 'running') {
        this.setPhase({ kind: 'idle', lastTurn: this.phase.turn })
      }
    })
  }

  private setPhase(phase: Phase): void {
    this.phase = phase
  }

  /** 主驱动循环：不断跑 turn，直到没有 pending 输入（dsh: kick） */
  private async kick(): Promise<void> {
    try {
      while (this.phase.kind === 'running' && await this.turn()) {}
    } catch (error) {
      // 错误已在 turn 内结构化记录
    }
  }

  /** 一轮对话：turn/start → 多个 step → turn/end（dsh: turn） */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') return false
    const turn = this.phase.turn + 1
    this.phase.turn = turn
    this.session.append({ type: 'turn/start', turn })

    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'

    try {
      while (this.phase.kind === 'running') {
        if (this.phase.aborted) { turnEnds = { kind: 'aborted' }; break }

        // preStep：从 Inbox claim 消息
        const step = this.phase.step + 1
        const claimed = this.inbox.claim(target)
        if (claimed.length === 0) {
          if (turnEnds !== null) break
          turnEnds = { kind: 'blocked' }
          return false
        }

        this.phase.step = step
        this.session.append({ type: 'step/start', turn, step })
        try {
          for (const message of claimed) {
            this.session.append({ type: 'user/message', content: message.content })
          }
          const stepEnd = await this.step(turn, step)
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append({ type: 'step/end', turn, step })
        }

        // turn-stopping：没有新输入则结束本轮
        if (turnEnds !== null && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: any) {
      if (this.phase.aborted) {
        turnEnds = { kind: 'aborted' }
      } else {
        turnEnds = { kind: 'error', error: String(error?.message ?? error) }
      }
    } finally {
      this.session.append({ type: 'turn/end', turn, reason: turnEnds ?? { kind: 'error', error: 'unknown' } })
    }

    if (!this.inbox.hasPending) return false
    this.phase.step = 0
    return true
  }

  /** 一个步骤：LLM 请求 → 工具调用循环（dsh: step） */
  private async step(turn: number, step: number): Promise<{ kind: 'completed' | 'max-tokens' } | null> {
    while (this.phase.kind === 'running') {
      // buildRequest：从 Session 投影消息 + 组装 tools/system
      const messages = this.session.deriveMessages()
      const stream = this.llm.stream(messages)

      const toolCalls: ToolCall[] = []
      let text = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text') {
          text += chunk.text
        } else if (chunk.type === 'tool-call' && chunk.call) {
          toolCalls.push(chunk.call)
        }
      }

      this.session.append({
        type: 'assistant/message',
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      })

      // 没有工具调用 → step 完成
      if (toolCalls.length === 0) return { kind: 'completed' }

      // 有工具调用 → 执行（dsh: executeToolCalls）
      // 执行完后不 return，继续循环：带着 tool/result 再请求 LLM
      await this.executeToolCalls(turn, step, toolCalls)
    }
    return null
  }

  /** 执行工具调用：tool/call → 执行 → tool/result（dsh: tool-calls.ts） */
  private async executeToolCalls(turn: number, step: number, calls: ToolCall[]): Promise<void> {
    for (const call of calls) {
      this.session.append({ type: 'tool/call', turn, step, callId: call.id, name: call.name, arguments: call.arguments })

      let content: string
      let isError = false
      try {
        const args = JSON.parse(call.arguments || '{}')
        const tool = this.tools.get(call.name)
        if (!tool) throw new Error(`Tool ${call.name} not found`)
        content = await tool(args)
      } catch (error: any) {
        isError = true
        content = String(error?.message ?? error)
      }

      this.session.append({ type: 'tool/result', turn, step, callId: call.id, content, isError })
    }
  }
}

// ============================================================
// 5. AgentLoop Service：管理 agent 生命周期（dsh: agent-loop/index.ts）
// ============================================================

class AgentLoopService extends Service {
  private agents = new Map<string, ReactLoopAgent>()  // 注册表：sessionId → agent
  private counter = 0  // 自增计数器，生成唯一 session ID

  constructor(ctx: Context) {
    super(ctx, 'agentLoop')  // Cordis v4 两参数构造
  }

  // 生成唯一 session ID：自增 session-<n>
  private mintId(): string {
    return `session-${++this.counter}`
  }

  /** 创建 agent（简化版：dsh 里通过 createAgent + publish 发布） */
  create(options: AgentOptions & { llm?: MockLlm }): ReactLoopAgent {
    const agent = new ReactLoopAgent(
      this.mintId(),
      { provider: options.provider ?? 'mock', model: options.model ?? 'mock-model', maxTokens: options.maxTokens },
      options.llm ?? new MockLlm({ provider: 'mock', model: 'mock-model' }),  // 缺省用 Mock LLM
    )
    this.agents.set(agent.session.id, agent)  // 登记到注册表
    return agent
  }

  // 列出所有 agent
  list(): ReactLoopAgent[] {
    return Array.from(this.agents.values())
  }
}

// 扩展 Cordis 类型：ctx.agentLoop 可用
declare module '@cordisjs/core' {
  interface Context {
    agentLoop: AgentLoopService
  }
}

// ============================================================
// 6. 演示：跑一个真实的 turn/step 循环
// ============================================================

console.log('='.repeat(60))
console.log('博客7：Loop 模块 - Agent 执行循环')
console.log('='.repeat(60))

let ctx = new Context()
// ctx.plugin() 是异步的，需要 await 等待服务激活
await ctx.plugin(AgentLoopService)

// 创建 agent（provider/model 指定路由，真实项目接真实适配器）
console.log('\n📦 创建 Agent...')
const agent = ctx.agentLoop.create({ provider: 'mock', model: 'react-loop', maxTokens: 512 })

// 注册 Agent 可用的工具（第五篇讲过：工具是插件注入的）
agent.registerTool('calculator', async (args) => {
  const match = (args.expression as string).match(/(\d+)\s*\+\s*(\d+)/)
  const sum = match ? Number(match[1]) + Number(match[2]) : NaN
  return `计算 ${args.expression} = ${sum}`
})

agent.registerTool('weather', async (args) => {
  return `${args.city} 天气: 晴天 25°C`
})

// 发送用户消息（followup：排入 next-turn 并唤醒驱动，agent 进入 running）
console.log('\n👤 用户: 帮我计算 2 + 2，然后查一下上海天气')
agent.followup('帮我计算 2 + 2，然后查一下上海天气')

// 等待 agent 收敛（dsh: whenIdle，等所有 turn/step 跑完回到 idle）
while (agent.status === 'running') {
  await new Promise(resolve => setTimeout(resolve, 10))
}

// 打印 Session 事件流（Agent 的完整思考过程）
console.log('\n📜 Session 事件流:')
for (const event of agent.session.events) {
  switch (event.type) {
    case 'turn/start': console.log(`  #${event.seq} turn/start   (turn ${event.turn})`); break
    case 'turn/end': console.log(`  #${event.seq} turn/end     (reason: ${event.reason.kind})`); break
    case 'step/start': console.log(`  #${event.seq} step/start   (turn ${event.turn} step ${event.step})`); break
    case 'step/end': console.log(`  #${event.seq} step/end     (turn ${event.turn} step ${event.step})`); break
    case 'user/message': console.log(`  #${event.seq} user/message "${event.content}"`); break
    case 'assistant/message': console.log(`  #${event.seq} assistant   "${event.content}"${event.toolCalls ? ` 工具调用: ${event.toolCalls.map(c => c.name).join(', ')}` : ''}`); break
    case 'tool/call': console.log(`  #${event.seq} tool/call    ${event.name}(${event.arguments})`); break
    case 'tool/result': console.log(`  #${event.seq} tool/result  "${event.content}"${event.isError ? ' [ERROR]' : ''}`); break
  }
}

console.log('\n✅ 博客7 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. ReactLoopAgent - kick/turn/step 状态机（agent-loop/src/agent.ts）')
console.log('  2. Inbox - next-turn/next-step 双队列 claim（core/agent/src/inbox.ts）')
console.log('  3. executeToolCalls - tool/call → tool/result（agent-loop/src/tool-calls.ts）')
console.log('  4. Session 事件日志 - turn/step 边界 + 消息投影')
