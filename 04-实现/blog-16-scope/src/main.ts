/**
 * 博客16：Scope 模块 - 作用域隔离（演示入口）
 *
 * 只做组装和演示。实现分布在 src/ 各文件，对应 dsh 的 core/scope 包：
 *   index.ts       核心：createScope / scopeOf / scopeTarget / bindScopeParent
 *   store.ts       ScopedLayers 分层注册表
 *   scope-events.ts 作用域事件系统（scopeTarget 过滤语义演示）
 *
 * 三个核心问题：
 * 1. 作用域是什么？——createScope 铸造带标记的 context
 * 2. 事件怎么路由？——scopeTarget 向上继承向下排除
 * 3. 注册怎么分层？——ScopedLayers 全局 + 每作用域层，最近遮蔽
 */

import { Context } from '@cordisjs/core'
import { ScopeKey, carrierKeyOf, createScope, isScopeCarrier, scopeChainOf, scopeOf, scopeTarget } from './index.ts'
import { NamedEntries, ScopedLayers, ScopeLayer } from './store.ts'
import { ScopeEventBus } from './scope-events.ts'

console.log('='.repeat(60))
console.log('博客16：Scope 模块 - 作用域隔离')
console.log('='.repeat(60))

let ctx = new Context()

// ============================================================
// Part 1: createScope——铸造作用域上下文
// ============================================================
console.log('\n' + '='.repeat(60))
console.log('Part 1: createScope——铸造作用域上下文')
console.log('='.repeat(60))

// 作用域键是 opaque 对象（dsh: ScopeKey = object，身份比较）
const mainKey: ScopeKey = { name: 'agent-main' }
const agentAKey: ScopeKey = { name: 'agent-a' }
const agentBKey: ScopeKey = { name: 'agent-b' }

// 铸造三个作用域：main 是根，a/b 是 main 的子
const mainScope = createScope(ctx, mainKey)
const agentAScope = createScope(ctx, agentAKey, { parent: mainKey })
const agentBScope = createScope(ctx, agentBKey, { parent: mainKey })

console.log('\n📦 铸造作用域:')
console.log(`  - agent-main（根作用域）`)
console.log(`  - agent-a（子作用域，父 = agent-main）`)
console.log(`  - agent-b（子作用域，父 = agent-main）`)

console.log('\n🔍 scopeOf 读 context 的标记:')
console.log(`  mainScope.ctx → ${scopeOf(mainScope.ctx) === mainKey ? 'agent-main' : '?'}`)
console.log(`  agentAScope.ctx → ${scopeOf(agentAScope.ctx) === agentAKey ? 'agent-a' : '?'}`)
console.log(`  原始 ctx → ${scopeOf(ctx) === undefined ? 'undefined（全局）' : '?'}`)

console.log('\n🔗 作用域链（dsh: scopeChainOf，近到远）:')
console.log(`  agent-a 的链: ${scopeChainOf(agentAKey).map(k => (k as any).name).join(' → ')}`)
console.log(`  agent-main 的链: ${scopeChainOf(mainKey).map(k => (k as any).name).join(' → ')}`)

// ============================================================
// Part 2: scopeTarget——事件路由载体（向上继承，向下排除）
// ============================================================
console.log('\n' + '='.repeat(60))
console.log('Part 2: scopeTarget——事件路由载体')
console.log('='.repeat(60))

// scopeTarget 构建一个路由载体（dsh: Scoped<T>）——携带过滤逻辑
const mainCarrier = scopeTarget({}, mainKey)
const aCarrier = scopeTarget({}, agentAKey)
console.log('\n🎯 scopeTarget 构建 carrier:')
console.log(`  mainCarrier 是 carrier: ${isScopeCarrier(mainCarrier)}，路由 key: ${(carrierKeyOf(mainCarrier) as any)?.name}`)
console.log(`  aCarrier 是 carrier: ${isScopeCarrier(aCarrier)}，路由 key: ${(carrierKeyOf(aCarrier) as any)?.name}`)

// 用 carrier 的过滤语义验证路由（dsh: scopeTarget filter）。
// 语义：carrier 的 key = 发送者作用域；filter 的参数 = 监听器 context。
// 从发送者 key 沿父链向上走，碰到监听器 tag → 父监听器收子事件（向上继承）。
console.log('\n📡 过滤语义验证（谁收谁的事件）:')
const listeners: Array<[string, Context]> = [
  ['agent-main 监听器', mainScope.ctx],
  ['agent-a 监听器', agentAScope.ctx],
  ['agent-b 监听器', agentBScope.ctx],
  ['全局监听器', ctx],
]
const emitters: Array<[string, ScopeKey]> = [
  ['agent-main 发', mainKey],
  ['agent-a 发', agentAKey],
  ['agent-b 发', agentBKey],
]
for (const [emitLabel, emitKey] of emitters) {
  const carrier = scopeTarget({}, emitKey) as any
  const cols = listeners.map(([lLabel, lCtx]) => `${lLabel}:${carrier.__scopeFilter(lCtx) ? '✅' : '❌'}`)
  console.log(`  ${emitLabel} → ${cols.join('  ')}`)
}

