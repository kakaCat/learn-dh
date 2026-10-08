/**
 * 博客8：Compaction 模块 - 上下文压缩
 *
 * 按 dsh 源码（packages/compaction/*）结构实现：
 * - 词汇表: compaction/start / summary / end 事件 + CompactionResult
 * - Tool-Pairing: 平衡切点，不分割工具调用/结果对（tool-pairing.ts）
 * - 区域选择: 保留最近尾部，压缩头部（region.ts 的 selectCompactableRange）
 * - Summarizer: 结构化摘要 + <compacted-summary> 标签（summarizer.ts）
 * - 事务: start → summarize → surface replace → end（region.ts 的 compactSurfaceRegion）
 */

import { Context, Service } from '@cordisjs/core'
import { randomUUID } from 'node:crypto'

// ============================================================
// 1. Compaction 词汇表：事件与结果类型
// ============================================================

// 会话事件：在 blog-07 基础上增加 compaction/* 三个元事件。
// 它们只记录日志，不进入消息投影（surface）——真正的替换由紧跟其后的 user/message 完成。
type SessionEvent =
  | { type: 'user/message'; seq: number; content: string; timestamp: number }
  | { type: 'assistant/message'; seq: number; content: string; toolCalls?: ToolCall[]; timestamp: number }
  | { type: 'tool/call'; seq: number; callId: string; name: string; arguments: string; timestamp: number }
  | { type: 'tool/result'; seq: number; callId: string; content: string; isError: boolean; timestamp: number }
  | { type: 'turn/start'; seq: number; turn: number; timestamp: number }
  | { type: 'turn/end'; seq: number; turn: number; reason: string; timestamp: number }
  | { type: 'step/start'; seq: number; turn: number; step: number; timestamp: number }
  | { type: 'step/end'; seq: number; turn: number; step: number; timestamp: number }
  // ↓ compaction 元事件（不进入 surface）
  | { type: 'compaction/start'; seq: number; compactionId: string; turn: number | null; timestamp: number }
  | {
    type: 'compaction/summary'
    seq: number
    compactionId: string
    summary: string
    shadowedRange: { start: number; end: number }
    shadowedSeqs: number[]
    shadowedTokenCount: number
    timestamp: number
  }
  | { type: 'compaction/end'; seq: number; compactionId: string; error?: string; timestamp: number }

// 追加事件时 seq 由 append 自动分配
type SessionEventInput = SessionEvent extends infer E ? Omit<E, 'seq'> : never

// 模型发出的工具调用
interface ToolCall {
  id: string
  name: string
  arguments: string
}

// 模型消息（surface 投影，OpenAI 风格）
interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/**
 * 一次压缩事务的结果（dsh: CompactionResult）。
 * shadowedRange 是被替换区间的边界 seq；shadowedSeqs 是被替换节点列表；shadowedTokenCount 是它们的估计 token。
 */
interface CompactionResult {
  compactionId: string
  startSeq: number
  summarySeq: number
  endSeq: number
  summary: string
  shadowedRange: { start: number; end: number }
  shadowedSeqs: number[]
  shadowedTokenCount: number
}

// ============================================================
// 2. Session + Surface：可替换的会话表面
// ============================================================

/**
 * Surface 是「当前活跃节点」的位置列表（dsh: session.surface）。
 * 事件日志是 append-only 全量记录；surface 则是被 replace 裁剪后的投影。
 * 压缩 = 把 surface 上一段旧节点替换成一个新摘要节点。
 */
class Surface {
  // surface 顺序的活跃事件 seq
  private seqs: number[] = []

  /** 追加一个节点到尾部 */
  push(seq: number): void {
    this.seqs.push(seq)
  }

  /** 把 [startSeq, endSeq] 区间替换为一个新节点（dsh: surfaceOp replace） */
  replaceRange(startSeq: number, endSeq: number, newSeq: number): void {
    const startIdx = this.seqs.indexOf(startSeq)
    const endIdx = this.seqs.indexOf(endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      throw new Error(`replaceRange: invalid span ${startSeq}..${endSeq}`)
    }
    this.seqs.splice(startIdx, endIdx - startIdx + 1, newSeq)
  }

  get nodes(): readonly number[] {
    return this.seqs
  }

  indexOf(seq: number): number {
    return this.seqs.indexOf(seq)
  }

