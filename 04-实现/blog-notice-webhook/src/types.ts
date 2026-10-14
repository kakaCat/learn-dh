// src/types.ts
import type { SessionEventType } from "@deepseek-ai/dsh-session"

/**
 * 通知事件类型 —— 直接取 DSH 会话事件词汇表（SessionEventType）的子集。
 * 这样配置里写 events: ["turn/end"] 与 DSH 会话日志里的词汇完全一致，读者不用做二次翻译。
 *
 * `SessionEventType = keyof SessionEventMap`，而 SessionEventMap 是**可被插件合并扩展**的，
 * 所以这里用 Extract 取子集而不是硬编码字符串。
 */
export type NoticeEventType = Extract<SessionEventType, "turn/end" | "tool/result">

export type NoticeLevel = "info" | "warning" | "error" | "critical"

export interface NoticePayload {
  type: NoticeEventType
  level: NoticeLevel
  title: string
  content: string
  /** 毫秒时间戳。DSH 的会话事件里这个字段叫 `time`，这里是我们自己 payload 的字段名。 */
  timestamp: number
  sessionId?: string
  metadata?: Record<string, unknown>
}

export interface WebhookConfig {
  url: string
  /** 订阅哪些事件；不写 = 全订阅 */
  events?: NoticeEventType[]
  /** 超时毫秒，默认 5000 */
  timeout?: number
  /** 重试次数，默认 2 */
  retries?: number
  headers?: Record<string, string>
}

export interface NoticeWebhookConfig {
  webhooks: WebhookConfig[]
  enabled?: boolean
  /** 全局级别闸门 */
  minLevel?: NoticeLevel
}

// 把 NoticeService 挂到 Context 上，插件里 ctx.notice 才有类型。
// 用内联 import 而不是顶层 import，避免 types.ts 与 service.ts 互相 import 成环。
declare module "@deepseek-ai/cordis" {
  interface Context {
    notice: import("./service").NoticeService
  }
}
