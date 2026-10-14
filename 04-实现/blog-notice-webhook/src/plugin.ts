// src/plugin.ts
import { Context } from "@deepseek-ai/cordis"
import type { NoticeWebhookConfig, NoticePayload } from "./types"

export const name = "notice-webhook"
export const inject = ["notice"]        // 依赖注入：等 notice 服务就绪

export function apply(ctx: Context, config: NoticeWebhookConfig): void {
  if (config.enabled === false) return
  const webhooks = config.webhooks ?? []
  if (webhooks.length === 0) {
    console.warn("[notice-webhook] 未配置 webhook，插件空转")
    return
  }
  console.log("[notice-webhook] 已加载 " + webhooks.length + " 个 webhook")

  // tool/result 只带 message.toolCallId、不带工具名，所以先用 tool/call 把名字记下来。
  // 记 { name, at } 而不是只记 name：正常情况 tool/call 与 tool/result 成对，
  // 但会话中断、事件丢失时只会留下一半，不做兜底就会一直涨。
  const TOOL_NAME_TTL_MS = 10 * 60 * 1000
  const toolNames = new Map<string, { name: string; at: number }>()

  // 兜底清理：每分钟扫一次，清掉超过 TTL 还没等到 result 的记录。
  // 用 ctx.effect 注册，插件卸载时定时器自动回收。
  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [id, entry] of toolNames) {
        if (now - entry.at > TOOL_NAME_TTL_MS) toolNames.delete(id)
      }
    }, 60_000)
    timer.unref?.()        // 别让清理定时器拖住进程退出（浏览器环境没有 unref，故用可选调用）
    return () => clearInterval(timer)
  })

  // 业务规则：事件订阅过滤 + 级别闸门 + 失败不影响主流程
  function sendNotice(payload: NoticePayload): void {
    const targets = webhooks.filter((w) => {
      if (w.events === undefined || w.events.length === 0) return true
      return w.events.includes(payload.type)
    })
    if (targets.length === 0) return

    if (config.minLevel) {
      const order: NoticePayload["level"][] = ["info", "warning", "error", "critical"]
      if (order.indexOf(payload.level) < order.indexOf(config.minLevel)) return
    }

    ctx.notice.broadcast(targets, payload).catch((err) => {
      console.error("[notice-webhook] 广播失败:", err)
    })
  }

  // ============ 只监听这一个宿主事件：会话事件总线 ============
  // 签名由 @deepseek-ai/dsh-session 声明：'session/event'(session: Session, event: SessionEvent)
  // 注意第一个参数是 Session 对象（id 在 session.header.id），不是 sessionId 字符串。
  ctx.on("session/event", (session, event) => {
    const sessionId = session.header.id

    // 1) 工具调用：先记住 callId -> 工具名
    if (event.type === "tool/call") {
      toolNames.set(event.data.callId, { name: event.data.name, at: Date.now() })
      return
    }

    // 2) 工具结果：只有失败才通知；关联 id 在 message.toolCallId 里
    if (event.type === "tool/result") {
      const callId = event.data.message.toolCallId
      const entry = toolNames.get(callId)
      toolNames.delete(callId)   // 先取再删：消费掉这条记录，重复到达的同 id 结果只能回退到 "unknown"
      if (event.data.message.isError !== true) return
      const toolName = entry?.name ?? "unknown"
      const reason = event.data.error?.reason ?? event.data.error?.name ?? "未提供原因"
      sendNotice({
        type: "tool/result",
        level: "error",
        title: "❌ 工具执行失败",
        content: "工具 " + toolName + " 执行失败：" + reason,
        timestamp: event.time,
        sessionId,
        metadata: { toolName, callId, errorCode: event.data.error?.code },
      })
      return
    }

    // 3) 一轮对话结束：reason.kind 决定级别
    if (event.type === "turn/end") {
      const kind = event.data.reason.kind
      const ok = kind === "completed"
      sendNotice({
        type: "turn/end",
        level: ok ? "info" : "warning",
        title: ok ? "✅ 一轮对话结束" : "⚠️ 一轮对话中断（" + kind + "）",
        content: "会话 " + sessionId + " 的第 " + event.data.turn + " 轮结束",
        timestamp: event.time,
        sessionId,
        metadata: { turn: event.data.turn, reason: kind },
      })
    }
  })

  console.log("[notice-webhook] 已监听 session/event")
}
