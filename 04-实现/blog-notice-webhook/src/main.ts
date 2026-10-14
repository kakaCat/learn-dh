// src/main.ts —— 本地演练脚本（不属于插件本体，也不是 DSH 的加载路径）
// 真实运行时：插件由 DSH 的 Loader 装进 profile，会话事件由 SessionService 广播。
// 这里伪造一个 Session 和几条会话事件，让 demo 能离线把完整逻辑跑一遍。
import { Context } from "@deepseek-ai/cordis"
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session"
import { NoticeService } from "./service"
import { apply as noticeWebhook, inject, name } from "./plugin"
import type { NoticeWebhookConfig } from "./types"

// 用假的 fetch 顶替真实网络：demo 离线也能看到 webhook 收到了什么
const received: any[] = []
globalThis.fetch = (async (url: any, init: any) => {
  const body = JSON.parse(String(init?.body ?? "{}"))
  received.push({ url: String(url), body })
  console.log("  📨 " + String(url) + " 收到：" + body.title)
  console.log("     正文：" + String(body.content))
  return new Response("{\"ok\":true}", { status: 200 })
}) as typeof fetch

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const app = new Context()

  // 第一步：注册服务（能力提供者）
  await app.plugin(NoticeService)

  // 第二步：安装插件（能力消费者），插件自己声明 inject: ["notice"]
  const config: NoticeWebhookConfig = {
    webhooks: [
      { url: "https://dingtalk.example.com/robot/send", events: ["turn/end"] },
      { url: "https://slack.example.com/hooks/xxx", events: ["tool/result"] },
    ],
    minLevel: "info",
  }
  await app.plugin({ name, inject, apply: noticeWebhook }, config)

  // 第三步：伪造 DSH 的 Session 与会话事件（仅本地演练用）
  // DSH 的事件信封是 { type, seq, time, data }，负载在 data 里。
  const session = { header: { id: "session-001", cwd: process.cwd() } } as unknown as Session
  let seq = 1
  const emit = (type: string, data: unknown) =>
    app.emit("session/event", session, { type, seq: seq++, time: Date.now(), data } as SessionEvent)

  console.log("")
  console.log("▶ 模拟一轮对话：工具失败 → 一轮结束")

  emit("tool/call", { turn: 1, step: 1, callId: "call-1", name: "write_file", arguments: "{\"path\":\"/root/x\"}" })
  await delay(20)
  emit("tool/result", {
    turn: 1,
    step: 1,
    message: { role: "tool", toolCallId: "call-1", isError: true, content: [] },
    error: { name: "EPERM", code: "EPERM", reason: "Permission denied" },
  })
  await delay(20)
  emit("turn/end", { turn: 1, reason: { kind: "completed" } })
  await delay(20)

  console.log("")
  console.log("累计发出 " + received.length + " 条通知")
}

main().catch(console.error)
