/**
 * 博客12：Persistence 模块 - 会话持久化
 *
 * 按 dsh 源码（packages/session/session-persistence*）结构实现：
 * - SessionPersistence: 抽象类（create/append/load/list）
 * - JsonlPersistence: JSONL 文件后端（每会话一个 .jsonl，append-only）
 * - 崩溃恢复: load 时检测不完整尾部，补齐缺失的 turn/step 边界
 * - 订阅持久化: 监听 session/event，批量写入（write-behind 简化版）
 */

import { Context, Service } from '@cordisjs/core'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ============================================================
// 1. Session 事件类型（复用 blog-04 的词汇，简化）
// ============================================================

type SessionEvent =
  | { type: 'turn/start'; seq: number; turn: number; timestamp: number }
  | { type: 'turn/end'; seq: number; turn: number; reason: string; timestamp: number }
  | { type: 'step/start'; seq: number; turn: number; step: number; timestamp: number }
  | { type: 'step/end'; seq: number; turn: number; step: number; timestamp: number }
  | { type: 'user/message'; seq: number; content: string; timestamp: number }
  | { type: 'assistant/message'; seq: number; content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }>; timestamp: number }
  | { type: 'tool/call'; seq: number; callId: string; name: string; arguments: string; timestamp: number }
  | { type: 'tool/result'; seq: number; callId: string; content: string; isError: boolean; timestamp: number }

// 会话头：持久化的元数据（id + 版本 + 创建时间 + 血缘）
interface SessionHeader {
  version: number
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
}

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

// ============================================================
// 2. SessionPersistence：抽象类（dsh: session-persistence/src/index.ts）
// ============================================================

/**
 * 持久化后端抽象：append-only 会话存储。
 * append 在 durability 之后 resolve（写入磁盘才算完成）；
 * load 平衡不完整的尾部，不重写已提交事件。
 */
abstract class SessionPersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /** 注册新会话的元数据（可延迟物化：没 append 过的会话不留痕） */
  abstract create(meta: SessionHeader): Promise<void>

  /** 持久化一批事件（首个事件 seq 必须等于存储的 next-seq） */
  abstract append(id: string, events: readonly SessionEvent[]): Promise<void>

  /** 加载会话（返回 header + 事件；平衡不完整尾部） */
  abstract load(id: string): Promise<{ meta: SessionHeader; events: SessionEvent[] }>

  /** 列出所有已物化的会话 */
  abstract list(): Promise<SessionHeader[]>

  /** 从指定 seq 读取（增量读取，dsh: readFrom） */
  abstract readFrom(id: string, fromSeq: number): Promise<SessionEvent[]>
}

// ============================================================
// 3. JsonlPersistence：JSONL 文件后端（dsh: session-persistence-jsonl）
// ============================================================

/**
 * JSONL 后端：每会话一个 <id>.jsonl 文件，每行一条事件。
 * - append-only：只追加，不修改
 * - 文件系统即存储：进程重启后数据还在
 * - 崩溃恢复：load 时检测不完整尾部
 */
class JsonlPersistence extends SessionPersistence {
  private root: string

  constructor(ctx: Context, root: string) {
    super(ctx)
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  /** 会话文件路径 */
  private pathOf(id: string): string {
    return join(this.root, `${id}.jsonl`)
  }

  /** 序列化一条事件为 JSON 行 */
  private serialize(event: SessionEvent): string {
    return JSON.stringify(event)
  }

  /** 反序列化一行 JSON */
  private deserialize(line: string): SessionEvent {
    return JSON.parse(line) as SessionEvent
  }

  /** 会话头也存一个文件（<id>.meta.json） */
  private metaPathOf(id: string): string {
    return join(this.root, `${id}.meta.json`)
  }

  async create(meta: SessionHeader): Promise<void> {
    // 写 meta 文件（头）；事件文件延迟到第一次 append
    writeFileSync(this.metaPathOf(meta.id), JSON.stringify(meta, null, 2))
  }

  async append(id: string, events: readonly SessionEvent[]): Promise<void> {
    // append-only：追加写，不动已有内容
    const lines = events.map(e => this.serialize(e)).join('\n') + (events.length > 0 ? '\n' : '')
    writeFileSync(this.pathOf(id), lines, { flag: 'a' })  // 'a' = append
  }

  async load(id: string): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const metaPath = this.metaPathOf(id)
    if (!existsSync(metaPath)) {
      throw new Error(`session "${id}" not found in persistence`)
    }
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SessionHeader

    const path = this.pathOf(id)
    if (!existsSync(path)) return { meta, events: [] }

    const events: SessionEvent[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      events.push(this.deserialize(line))
    }

    return { meta, events: this.balanceTail(meta, events) }
  }

