/**
 * [subagent] 服务定义：SubagentRuntime（dsh: packages/subagent/subagent/src/index.ts）
 *
 * 命名 provider 注册表 + start API + 生命周期事件。
 * 与 bash 单 executor 不同：多个 provider 共存、按名选择
 * （dsh: "mirrors the LLM adapter registry, not the single-service bash executor"）。
 */

import { Context, Service } from '@cordisjs/core'
import type { Agent } from './agent.ts'
import { resolveChildDepth } from './child-agent.ts'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentRunEndInfo,
  SubagentRunInfo,
  SubagentStartRequest,
} from './types.ts'

declare module '@cordisjs/core' {
  interface Context {
    subagents: SubagentRuntime
  }

  interface Events {
    'subagent/provider-added'(provider: SubagentProvider): void
    'subagent/provider-removed'(name: string): void
    'subagent/start'(info: SubagentRunInfo): void
    'subagent/end'(info: SubagentRunEndInfo): void
  }
}

/** 从子会话日志读最终输出：最后一条 assistant 消息（dsh: finalAssistantOutput） */
export function finalAssistantOutput(session: { events: Array<{ type: string; text?: string }> }): { type: 'text'; text: string }[] {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i]!
    if (e.type === 'assistant/message' && e.text !== undefined) return [{ type: 'text', text: e.text }]
  }
  return []
}

/**
 * 子代理运行时（dsh: SubagentRuntime）：
 * 命名 provider 注册表 + 能力校验 + 深度校验 + start + 生命周期事件。
 */
export class SubagentRuntime extends Service {
  private providers = new Map<string, SubagentProvider>()
  constructor(ctx: Context) { super(ctx, 'subagents') }

  /**
   * 注册 provider（dsh: registerProvider）——effect 作用域，HMR 安全。
   * 重复名抛 DUPLICATE_PROVIDER。
   */
  registerProvider(provider: SubagentProvider): () => void {
    if (this.providers.has(provider.name)) {
      throw new Error(`a subagent provider named "${provider.name}" is already registered`)
    }
    this.providers.set(provider.name, provider)
    this.ctx.emit('subagent/provider-added', provider)
    return () => {
      this.providers.delete(provider.name)
      this.ctx.emit('subagent/provider-removed', provider.name)
    }
  }

  /** 按名查 provider（dsh: getProvider） */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /** 已注册 provider 名（插入序，dsh: list） */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * 发起一次委托（dsh: start）：
   * 1. 查 provider（NO_PROVIDER）
   * 2. 能力校验（请求的 outputSchema/depthLimit 等，provider 不支持 → UNSUPPORTED_CAPABILITY）
   * 3. 深度校验（resolveChildDepth）
   * 4. 快照描述符 → provider.start
   * 5. 生命周期观测（subagent/start + subagent/end）
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.expectProvider(name)
    this.assertCapabilities(provider, request)
    resolveChildDepth(request.parent, request.maxDepth)
    const descriptor = {
      mode: 'one-shot' as const,
      provider: name,
      ...request.label !== undefined ? { label: request.label } : {},
    }
    const resolved: ResolvedSubagentStartRequest = { ...request, descriptor }
    const run = await provider.start(resolved)
    const info: SubagentRunInfo = { runId: run.id, provider: name, id: run.id }
    this.ctx.emit('subagent/start', info)
    void run.result.then((outcome) => {
      this.ctx.emit('subagent/end', { ...info, outcome: outcome.stopReason })
    })
    return run
  }

  /** 查 provider 或抛错（dsh: expectProvider） */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new Error(`no subagent provider registered for "${name}"`)
    }
    return provider
  }

  /** 拒绝 provider 不支持的请求能力（dsh: assertCapabilities） */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    const needs: Array<{ when: boolean; cap: keyof SubagentCapabilities }> = [
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
      { when: request.toolFilter !== undefined, cap: 'toolFilter' },
      { when: request.persona !== undefined, cap: 'persona' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new Error(`subagent provider "${provider.name}" does not support the "${cap}" capability`)
      }
    }
  }
}
