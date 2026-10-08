/**
 * 简化工具注册表（dsh: @deepseek-ai/dsh-tools 的简化）
 *
 * todo_write 工具注册在这里。工具是模型与系统的接口：
 * 模型声明工具调用，框架执行，exec.agent 携带调用者。
 */

import { Context, Service } from '@cordisjs/core'
import type { Agent } from './agent.ts'

declare module '@cordisjs/core' {
  interface Context {
    tools: ToolRegistry
  }
}

export interface ToolDef {
  name: string
  description: string
  execute: (args: any, exec: { agent?: Agent; signal?: AbortSignal }) => Promise<any>
}

export class ToolRegistry extends Service {
  private tools = new Map<string, ToolDef>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(tool: ToolDef): void { this.tools.set(tool.name, tool) }
  async invoke(name: string, args: any, exec: { agent?: Agent; signal?: AbortSignal } = {}): Promise<any> {
    const tool = this.tools.get(name)
    if (tool === undefined) throw new Error(`tool "${name}" not registered`)
    return tool.execute(args, exec)
  }
}
