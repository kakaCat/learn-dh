/**
 * goal-round-driver（dsh: packages/goal/goal-round-driver/src/index.ts 的简化实现）
 *
 * 自动续跑引擎：目标 active + armed 时，agent 静默后自动发起下一轮。
 * 核心（对应 dsh drive()）：
 *   1. 检查：目标 active + armed + 轮数有余量
 *   2. 预算耗尽：自动 block（code: round-limit），不自动重试
 *   3. 发起：round = roundsStarted + 1，返回 <goal_round> 续跑消息
 *
 * 诚实标注（未实现 dsh 完整机制）：
 *   - agent 静默事件监听（demo 手动调用 schedule）
 *   - 竞态围栏（预留身份 vs live revision 的双重校验）
 *   - 串行化合并（coalesce）、结算分类、卸载时 disarm
 */

import type { Context } from '@cordisjs/core'
import type { Agent } from './agent.ts'
import type { GoalView } from './types.ts'

/** 每轮发给模型的续跑消息（dsh: renderGoalRoundPrompt 简化） */
export function renderGoalRoundPrompt(goal: GoalView, round: number): string {
  return '<goal_round>\n'
    + `Objective: ${JSON.stringify(goal.objective)}\n`
    + `Round: ${round}/${goal.maxGoalRounds}\n\n`
    + 'Continue working toward the objective in this same session. Treat the current workspace, '
    + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
    + 'earlier narration is still current. Make concrete progress and verify the result. '
    + 'If work remains, leave the goal active for the next round.\n'
    + '</goal_round>'
}

export class GoalRoundDriver {
  private ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /**
   * agent 静默后调用：检查目标并决定是否发起下一轮（dsh: drive() 的核心）。
   * 返回 { round, prompt } 表示应发起一轮；无事可做返回 undefined
   * （目标缺失 / 非 active / 未 armed / 预算耗尽已自动 block）。
   */
  schedule(agent: Agent): { round: number; prompt: string } | undefined {
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined) return undefined
    if (goal.phase !== 'active' || goal.activation !== 'armed') return undefined
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      // 预算耗尽 → 自动阻塞（dsh: block with code round-limit），从不自动重试
      this.ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      })
      return undefined
    }
    const round = goal.roundsStarted + 1
    return { round, prompt: renderGoalRoundPrompt(goal, round) }
  }

  /** 移除进程内续跑权（dsh: disarm）——不写事件、不改 revision、不通知 */
  disarm(agent: Agent): void {
    this.ctx.goals.disarm(agent)
  }
}
