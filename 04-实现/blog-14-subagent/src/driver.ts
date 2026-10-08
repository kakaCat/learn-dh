/**
 * [in-process-driver] 共享驱动：startInProcessRun
 * （dsh: packages/subagent/subagent-in-process-driver/src/index.ts）
 *
 * spawn 和 fork provider 共用的"创建 + 驱动一轮"骨架：
 * 1. 创建子代理：ctx.agents.create（同一个 context 上的新 Agent）
 * 2. 创建窗口 setup：委托策略事件 + 子代理组合（system prompt 组装）
 * 3. 驱动一轮：父 followup 投递 → whenIdle 等待 → finalAssistantOutput 读结果
 *
 * 回答"子代理在哪里执行"和"父子如何通信"两个问题。
 */

import type { Agent } from './agent.ts'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  captureDelegatedPolicyOverrides,
  resolveChildDepth,
} from './child-agent.ts'
import { finalAssistantOutput } from './subagent.ts'
import type { ContentBlock, ResolvedSubagentStartRequest, SubagentResult, SubagentRun } from './types.ts'

/** 子代理 id 计数器（简化：真实 dsh 用随机 UUID） */
let childCounter = 0

/**
 * 建立并驱动一个进程内 one-shot 子代理（dsh: startInProcessRun）。
 * @param request - 已解析的委托请求（含描述符）。
 * @returns holder 拥有的 run：result 结算 + dispose 释放。
 */
export async function startInProcessRun(
  request: ResolvedSubagentStartRequest,
): Promise<SubagentRun> {
  const parent = request.parent
  const childDepth = resolveChildDepth(parent, request.maxDepth)
  // 委托策略固定：在第一次 await 前捕获（父的后续切换属于父的未来）
  const inherited = captureDelegatedPolicyOverrides(parent)

  // 1. 创建子代理：同一个 Cordis context 上的全新 Agent（own session + own system prompt）
  //    dsh: parent.ctx.agents.create({ sessionId, meta, setup })
  const childId = `child-${parent.session.id}-${++childCounter}`
  const child = parent.ctx.agents.create(childId)
  child.session.meta = { parentSession: parent.session.id, origin: 'subagent', delegationDepth: childDepth }

  // 2. 创建窗口内的 setup（dsh: agents.create 的 setup 回调）：
  //    委托策略事件 + 子代理组合（system prompt 组装）
  appendDelegatedPolicyOverrides(child.session, inherited)
  applyChildComposition(child, parent, {
    persona: request.persona,
    toolFilter: request.toolFilter,
  })

  // 3. 驱动一轮：父投递任务 → 等子代理跑完 → 读结果
  //    dsh: child.followup(createUserMessage(...)) → child.whenIdle() → finalAssistantOutput()
  const result: Promise<SubagentResult> = (async () => {
    child.followup({ type: 'text', text: request.prompt.map(b => b.text).join('') })
    await child.whenIdle()
    const output = finalAssistantOutput(child.session)
    return { output, stopReason: 'completed' }
  })()

  return { id: childId, localAgent: child, result, dispose: async () => {} }
}