  has(seq: number): boolean {
    return this.seqs.includes(seq)
  }
}

// 简化版 Session：事件日志 + 可替换的 surface + 消息投影
class CompactSession {
  readonly id: string
  readonly events: SessionEvent[] = []  // append-only 事件日志
  readonly surface = new Surface()      // 当前活跃节点（压缩裁剪后）

  constructor(id: string) {
    this.id = id
  }

  /** 追加事件：自动分配 seq；可附带 surfaceOp 执行替换 */
  append(input: SessionEventInput, surfaceOp?: { op: 'replace'; start: number; end: number }): SessionEvent {
    const event = { seq: this.events.length, timestamp: Date.now(), ...input } as SessionEvent
    this.events.push(event)

    // compaction 元事件只记录日志，不进 surface（dsh: 不进入 surface 的日志事件）
    if (input.type.startsWith('compaction/')) return event

    if (surfaceOp) {
      // 压缩替换：新节点落在旧区间的位置（shadow），紧跟的 user/message 携带摘要
      this.surface.replaceRange(surfaceOp.start, surfaceOp.end, event.seq)
    } else {
      this.surface.push(event.seq)
    }
    return event
  }

  /** 从 surface 投影模型消息（只投影当前活跃节点，被压缩的旧节点不再出现） */
  deriveMessages(): Message[] {
    return this.deriveMessagesFromSeqs(this.surface.nodes)
  }

