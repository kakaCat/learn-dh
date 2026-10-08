/**
 * [tool-todo] todo_write 工具（dsh: packages/todo/tool-todo/src/index.ts）
 *
 * 模型侧工具：agent 的完整任务列表，每次调用整表替换。
 * - 每次调用写 todo/write 事件（全量快照）到调用者 session 日志（last-write-wins）
 * - 无部分更新、无逐项编辑——模型每次发整个列表
 * - 单 owner：必须有 exec.agent（非 agent 调用无处写列表，拒绝）
 * - allowParallelInProgress：部署选择是否允许多个 in_progress
 */

import type { Context } from '@cordisjs/core'
import type { Agent } from './agent.ts'
import type { TodoItem, TodoToolConfig } from './types.ts'
import { TODO_STATUSES } from './types.ts'

/** 工具描述（dsh: describe）——active 子句按并行策略变化 */
function describe(allowParallel: boolean): string {
  const head = 'Record and update a structured task list for the current work. Send the ENTIRE '
    + 'list every call — it REPLACES the previous list (there are no partial updates, '
    + 'no per-item edits). Use it to plan multi-step work and show progress: add one '
    + 'todo per concrete step before you start. '
  const active = allowParallel
    ? 'Mark every todo being actively worked on `in_progress` — several at once when work '
      + 'genuinely runs in parallel, one for sequential work. '
    : 'Keep AT MOST ONE todo `in_progress` at a time. '
  const tail = 'Mark a todo `completed` the moment it is done (do not batch completions). '
    + 'Statuses: `pending` (not started), `in_progress` (being worked on now), `completed` (finished).'
  return head + active + tail
}

/**
 * 校验 schema 表达不了的值约束（dsh: toTodoList）：
 * content 非空唯一；allowParallel=false 时最多一个 in_progress。
 */
function toTodoList(raw: Array<{ content: string; status: string }>, allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) throw new Error('invalid todo: `content` must be a non-empty string')
    if (seen.has(content)) throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  if (!allowParallel && active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  }
  return todos
}

/** 从日志取当前 todo 列表（重放 last-write-wins）——dsh: fold 最后一条 todo/write */
export function currentTodos(events: readonly Array<{ type: string; data?: any }>): TodoItem[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'todo/write') return e.data.todos as TodoItem[]
  }
  return null
}

/**
 * 注册 todo_write 工具（dsh: apply）。
 * @param ctx - 带 tools 的上下文
 * @param config - 部署的 todo 策略（allowParallelInProgress 必填）
 */
export function registerTodoTool(ctx: Context, config: TodoToolConfig): void {
  const allowParallel = config.allowParallelInProgress
  ctx.tools.register({
    name: 'todo_write',
    description: describe(allowParallel),
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      const agent = exec.agent
      if (!agent) {
        // 列表是 per-agent-session 状态；非 agent 调用没有所属 session，拒绝而非静默
        throw new Error('todo_write requires an owning agent session')
      }
      // 写全量快照到调用者 session（last-write-wins，UI 从事件流渲染）
      agent.session.append({ type: 'todo/write', data: { todos } })
      const count = (status: TodoItem['status']): number => todos.filter(t => t.status === status).length
      return {
        todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
        },
      }
    },
  })
}

/** 渲染计数（dsh: output.render）——compact 确认文本 */
export function renderCounts(counts: { pending: number; inProgress: number; completed: number }): string {
  return `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`
}
