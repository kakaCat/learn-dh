/**
 * [plan-mode] PlanModeController（dsh: packages/plan/plan-mode/src/index.ts）
 *
 * Plan mode 是"记录在案的、每个 agent 的协作状态"——不是通用模式注册表：
 * - plan/mode 事件：log-only、whole-value-replace，重放恢复（resume/fork 不需要实时镜像）
 * - set(agent, active)：idle 时立即 append；running 时挂起 pending，等下次 accepted pre-step
 * - exit_plan_mode 工具：始终注册（工具目录稳定），active 才可用，经 userQuestions 审批
 * - plan:policy prompt section：active 时渲染部署配置的 guidance
 */

import { Context, Service } from '@cordisjs/core'
import type { Agent } from './agent.ts'
import { foldPlanMode, hasOpenTurn, PlanModeConfig, resolveConfig } from './domain.ts'

/** 模型侧 exit 工具名（dsh: EXIT_PLAN_MODE）——inactive 也保持注册，目录稳定 */
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** review 问题 id 与选项标签（dsh: REVIEW_ID / APPROVE_LABEL / KEEP_PLANNING_LABEL） */
const REVIEW_ID = 'plan-review'
const APPROVE_LABEL = 'Approve'
const KEEP_PLANNING_LABEL = 'Keep planning'

/** exit 工具的描述（dsh: EXIT_DESCRIPTION） */
const EXIT_DESCRIPTION
  = "Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. "
  + 'Send the COMPLETE plan as markdown, starting with a # heading that names it. '
  + 'The user may approve (carry out the plan from your next step) or keep '
  + 'planning — their feedback comes back in the tool result; revise and present again.'

/** 取 plan 的第一个 markdown 标题（任意级）——presentation 用（dsh: firstHeading） */
function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

export class PlanModeController extends Service {
  /** Cordis 依赖声明：需要 tools（注册 exit_plan_mode）、userQuestions（审批）、systemPrompt（注册片段） */
  static inject = ['tools', 'userQuestions', 'systemPrompt']

  /** 部署配置（校验后的 guidance） */
  private readonly section: string

  /**
   * 每个会话等待下一个 accepted in-turn pre-step 的最新选择。
   * narrate=true 用于用户选择（要通知模型）；false 用于 exit 工具（结果已叙述）。
   */
  private readonly pendingIntents = new WeakMap<object, { active: boolean; narrate: boolean }>()

  constructor(ctx: Context, config: PlanModeConfig = { section: '' }) {
    super(ctx, 'planMode')
    this.section = resolveConfig(config).section
    // execute 回调里 this 不是 controller 实例，先保存引用（dsh 用闭包同样处理）
    const controller = this

    // 关键：注册 plan:policy 提示词片段（dsh: systemPrompt.section order 50）
    // text 是函数——组装时按"当前 agent 的 plan 状态"决定返回 section 还是空串
    ctx.systemPrompt.section({
      name: 'plan:policy',
      order: 50,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        const pending = controller.pendingIntents.get(agent.session)
        return (pending?.active ?? foldPlanMode(agent.session.events)) ? controller.section : ''
      },
    })

    // 模拟 dsh 的 agent/pre-step：turn 开始时应用 pending 选择并写 plan/mode 事件。
    // 简化：由演示代码显式调用 applyPending()（真实 dsh 挂 agent/pre-step 钩子）。
    ctx.tools.register({
      name: EXIT_PLAN_MODE,
      description: EXIT_DESCRIPTION,
      async execute(args, exec) {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${EXIT_PLAN_MODE} requires a calling agent`)
        if (!foldPlanMode(agent.session.events)) {
          throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode`)
        }
        if (!/^#\s+\S/.test(String(args.plan ?? '').trim())) {
          throw new Error(`${EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading`)
        }
        // 经 userQuestions 审批（dsh: plan-review intent，UI 呈现为决策）
        const interaction = ctx.userQuestions
        const answer = await interaction.ask({
          questions: [{
            id: REVIEW_ID,
            question: 'Approve this plan and leave plan mode?',
            detail: String(args.plan),
            options: [
              { label: APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
              { label: KEEP_PLANNING_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
            ],
          }],
          agent,
          signal: exec.signal,
        })
        const item = answer.answers.find(entry => entry.id === REVIEW_ID)
        if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined) {
          const feedback = item?.custom ?? ''
          throw new Error(feedback === ''
            ? 'The user chose to keep planning; revise the plan and present it again.'
            : `The user chose to keep planning; their feedback: ${feedback}`)
        }
        // 通过：静默选择 inactive，下一个 accepted pre-step 应用（本 batch 内保持 guidance）
        controller.pendingIntents.set(agent.session, { active: false, narrate: false })
        return { approved: true }
      },
    })
  }

  /**
   * 应用 pending 选择（简化版 pre-step 钩子）——写 plan/mode 事件。
   * 真实 dsh 在 agent/pre-step 的 accepted 决策后调用。
   */
  applyPending(agent: Agent): void {
    const pending = this.pendingIntents.get(agent.session)
    if (pending === undefined) return
    this.pendingIntents.delete(agent.session)
    agent.session.append({ type: 'plan/mode', data: { active: pending.active } })
  }

  /**
   * 读 plan 状态（dsh: get）——logged 状态 + 待应用选择。
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = foldPlanMode(agent.session.events)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * 选择 plan 状态（dsh: set）：
   * - idle（无 open turn）：立即 append（下次 prompt 前没有 pre-step）
   * - running（open turn）：挂起 pending，等下次 accepted pre-step
   * - 重复选择当前/已 pending 状态：noop
   * @returns committed（立即记录）/ queued（等 pre-step）/ cancelled（撤销相反选择）/ noop
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? foldPlanMode(session.events)
    if (active === target) return 'noop'
    if (hasOpenTurn(session.events)) {
      this.pendingIntents.set(session, { active, narrate: true })
      return foldPlanMode(session.events) === active ? 'cancelled' : 'queued'
    }
    // idle：立即 append
    session.append({ type: 'plan/mode', data: { active } })
    return 'committed'
  }

  /** 当前是否 active（含 pending 方向）——plan:policy 渲染用（dsh: 简化） */
  shouldRender(agent: Agent): boolean {
    const pending = this.pendingIntents.get(agent.session)
    return pending?.active ?? foldPlanMode(agent.session.events)
  }

  /** 渲染 guidance（dsh: plan:policy section） */
  guidance(agent: Agent): string {
    return this.shouldRender(agent) ? this.section : ''
  }

  /**
   * 模拟 systemPrompt.section 的 text 调用（dsh: plan:policy 的注册）：
   * 组装 system prompt 时，按"当前 agent 的 plan 状态"返回 section 文本或空串。
   * @returns 这个 agent 的 plan:policy 片段贡献（active 返回 section，inactive 空）
   */
  planPolicySection(agent: Agent): { name: string; order: number; text: string } {
    return { name: 'plan:policy', order: 50, text: this.guidance(agent) }
  }
}
