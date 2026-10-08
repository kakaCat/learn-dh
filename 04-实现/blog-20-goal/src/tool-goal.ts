/**
 * 模型侧 goal 工具（dsh: packages/goal/tool-goal/src/index.ts 的简化）
 *
 * get_goal / create_goal / update_goal：
 * - create_goal 只能从"直接的人类回合"创建（非人类回合和子代理被拒绝）
 * - edit / pause / resume 同样需要直接人类输入
 * - complete / blocked 允许在"当前目标的精确续跑轮"里执行（authority 二选一）
 * - blocked 需要 blocked_reason，且自动续跑轮数达到阈值（默认 3）
 */

import { Context } from '@cordisjs/core'
import type { Agent } from './agent.ts'
import type { GoalView } from './types.ts'
import { GoalId } from './types.ts'
import type { GoalRef } from './types.ts'
import type { SessionEvent } from './session.ts'

declare module '@cordisjs/core' {
  interface Context {
    tools: import('./tools.ts').ToolRegistry
  }
}

type UpdateAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked'
const UPDATE_ACTIONS: UpdateAction[] = ['edit', 'pause', 'resume', 'complete', 'blocked']

/** 工具策略：自动续跑轮里报 blocked 的最低轮数（dsh: blockedAfterConsecutiveRounds） */
export interface ToolGoalConfig {
  blockedAfterConsecutiveRounds?: number
}

type GoalToolValue =
  | { goal: null }
  | {
    goal: {
      id: string
      revision: number
      objective: string
      phase: GoalView['phase']
      roundsStarted: number
      maxGoalRounds: number
      blockedReason?: { code: string; message: string }
    }
    activation: GoalView['activation']
  }

function goalValue(goal: GoalView | undefined): GoalToolValue {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id, revision: goal.revision, objective: goal.objective, phase: goal.phase,
      roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds,
      ...goal.blockedReason === undefined ? {} : { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } },
    },
    activation: goal.activation,
  }
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

function hasRoundCap(value: number | undefined): value is number {
  return value !== undefined && value !== 0
}

function goalRef(goalId: string, revision: number): GoalRef {
  if (goalId.length === 0 || goalId !== goalId.trim()
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('goal_id must be non-empty and revision must be a positive safe integer')
  }
  return { id: GoalId(goalId), revision }
}

/** 当前回合窗口：最后一个 turn/start 之后的全部事件（dsh: openTurn） */
function openTurn(agent: Agent): SessionEvent[] {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') throw new Error('goal tools require an open model turn')
    if (boundary?.type === 'turn/start') return events.slice(index + 1)
  }
  return []
}

/** 校验调用 agent 是 live 且在跑（dsh: goalToolExecution 简化） */
function goalToolExecution(ctx: Context, exec: { agent?: Agent }): Agent {
  const agent = exec.agent
  if (agent === undefined) throw new Error('goal tools require a calling agent')
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running') {
    throw new Error('goal tools require the exact live calling agent inside its active driver')
  }
  return agent
}

/** 当前回合窗口是否有宿主认可的人类输入（dsh: hasDirectHumanInput） */
function hasDirectHumanInput(ctx: Context, agent: Agent, window: SessionEvent[]): boolean {
  if (!ctx.agents.roots().includes(agent)) return false
  return window.some(event => event.type === 'user/message' && event.data.source.kind === 'user')
}

/** 本回合是否是当前目标的精确续跑轮（dsh: isMatchingGoalRound） */
function isMatchingGoalRound(window: SessionEvent[], goal: GoalView): boolean {
  return window.some(event =>
    event.type === 'user/message'
    && event.data.source.kind === 'goal'
    && event.data.source.goalId === goal.id
    && event.data.source.revision === goal.revision
    && event.data.source.round === goal.roundsStarted)
}

type GoalToolAuthority = { kind: 'direct-human' } | { kind: 'goal-round'; goal: GoalView }

/** create/edit/pause/resume 的权威：必须是直接人类回合 */
function requireDirectHuman(ctx: Context, agent: Agent, window: SessionEvent[]): void {
  if (hasDirectHumanInput(ctx, agent, window)) return
  throw new Error('this goal operation requires a direct human turn on a top-level agent')
}

/** complete/blocked 的权威：直接人类 或 当前目标的精确续跑轮 */
function completionAuthority(ctx: Context, agent: Agent, window: SessionEvent[]): GoalToolAuthority {
  if (hasDirectHumanInput(ctx, agent, window)) return { kind: 'direct-human' }
  const goal = ctx.goals.get(agent)
  if (goal !== undefined && isMatchingGoalRound(window, goal)) return { kind: 'goal-round', goal }
  throw new Error('complete and blocked require a direct human turn or the current goal round')
}

