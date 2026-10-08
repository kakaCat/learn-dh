/**
 * 博客9：System Prompt 模块 - 提示词组装
 *
 * 按 dsh 源码（packages/core/system-prompt/src/index.ts）结构实现：
 * - SystemPrompt Service: ctx.systemPrompt
 * - section(): 注册有序提示片段（order 排序，-100 是 harness 身份，0 是 persona）
 * - context(): 注册动态上下文（runtime context 快照）
 * - variable(): 注册变量（{{name}} 插值）
 * - tools(): 注册工具 schema 提供方
 * - assemble(): 组装（全局 + 作用域分层、排序、waterfall 扩展）
 * - renderPrompt(): 渲染（变量插值、去空段、空行连接）
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 1. 类型定义（dsh: index.ts 的 PromptSection / PromptContext / PromptAssembly）
// ============================================================

// 一段提示词片段：名字 + 顺序 + 文本（静态或按上下文求值）
interface PromptSection {
  name: string
  order: number  // 升序拼接；-100 是 harness 身份，0 是 persona
  text: string | ((context: AssembleContext) => string)
  complete?: boolean  // 视作完整提示词（组装后只保留它）
}

// 动态上下文片段：同样有名字和顺序
interface PromptContext {
  name: string
  order: number
  text: string | ((context: AssembleContext) => string)
}

// 组装上下文：scope 作用域 + 取消信号
interface AssembleContext {
  scope?: string
  signal?: AbortSignal
}

// 工具 schema 提供方的返回
interface ToolProviderResult {
  schemas: ToolSchema[]
}

// 工具 schema（OpenAI 格式的简化版）
interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// 组装结果：片段 + 上下文 + 工具 + 变量（都未插值，渲染时才插）
interface PromptAssembly {
  sections: Array<{ name: string; text: string }>
  contexts: Array<{ name: string; text: string }>
  tools: ToolSchema[]
  variables: Record<string, string | undefined>
}

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Events {
    // 组装瀑布：监听器可以修改/替换整个 assembly（洋葱模型）
    'system-prompt/assemble': (
      assembly: PromptAssembly,
      context: AssembleContext,
      next: () => Promise<PromptAssembly>,
    ) => Promise<PromptAssembly>
    // 任何提示词提供方变化时广播
    'system-prompt/change': () => void
  }

  interface Context {
    systemPrompt: SystemPrompt
  }
}

// ============================================================
// 2. 变量插值（dsh: interpolate）
// ============================================================

// 合法变量名：小写字母开头，后续字母/数字/下划线
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

// 插值 {{name}} 引用：未知变量、无值变量、畸形引用都会抛错
function interpolate(
  input: { name: string; text: string },
  variables: Record<string, string | undefined>,
  kind: 'section' | 'context',
): string {
  const text = input.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    // 找到完整的 {{...}} 组
    const close = text.indexOf('}}', open + 2)
    if (close < 0) {
      // 只有 {{ 没有 }}：视为普通文字
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = text.slice(open + 2, close)
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}"`)
    }
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"`)
    }
    const value = variables[name]
    if (value === undefined) {
      throw new Error(`prompt variable "{{${name}}}" has no value for this assembly (${kind} "${input.name}")`)
    }
    result += text.slice(last, open) + value
    last = close + 2
  }
  return result + text.slice(last)
}

// ============================================================
// 3. SystemPrompt Service（dsh: SystemPrompt class）
// ============================================================

// 配置：harness 身份 / runtime context / persona / 工具排序
interface SystemPromptConfig {
  includeHarnessIdentity?: boolean
  includeRuntimeContext?: boolean
  persona?: string
  toolOrder?: string[]
}

class SystemPrompt extends Service {
  // 全局注册表（简化版：dsh 里还有 scope 分层，这里只做全局 + 一个可选的 scope）
  private sections = new Map<string, PromptSection>()
  private contexts = new Map<string, PromptContext>()
  private variables = new Map<string, (context: AssembleContext) => string | undefined>()
  private toolProviders: Array<(context: AssembleContext) => ToolProviderResult> = []
  private runtimeContextSuppressed = false
  private toolOrder: string[] | undefined

  constructor(ctx: Context, config: SystemPromptConfig = {}) {
    super(ctx, 'systemPrompt')
    this.toolOrder = config.toolOrder

    // 内置两个片段：harness 身份（-100）+ persona（0）
    if (config.includeHarnessIdentity ?? true) {
      this.section({
        name: 'harness:identity',
        order: -100,
        text: 'You are an AI agent powered by DeepSeek Harness.',
      })
    }
    this.section({
      name: 'deployment:persona',
      order: 0,
      text: config.persona ?? '',
    })
    this.runtimeContextSuppressed = !(config.includeRuntimeContext ?? true)
  }

  /**
   * 注册一个有序提示片段（dsh: section）
   * 同名重复注册抛错；返回 effect disposer（插件卸载自动移除）
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    if (this.sections.has(section.name)) {
      throw new Error(`prompt section "${section.name}" is already registered`)
    }
    // 用 effect 管理生命周期：dispose 时自动移除
    return this.ctx.effect(() => {
      this.sections.set(section.name, section)
      this.ctx.emit('system-prompt/change')
      return () => {
        this.sections.delete(section.name)
        this.ctx.emit('system-prompt/change')
      }
    })
  }

  /**
   * 注册动态上下文（dsh: context）
   */
  context(context: PromptContext): () => void {
    if (!Number.isFinite(context.order)) {
      throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
    }
    if (this.contexts.has(context.name)) {
      throw new Error(`prompt context "${context.name}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.contexts.set(context.name, context)
      this.ctx.emit('system-prompt/change')
      return () => {
        this.contexts.delete(context.name)
        this.ctx.emit('system-prompt/change')
      }
    })
  }

  /**
   * 注册提示变量（dsh: variable）{{name}} 插值用
   */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}"`)
    }
    if (this.variables.has(name)) {
      throw new Error(`prompt variable "${name}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.variables.set(name, provider)
      this.ctx.emit('system-prompt/change')
      return () => {
        this.variables.delete(name)
        this.ctx.emit('system-prompt/change')
      }
    })
  }

  /**
   * 注册工具 schema 提供方（dsh: tools）
   */
  tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
    return this.ctx.effect(() => {
      this.toolProviders.push(provider)
      this.ctx.emit('system-prompt/change')
      return () => {
        this.toolProviders.splice(this.toolProviders.indexOf(provider), 1)
        this.ctx.emit('system-prompt/change')
      }
    })
  }

  /**
   * 组装提示词（dsh: assemble）
   * 1. 求值所有变量
   * 2. 收集所有片段，按 order 升序排序
   * 3. 收集所有上下文，按 order 排序（除非被 suppress）
   * 4. 收集工具 schema（按 toolOrder 排序）
   * 5. 跑 system-prompt/assemble 瀑布（监听器可修改）
   * 6. 若有 complete 片段，只保留它
   */
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    // 1. 求值变量
    const variables: Record<string, string | undefined> = {}
    for (const [name, provider] of this.variables) {
      variables[name] = provider(context)
    }

    // 2. 片段：按 order 升序
    const sections = [...this.sections.values()]
      .sort((a, b) => a.order - b.order)
      .map(section => ({
        name: section.name,
        text: typeof section.text === 'function' ? section.text(context) : section.text,
      }))

    // complete 校验：多个 complete 片段报错
    const completeSections = [...this.sections.values()].filter(s => s.complete === true)
    if (completeSections.length > 1) {
      throw new Error(`multiple complete prompt sections are active: ${completeSections.map(s => s.name).join(', ')}`)
    }

    // 3. 上下文（除非被 suppress）
    const contexts = this.runtimeContextSuppressed
      ? []
      : [...this.contexts.values()]
        .sort((a, b) => a.order - b.order)
        .map(entry => ({
          name: entry.name,
          text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
        }))

    // 4. 工具 schema
    const collected: ToolSchema[] = []
    for (const provider of this.toolProviders) {
      collected.push(...provider(context).schemas)
    }
    const tools = this.orderTools(collected)

    const assembly: PromptAssembly = { sections, contexts, tools, variables }

    // 5. 组装瀑布：监听器可以修改/替换整个 assembly
    const transformed = await this.ctx.waterfall(
      'system-prompt/assemble', assembly, context,
      () => Promise.resolve(assembly),
    )

    // 6. complete 片段兜底
    if (completeSections.length === 1) {
      return { ...transformed, sections: [{
        name: completeSections[0]!.name,
        text: typeof completeSections[0]!.text === 'function'
          ? (completeSections[0]!.text as any)(context)
          : (completeSections[0]!.text as string),
      }] }
    }
    return transformed
  }

  /** 按 toolOrder 排序工具（未列出的按名字字典序排最后） */
  private orderTools(tools: ToolSchema[]): ToolSchema[] {
    if (this.toolOrder === undefined) return [...tools].sort((a, b) => a.name.localeCompare(b.name))
    const listed = this.toolOrder
    const rest = tools.filter(t => !listed.includes(t.name)).sort((a, b) => a.name.localeCompare(b.name))
    const ordered = listed
      .map(name => tools.find(t => t.name === name))
      .filter((t): t is ToolSchema => t !== undefined)
    return [...ordered, ...rest]
  }
}

// ============================================================
// 4. 渲染（dsh: renderPrompt / renderContextSnapshot）
// ============================================================

/**
 * 渲染提示词：插值变量 → 去掉空片段 → 空行连接
 */
function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map(section => interpolate(section, assembly.variables, 'section'))
    .filter(text => text.length > 0)
    .join('\n\n')
}

/**
 * 渲染动态上下文快照（dsh: renderContextSnapshot）
 * 带「Current runtime context」前缀，声明它取代早前的快照
 */
function renderContextSnapshot(assembly: PromptAssembly): string {
  const sections = assembly.contexts
    .map(context => ({ name: context.name, text: interpolate(context, assembly.variables, 'context') }))
    .filter(section => section.text.length > 0)
  const body = sections.map(s => s.text).join('\n\n')
  if (body.length === 0) return ''
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

// ============================================================
// 5. 演示
// ============================================================

console.log('='.repeat(60))
console.log('博客9：System Prompt 模块 - 提示词组装')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(SystemPrompt, {
  includeHarnessIdentity: true,
  includeRuntimeContext: true,
  persona: '你是一个专业的 TypeScript 编码助手，帮助用户实现 DeepSeek Harness。',
})

// ---- Part 1: 片段注册与排序 ----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 片段注册与排序')
console.log('='.repeat(60))

// 内置片段：harness:identity(-100) + deployment:persona(0)
// 注册工具使用规则（order 100，工具提示约定用 100-199）
ctx.systemPrompt.section({
  name: 'tool:usage-rules',
  order: 100,
  text: '工具使用规则：\n- 需要执行命令时使用 bash 工具\n- 需要读取文件时使用 read_file 工具\n- 每次工具调用后检查结果再决定下一步',
})

// 注册行为准则（order 200）
ctx.systemPrompt.section({
  name: 'behavior:rules',
  order: 200,
  text: '行为准则：\n- 回答要简洁、准确\n- 不确定时明确说明\n- 代码要附带注释',
})

console.log('📋 已注册片段（按 order 排序）:')
const assembly1 = await ctx.systemPrompt.assemble()
// order 值（简化标注；真实实现里 order 在 section 定义上）
const orders = new Map<string, number>([
  ['harness:identity', -100],
  ['deployment:persona', 0],
  ['runtime:info', 50],
  ['tool:usage-rules', 100],
  ['behavior:rules', 200],
])
for (const section of assembly1.sections) {
  const order = orders.get(section.name) ?? '?'
  console.log(`  [order ${order}] ${section.name}: ${section.text.split('\n')[0]}`)
}

console.log('\n📝 渲染结果:')
console.log(renderPrompt(assembly1))

// ---- Part 2: 变量插值 ----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 变量插值')
console.log('='.repeat(60))

// 注册变量：当前工作目录 + 用户语言
ctx.systemPrompt.variable('cwd', () => '/workspace/blog-09-system-prompt')
ctx.systemPrompt.variable('language', () => 'Chinese')

// 在片段里引用变量
ctx.systemPrompt.section({
  name: 'runtime:info',
  order: 50,
  text: '当前工作目录: {{cwd}}\n用户语言: {{language}}',
})

const assembly2 = await ctx.systemPrompt.assemble()
console.log('📝 渲染结果（含变量插值）:')
console.log(renderPrompt(assembly2))

// ---- Part 3: 动态上下文 ----
console.log('\n' + '='.repeat(60))
console.log('Part 3: 动态上下文')
console.log('='.repeat(60))

// 注册动态上下文：当前时间（每次组装时求值）
ctx.systemPrompt.context({
  name: 'runtime:time',
  order: 10,
  text: () => `当前时间: ${new Date().toLocaleTimeString()}`,
})

// 注册上下文：最近操作（模拟）
ctx.systemPrompt.context({
  name: 'runtime:last-action',
  order: 20,
  text: () => '最近操作: 用户要求实现 System Prompt 模块',
})

const assembly3 = await ctx.systemPrompt.assemble()
console.log('📝 上下文快照:')
console.log(renderContextSnapshot(assembly3))

// ---- Part 4: 工具 schema 提供方 ----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 工具 schema 提供方')
console.log('='.repeat(60))

// 注册工具 schema（模拟 blog-05 的 Tools 模块）
ctx.systemPrompt.tools(() => ({
  schemas: [
    {
      name: 'bash',
      description: 'Execute a bash command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
    {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
}))

const assembly4 = await ctx.systemPrompt.assemble()
console.log('📋 组装结果中的工具:')
for (const tool of assembly4.tools) {
  console.log(`  - ${tool.name}: ${tool.description}`)
}

// ---- Part 5: 完整组装 + 瀑布扩展 ----
console.log('\n' + '='.repeat(60))
console.log('Part 5: 完整组装 + 瀑布扩展')
console.log('='.repeat(60))

// 监听 assemble 瀑布：可以修改 assembly（洋葱模型）
ctx.on('system-prompt/assemble', async (assembly, context, next) => {
  const result = await next()
  // 在片段后追加一段「会话说明」
  result.sections.push({ name: 'session:note', text: '（本条消息由 assemble 瀑布追加）' })
  return result
})

const assembly5 = await ctx.systemPrompt.assemble()
console.log('📝 最终渲染结果:')
console.log(renderPrompt(assembly5))

// ---- Part 6: complete 片段（覆盖式） ----
console.log('\n' + '='.repeat(60))
console.log('Part 6: complete 片段（覆盖式）')
console.log('='.repeat(60))

// 注册一个 complete 片段：组装后只保留它（忽略其他所有片段）
const disposeComplete = ctx.systemPrompt.section({
  name: 'override:everything',
  order: 999,
  complete: true,
  text: '你是评审模式。只输出评审意见，不写代码。',
})

const assembly6 = await ctx.systemPrompt.assemble()
console.log('📝 complete 片段渲染（其他片段被忽略）:')
console.log(renderPrompt(assembly6))

// 移除 complete 片段，恢复正常
disposeComplete()

const assembly7 = await ctx.systemPrompt.assemble()
console.log('\n📝 移除 complete 后恢复:')
console.log(renderPrompt(assembly7).split('\n')[0] + ' ...')

console.log('\n✅ 博客9 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. SystemPrompt Service - section/context/variable/tools 注册（system-prompt/src/index.ts）')
console.log('  2. assemble - 排序 + 瀑布扩展 + complete 兜底（index.ts assemble()）')
console.log('  3. renderPrompt - 变量插值 + 去空段 + 空行连接（index.ts renderPrompt()）')
console.log('  4. renderContextSnapshot - runtime context 快照（index.ts renderContextSnapshot()）')
console.log('  5. 内置片段 - harness:identity(-100) + deployment:persona(0)（SystemPrompt 构造器）')
