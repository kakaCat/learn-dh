/**
 * run_code：workflow 的唯一实现入口（dsh: tool-run-code 的简化）
 *
 * 对应 dsh 的运行时契约：
 * - code 是 async 函数体：顶层 await/return 可用，类型标注被剥离
 * - 每次调用一份全新的执行上下文；工具面投影成 tools.<name>(args)
 * - 只有 return 值与 console.log 进入输出
 * - timeoutMs 是整段执行的预算（默认 120s，上限 600s）
 * - 程序不会被自动重放
 *
 * 简化声明：真实 dsh 每次调用跑在全新 Node 进程里（进程级隔离）；
 * 这里用 new Function + 显式沙箱全局对象演示同样的"无持久状态"语义。
 */

import { Context, Service } from '@cordisjs/core'
import type { CallTrace } from './tools.ts'

declare module '@cordisjs/core' {
  interface Context {
    runCode: RunCodeService
  }
}

export interface RunCodeArgs {
  code: string
  description: string
  timeoutMs?: number
}

export interface RunCodeOutput {
  kind: 'foreground'
  result: unknown
  console: string[]
  duration: number
  calls: CallTrace[]
}

export class RunCodeService extends Service {
  static readonly DEFAULT_TIMEOUT_MS = 120_000
  static readonly MAX_TIMEOUT_MS = 600_000

  constructor(ctx: Context) {
    super(ctx, 'runCode')
  }

  async execute(args: RunCodeArgs): Promise<RunCodeOutput> {
    const timeoutMs = Math.min(
      args.timeoutMs ?? RunCodeService.DEFAULT_TIMEOUT_MS,
      RunCodeService.MAX_TIMEOUT_MS,
    )
    const start = performance.now()
    const consoleLogs: string[] = []
    const calls: CallTrace[] = []

    // 每次执行一份全新的沙箱全局对象——无持久状态，跨调用互不污染
    const sandbox = {
      tools: this.createToolsSDK(calls),
      console: {
        log: (...values: unknown[]) => {
          consoleLogs.push(values.map(String).join(' '))
        },
      },
      Promise,
      JSON,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      Date,
      Error,
      setTimeout,
    }

    // 把 code 包装成 async 函数体：顶层 await/return 由此而来
    const fn = new Function(
      ...Object.keys(sandbox),
      `return (async () => {\n${args.code}\n})()`,
    ) as (...values: unknown[]) => Promise<unknown>

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`run_code 超出执行预算（timeoutMs=${timeoutMs}），程序不会被自动重放`))
      }, timeoutMs)
    })

    try {
      const result = await Promise.race([fn(...Object.values(sandbox)), timeout])
      return {
        kind: 'foreground',
        result,
        console: consoleLogs,
        duration: Math.round(performance.now() - start),
        calls,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 把工具注册表投影成 tools.<name>(args)，并收集调用轨迹 */
  private createToolsSDK(calls: CallTrace[]): Record<string, (args: any) => Promise<any>> {
    const registry = this.ctx.tools
    const sdk: Record<string, (args: any) => Promise<any>> = {}
    for (const name of ['glob', 'read', 'write', 'fail']) {
      sdk[name] = (args: any) => registry.invoke(name, args, calls)
    }
    return sdk
  }
}
