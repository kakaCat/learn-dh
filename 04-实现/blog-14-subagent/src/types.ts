/**
 * 类型定义（dsh: subagent/src/types.ts + fs/types 的简化）
 *
 * subagent 域的共享词汇：会话事件、内容块、provider 契约、start 请求、
 * run / result / 生命周期负载。
 */

import type { Context } from '@cordisjs/core'

// ---- 会话事件（简化：subagent 域涉及 + 委托策略事件）----
export type SandboxMode = 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'ask' | 'never'

export type SessionEvent =
  | { type: 'permission/preset'; seq: number; preset: string; timestamp: number }
  | { type: 'sandbox/mode'; seq: number; mode: SandboxMode; source?: 'delegation'; timestamp: number }
  | { type: 'approval/policy'; seq: number; policy: ApprovalPolicy; source?: 'delegation'; timestamp: number }
  | { type: 'user/message'; seq: number; text: string; timestamp: number }
  | { type: 'assistant/message'; seq: number; text: string; timestamp: number }

// ---- 内容块（简化：只有 text）----
export interface ContentBlock { type: 'text'; text: string }

// ---- 子代理运行能力声明（dsh: SubagentCapabilities）----
export interface SubagentCapabilities {
  outputSchema: boolean   // 支持结构化输出 schema
  depthLimit: boolean     // 支持深度上限
  toolFilter: boolean     // 支持工具过滤
  persona: boolean        // 支持 persona 覆盖
}

// ---- 子代理 provider（dsh: SubagentProvider）——命名注册，多 provider 共存----
export interface SubagentProvider {
  name: string                       // 注册名（spawn / fork / acp ...）
  capabilities: SubagentCapabilities // 支持的能力（start 前校验）
  inheritsParentContext: boolean     // 是否继承父会话上下文（工具措辞用）
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
}

// ---- 一次委托请求（dsh: SubagentStartRequest）----
export interface SubagentStartRequest {
  label?: string             // 短展示名
  prompt: ContentBlock[]     // 交付给子代理的任务
  parent: Agent              // 发起委托的父 agent
  maxDepth?: number          // 深度上限
  outputSchema?: object      // 结构化输出 schema
  persona?: string           // 子代理身份覆盖
  toolFilter?: { allow?: string[]; deny?: string[] }
  signal?: AbortSignal
}

// 解析后的请求（含描述符快照，dsh: ResolvedSubagentStartRequest）
export interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  descriptor: { mode: 'one-shot'; provider: string; label?: string }
}

// ---- 子代理运行（dsh: SubagentRun）——holder 拥有，result 是终结结果----
export interface SubagentRun {
  id: string
  localAgent?: Agent              // 进程内子代理
  result: Promise<SubagentResult> // 终结结果（不因子代理失败而 reject）
  dispose(): Promise<void>        // 取消剩余工作、释放资源（幂等）
}

// ---- 子代理结果（dsh: SubagentResult）----
export interface SubagentResult {
  output: ContentBlock[]
  stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
}

// ---- 生命周期事件负载（dsh: SubagentRunInfo / SubagentRunEndInfo）----
export interface SubagentRunInfo { runId: string; provider: string; id: string }
export interface SubagentRunEndInfo { runId: string; provider: string; id: string; outcome: SubagentResult['stopReason'] }

// ---- Agent（dsh: Agent）——定义见 agent.ts，这里只引用类型----
import type { Agent } from './agent.ts'

// 重新导出 Agent 类型供各模块使用
export type { Agent }
