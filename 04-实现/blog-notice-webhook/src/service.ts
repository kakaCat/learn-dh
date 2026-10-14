// src/service.ts
import { Context, Service } from '@deepseek-ai/cordis'
import type { NoticePayload, WebhookConfig } from './types'

/** HTTP 发送结果 */
interface SendResult {
  success: boolean
  statusCode?: number
  error?: string
  duration: number
}

/**
 * NoticeService：通知发送服务
 * 
 * 职责：
 * 1. 发送 HTTP POST 到 Webhook
 * 2. 重试逻辑（失败自动重试）
 * 3. 错误容错（绝不抛异常到调用方）
 * 4. 性能监控（记录耗时）
 */
export class NoticeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'notice')
  }

  /**
   * 发送通知到单个 Webhook
   * 
   * @param webhook Webhook 配置
   * @param payload 通知内容
   * @returns 发送结果（永远返回，不抛异常）
   */
  async send(webhook: WebhookConfig, payload: NoticePayload): Promise<SendResult> {
    const started = Date.now()
    const timeout = webhook.timeout ?? 5000
    const maxRetries = webhook.retries ?? 2

    // 尝试发送（带重试）
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'dsh-notice-webhook/1.0',
            ...webhook.headers,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        const duration = Date.now() - started
        
        if (response.ok) {
          return { success: true, statusCode: response.status, duration }
        } else {
          // HTTP 错误状态码
          const error = `HTTP ${response.status}: ${response.statusText}`
          if (attempt < maxRetries) {
            console.warn(`[NoticeService] 发送失败 (尝试 ${attempt + 1}/${maxRetries + 1}): ${error}`)
            await this.delay(1000 * 2 ** attempt)  // 指数退避：1s、2s、4s
            continue
          }
          return { success: false, statusCode: response.status, error, duration }
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err)
        
        if (attempt < maxRetries) {
          console.warn(`[NoticeService] 发送异常 (尝试 ${attempt + 1}/${maxRetries + 1}): ${error}`)
          await this.delay(1000 * 2 ** attempt)
          continue
        }
        
        const duration = Date.now() - started
        return { success: false, error, duration }
      }
    }

    // 理论上不会到这里（循环会 return）
    return { success: false, error: 'Unknown error', duration: Date.now() - started }
  }

  /**
   * 批量发送到多个 Webhook（并发）
   * 
   * @param webhooks Webhook 配置列表
   * @param payload 通知内容
   */
  async broadcast(webhooks: WebhookConfig[], payload: NoticePayload): Promise<void> {
    const promises = webhooks.map(webhook => this.send(webhook, payload))
    const results = await Promise.all(promises)

    // 记录结果（但不影响主流程）
    results.forEach((result, index) => {
      const webhook = webhooks[index]
      if (result.success) {
        console.log(`[NoticeService] ✅ 通知发送成功: ${webhook.url} (${result.duration}ms)`)
      } else {
        console.error(`[NoticeService] ❌ 通知发送失败: ${webhook.url} - ${result.error}`)
      }
    })
  }

  /** 延迟工具（用于重试退避） */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Context.notice 的类型增强统一在 types.ts 里声明（见该文件末尾），此处不重复
