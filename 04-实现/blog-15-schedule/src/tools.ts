/**
 * Schedule 管理工具（dsh: packages/schedule/schedule/src/tools.ts）
 *
 * schedule_create / schedule_list / schedule_delete——模型侧工具：
 * 工具调 domain 纯函数写 schedule/change 事件，然后请求调度循环重算。
 */

import type { Agent } from './agent.ts'
import type { Context } from '@cordisjs/core'
import {
  allocateScheduleId,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  foldScheduleEvents,
  scheduleView,
} from './domain.ts'
import type { ScheduleErrorCode, ScheduleView } from './types.ts'

export interface ToolRegistryLike {
  register(tool: { name: string; description: string; execute: (args: any, exec: { agent?: Agent }) => Promise<any> }): void
}

interface ScheduleToolError { code: ScheduleErrorCode; message: string }

/** 统一错误形状（dsh: ScheduleToolError） */
function toolError(code: ScheduleErrorCode, message: string): ScheduleToolError {
  return { code, message }
}

/**
 * 注册三个管理工具。每个工具挂在 agent 自己的 ctx 上（dsh: registered through
 * the exact agent.ctx），操作后回调 requestDrive 让调度循环重算。
 */
export function registerScheduleTools(
  ctx: Context,
  tools: ToolRegistryLike,
  agent: Agent,
  requestDrive: () => void,
): void {
  tools.register({
    name: 'schedule_create',
    description: 'Create a durable reminder: one of after_seconds (delay), at (absolute instant), or every_seconds (fixed rate).',
    async execute(args) {
      const selectors = ['after_seconds', 'at', 'every_seconds'].filter(key => args[key] !== undefined)
      if (selectors.length !== 1) {
        return toolError('invalid_selector', 'exactly one of after_seconds, at, every_seconds is required')
      }
      try {
        const folded = foldScheduleEvents(agent.session.events, agent.session.meta.seedLength)
        const id = allocateScheduleId(folded)
        const now = Date.now()
        const record = args.after_seconds !== undefined
          ? createAfterScheduleRecord(id, args.prompt, args.after_seconds, now)
          : args.at !== undefined
            ? createAtScheduleRecord(id, args.prompt, args.at, now)
            : createEveryScheduleRecord(id, args.prompt, args.every_seconds, now)
        // 写 create 事件：持久化唯一真源
        agent.session.append({ type: 'schedule/change', data: { version: 1, operation: 'create', schedule: record } })
        requestDrive()  // 让调度循环重算（可能要提前装定时器）
        return scheduleView(record, now)
      } catch (error) {
        return error instanceof Error
          ? toolError((error as { code?: ScheduleErrorCode }).code ?? 'invalid_rule', error.message)
          : toolError('invalid_rule', String(error))
      }
    },
  })

  tools.register({
    name: 'schedule_list',
    description: 'List active reminders with state scheduled or overdue.',
    async execute() {
      try {
        const folded = foldScheduleEvents(agent.session.events, agent.session.meta.seedLength)
        const now = Date.now()
        return folded.active.map(record => scheduleView(record, now))
      } catch (error) {
        return toolError('corrupt_schedule_log', error instanceof Error ? error.message : String(error))
      }
    },
  })

  tools.register({
    name: 'schedule_delete',
    description: 'Delete one active reminder by its id.',
    async execute(args) {
      const id = String(args.id ?? '')
      if (id.trim().length === 0) return toolError('invalid_rule', 'id must be a non-empty string')
      try {
        const folded = foldScheduleEvents(agent.session.events, agent.session.meta.seedLength)
        if (!folded.active.some(record => record.id === id)) {
          return { id, deleted: false, code: 'schedule_not_found' }
        }
        agent.session.append({ type: 'schedule/change', data: { version: 1, operation: 'delete', id: id as any } })
        requestDrive()
        return { id, deleted: true }
      } catch (error) {
        return toolError('corrupt_schedule_log', error instanceof Error ? error.message : String(error))
      }
    },
  })
}
