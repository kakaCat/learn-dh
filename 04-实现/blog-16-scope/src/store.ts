/**
 * 博客16：Scope 模块 - ScopedLayers 分层注册表（dsh: core/scope/src/store.ts）
 *
 * 一个注册表 = 全局层 + 每作用域层。
 * - 查询不创建作用域层（peek 链盲）
 * - 沿作用域链合并（chainLayers 远祖先在前，最近作用域最后覆盖）
 * - effect 从注册上下文推导可见性和所有权
 */

import { Context } from '@cordisjs/core'
import { scopeChainOf, scopeOf, ScopeKey } from './index.ts'

/** 一个作用域对注册表的整体贡献（dsh: ScopeLayer） */
export interface ScopeLayer {
  isEmpty(): boolean
}

/**
 * 命名条目：插入序存储（dsh: NamedEntries）。
 * 每次插入返回一个幂等的精确撤销。
 */
export class NamedEntries<V> {
  private data = new Map<string, V>()

  constructor(
    private readonly duplicateError: (name: string) => Error,
  ) {}

  /** 插入一个唯一名字；重复抛调用方错误 */
  insert(name: string, value: V): () => void {
    if (this.data.has(name)) throw this.duplicateError(name)
    this.data.set(name, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.data.delete(name)
    }
  }

  get(name: string): V | undefined {
    return this.data.get(name)
  }

  has(name: string): boolean {
    return this.data.has(name)
  }

  entries(): IterableIterator<[string, V]> {
    return this.data.entries()
  }

  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * 分层注册表（dsh: ScopedLayers）：
 * 拥有一个 eager 全局层 + 惰性每作用域层。
 */
export class ScopedLayers<L extends ScopeLayer> {
  /** 全局层（context 无作用域时用） */
  readonly global: L
  private readonly scoped = new Map<ScopeKey, L>()

  constructor(
    private readonly createLayer: (scope: ScopeKey | undefined) => L,
    private readonly onChange: () => void = () => {},
  ) {
    this.global = createLayer(undefined)
  }

  /**
   * 读一个已有的精确作用域层（dsh: peek）——故意链盲：
   * 调用者要的是"这个作用域自己的贡献"（限制、守卫），不能静默吸收祖先的。
   */
  peek(scope: ScopeKey | undefined): L | undefined {
    if (scope === undefined) return undefined
    return this.scoped.get(scope)
  }

  /**
   * 沿作用域链的已有覆盖层（dsh: chainLayers）——远祖先在前，精确作用域最后。
   * 按这个顺序 layering，最近作用域有最后发言权。
   */
  chainLayers(scope: ScopeKey | undefined): L[] {
    const layers: L[] = []
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key)
      if (layer !== undefined) layers.push(layer)
    }
    return layers
  }

  /**
   * 合并视图（dsh: merge）：全局命名条目 + 沿作用域链的遮蔽，远祖先在前，
   * 最近作用域的同名条目获胜（遮蔽）。
   */
  merge<V>(scope: ScopeKey | undefined, pick: (layer: L) => NamedEntries<V>): Map<string, V> {
    const merged = new Map(pick(this.global).entries())
    for (const layer of this.chainLayers(scope)) {
      for (const [name, value] of pick(layer).entries()) merged.set(name, value)
    }
    return merged
  }

  /**
   * 在注册上下文里做一层变更（dsh: effect）：
   * 上下文决定可见性（scope）和所有权（effect 生命周期）。
   * @returns 精确的 Cordis disposer
   */
  effect(
    ctx: Context,
    action: (layer: L) => () => void,
    options: { label: string; notify?: boolean },
  ): () => void {
    const scope = scopeOf(ctx)
    const notify = options.notify ?? true

    // 找到或创建本作用域的层
    const layer = this.layerFor(scope)
    let undo: () => void
    try {
      undo = action(layer)
    } catch (error) {
      this.reclaim(scope, layer)
      throw error
    }

    // 注册到 ctx 的 effect：dispose 时撤销 + 回收空层
    return ctx.effect(
      function* (this: ScopedLayers<L>) {
        yield () => {
          undo()
          this.reclaim(scope, layer)
          if (notify) this.onChange()
        }
        if (notify) this.onChange()
      }.bind(this),
      options.label,
    )
  }

  /** 找或创建作用域层（惰性） */
  private layerFor(scope: ScopeKey | undefined): L {
    if (scope === undefined) return this.global
    const existing = this.scoped.get(scope)
    if (existing !== undefined) return existing
    const layer = this.createLayer(scope)
    this.scoped.set(scope, layer)
    return layer
  }

  /** 回收完全空的层（dsh: 只在完整聚合为空时回收） */
  private reclaim(scope: ScopeKey | undefined, layer: L): void {
    if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
  }
}
