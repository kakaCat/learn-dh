/**
 * 简化工具注册表 + 读写调度器（dsh: @deepseek-ai/dsh-tools 的简化）
 *
 * 对应 dsh 的两条运行时契约：
 * - 工具失败以 ToolCallError（带 toolName/message）reject，可 try/catch 续跑
 * - 独立只读调用可在 Promise.all 下重叠；写调用单独执行、按提交顺序
 */

import { Context, Service } from '@cordisjs/core'

declare module '@cordisjs/core' {
  interface Context {
    tools: ToolRegistry
  }
}

export class ToolCallError extends Error {
  readonly name = 'ToolCallError'
  constructor(
    public toolName: string,
    message: string,
  ) {
    super(message)
  }
}

export interface ToolDef {
  name: string
  /** 只读工具可并发重叠；写工具独占执行 */
  readonly: boolean
  /** 演示用：模拟工具耗时，让并发/串行在时间轴上可见 */
  delayMs?: number
  execute: (args: any) => Promise<any>
}

/** 单次工具调用的执行轨迹（用于把调度行为打印出来） */
export interface CallTrace {
  tool: string
  kind: 'read' | 'write'
  start: number
  end: number
  ok: boolean
}

/**
 * 公平读写锁：
 * - 连续的只读调用一起放行（并发重叠）
 * - 写调用等待所有已放行调用结束后单独执行
 * - 按提交顺序授予，写调用不会插队到先提交的读之前
 */
class RwScheduler {
  private readers = 0
  private writing = false
  private queue: { kind: 'read' | 'write'; grant: () => void }[] = []

  acquire(kind: 'read' | 'write'): Promise<void> {
    return new Promise((grant) => {
      this.queue.push({ kind, grant })
      this.pump()
    })
  }

  release(kind: 'read' | 'write'): void {
    if (kind === 'read') this.readers--
    else this.writing = false
    this.pump()
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]
      if (head.kind === 'read') {
        if (this.writing) return
        this.queue.shift()
        this.readers++
        head.grant()
      } else {
        if (this.writing || this.readers > 0) return
        this.queue.shift()
        this.writing = true
        head.grant()
      }
    }
  }
}

export class ToolRegistry extends Service {
  private tools = new Map<string, ToolDef>()
  private scheduler = new RwScheduler()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool)
  }

  /**
   * 调用一个工具。
   * sink 由 run_code 传入，收集本次执行内所有工具调用的轨迹。
   */
  async invoke(name: string, args: any, sink?: CallTrace[]): Promise<any> {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      throw new ToolCallError(name, `tool "${name}" not registered`)
    }
    const kind: 'read' | 'write' = tool.readonly ? 'read' : 'write'
    const start = performance.now()
    await this.scheduler.acquire(kind)
    try {
      if (tool.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, tool.delayMs))
      }
      const result = await tool.execute(args)
      sink?.push({ tool: name, kind, start, end: performance.now(), ok: true })
      return result
    } catch (error) {
      sink?.push({ tool: name, kind, start, end: performance.now(), ok: false })
      // 统一包装成 ToolCallError：用户代码可 try/catch 后续跑
      if (error instanceof ToolCallError) throw error
      throw new ToolCallError(name, error instanceof Error ? error.message : String(error))
    } finally {
      this.scheduler.release(kind)
    }
  }
}
