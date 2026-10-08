/**
 * 博客16：Scope 模块 - 作用域隔离（核心）
 *
 * 按 dsh 源码（packages/core/scope/src/index.ts）结构实现：
 * - ScopeKey: opaque 身份（dsh: object，身份比较，不解析）
 * - createScope: 铸造作用域上下文（fiber + 标记）
 * - scopeOf: 读 context 的作用域标记
 * - bindScopeParent / scopeChainOf: 作用域父链（一条关系驱动两个方向）
 * - scopeTarget: 事件路由载体（carrier，向上继承向下排除）
 */

import { Context } from '@cordisjs/core'

/** 作用域键：opaque 身份（dsh: ScopeKey = object）——用对象身份比较，不解析内容 */
export type ScopeKey = object

/** 标记作用域键的 symbol（dsh: kScope） */
const kScope = Symbol('dsh.scope')

// ============================================================
// 作用域父链（dsh: scopeParents WeakMap）
// ============================================================

/**
 * 每个 key 的父作用域。一条关系驱动两个方向：
 * - 注册视图向下继承（子作用域看到祖先的层——ScopedLayers）
 * - 事件准入向上延伸（祖先标签的监听器收到后代 key 的事件——scopeTarget）
 */
const scopeParents = new WeakMap<ScopeKey, ScopeKey>()

/**
 * 绑定父作用域（dsh: bindScopeParent）——只绑一次：
 * 已绑定的 key 再绑抛错；返回的 binding 是唯一可重链的句柄。
 * 拒绝成环的链接（每个链消费者都沿父链走到根）。
 */
export function bindScopeParent(key: ScopeKey, parent: ScopeKey): { rebind(next: ScopeKey): void } {
  if (scopeParents.has(key)) {
    throw new Error('dsh-scope: scope key is already bound to a parent; re-linking requires the binding returned by the original bind')
  }
  linkScopeParent(key, parent)
  return {
    rebind(next: ScopeKey): void {
      linkScopeParent(key, next)
    },
  }
}

/** 带环检查的写（bind 和每次 rebind 共用） */
function linkScopeParent(key: ScopeKey, parent: ScopeKey): void {
  for (let cursor: ScopeKey | undefined = parent; cursor !== undefined; cursor = scopeParents.get(cursor)) {
    if (cursor === key) throw new Error('dsh-scope: scope parent link would form a cycle')
  }
  scopeParents.set(key, parent)
}

/** 读一个 key 的父作用域（dsh: scopeParentOf） */
export function scopeParentOf(key: ScopeKey): ScopeKey | undefined {
  return scopeParents.get(key)
}

/**
 * 作用域链：从 key 到根（dsh: scopeChainOf）
 * @returns 近到远：[key, parent, grandparent, ...]
 */
export function scopeChainOf(key: ScopeKey | undefined): ScopeKey[] {
  const chain: ScopeKey[] = []
  for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) chain.push(cursor)
  return chain
}

// ============================================================
// createScope：铸造作用域上下文（dsh: createScope）
// ============================================================

/** 铸造出的作用域（dsh: Scope） */
export interface Scope {
  /** 作用域上下文：通过它的注册既作用域可见又作用域生命周期 */
  ctx: Context
  /** 精确的 Cordis disposer（嵌套有序组合 effect 时用） */
  rawDispose: () => void
  /** 幂等 dispose：清理所有作用域注册（并发调用等同一完成） */
  dispose(): Promise<void>
}

/** 共享的空插件作为作用域 backing fiber（dsh: function scope() {}） */
function scopePlugin(): void {}

/**
 * 铸造一个作用域（dsh: createScope）：
 * 1. 可选绑定父作用域
 * 2. 在 ctx 上建一个 fiber（ctx.plugin），fiber 的 context 扩展带 kScope 标记
 * 3. 返回 { ctx, rawDispose, dispose }
 */
export function createScope(ctx: Context, key: ScopeKey, options?: { parent?: ScopeKey }): Scope {
  if (options?.parent !== undefined) bindScopeParent(key, options.parent)
  const fiber = ctx.plugin(scopePlugin)
  const scoped = fiber.ctx.extend({ [kScope]: key }) as Context & { [kScope]: ScopeKey }
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    rawDispose: fiber.dispose,
    // 幂等 + 静默：并发/重复调用等同一完成（dsh: quiesceFiber）
    dispose: () => (disposing ??= Promise.resolve().then(() => fiber.dispose())),
  }
}

/** 读 context 的作用域标记（dsh: scopeOf）——undefined = 全局 */
export function scopeOf(ctx: Context): ScopeKey | undefined {
  return (ctx as Context & { [kScope]?: ScopeKey })[kScope]
}

// ============================================================
// scopeTarget：事件路由载体（dsh: scopeTarget + Scoped<T>）
// ============================================================

declare const ScopedBrand: unique symbol

/**
 * 路由载体类型（dsh: Scoped<T>）：只记录主题类型，不暴露属性。
 * 事件参数携带真正的主题。
 */
export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }

/** 每个 carrier 关联的 key（存在 = 有 key 的 carrier） */
const carrierKeys = new WeakMap<object, ScopeKey | undefined>()

/**
 * 构建一个路由载体（dsh: scopeTarget）：
 * - 保留 base 已有的 Cordis filter
 * - 无标记的监听器：全局接收（tag === undefined → true）
 * - 有标记的监听器：tag 是 key 或 key 的祖先 → 接收；否则排除
 *   即：祖先标签的监听器收到后代 key 的事件（向上），后代标签不收祖先（向下排除）
 */
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const carrier = {
    // 简化：用自定义属性标记过滤（真实 dsh 用 CordisContext.filter 符号）
    __scopeFilter(ctx: Context): boolean {
      const tag = scopeOf(ctx)
      if (tag === undefined) return true               // 无标记监听器：全局接收
      if (key === undefined) return false              // 无 key 的监听器不收作用域事件
      // 事件发送者的祖先链里找 key：找到 = 祖先监听器收后代事件
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true
      }
      return false
    },
  }
  carrierKeys.set(carrier, key)
  return carrier as unknown as Scoped<T>
}

/** 判断一个值是不是 scope carrier（dsh: isScopeCarrier） */
export function isScopeCarrier(value: unknown): value is Scoped<object> {
  return typeof value === 'object' && value !== null && carrierKeys.has(value)
}

/** 读 carrier 的路由 key（dsh: carrierKeyOf） */
export function carrierKeyOf(value: unknown): ScopeKey | undefined {
  if (!isScopeCarrier(value)) return undefined
  return carrierKeys.get(value)
}
