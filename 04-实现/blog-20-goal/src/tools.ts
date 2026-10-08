/**
 * 简化工具注册表（dsh: @deepseek-ai/dsh-tools 的简化）
 *
 * get_goal / create_goal / update_goal 注册在这里（dsh: tool-goal）。
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
  execute: (args: any, exec: { agent?: Agent; turnEvents?: import('./session.ts').SessionEvent[] }) => Promise<any>
}

export class ToolRegistry extends Service {
  private tools = new Map<string, ToolDef>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(tool: ToolDef): void { this.tools.set(tool.name, tool) }
  async invoke(name: string, args: any, exec: { agent?: Agent; turnEvents?: import('./session.ts').SessionEvent[] } = {}): Promise<any> {
    const tool = this.tools.get(name)
    if (tool === undefined) throw new Error(`tool "${name}" not registered`)
    return tool.execute(args, exec)
  }
}