  /**
   * 崩溃恢复（dsh: load balances a complete interrupted tail）：
   * 进程可能在 turn 中途崩溃——最后一条事件是不完整的 turn/step 边界。
   * load 时检测并「平衡」：补上缺失的 step/end 和 turn/end（reason: interrupted）。
   * 绝不重写已提交事件——只追加合成关闭事件。
   */
  private balanceTail(meta: SessionHeader, events: SessionEvent[]): SessionEvent[] {
    if (events.length === 0) return events
    const balanced = [...events]
    let last: SessionEvent = events[events.length - 1]!

    // 辅助：找最新的 step 编号
    const lastStep = [...events].reverse().find(e => e.type === 'step/start') as
      | { type: 'step/start'; step: number; turn: number }
      | undefined

    // 检查是否需要补 step/end
    if (last.type === 'user/message' || last.type === 'assistant/message'
      || last.type === 'tool/call' || last.type === 'tool/result'
      || last.type === 'step/start') {
      // 有 step 打开但没结束 → 补 step/end
      if (lastStep) {
        balanced.push({
          type: 'step/end', seq: balanced.length, turn: lastStep.turn, step: lastStep.step,
          timestamp: Date.now(),
        })
      }
    }

    // 检查是否需要补 turn/end
    last = balanced[balanced.length - 1]!
    const lastTurn = [...events].reverse().find(e => e.type === 'turn/start') as
      | { type: 'turn/start'; turn: number }
      | undefined
    if (lastTurn && last.type !== 'turn/end') {
      balanced.push({
        type: 'turn/end', seq: balanced.length, turn: lastTurn.turn,
        reason: 'interrupted',  // 崩溃中断标记（dsh: TurnEndReasonMap.interrupted）
        timestamp: Date.now(),
      })
    }

    // 如果补了事件，把它们持久化（合成关闭，不改已提交）
    if (balanced.length > events.length) {
      this.append(meta.id, balanced.slice(events.length)).catch(() => {})
    }

    return balanced
  }

  async list(): Promise<SessionHeader[]> {
    // 扫描 *.meta.json 文件
    const headers: SessionHeader[] = []
    if (!existsSync(this.root)) return headers
    for (const entry of readdirSync(this.root)) {
      if (!entry.endsWith('.meta.json')) continue
      headers.push(JSON.parse(readFileSync(join(this.root, entry), 'utf8')))
    }
    return headers
  }

  async readFrom(id: string, fromSeq: number): Promise<SessionEvent[]> {
    const { events } = await this.load(id)
    return events.filter(e => e.seq >= fromSeq)
  }
}

// ============================================================
// 4. 持久化订阅：监听 session/event 自动落盘（write-behind 简化版）
// ============================================================

/**
 * 订阅器：监听 session/event 事件，把新事件批量写入持久化后端。
 * 简化版：每次事件立即写；dsh 是批量 + 延迟（write-behind.ts）。
 */
class PersistenceSubscriber {
  constructor(
    private ctx: Context,
    private backend: SessionPersistence,
  ) {
    // 监听会话事件：每来一条就追加到持久化
    ctx.on('session/event', (sessionId: string, event: any) => {
      // 只持久化带 seq 的事件（session/event 广播里的事件）
      void this.persistOne(sessionId, event).catch(err => {
        console.error(`  ❌ 持久化失败: ${err.message}`)
      })
    })
  }

  private async persistOne(sessionId: string, event: any): Promise<void> {
    // 过滤掉 compaction 元事件等非持久化事件（简化：全存）
    const { seq, ...rest } = event as SessionEvent
    const persisted: SessionEvent = { seq, ...rest } as SessionEvent
    await this.backend.append(sessionId, [persisted])
  }
}

// ============================================================
// 5. 演示
// ============================================================

console.log('='.repeat(60))
console.log('博客12：Persistence 模块 - 会话持久化')
console.log('='.repeat(60))

// 持久化目录（演示用 /tmp，可重复运行）
const PERSIST_DIR = join('/tmp', `dsh-blog12-${process.pid}`)

let ctx = new Context()
await ctx.plugin(JsonlPersistence, PERSIST_DIR)

// 启动持久化订阅
new PersistenceSubscriber(ctx, ctx.sessionPersistence)

console.log(`\n📦 持久化目录: ${PERSIST_DIR}`)

// ---- Part 1: 创建会话并写入 ----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 创建会话并写入')
console.log('='.repeat(60))

const sessionId = `session-${Date.now()}`
await ctx.sessionPersistence.create({
  version: 0,
  id: sessionId,
  createdAt: Date.now(),
  cwd: '/workspace/blog-12',
})

// 模拟会话事件（dsh: session/event 广播）
function appendEvent(sessionId: string, event: Omit<SessionEvent, 'seq'>, seq: number) {
  ctx.emit('session/event', sessionId, { seq, ...event })
}

// 写入一轮完整对话（6 条事件）
appendEvent(sessionId, { type: 'turn/start', turn: 1, timestamp: Date.now() }, 0)
appendEvent(sessionId, { type: 'step/start', turn: 1, step: 1, timestamp: Date.now() }, 1)
appendEvent(sessionId, { type: 'user/message', content: 'Hello', timestamp: Date.now() }, 2)
appendEvent(sessionId, { type: 'assistant/message', content: 'Hi!', timestamp: Date.now() }, 3)
appendEvent(sessionId, { type: 'step/end', turn: 1, step: 1, timestamp: Date.now() }, 4)
appendEvent(sessionId, { type: 'turn/end', turn: 1, reason: 'completed', timestamp: Date.now() }, 5)