// ============================================================
// Part 3: 作用域事件系统（ScopeEventBus + scopeTarget 语义）
// ============================================================
console.log('\n' + '='.repeat(60))
console.log('Part 3: 作用域事件路由（父收子，子不收父，兄弟互不收）')
console.log('='.repeat(60))

const bus = new ScopeEventBus()
const received: string[] = []

// 全局监听器：接收所有
bus.on(undefined, (p) => received.push(`[global] ${p}`))
// agent-main 监听器：接收自己 + 子作用域事件（向上继承）
bus.on(mainKey, (p) => received.push(`[agent-main] ${p}`))
// agent-a 监听器：只接收自己及祖先事件
bus.on(agentAKey, (p) => received.push(`[agent-a] ${p}`))
// agent-b 监听器：只接收自己事件
bus.on(agentBKey, (p) => received.push(`[agent-b] ${p}`))

console.log('\n📢 从 agent-a 发事件...')
bus.emit(agentAKey, 'agent-a 的事件')
console.log('📢 从 agent-main 发事件...')
bus.emit(mainKey, 'agent-main 的事件')

console.log('\n📋 收到的监听器:')
for (const r of received) console.log(`  ${r}`)

// ============================================================
// Part 4: ScopedLayers——分层注册表（全局 + 每作用域层，最近遮蔽）
// ============================================================
console.log('\n' + '='.repeat(60))
console.log('Part 4: ScopedLayers——分层注册表')
console.log('='.repeat(60))

// 一个工具注册表：每层是一个 NamedEntries（名字 → 工具描述）
interface ToolEntry { name: string; allow: boolean }
class ToolLayer implements ScopeLayer {
  readonly entries = new NamedEntries<ToolEntry>(n => new Error(`duplicate tool ${n}`))
  isEmpty(): boolean { return this.entries.isEmpty() }
}

const toolLayers = new ScopedLayers<ToolLayer>(() => new ToolLayer())

// 注册到全局层（dsh: effect with 全局 context）
toolLayers.effect(ctx, (layer) => layer.entries.insert('bash', { name: 'bash', allow: true }), { label: 'global bash' })
// agent-a 专属工具 read_file（dsh: effect with agent-a 的 context）
toolLayers.effect(agentAScope.ctx, (layer) => layer.entries.insert('read_file', { name: 'read_file', allow: true }), { label: 'a read_file' })
// agent-b 遮蔽全局 bash（禁用它）
toolLayers.effect(agentBScope.ctx, (layer) => layer.entries.insert('bash', { name: 'bash', allow: false }), { label: 'b bash deny' })

console.log('\n📋 各作用域可见的工具（merge 合并视图）:')
const scopeViews: Array<[string, Context]> = [
  ['agent-a', agentAScope.ctx],
  ['agent-b', agentBScope.ctx],
  ['全局', ctx],
]
for (const [label, c] of scopeViews) {
  const merged = toolLayers.merge(scopeOf(c), (layer) => layer.entries)
  const allowed = [...merged.entries()].filter(([, t]) => t.allow).map(([n]) => n)
  const denied = [...merged.entries()].filter(([, t]) => !t.allow).map(([n]) => `${n}(遮蔽)`)
  console.log(`  ${label}: ${[...allowed, ...denied].join(', ') || '(无)'}`)
}

// ============================================================
// Part 5: 作用域生命周期（dispose 清理）
// ============================================================
console.log('\n' + '='.repeat(60))
console.log('Part 5: 作用域生命周期（dispose 清理）')
console.log('='.repeat(60))

console.log('\n🗑️  dispose agent-b 作用域（其注册被清理）...')
await agentBScope.dispose()

const mergedB = toolLayers.merge(scopeOf(agentBScope.ctx), (layer) => layer.entries)
const mergedGlobal = toolLayers.merge(undefined, (layer) => layer.entries)
console.log('  agent-b 的 bash 遮蔽已消失（回退到全局 bash）:')
console.log(`  agent-b 视图: ${[...mergedB.entries()].map(([n, t]) => `${n}(${t.allow ? '允许' : '遮蔽'})`).join(', ') || '(无)'}`)
console.log(`  全局视图: ${[...mergedGlobal.entries()].map(([n, t]) => `${n}(${t.allow ? '允许' : '遮蔽'})`).join(', ') || '(无)'}`)

// dispose 幂等：重复调用无副作用
await agentBScope.dispose()
console.log('  ✅ dispose 幂等（重复调用无副作用）')

console.log('\n✅ 博客16 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. createScope - 铸造作用域上下文（core/scope/src/index.ts）')
console.log('  2. scopeOf - 读 context 的作用域标记（index.ts）')
console.log('  3. scopeTarget + Scoped - 事件路由载体（index.ts，向上继承向下排除）')
console.log('  4. bindScopeParent / scopeChainOf - 作用域父链（index.ts）')
console.log('  5. ScopedLayers - 分层注册表 全局+每作用域（core/scope/src/store.ts）')
console.log('  6. NamedEntries - 插入序命名存储（store.ts）')
console.log('  7. effect - 注册上下文决定可见性与所有权（store.ts）')
console.log('  8. Scope.dispose - 幂等静默清理（index.ts）')
