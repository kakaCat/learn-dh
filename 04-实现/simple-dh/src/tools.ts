/**
 * Tools 模块
 *
 * 工具注册、Schema 生成、执行管道
 */

import { Context, Service, Next } from '@cordisjs/core'

// ==================== 类型定义 ====================

export interface Tool {
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, JSONSchema>
    required?: string[]
  }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

export interface JSONSchema {
  type: string
  description?: string
  enum?: string[]
  items?: JSONSchema
  properties?: Record<string, JSONSchema>
  required?: string[]
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolResult {
  id: string
  result?: unknown
  error?: string
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JSONSchema
  }
}

// ==================== 扩展 Cordis 类型 ====================

declare module '@cordisjs/core' {
  interface Events {
    'tools/pre-execute': (call: ToolCall, next: Next) => Promise<void>
    'tools/execute': (call: ToolCall, next: Next) => Promise<ToolResult>
    'tools/post-execute': (result: ToolResult, next: Next) => Promise<void>
  }

  interface Context {
    tools: ToolsService
  }
}

// ==================== Tools Service ====================

export class ToolsService extends Service {
  private tools = new Map<string, Tool>()

  constructor(ctx: Context) {
    super(ctx, 'tools', true)

    // 注册默认执行器
    this.setupDefaultExecutor()
  }

  /**
   * 注册工具
   */
  register(name: string, tool: Tool) {
    return this.ctx.effect(() => {
      this.tools.set(name, tool)

      // 返回 disposer
      return () => {
        this.tools.delete(name)
      }
    })
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /**
   * 列出所有工具
   */
  list(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * 生成 OpenAI 格式的 schemas
   */
  getSchemas(): OpenAITool[] {
    const schemas: OpenAITool[] = []

    for (const [name, tool] of this.tools) {
      schemas.push({
        type: 'function',
        function: {
          name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })
    }

    return schemas
  }

  /**
   * 执行工具（通过管道）
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      // 1. pre-execute
      await this.ctx.waterfall('tools/pre-execute', call)

      // 2. execute
      const result = await this.ctx.waterfall('tools/execute', call)

      // 3. post-execute
      await this.ctx.waterfall('tools/post-execute', result)

      return result
    } catch (error: any) {
      return {
        id: call.id,
        error: error.message,
      }
    }
  }

  /**
   * 设置默认执行器
   */
  private setupDefaultExecutor() {
    this.ctx.on('tools/execute', async (call, next) => {
      const tool = this.tools.get(call.name)
      if (!tool) {
        throw new Error(`Tool ${call.name} not found`)
      }

      try {
        const result = await tool.execute(call.args)
        return { id: call.id, result }
      } catch (error: any) {
        return { id: call.id, error: error.message }
      }
    })
  }
}

/**
 * 应用插件
 */
export function apply(ctx: Context) {
  ctx.plugin(ToolsService)

  // 添加默认的 post-execute 处理器：记录到 session
  ctx.on('tools/post-execute', async (result, next) => {
    // 获取当前 session ID（从上下文中，实际应用中可能需要更好的方式）
    const sessionId = (ctx as any)._currentSessionId
    if (sessionId && ctx.sessions) {
      ctx.sessions.append(sessionId, {
        type: 'tool/result',
        id: result.id,
        result: result.result,
        error: result.error,
        timestamp: Date.now(),
      })
    }
    await next()
  })
}
