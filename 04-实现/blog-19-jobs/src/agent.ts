/**
 * 最小“执行者”模型（dsh: agent 层简化）
 *
 * 真正的 dsh 里，agent 驱动器负责：启动任务（ctx.jobs.start）、
 * 轮询输出、在任务完成时把结果合并回主对话。
 * 这里只保留工具所需的身份信息：session.id 即 owner。
 */

export interface Agent {
  name: string
  session: { id: string }
}

export function createAgent(name: string): Agent {
  return { name, session: { id: name } }
}
