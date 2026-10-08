/**
 * Todo 类型定义（dsh: packages/todo/tool-todo/src/types.ts）
 *
 * TodoItem 是 session 域的类型；todo/write 事件携带完整列表快照。
 */

/** 一条待办（dsh: TodoItem）——content + status */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 有效的 status 集合（dsh: STATUSES） */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

/** todo_write 工具的配置（dsh: Config）——必填的部署选择 */
export interface TodoToolConfig {
  /** 是否允许多个 in_progress 同时存在（并行 fan-out 用 true，单活跃纪律用 false） */
  allowParallelInProgress: boolean
}
