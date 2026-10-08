/**
 * 子代理组合（dsh: subagent/src/child-agent.ts）
 *
 * 三个职责：
 * 1. 深度控制（dsh: depth.ts + resolveChildDepth）
 * 2. 委托策略固定（captureDelegatedPolicyOverrides / appendDelegatedPolicyOverrides）
 * 3. 子代理 system prompt 组装（applyChildComposition）
 *
 * 与 blog-13 的联动点：委托策略固定把 sandbox 继承、approval 钉死 never，
 * 写进子会话的 source: 'delegation' 事件。
 */

import type { Agent } from './agent.ts'
import type { Session } from './session.ts'
import type { ApprovalPolicy, SandboxMode } from './types.ts'

// ============================================================
// 深度控制（dsh: depth.ts + child-agent.ts）
// ============================================================

/** 一个 agent 的委托深度（存会话 meta，持久化） */
export function delegationDepthOf(agent: Agent): number {
  return agent.session.meta.delegationDepth
}

/**
 * 解析子代理深度：父深度 + 1，超过 maxDepth 抛错（dsh: resolveChildDepth）
 * 深度持久化在子会话 meta——恢复的会话不能假装顶层再无限委托。
 */
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new Error(`subagent depth ${childDepth} exceeds maxDepth ${maxDepth}`)
  }
  return childDepth
}

// ============================================================
// 委托策略固定（dsh: DelegatedPolicyOverrides）
// ============================================================

export interface DelegatedPolicyOverrides {
  sandboxMode: SandboxMode | undefined
  approvalPolicy: 'never' | undefined
}

/**
 * 捕获委托策略（dsh: captureDelegatedPolicyOverrides）——同步调用，
 * 委托瞬间的快照（父的后续切换属于父的未来）。
 * sandbox 继承父的显式覆盖；approval 一律 never（子代理不问用户）。
 */
export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  let sandboxMode: SandboxMode | undefined
  for (let i = parent.session.events.length - 1; i >= 0; i--) {
    const e = parent.session.events[i]!
    if (e.type === 'sandbox/mode' && e.source !== 'delegation') { sandboxMode = e.mode; break }
  }
  return { sandboxMode, approvalPolicy: 'never' }
}

/** 写进子会话（dsh: appendDelegatedPolicyOverrides）——source: 'delegation' 标记 */
export function appendDelegatedPolicyOverrides(childSession: Session, overrides: DelegatedPolicyOverrides): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append({ type: 'sandbox/mode', mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append({ type: 'approval/policy', policy: overrides.approvalPolicy, source: 'delegation' })
  }
}

// ============================================================
// 子代理 system prompt 组装（dsh: applyChildComposition）
// ============================================================

/** 子代理固定权限声明（dsh: SUBAGENT_DELEGATION_CONTEXT，system prompt 注入） */
export const SUBAGENT_DELEGATION_CONTEXT = 'You are a delegated subagent: your permission scope was fixed when you were started '
  + 'and cannot be widened from inside this session — operations that require approval are rejected automatically.'

/** 子代理的个性化组合（dsh: ChildComposition） */
export interface ChildComposition {
  persona?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
}

/**
 * 组装子代理（dsh: applyChildComposition）——回答"子代理有自己的提示词吗"：
 * 1. 继承父的预设（dsh: agentPresets.composeFrom——父的 system prompt 公共段）
 * 2. 注入固定权限声明（order 120 的 runtime context）
 * 3. persona 覆盖（order 0 的 shadowing section，可选）
 * 全部注册在子代理自己的作用域，父和兄弟看不见。
 */
export function applyChildComposition(child: Agent, parent: Agent, composition: ChildComposition): void {
  child.systemPrompt = [...parent.systemPrompt]              // 1. 继承父预设
  child.systemPrompt.push(SUBAGENT_DELEGATION_CONTEXT)        // 2. 固定权限声明
  if (composition.persona !== undefined) {
    child.systemPrompt.push(`Persona: ${composition.persona}`) // 3. persona 覆盖
  }
}