export function setupGoalTools(ctx: Context, config: ToolGoalConfig = {}): void {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    throw new TypeError('blockedAfterConsecutiveRounds must be a positive safe integer')
  }

  ctx.tools.register({
    name: 'get_goal',
    description: '读取当前同会话目标：精确 id/revision、objective、phase、已计入续跑轮数、轮数上限、blocker reason、是否 armed。更新目标前先调用它并抄下精确 id 与 revision。',
    execute: async (_args, exec) => {
      const agent = goalToolExecution(ctx, exec)
      return goalValue(ctx.goals.get(agent))
    },
  })

  ctx.tools.register({
    name: 'create_goal',
    description: '当当前直接人类请求是应跨自动续跑轮的长目标时创建持久化目标。可从直接人类请求推断意图，无需用户说出创建目标的命令；琐碎单轮工作不要创建。拒绝非人类与子代理权威。',
    execute: async (args: { objective?: string; max_goal_rounds?: number }, exec) => {
      const agent = goalToolExecution(ctx, exec)
      requireDirectHuman(ctx, agent, openTurn(agent))
      const goal = ctx.goals.create(agent, {
        objective: args.objective ?? '',
        ...args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds },
      })
      return goalValue(goal)
    },
  })

  ctx.tools.register({
    name: 'update_goal',
    description: '更新精确的当前目标修订。edit/pause/resume 需要直接顶层人类请求；自动续跑轮中 complete/blocked 也允许。blocked 在达到最低连续轮数前被拒；模型负责判断同一阻塞条件持续多轮并在 blocked_reason 中说明。',
    execute: async (
      args: { goal_id?: string; revision?: number; action?: UpdateAction; objective?: string; max_goal_rounds?: number; blocked_reason?: string },
      exec,
    ) => {
      const agent = goalToolExecution(ctx, exec)
      const window = openTurn(agent)
      const action = args.action ?? ''
      if (!UPDATE_ACTIONS.includes(action)) throw new Error(`invalid update_goal action ${JSON.stringify(action)}`)
      const ref = goalRef(args.goal_id ?? '', args.revision ?? 0)
      const replacements = {
        ...hasText(args.objective) ? { objective: args.objective } : {},
        ...hasRoundCap(args.max_goal_rounds) ? { maxGoalRounds: args.max_goal_rounds } : {},
      }

      if (action === 'edit') {
        requireDirectHuman(ctx, agent, window)
        if (hasText(args.blocked_reason)) throw new Error('blocked_reason is valid only with action blocked')
        return goalValue(ctx.goals.edit(agent, ref, replacements))
      }
      if (action === 'pause' || action === 'resume') {
        requireDirectHuman(ctx, agent, window)
        if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds) || hasText(args.blocked_reason)) {
          throw new Error('objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked')
        }
        return goalValue(action === 'pause' ? ctx.goals.pause(agent, ref) : ctx.goals.resume(agent, ref))
      }

      const authority = completionAuthority(ctx, agent, window)
      if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds)) {
        throw new Error('objective and max_goal_rounds are valid only with action edit')
      }
      if (action === 'complete' && hasText(args.blocked_reason)) {
        throw new Error('blocked_reason is valid only with action blocked')
      }
      if (action === 'blocked' && !hasText(args.blocked_reason)) {
        throw new Error('blocked_reason is required with action blocked')
      }
      if (action === 'blocked' && authority.kind === 'goal-round'
        && authority.goal.roundsStarted < blockedAfter) {
        throw new Error(
          `blocked requires at least ${blockedAfter} consecutive goal rounds; current round is ${authority.goal.roundsStarted}`,
        )
      }
      const goal = action === 'complete'
        ? ctx.goals.complete(agent, ref)
        : ctx.goals.block(agent, ref, { code: 'model-reported', message: args.blocked_reason as string })
      const result = goalValue(goal)
      if (authority.kind === 'goal-round') {
        // dsh 在续跑轮里报 complete/blocked 时 defer 一条收尾 notice（简化：附在结果里）
        return {
          ...result,
          wrapup: action === 'complete'
            ? `目标已完成：${goal.objective}`
            : `目标已阻塞：${goal.objective} —— ${args.blocked_reason}`,
        }
      }
      return result
    },
  })
}