// 给订阅器一点时间写盘
await new Promise(resolve => setTimeout(resolve, 50))

// 验证文件
const filePath = join(PERSIST_DIR, `${sessionId}.jsonl`)
console.log(`\n📄 已写入文件: ${filePath}`)
const raw = readFileSync(filePath, 'utf8')
console.log(`  文件行数: ${raw.trim().split('\n').length}`)
console.log(`  内容预览: ${raw.split('\n')[0]}`)

// ---- Part 2: 加载会话（模拟重启）----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 加载会话（模拟进程重启后）')
console.log('='.repeat(60))

// 模拟：新 Context + 新后端实例（读同一个目录 = 重启）
let ctx2 = new Context()
await ctx2.plugin(JsonlPersistence, PERSIST_DIR)

const loaded = await ctx2.sessionPersistence.load(sessionId)
console.log(`\n📂 加载会话: ${loaded.meta.id}`)
console.log(`  事件数: ${loaded.events.length}（进程重启后数据还在！）`)
for (const event of loaded.events) {
  console.log(`  #${event.seq} ${event.type}${event.type === 'turn/end' ? ` (reason: ${event.reason})` : ''}`)
}

// ---- Part 3: 崩溃恢复 ----
console.log('\n' + '='.repeat(60))
console.log('Part 3: 崩溃恢复（进程中途崩溃）')
console.log('='.repeat(60))

// 模拟崩溃：写入一个不完整的尾部（turn 开了没关）
const crashId = `crash-${Date.now()}`
await ctx2.sessionPersistence.create({
  version: 0, id: crashId, createdAt: Date.now(),
})
// 直接写文件（不走事件，模拟「写了一半崩了」）
const crashFile = join(PERSIST_DIR, `${crashId}.jsonl`)
writeFileSync(crashFile, [
  JSON.stringify({ type: 'turn/start', seq: 0, turn: 1, timestamp: Date.now() }),
  JSON.stringify({ type: 'step/start', seq: 1, turn: 1, step: 1, timestamp: Date.now() }),
  JSON.stringify({ type: 'user/message', seq: 2, content: '崩溃前的消息', timestamp: Date.now() }),
  // ← 没有 step/end 和 turn/end（进程在这里崩了）
].join('\n') + '\n')

// 再重启一次，加载崩溃会话
let ctx3 = new Context()
await ctx3.plugin(JsonlPersistence, PERSIST_DIR)
const crashed = await ctx3.sessionPersistence.load(crashId)

console.log(`\n🔧 加载崩溃会话: ${crashId}`)
console.log(`  事件数: ${crashed.events.length}`)
for (const event of crashed.events) {
  console.log(`  #${event.seq} ${event.type}${event.type === 'turn/end' ? ` (reason: ${event.reason})` : ''}`)
}
const lastEvent = crashed.events[crashed.events.length - 1]!
console.log(`\n  🔍 尾部已平衡: 最后事件是 ${lastEvent.type}（reason: ${(lastEvent as any).reason})）——崩溃的 turn 被合成关闭`)

// ---- Part 4: 列出会话 + 增量读取 ----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 列出会话 + 增量读取')
console.log('='.repeat(60))

const sessions = await ctx3.sessionPersistence.list()
console.log(`\n📋 已持久化的会话: ${sessions.length}`)
for (const s of sessions) {
  console.log(`  - ${s.id} (createdAt: ${new Date(s.createdAt).toISOString()})`)
}

// 增量读取：从 seq 3 开始（dsh: readFrom）
const tail = await ctx3.sessionPersistence.readFrom(sessionId, 3)
console.log(`\n🔢 增量读取（seq >= 3）: ${tail.length} 条`)
for (const e of tail) {
  console.log(`  #${e.seq} ${e.type}`)
}

// ---- Part 5: 清理演示目录 ----
console.log('\n' + '='.repeat(60))
console.log('Part 5: 清理')
console.log('='.repeat(60))

const { rmSync } = await import('node:fs')
rmSync(PERSIST_DIR, { recursive: true, force: true })
console.log(`  🗑️  已清理演示目录 ${PERSIST_DIR}`)

console.log('\n✅ 博客12 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. SessionPersistence - 抽象类 create/append/load/list（session-persistence/src/index.ts）')
console.log('  2. JsonlPersistence - JSONL 后端，每会话一个文件（session-persistence-jsonl/src/index.ts）')
console.log('  3. balanceTail - 崩溃恢复：补平衡不完整尾部（index.ts 的 load 语义）')
console.log('  4. readFrom - 增量读取（index.ts 的 readFrom）')
console.log('  5. PersistenceSubscriber - 订阅 session/event 自动落盘（write-behind 简化版）')
