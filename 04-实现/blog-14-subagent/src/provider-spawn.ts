/**
 * [spawn-in-process] spawn provider（dsh: packages/subagent/subagent-spawn-in-process/src/index.ts）
 *
 * 薄封装：注册名 spawn，声明全部能力（outputSchema/depthLimit/toolFilter/persona），
 * 真正的创建委托给共享驱动 startInProcessRun（driver.ts）。
 */

import { startInProcessRun } from './driver.ts'
import type { SubagentProvider } from './types.ts'

export const spawnProvider: SubagentProvider = {
  name: 'spawn',
  capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  inheritsParentContext: false,  // 全新子代理：zero parent context
  start(request) {
    // 共享驱动：ctx.agents.create + followup + whenIdle + finalAssistantOutput
    return startInProcessRun(request)
  },
}
