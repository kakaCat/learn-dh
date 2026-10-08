/**
 * Plan 域逻辑（dsh: packages/plan/plan-mode/src/index.ts 的纯函数部分）
 *
 * - foldPlanMode: 重放日志算 plan 状态（最后一条生效）
 * - resolveConfig: 部署配置校验（section 必填非空）
 * - hasOpenTurn: 是否有未闭合的 turn（set 的 idle/running 判定）
 */

import type { SessionEvent } from './session.ts'

/** 重放日志算 plan 状态（dsh: foldPlanMode）——最后一条 plan/mode 生效，无则 inactive */
export function foldPlanMode(events: readonly SessionEvent[], end = events.length): boolean {
  for (let i = end - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'plan/mode') return e.data.active
  }
  return false
}

/** 部署拥有的 plan guidance（dsh: PlanModeConfig） */
export interface PlanModeConfig {
  /** active 时渲染为 plan:policy prompt section 的指导文本 */
  section: string
}

/**
 * 校验部署配置（dsh: resolveConfig）——缺失/空/未知键在加载时 fail，不忽略。
 */
export function resolveConfig(config: PlanModeConfig): PlanModeConfig {
  const section = (config as Partial<PlanModeConfig>).section
  if (typeof section !== 'string') throw new Error('PlanModeConfig needs a string `section`')
  if (section.trim() === '') throw new Error('PlanModeConfig needs a non-empty `section`')
  const unknown = Object.keys(config).filter(key => key !== 'section')
  if (unknown.length > 0) {
    throw new Error(`PlanModeConfig has unknown key(s) ${unknown.join(', ')} — config is { section }`)
  }
  return { section }
}

/** 会话是否在未闭合的 turn 内（dsh: hasOpenTurn）——set 的 idle/running 判定 */
export function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]!.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}
