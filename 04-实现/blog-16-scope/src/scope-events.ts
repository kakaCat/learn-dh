/**
 * 博客16：Scope 模块 - 作用域事件系统（教学演示用）
 *
 * dsh 用 Cordis 事件 + scopeTarget carrier 实现作用域过滤（scope-filtered
 * dispatch）。这里用一个简化但语义一致的事件总线：监听器带作用域标签，
 * emit 按 scopeTarget 的过滤语义派发——父收子，子不收父，兄弟互不收。
 */

import { scopeChainOf, ScopeKey, scopeParentOf } from './index.ts'

type Listener = (payload: any) => void

interface RegisteredListener {
  scope: ScopeKey | undefined   // undefined = 全局监听器
  handler: Listener
}

export class ScopeEventBus {
  private listeners: RegisteredListener[] = []

  /** 注册监听器（scope = undefined 表示全局） */
  on(scope: ScopeKey | undefined, handler: Listener): () => void {
    this.listeners.push({ scope, handler })
    return () => {
      this.listeners = this.listeners.filter(l => !(l.scope === scope && l.handler === handler))
    }
  }

  /**
   * 发事件（带发送者作用域）——scopeTarget 过滤语义：
   * - 全局监听器（无 scope）：接收所有
   * - 有 scope 的监听器：接收「自己或祖先作用域」发出的事件
   *   即发送者的祖先链（含自己）里包含监听器 scope → 父监听器收子事件
   */
  emit(fromScope: ScopeKey | undefined, payload: any): void {
    for (const listener of this.listeners) {
      if (this.shouldDeliver(listener.scope, fromScope)) {
        listener.handler(payload)
      }
    }
  }

  /** 监听器 scope 是否应接收来自 fromScope 的事件（dsh: scopeTarget 的 filter） */
  private shouldDeliver(listenerScope: ScopeKey | undefined, fromScope: ScopeKey | undefined): boolean {
    if (listenerScope === undefined) return true    // 全局监听器收所有
    if (fromScope === undefined) return false       // 无作用域发送者，作用域监听器不收
    // 发送者的祖先链（含自己）里找监听器 scope：找到了 = 父监听器收子事件
    for (let cursor: ScopeKey | undefined = fromScope; cursor !== undefined; cursor = scopeParentOf(cursor)) {
      if (cursor === listenerScope) return true
    }
    return false
  }
}
