/**
 * Schedule 装配（dsh: packages/schedule/schedule/src/index.ts 的简化）
 *
 * dsh 监听 agent/created 为每个后续 root agent 自动挂 runtime + 工具；
 * 这里提供显式 attachSchedule(agent)，由 main.ts 调用（语义等价：一个
 * 活着的 agent 对应一个 ScheduleRuntime）。
 */

import { Context } from '@cordisjs/core'
import type { Agent } from './agent.ts'
import { ScheduleRuntime } from './runtime.ts'
import { registerScheduleTools, ToolRegistryLike } from './tools.ts'

/**
 * 给一个 agent 挂上调度循环 + 三个管理工具。
 * @returns 卸载函数（停定时器）。
 */
export function attachSchedule(ctx: Context, agent: Agent): () => void {
  const runtime = new ScheduleRuntime(ctx, agent)
  registerScheduleTools(ctx, ctx.tools as unknown as ToolRegistryLike, agent, () => runtime.requestDrive())
  runtime.start()
  return () => runtime.dispose()
}