  /** 从任意 seq 列表投影模型消息（压缩器用它重建被压缩区域，dsh: deriveEventMessage） */
  deriveMessagesFromSeqs(seqs: readonly number[]): Message[] {
    const messages: Message[] = []
    for (const seq of seqs) {
      const event = this.events[seq]
      switch (event?.type) {
        case 'user/message':
          messages.push({ role: 'user', content: event.content })
          break
        case 'assistant/message':
          messages.push({
            role: 'assistant',
            content: event.content,
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
// 3. TokenMeter：上下文测量与压力
// ============================================================

// 一次测量结果：surface 顺序的 seq + 每个 seq 的估计 token + 总量
interface TokenMeasurement {
  seqs: readonly number[]
  tokensBySeq: Map<number, number>
  totalTokens: number
}

/**
 * Token 计量器（dsh: token-meter）。
 * 真实项目用 provider 的 tokenizer；这里用一个固定启发式：约 4 字符 ≈ 1 token。
 */
class TokenMeter {
  constructor(
    readonly contextWindow: number,
    readonly thresholdRatio = 0.8,
  ) {}

  /** 压力阈值：上下文窗口 * thresholdRatio（dsh: thresholdTokens） */
  get thresholdTokens(): number {
    return Math.floor(this.contextWindow * this.thresholdRatio)
  }

  /** 单条文本的估计 token 数 */
  estimate(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4))
  }

  /** 测量一个会话：为每个 surface 活跃节点定价 */
  measure(session: CompactSession): TokenMeasurement {
    const seqs = [...session.surface.nodes]  // 拷贝，避免被后续 replace 污染快照
    const tokensBySeq = new Map<number, number>()
    let totalTokens = 0
    for (const seq of seqs) {
      const tokens = this.estimateMessage(session.events[seq])
      tokensBySeq.set(seq, tokens)
      totalTokens += tokens
    }
    return { seqs, tokensBySeq, totalTokens }
  }

  /** 估算一个事件占用的 token */
  private estimateMessage(event: SessionEvent | undefined): number {
    if (!event) return 0
    switch (event.type) {
      case 'user/message':
        return this.estimate(event.content)
      case 'assistant/message': {
        let tokens = this.estimate(event.content)
        // 工具调用参数的 JSON 也计费
        for (const call of event.toolCalls ?? []) {
          tokens += this.estimate(call.arguments)
        }
        return tokens
      }
      case 'tool/result':
        return this.estimate(event.content)
      case 'compaction/summary':
        return this.estimate(event.summary)
      default:
        return 0
    }
  }
}

// ============================================================
// 4. Tool-Pairing 平衡：安全切点
// ============================================================

/**
 * 每个事件的「进行中工具调用」增量（dsh: eventDelta）：
 * - assistant/message 携带 N 个 tool-call → +N
 * - tool/result → -1
 * 压缩会改变 surface 位置，所以安全切点只能由「工具调用/结果是否配平」决定，
 * 而不是靠 step 标记。
 */
function eventDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.toolCalls?.length ?? 0
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

/**
 * 计算 surface 每个切点的平衡状态（dsh: balanceCache 的折叠结果）。
 * N 个节点的 surface 有 N+1 个切点：入口 i 是节点 i 之前的切点，最后一项是尾部切点。
 * 切点平衡 = 没有未响应的工具调用跨越该切点。
 */
function toolPairingCuts(session: CompactSession): boolean[] {
  const cuts: boolean[] = [true]
  let inProgress = 0
  for (const seq of session.surface.nodes) {
    inProgress += eventDelta(session.events[seq]!)
    if (inProgress < 0) {
      throw new Error(`tool-pairing balance: tool/result at seq ${seq} has no matching tool-call`)
    }
    cuts.push(inProgress === 0)
  }
  return cuts
}

/** 某个 surface 节点「之前」的切点是否平衡（dsh: toolPairingBalancedBefore） */
function toolPairingBalancedBefore(session: CompactSession, seq: number): boolean {
  const idx = session.surface.indexOf(seq)
  if (idx === -1) throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  return toolPairingCuts(session)[idx]!
}

/** 某个 surface 节点「之后」的切点是否平衡（dsh: toolPairingBalancedAfter） */
function toolPairingBalancedAfter(session: CompactSession, seq: number): boolean {
  const idx = session.surface.indexOf(seq)
  if (idx === -1) throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  return toolPairingCuts(session)[idx + 1]!
}

// ============================================================
// 5. 区域选择：保留尾部，压缩头部
// ============================================================

/**
 * 解析出「以头部为锚、向前延伸」的可压缩区间（dsh: selectCompactableRange）：
 * 1. 从尾部反向累计 token，确保保留 retainTokens 的最近尾部原样不动
 * 2. 往前回溯到最近的平衡切点，绝不把一个 step 的工具调用/结果对劈开
 * 3. 返回 { start: 第一个节点 seq, end: 保留区前一个节点 seq }
 */
function selectCompactableRange(
  session: CompactSession,
  measurement: TokenMeasurement,
  retainTokens: number,
): { start: number; end: number } | null {
  const seqs = measurement.seqs
  if (seqs.length === 0) return null

  // 从尾部累计，找到保留尾部的最小起点
  let accumulated = 0
  let keepFromIdx = seqs.length
  for (let index = seqs.length - 1; index >= 0; index--) {
    accumulated += measurement.tokensBySeq.get(seqs[index]!) ?? 0
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === 0) return null  // 整段都要保留，无可压缩

  // 回溯到平衡切点：不分割工具对
  while (keepFromIdx > 0) {
    if (toolPairingBalancedBefore(session, seqs[keepFromIdx]!)) break
    keepFromIdx--
  }
  if (keepFromIdx === 0) return null

  return { start: seqs[0]!, end: seqs[keepFromIdx - 1]! }
}

/** 校验一个请求的区间是合法的替换目标（dsh: validateSurfaceRegion） */
function validateSurfaceRegion(
  session: CompactSession,
  start: number,
  end: number,
): { startIdx: number; endIdx: number; shadowedSeqs: number[] } {
  const startIdx = session.surface.indexOf(start)
  const endIdx = session.surface.indexOf(end)
  if (startIdx === -1) throw new Error(`compact: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compact: end seq ${end} not found in surface`)
  if (startIdx > endIdx) throw new Error(`compact: start seq ${start} is after end seq ${end}`)
  if (!toolPairingBalancedBefore(session, session.surface.nodes[startIdx]!)) {
    throw new Error('compact: start is not a balanced boundary (would split a tool-call/result pair)')
  }
  if (!toolPairingBalancedAfter(session, session.surface.nodes[endIdx]!)) {
    throw new Error('compact: end is not a balanced boundary (would split a tool-call/result pair)')
  }
  return { startIdx, endIdx, shadowedSeqs: session.surface.nodes.slice(startIdx, endIdx + 1) }
}

// ============================================================
// 6. Summarizer：结构化摘要
// ============================================================

// 摘要标签（dsh: summarizer.ts 的 SUMMARY_OPEN_TAG / SUMMARY_CLOSE_TAG）
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

// 摘要前置说明：让后续模型把摘要当作既定背景，而不是重新叙述
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation. ' +
  'Treat the captured context as established background and continue the task directly from the messages that follow.'

// 压缩指令（dsh: COMPACTION_INSTRUCTION）——作为最后一条 user message 追加，
// 让摘要调用是上一轮请求的真实前缀，复用 provider 的 KV 缓存。
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. ' +
  'Condense the conversation ABOVE into a structured checkpoint that lets another model resume with no loss of essential context.',
  '',
  'Output the following sections, in order, using terse bullets:',
  '- Primary Request and Intent',
  '- Key Technical Concepts',
  '- Files and Code',
  '- Errors and Fixes',
  '- Pending Jobs',
  '- Current Work',
  '- Next Step',
  '- Critical Context',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, and numeric values.',
  '- Do NOT mention this summarization request or that the context was compacted.',
].join('\n')

/** 把模型摘要包进检查点框架（dsh: frameSummary） */
function frameSummary(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${summary}\n${SUMMARY_CLOSE_TAG}`
}

/**
 * Mock 摘要器：模拟 LLM 生成结构化摘要。
 * 真实项目调用 ctx.llm.stream()（dsh: summarizeWithLlm），这里用规则提取关键信息，
 * 演示同样的输入（被压缩区域的消息）和输出（结构化 Markdown）。
 */
class MockSummarizer {
  async summarize(messages: readonly Message[]): Promise<string> {
    // 从被压缩区域里提取关键事实，模拟模型"读后总结"
    const userMsgs = messages.filter(m => m.role === 'user').map(m => m.content)
    const toolCalls = messages
      .flatMap(m => m.tool_calls?.map(tc => tc.function.name) ?? [])

    const sections = [
      `Primary Request and Intent: ${userMsgs[0]?.slice(0, 24) ?? '(none)'}`,
      `Key Technical Concepts: tools=${[...new Set(toolCalls)].join(',') || 'none'}`,
      `Current Work: ${userMsgs.length} user turns, results returned`,
      `Next Step: (none)`,
    ]
    return sections.join('\n')
  }
}

// ============================================================
// 7. Compaction 事务：start → summarize → replace → end
// ============================================================

/**
 * 运行一次完整的压缩事务（dsh: compactSurfaceRegion）：
 * 1. 校验区间 + 确认无未闭合的压缩锁
 * 2. append compaction/start（记录开始，占锁）
 * 3. 快照被压缩区域的 token + 构建摘要输入
 * 4. summarize（异步，此刻 surface 可能已变化 → SurfaceChangedError）
 * 5. 校验摘要必须比被压缩内容更小
 * 6. append compaction/summary + 紧跟 user/message（surface replace）
 * 7. append compaction/end（释放锁）
 */
async function compactSurfaceRegion(
  session: CompactSession,
  meter: TokenMeter,
  summarizer: MockSummarizer,
  start: number,
  end: number,
): Promise<CompactionResult> {
  // 1. 校验：区间合法 + 无未闭合压缩
  const selection = validateSurfaceRegion(session, start, end)
  if (hasOpenCompaction(session)) {
    throw new Error('compaction already in progress; the session compaction lock is active')
  }

  // 2. 记录开始（占锁）：compactionId 用 randomUUID（dsh: CompactionId(randomUUID())）
  const compactionId = `cmp-${randomUUID().slice(0, 8)}`
  const startEvent = session.append({ type: 'compaction/start', compactionId, turn: null })
  console.log(`  🔒 compaction/start  #${startEvent.seq} (${compactionId})`)

  try {
    // 3. 快照被压缩区域
    const measurement = meter.measure(session)
    const shadowedTokenCount = selection.shadowedSeqs.reduce(
      (total, seq) => total + (measurement.tokensBySeq.get(seq) ?? 0),
      0,
    )
    const input = buildSummarizationInput(session, selection.shadowedSeqs)
    console.log(`  📦 被压缩区域: ${selection.shadowedSeqs.length} 个节点, ~${shadowedTokenCount} tokens`)

    // 4. 生成摘要
    const summary = await summarizer.summarize(input)

    // 5. 摘要必须更小（dsh 校验 framedSummaryTokenCount < shadowedTokenCount）
    const framed = frameSummary(summary)
    const framedTokens = meter.estimate(framed)
    if (framedTokens >= shadowedTokenCount) {
      throw new Error(
        `summary is not smaller than the shadowed content (${framedTokens} >= ${shadowedTokenCount})`,
      )
    }
    console.log(`  ✍️  摘要生成: ~${framedTokens} tokens < 原 ${shadowedTokenCount} tokens`)

    // 6. 记录摘要 + 替换 surface
    const summaryEvent = session.append({
      type: 'compaction/summary',
      compactionId,
      summary: framed,
      shadowedRange: { start, end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount,
    })
    session.append(
      { type: 'user/message', content: framed },
      { op: 'replace', start, end },
    )
    console.log(`  🔁 compaction/summary #${summaryEvent.seq} + user/message replace`)

    // 7. 释放锁
    const endEvent = session.append({ type: 'compaction/end', compactionId })
    console.log(`  🔓 compaction/end    #${endEvent.seq}`)

    return {
      compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: framed,
      shadowedRange: { start, end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount,
    }
  } catch (error: any) {
    // 失败也要闭合：记录 error，留下可检测的痕迹（dsh: fail-closed）
    session.append({ type: 'compaction/end', compactionId, error: String(error?.message ?? error) })
    throw error
  }
}

/** 是否存在未闭合的压缩事务（dsh: assertCompactionInactive） */
function hasOpenCompaction(session: CompactSession): boolean {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event?.type === 'compaction/start') return true
    if (event?.type === 'compaction/end') return false
  }
  return false
}

/** 构建摘要输入：被压缩区域的 surface 消息（dsh: buildSummarizationInput） */
function buildSummarizationInput(session: CompactSession, shadowedSeqs: readonly number[]): Message[] {
  const all = session.deriveMessagesFromSeqs(shadowedSeqs)
  return [...all, { role: 'user', content: COMPACTION_INSTRUCTION }]
}

// ============================================================
// 8. ToolResultPruner：工具结果修剪（策略②，无模型）
// ============================================================

// 配置（dsh: compaction-tool-result-pruner config.ts）
interface PruneConfig {
  thresholdChars?: number  // 超过多少字符才修剪（默认 8192）
  headChars?: number       // 保留开头字符数（默认 4096）
  tailChars?: number       // 保留结尾字符数（默认 1024）
}

// 剪裁标记：替换被剪掉的中间部分
const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

// 按 Unicode code point 计数（不劈开代理对，如 emoji）
function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * 工具结果修剪器（dsh: compaction-tool-result-pruner）。
 * 无模型（model-free）：超大工具结果 → 保留头 + 剪裁标记 + 保留尾，
 * 确定性、可重放、零 LLM 成本。
 */
class ToolResultPruner {
  private readonly config: Required<PruneConfig>

  constructor(options: PruneConfig = {}) {
    this.config = {
      thresholdChars: options.thresholdChars ?? 8192,
      headChars: options.headChars ?? 4096,
      tailChars: options.tailChars ?? 1024,
    }
  }

  /** 是否应该修剪（超阈值） */
  shouldPrune(content: string): boolean {
    return codePointLength(content) > this.config.thresholdChars
  }

  /** 修剪一条文本：保留头尾，中间替换为标记 */
  prune(content: string): { content: string; prunedChars: number } {
    const original = codePointLength(content)
    if (original <= this.config.thresholdChars) {
      return { content, prunedChars: 0 }  // 未超阈值，原样返回
    }

    const head = Array.from(content).slice(0, this.config.headChars).join('')
    const tail = Array.from(content).slice(-this.config.tailChars).join('')
    const pruned = head + PRUNE_MARKER + tail

    return { content: pruned, prunedChars: original - codePointLength(pruned) }
  }

  /**
   * 修剪一个会话里所有超阈值的 tool/result 内容（返回是否发生了修剪）。
   * 注意：这里直接改写事件内容（演示简化）；dsh 是追加新的 pruned 事件 + shadow-price。
   */
  pruneSession(session: CompactSession): number {
    let prunedCount = 0
    for (const event of session.events) {
      if (event.type !== 'tool/result') continue
      if (!this.shouldPrune(event.content)) continue

      const { content, prunedChars } = this.prune(event.content)
      ;(event as { content: string }).content = content
      prunedCount++
      console.log(`  ✂️  修剪 tool/result #${event.seq}: 剪掉 ${prunedChars} 字符`)
    }
    return prunedCount
  }
}

// ============================================================
// 9. CompactionService：插件入口 + 配置
// ============================================================

// 配置（dsh: compaction-basic config.ts）：
// thresholdRatio 压力阈值比例（默认 0.8）；retainRatio 保留尾部比例（默认 0.16）
interface CompactConfig {
  contextWindow?: number   // 模型上下文窗口（默认 4096）
  thresholdRatio?: number  // 压力阈值比例（默认 0.8）
  retainRatio?: number     // 保留最近尾部比例（默认 0.16）
  maxTokens?: number       // 摘要输出上限（默认 512，演示未用）
  prune?: PruneConfig      // 策略②工具结果修剪配置（可选，不配则不修剪）
}

class CompactionService extends Service {
  readonly meter: TokenMeter
  private summarizer = new MockSummarizer()
  private pruner: ToolResultPruner | null  // 策略②：工具结果修剪（可选）
  private config: Required<Pick<CompactConfig, 'contextWindow' | 'thresholdRatio' | 'retainRatio' | 'maxTokens'>>

  constructor(ctx: Context, options: CompactConfig = {}) {
    super(ctx, 'compaction')
    this.config = {
      contextWindow: options.contextWindow ?? 4096,
      thresholdRatio: options.thresholdRatio ?? 0.8,
      retainRatio: options.retainRatio ?? 0.16,
      maxTokens: options.maxTokens ?? 512,
    }
    this.meter = new TokenMeter(this.config.contextWindow, this.config.thresholdRatio)
    this.pruner = options.prune ? new ToolResultPruner(options.prune) : null
  }

  /** 当前是否达到压缩压力（总 token >= 阈值） */
  shouldCompact(session: CompactSession): boolean {
    const { totalTokens } = this.meter.measure(session)
    return totalTokens >= this.meter.thresholdTokens
  }

  /**
   * 执行一次自动压缩（dsh: compactIfNeeded）：
   * 策略①先修剪超大工具结果（便宜）→ 重新测量 → 压力降了就结束；
   * 压力还在 → 策略②摘要压缩（贵）。
   */
  async compact(session: CompactSession): Promise<CompactionResult | null> {
    // 策略①：先修剪超大工具结果（无模型，零成本）
    let pruned = 0
    if (this.pruner) {
      pruned = this.pruner.pruneSession(session)
      if (pruned > 0) {
        const afterPrune = this.meter.measure(session)
        console.log(`  ✅ 修剪后重新测量: ${afterPrune.totalTokens} tokens（阈值 ${this.meter.thresholdTokens}）`)
        if (!this.shouldCompact(session)) {
          console.log('  🟢 修剪后压力已下降，无需摘要压缩')
          return null  // 只做了修剪，没做摘要
        }
      }
    }

    // 策略②：摘要压缩（需要 LLM）
    const measurement = this.meter.measure(session)
    const retainTokens = Math.floor(this.config.contextWindow * this.config.retainRatio)

    const range = selectCompactableRange(session, measurement, retainTokens)
    if (range === null) {
      throw new Error('nothing compactable: the whole surface must be retained')
    }

    return compactSurfaceRegion(session, this.meter, this.summarizer, range.start, range.end)
  }
}

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Context {
    compaction: CompactionService
  }
}

// ============================================================
// 9. 演示：完整压缩流程
// ============================================================

console.log('='.repeat(60))
console.log('博客8：Compaction 模块 - 上下文压缩')
console.log('='.repeat(60))

// 构建一个会话并灌入对话（辅助函数）
function appendConversation(
  session: CompactSession,
  turns: Array<{ user: string; assistant?: string; tool?: { name: string; args: string; result: string } }>,
): void {
  for (const turn of turns) {
    session.append({ type: 'user/message', content: turn.user })
    if (turn.tool) {
      const callId = `c-${randomUUID().slice(0, 4)}`
      session.append({
        type: 'assistant/message',
        content: '',
        toolCalls: [{ id: callId, name: turn.tool.name, arguments: turn.tool.args }],
      })
      session.append({ type: 'tool/call', callId, name: turn.tool.name, arguments: turn.tool.args })
      session.append({
        type: 'tool/result',
        callId,
        content: turn.tool.result,
        isError: false,
      })
    }
    if (turn.assistant) {
      session.append({ type: 'assistant/message', content: turn.assistant })
    }
  }
}

let ctx = new Context()
// ctx.plugin() 是异步的，需要 await 等待服务激活
await ctx.plugin(CompactionService, {
  contextWindow: 300,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  // 策略②：工具结果修剪配置（演示阈值调小，让构建日志触发修剪）
  prune: { thresholdChars: 200, headChars: 60, tailChars: 30 },
})

// 构造一段会触发压缩的对话（窗口 300，阈值 240，保留尾部 48）
const session = new CompactSession('session-demo')

console.log('\n👤 构建对话...')
appendConversation(session, [
  { user: '帮我看看项目结构，然后修复报错', tool: { name: 'read_file', args: '{"path":"src/main.ts"}', result: 'import { Context } from "@cordisjs/core"\n\n// 入口文件：创建 Context 并加载插件\nconst ctx = new Context()' }, assistant: '这是入口文件，创建 Context 并加载插件' },
  { user: 'TypeScript 报错：ctx.sessions 不存在', tool: { name: 'search', args: '{"query":"sessions","path":"src"}', result: 'src/main.ts:12 调用了 ctx.sessions 但未声明\nsrc/services/ 目录下没有任何 session 相关文件' }, assistant: '需要为 Context 声明 sessions 服务' },
  { user: '应该怎么声明？', tool: { name: 'read_file', args: '{"path":"src/types.ts"}', result: 'import { Context } from "@cordisjs/core"\n\nexport interface AppEvents {}\nexport interface AppContext extends Context {}' }, assistant: '用 declare module 扩展 Context 的接口' },
  { user: '帮我把声明加上，然后测一下', tool: { name: 'edit_file', args: '{"path":"src/types.ts","patch":"+declare module @cordisjs/core"}', result: '补丁应用成功，tsc 类型检查通过，无报错输出' }, assistant: '声明已加入，测试通过' },
  { user: '现在帮我实现 Session 服务', tool: { name: 'write_file', args: '{"path":"src/session.ts"}', result: 'Session 服务实现完成：包含 create/get/append/fork 方法，事件广播已接入' }, assistant: 'Session 服务实现完成' },
  { user: '给 Session 加一个统计功能，统计每种事件的数量', tool: { name: 'edit_file', args: '{"path":"src/session.ts","patch":"+stats()"}', result: 'stats() 方法已添加，返回各事件类型计数，单测通过' }, assistant: '统计功能已添加' },
  { user: '写一个测试文件覆盖这些功能', tool: { name: 'write_file', args: '{"path":"tests/session.spec.ts"}', result: '测试覆盖 create/append/stats，全部通过，共 12 个用例' }, assistant: '测试已写好并通过' },
  {
    user: '跑一下构建看看有没有报错',
    tool: {
      name: 'bash',
      args: '{"command":"pnpm build"}',
      result: '$ pnpm build\n\n> blog-08@0.1.0 build /workspace/blog-08\n> tsc --noEmit\n\n'
        + 'src/main.ts:12:5 - error TS2339: Property "sessions" does not exist on type "Context".\n\n'
        + '12     ctx.sessions.create()\n       ~~~~~~~~~~\n\n'
        + 'src/session.ts:45:3 - error TS2339: Property "stats" does not exist on type "Session".\n\n'
        + '45     session.stats()\n       ~~~~~~~\n\n'
        + 'Found 2 errors in 2 files.\n\n'
        + 'ELIFECYCLE Command failed with exit code 1.\n\n'
        + '上面是完整的构建输出。第 12 行 ctx.sessions 未声明类型，第 45 行 session.stats 未声明，'
        + '两处都需要补 declare module 类型扩展，修复后重新跑 pnpm build 确认。',
    },
    assistant: '构建报错，需要补类型声明',
  },
  { user: '帮我把 README 更新一下', tool: { name: 'edit_file', args: '{"path":"README.md","patch":"+Session"}', result: 'README 已补充 Session 章节，含用法示例和 API 列表' }, assistant: 'README 已更新' },
])

const beforeMeasurement = ctx.compaction.meter.measure(session)
console.log(`  事件数: ${session.events.length}, surface 节点: ${session.surface.nodes.length}, 总 token: ${beforeMeasurement.totalTokens}`)

// 检查压力（演示用；达到阈值才应自动触发压缩）
const pressured = ctx.compaction.shouldCompact(session)
console.log(`  压力阈值: ${ctx.compaction.meter.thresholdTokens} tokens → ${pressured ? '🟡 需要压缩' : '🟢 安全'}`)
if (!pressured) console.log('  ⚠️  压力未达阈值，演示强制压缩以展示完整流程')

// 查看消息投影（压缩前）
console.log('\n📋 压缩前消息投影:')
for (const msg of session.deriveMessages()) {
  if (msg.tool_calls) console.log(`  [assistant] 工具调用: ${msg.tool_calls[0].function.name}`)
  else if (msg.tool_call_id) console.log(`  [tool] ${msg.content.slice(0, 40)}${msg.content.length > 40 ? '...' : ''}`)
  else console.log(`  [${msg.role}] ${msg.content.slice(0, 50)}${msg.content.length > 50 ? '...' : ''}`)
}

// 压缩（策略①先修剪 → 重新测量 → 策略②摘要）
console.log('\n🚀 执行压缩...')
const result = await ctx.compaction.compact(session)

if (result === null) {
  console.log('\n  ✅ 本轮只做了工具结果修剪，未触发摘要压缩')
} else {
  console.log(`\n  ✅ 摘要压缩完成: ${result.shadowedSeqs.length} 个节点 → 1 个摘要节点`)
}

// 压缩后对比
const afterMeasurement = ctx.compaction.meter.measure(session)
console.log('\n📊 压缩前后对比:')
console.log(`  事件数: ${session.events.length}（日志全量保留）`)
console.log(`  surface 节点: ${beforeMeasurement.seqs.length} → ${afterMeasurement.seqs.length}`)
console.log(`  总 token: ${beforeMeasurement.totalTokens} → ${afterMeasurement.totalTokens} (节省 ${Math.round((1 - afterMeasurement.totalTokens / beforeMeasurement.totalTokens) * 100)}%)`)

// 查看压缩后的消息投影（摘要替换了旧对话）
console.log('\n📋 压缩后消息投影:')
const afterMessages = session.deriveMessages()
for (const msg of afterMessages) {
  if (msg.role === 'user' && msg.content.includes('<compacted-summary>')) {
    console.log('  [user] <compacted-summary> 摘要节点（替换了旧对话）')
  } else {
    console.log(`  [${msg.role}] ${msg.content.slice(0, 50)}${msg.content.length > 50 ? '...' : ''}`)
  }
}

// 校验：摘要节点位于 surface 开头，被替换的旧节点已全部消失
if (result !== null) {
  const firstSeq = session.surface.nodes[0]!
  const firstEvent = session.events[firstSeq]
  const isCheckpoint = firstEvent?.type === 'user/message' && firstEvent.content.includes(SUMMARY_OPEN_TAG)
  const oldNodesGone = result.shadowedSeqs.every(seq => !session.surface.has(seq))
  console.log(`\n  🔍 校验: surface[0] = seq ${firstSeq} (${firstEvent?.type}), 是摘要节点 = ${isCheckpoint}`)
  console.log(`  🔍 校验: 被替换的 ${result.shadowedSeqs.length} 个旧节点已全部消失 = ${oldNodesGone}`)

  // 校验工具配对仍平衡（尾部切点不能劈开工具对）
  const lastSeq = session.surface.nodes[session.surface.nodes.length - 1]!
  console.log(`  🔍 校验: 尾部切点平衡 = ${toolPairingBalancedAfter(session, lastSeq)}`)
}

console.log('\n✅ 博客8 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. 词汇表 - compaction/start|summary|end + CompactionResult（compaction/src/types.ts）')
console.log('  2. Tool-Pairing - 平衡切点不分割工具对（compaction/src/tool-pairing.ts）')
console.log('  3. 区域选择 - 保留尾部压缩头部（compaction-basic/src/region.ts）')
console.log('  4. Summarizer - 结构化摘要 + 检查点标签（compaction-basic/src/summarizer.ts）')
console.log('  5. 事务 - start → summarize → replace → end（compaction-basic/src/region.ts）')
