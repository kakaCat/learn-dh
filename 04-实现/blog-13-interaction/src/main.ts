/**
 * 博客13：interaction 域 - 权限预设 + 审批 + 用户提问
 *
 * 按 dsh 源码（packages/interaction/ 下 5 个独立 npm 包）结构实现，
 * 章节顺序 = 域内依赖链：
 *   [user-approval]  审批服务定义（permission-presets 依赖它的 setApprovalPolicy）
 *   [user-questions] 提问服务定义（tool-ask-user 依赖它的 ask）
 *   [tool-ask-user]  模型侧工具（消费 ctx.userQuestions）
 *   [permission-presets] 预设表（写侧经 canonical setters 联动前两者）
 *
 * 域 = 服务定义 + 后端实现 + 策略 + 模型侧工具 的完整家族：
 * - user-approval: 审批通道（ask/never、answerer 链、fail closed、审计事件对）
 * - user-questions: 提问服务（provider 模式、多问题）
 * - tool-ask-user: ask_user_question 工具（ctx.tools.register）
 * - permission-presets: 预设表 + 写路径（setApprovalPolicy / setSandboxMode 联动）
 */

import { Context, Service } from '@cordisjs/core'

// ============================================================
// 1. 基础设施：Session 事件日志 + 简化工具注册表
// ============================================================

// 会话注册表：agent → Session（简化 dsh 的 ctx.sessions）
const sessions = new Map<string, Session>()

// 沙箱模式（dsh: SandboxMode 的简化子集）
type SandboxMode = 'workspace-write' | 'danger-full-access'

// 审批策略（dsh: ApprovalPolicy）
type ApprovalPolicy = 'ask' | 'never'

// 审批结果（dsh: ApprovalOutcome）——只有 allowed-once 是授权
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

// 会话事件（简化：interaction 域涉及的全部事件）
type SessionEvent =
  | { type: 'permission/preset'; seq: number; preset: string; timestamp: number }
  | { type: 'sandbox/mode'; seq: number; mode: SandboxMode; timestamp: number }
  | { type: 'approval/policy'; seq: number; policy: ApprovalPolicy; timestamp: number }
  | { type: 'approval/asked'; seq: number; id: string; toolName: string; reason?: string; timestamp: number }
  | { type: 'approval/decided'; seq: number; id: string; outcome: ApprovalOutcome; timestamp: number }

// 会话（简化：事件日志，blog-04 的实现）
class Session {
  readonly id: string
  readonly events: SessionEvent[] = []

  constructor(id: string) {
    this.id = id
  }

  append(event: Omit<SessionEvent, 'seq' | 'timestamp'>): SessionEvent {
    const full = { ...event, seq: this.events.length, timestamp: Date.now() } as SessionEvent
    this.events.push(full)
    return full
  }
}

// 一次审批请求（dsh: ApprovalRequest）
interface ApprovalRequest {
  agent: string          // 提问的 agent（路由 + 审计）
  toolName: string       // 请求涉及的工具
  callId?: string        // 关联的工具调用
  reason?: string        // 为什么问（用户可见）
  signal?: AbortSignal
}

// 用户问题（dsh: user-questions 的 AskUserQuestionItem）
interface AskUserQuestionItem {
  id: string
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

// 提问请求（dsh: AskUserQuestionRequest）——支持一次问多个问题
interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[]
  agent?: string
  signal?: AbortSignal
}

// 提问回答（dsh: AskUserQuestionAnswer）
interface AskUserQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

// 扩展 Cordis 类型
declare module '@cordisjs/core' {
  interface Events {
    // 审批请求事件（answerer 链监听，dsh: approval/request waterfall）
    'approval/request': (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>
  }

  interface Context {
    approval: ApprovalService
    userQuestions: UserQuestionService
    tools: ToolRegistry
  }
}

// 简化工具注册表（dsh: ctx.tools.register + defineTool）
interface ToolDef {
  name: string
  description: string
  execute: (args: any, exec: { agent?: string; signal?: AbortSignal }) => Promise<any>
}

class ToolRegistry extends Service {
  private tools = new Map<string, ToolDef>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool)
  }

  async invoke(name: string, args: any, exec: { agent?: string; signal?: AbortSignal } = {}): Promise<any> {
    const tool = this.tools.get(name)
    if (tool === undefined) throw new Error(`tool "${name}" not registered`)
    return tool.execute(args, exec)
  }
}

// ============================================================
// 2. [user-approval] 审批服务定义
//    dsh: packages/interaction/user-approval/src/index.ts
// ============================================================

// 从日志折叠会话策略覆盖（dsh: effectiveApprovalPolicy）——最后一条 approval/policy 事件
function effectiveApprovalPolicy(events: readonly SessionEvent[]): ApprovalPolicy | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'approval/policy') return e.policy
  }
  return undefined
}

// 写会话策略覆盖（dsh: setApprovalPolicy）——canonical setter：校验 + append
function setApprovalPolicy(session: Session, policy: ApprovalPolicy): void {
  if (policy !== 'ask' && policy !== 'never') {
    throw new TypeError('approval policy must be one of "ask" or "never"')
  }
  session.append({ type: 'approval/policy', policy })
}

/**
 * 审批服务（dsh: ApprovalService）：
 * 应用会话策略（ask/never）→ 记录 approval/asked → 交给 answerer 链 → 记录 approval/decided。
 * - ask: 委托 answerer；没有 answerer → fail closed（unavailable）
 * - never: 不提示任何人，直接拒绝（CI/无人值守的确定性姿态）
 * - aborted: cancelled（问题被撤回）
 */
class ApprovalService extends Service {
  private defaultPolicy: ApprovalPolicy
  // answerer：谁能回答审批问题（简化：一个回调，dsh 是可组合链）
  private answerer: ((req: ApprovalRequest) => Promise<ApprovalOutcome>) | null = null

  constructor(ctx: Context, config: { policy?: ApprovalPolicy } = {}) {
    super(ctx, 'approval')
    this.defaultPolicy = config.policy ?? 'ask'
  }

  /** 会话的有效策略（dsh: effectivePolicy）：日志覆盖 ?? 部署默认 */
  effectivePolicy(session: Session): ApprovalPolicy {
    return effectiveApprovalPolicy(session.events) ?? this.defaultPolicy
  }

  /** 注册 answerer（UI 回答者；dsh 是可组合链，这里简化单链） */
  setAnswerer(answerer: (req: ApprovalRequest) => Promise<ApprovalOutcome>): void {
    this.answerer = answerer
  }

  /**
   * 切换会话策略（dsh: setPolicy）：
   * 写 approval/policy 事件（durable 覆盖）+ 通知模型（dsh 注入一条用户消息）。
   */
  setPolicy(session: Session, policy: ApprovalPolicy): void {
    const previous = this.effectivePolicy(session)
    if (previous === policy) return
    setApprovalPolicy(session, policy)
    console.log(`  🔐 审批策略: ${previous} → ${policy}（已写入会话，模型下次步骤感知）`)
  }

  /**
   * 发起一次审批请求（dsh: request）：
   * 1. 记录 approval/asked（审计）
   * 2. decide：aborted → cancelled；never → rejected；ask → answerer 链（fail closed）
   * 3. 记录 approval/decided（审计配对）
   * @returns allowed-once 是唯一授权
   */
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = sessions.get(req.agent)
    if (session === undefined) {
      throw new Error(`approval.request(): no session for agent "${req.agent}"`)
    }

    // 1. 审计对的前半：ask 已发出
    const id = `ask-${req.agent}-${session.events.length}`
    session.append({
      type: 'approval/asked', id,
      toolName: req.toolName,
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })

    // 2. 决策
    const outcome = await this.decide(req, session)

    // 3. 审计对的后半：outcome 已知
    session.append({ type: 'approval/decided', id, outcome })
    console.log(`  📤 审批结果: ${outcome}`)
    return outcome
  }

  /** 决策阶段（dsh: decide）——策略在 dispatch 前决定，保证 never 确定性 */
  private async decide(req: ApprovalRequest, session: Session): Promise<ApprovalOutcome> {
    if (req.signal?.aborted) return 'cancelled'
    console.log(`  📨 审批请求: ${req.agent} 要调 ${req.toolName}${req.reason ? `（原因: ${req.reason}）` : ''} [策略: ${this.effectivePolicy(session)}]`)

    if (this.effectivePolicy(session) === 'never') {
      // 无人值守：自动拒绝（dsh: every ask resolves 'rejected'）
      console.log(`  ❌ 策略 never → 自动拒绝`)
      return 'rejected'
    }

    // ask 策略：走 approval/request 瀑布（answerer 链）
    const answer: Promise<ApprovalOutcome> = (async () => {
      const outcome = await this.ctx.waterfall(
        'approval/request', req,
        async (): Promise<ApprovalOutcome> => {
          // 核心：没有 answerer → fail closed（unavailable）
          if (!this.answerer) {
            console.log(`  ⚠️  无 answerer → fail closed (unavailable)`)
            return 'unavailable'
          }
          return this.answerer(req)
        },
      )
      // 归一化：answerer 返回非法值 → unavailable（dsh: rogue return normalized）
      return (['allowed-once', 'rejected', 'cancelled', 'unavailable'] as ApprovalOutcome[]).includes(outcome)
        ? outcome
        : 'unavailable'
    })()

    // 与请求信号竞速：abort 撤回问题 → cancelled；晚到的回答被丢弃
    const signal = req.signal
    if (signal === undefined) return answer
    return await new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        console.log(`  ⏹️  请求被取消`)
        resolve('cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      })
    })
  }
}

// ============================================================
// 3. [user-questions] 用户提问服务定义
//    dsh: packages/interaction/user-questions/src/index.ts
// ============================================================

// UI 侧提问提供者（dsh: UserQuestionProvider）——收集人类答案
interface UserQuestionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

/**
 * 用户提问服务（dsh: UserQuestionService）：
 * 模型需要暂停工作、问用户一个决定时使用。
 * provider 模式：UI 注册一个 provider，ask() 委托给它；无 provider → 抛错。
 */
class UserQuestionService extends Service {
  private provider: UserQuestionProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'userQuestions')
  }

  /** 注册 UI provider（dsh: registerProvider）——同一上下文只允许一个活跃 provider */
  registerProvider(provider: UserQuestionProvider): () => void {
    if (this.provider !== undefined) {
      throw new Error('a user-questions provider is already registered')
    }
    this.provider = provider
    return () => { this.provider = undefined }
  }

  /** 向活跃 provider 提问并等待回答（dsh: ask） */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw new Error('ask_user_question was aborted before the user answered')
    }
    if (request.questions.length === 0) {
      throw new Error('ask_user_question requires at least one question')
    }
    if (this.provider === undefined) {
      throw new Error('no user-questions provider is registered')
    }
    return this.provider.ask(request)
  }
}

// ============================================================
// 4. [tool-ask-user] 模型侧工具
//    dsh: packages/interaction/tool-ask-user/src/index.ts
// ============================================================

/**
 * ask_user_question 工具：模型侧的工具——让模型能问用户。
 * 复用 ctx.userQuestions（工具 + 服务配对，dsh: tool-ask-user over ctx.userQuestions）。
 */
function registerAskUserQuestionTool(ctx: Context): void {
  ctx.tools.register({
    name: 'ask_user_question',
    description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
      + 'Send one or more questions, each with a stable id that will be echoed in the answer.',
    async execute(args, exec) {
      const result = await ctx.userQuestions.ask({
        questions: args.questions.map((q: any) => ({
          id: q.id,
          question: q.question,
          ...q.header !== undefined ? { header: q.header } : {},
          ...q.options !== undefined ? { options: q.options } : {},
          ...q.multi_select !== undefined ? { multiSelect: q.multi_select } : {},
        })),
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        signal: exec.signal,
      })
      return {
        answers: result.answers.map(a => ({
          id: a.id,
          selected: [...a.selected],
          ...a.custom !== undefined ? { custom: a.custom } : {},
        })),
      }
    },
  })
}

// ============================================================
// 5. [permission-presets] 权限预设
//    dsh: packages/interaction/permission-presets/src/index.ts
// ============================================================

// 一个预设 = sandbox 模式 + 审批策略 的捆绑（dsh: PresetSpec）
interface PresetSpec {
  sandbox: SandboxMode
  approval: ApprovalPolicy
  name?: string        // 展示名（省略 = 表键）
  description?: string // 一句用户说明
}

// 配置：预设表 + 新会话默认预设
interface Config {
  presets?: Record<string, PresetSpec>
  defaultPreset?: string
}

// 有效旋钮值匹配不到任何预设时的状态（dsh: CUSTOM_PRESET）
const CUSTOM_PRESET = 'custom'

// 旋钮状态：每个旋钮事件的最后值（null = 未覆盖，组合默认在视图时应用）
interface KnobState {
  preset: string | null
  sandbox: SandboxMode | null
  approval: ApprovalPolicy | null
}

const EMPTY_KNOBS: KnobState = { preset: null, sandbox: null, approval: null }

// 单事件旋钮转换（dsh: applyKnobEvent）——不感兴趣的事件返回同一引用
function applyKnobEvent(state: KnobState, event: SessionEvent): KnobState {
  switch (event.type) {
    case 'permission/preset': return { ...state, preset: event.preset }
    case 'sandbox/mode': return { ...state, sandbox: event.mode }
    case 'approval/policy': return { ...state, approval: event.policy }
    default: return state
  }
}

// 整日志折叠（dsh: foldKnobs）
function foldKnobs(events: readonly SessionEvent[]): KnobState {
  let state = EMPTY_KNOBS
  for (const event of events) state = applyKnobEvent(state, event)
  return state
}

// 从日志找最后选择的预设（dsh: effectivePermissionPreset）
function effectivePermissionPreset(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'permission/preset') return events[i]!.preset
  }
  return undefined
}

// 从日志取有效 sandbox 模式（dsh: effectiveSandboxMode）
function effectiveSandboxMode(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'sandbox/mode') return e.mode
  }
  return undefined
}

/**
 * 权限预设服务（dsh: PermissionPresetService）：
 * 拥有部署的预设表 + 写路径。切换预设 = 写意图 + 经 canonical setters 联动两个旋钮。
 * dsh 中 setApprovalPolicy 来自 user-approval 包、setSandboxMode 来自 sandbox-policy 包——
 * 本服务 import 它们，是 interaction 域内协作的体现。
 */
class PermissionPresetService extends Service {
  private readonly presets: Record<string, PresetSpec>
  private readonly defaultPreset: string
  // 组合默认（dsh 从 ctx.shell.sandboxMode / ctx.approval.config.policy 读取，这里注入）
  private readonly defaults: { sandbox: SandboxMode; approval: ApprovalPolicy }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'permissionPresets')
    // 预设表（dsh 默认：workspace-write + danger-full-access）
    this.presets = config.presets ?? {
      'workspace-write': {
        sandbox: 'workspace-write', approval: 'ask',
        name: 'workspace-write',
        description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
      },
      'danger-full-access': {
        sandbox: 'danger-full-access', approval: 'never',
        name: 'danger-full-access',
        description: 'Full file access without approval prompts.',
      },
    }
    // custom 是保留名，不能作为表项
    if (CUSTOM_PRESET in this.presets) {
      throw new Error(`permission: "${CUSTOM_PRESET}" is reserved for the derived not-a-preset state`)
    }
    // 组合默认（dsh: ctx.shell.sandboxMode + ctx.approval.config.policy）
    this.defaults = {
      sandbox: 'workspace-write',
      approval: 'ask',
    }
    // 默认预设：显式配置，或从组合默认推导
    const inferred = this.derive(EMPTY_KNOBS)
    this.defaultPreset = config.defaultPreset ?? inferred
    if (this.defaultPreset === CUSTOM_PRESET) {
      throw new Error('permission: composed defaults match no preset; configure defaultPreset explicitly')
    }
    // 校验默认预设存在
    this.resolve(this.defaultPreset)
  }

  /** 可切换的预设名（按表声明顺序） */
  get names(): readonly string[] {
    return Object.keys(this.presets)
  }

  /**
   * 解析预设名 → 捆绑（dsh: resolve）
   * 未知预设抛错（fail loud）
   */
  resolve(name: string): PresetSpec {
    const spec = this.presets[name]
    if (spec === undefined) {
      throw new Error(`permission: unknown preset "${name}" (known: ${Object.keys(this.presets).join(', ')})`)
    }
    return spec
  }

  /**
   * 推导有效预设（dsh: derive）：
   * - 有效旋钮值 = 日志里最后值 ?? 组合默认
   * - 仍匹配的最后选择优先（共享捆绑时保留用户意图）
   * - 否则第一个匹配的表项，或 custom
   */
  private derive(state: KnobState): string {
    const sandbox = state.sandbox ?? this.defaults.sandbox
    const approval = state.approval ?? this.defaults.approval
    const matches = (spec: PresetSpec): boolean =>
      spec.sandbox === sandbox && spec.approval === approval

    // 最后选择的预设仍匹配 → 保留（共享捆绑时用户意图优先）
    if (state.preset !== null) {
      const spec = this.presets[state.preset]
      if (spec !== undefined && matches(spec)) return state.preset
    }
    // 否则第一个匹配的表项
    for (const [name, spec] of Object.entries(this.presets)) {
      if (matches(spec)) return name
    }
    return CUSTOM_PRESET
  }

  /** 会话当前的有效预设（dsh: current） */
  current(session: Session): string {
    return this.derive(foldKnobs(session.events))
  }

  /**
   * 切换预设（dsh: set）——写路径：
   * 1. 记录 permission/preset 事件（durable 用户意图，不进模型）
   * 2. sandbox 旋钮变了 → setSandboxMode（canonical setter）
   * 3. approval 旋钮变了 → setApprovalPolicy（来自 user-approval 包！）
   * 选当前预设 → 什么都不追加（幂等）
   */
  set(session: Session, name: string): void {
    const spec = this.resolve(name)
    const current = this.current(session)
    if (current === name) {
      console.log(`  ⏭️  已是 ${name} 预设，不追加`)
      return
    }

    // 1. 记录预设选择（只记日志，durable 用户意图）
    session.append({ type: 'permission/preset', preset: name })
    console.log(`  🔀 切换预设: ${name}`)

    // 2. sandbox 旋钮（若与当前有效值不同）
    const effectiveSandbox = effectiveSandboxMode(session.events) ?? this.defaults.sandbox
    if (spec.sandbox !== effectiveSandbox) {
      session.append({ type: 'sandbox/mode', mode: spec.sandbox })
      console.log(`  🏜️  sandbox 模式 → ${spec.sandbox}`)
    }

    // 3. approval 旋钮（若与当前有效值不同）
    const effectiveApproval = effectiveApprovalPolicy(session.events) ?? this.defaults.approval
    if (spec.approval !== effectiveApproval) {
      setApprovalPolicy(session, spec.approval)  // canonical setter（dsh 从 user-approval import）
      console.log(`  🔐 approval 策略 → ${spec.approval}`)
    }
  }

  /**
   * 新会话填充初始权限（dsh: pinInitialPermission）：
   * 全新会话 → 写默认预设 + 两个旋钮；部分初始化 → 只补缺失的事实。
   */
  pinInitialPermission(session: Session): void {
    const events = session.events
    const selected = effectivePermissionPreset(events)
    const sandbox = effectiveSandboxMode(events)
    const approval = effectiveApprovalPolicy(events)
    if (selected === undefined && sandbox === undefined && approval === undefined) {
      const spec = this.resolve(this.defaultPreset)
      session.append({ type: 'permission/preset', preset: this.defaultPreset })
      session.append({ type: 'sandbox/mode', mode: spec.sandbox })
      setApprovalPolicy(session, spec.approval)
      return
    }
    // 部分初始化：补缺失的旋钮/意图
    if (selected === undefined && this.current(session) !== CUSTOM_PRESET) {
      session.append({ type: 'permission/preset', preset: this.current(session) })
    }
    if (sandbox === undefined) {
      session.append({ type: 'sandbox/mode', mode: this.defaults.sandbox })
    }
    if (approval === undefined) {
      setApprovalPolicy(session, this.defaults.approval)
    }
  }

  /** 预设展示选项（dsh: selectFor / optionOf） */
  selectFor(session: Session): { options: Array<{ value: string; name: string; description?: string }>; currentValue: string } {
    const currentValue = this.current(session)
    return {
      options: [
        ...this.names.map(name => this.optionOf(name)),
        ...currentValue === CUSTOM_PRESET ? [this.optionOf(CUSTOM_PRESET)] : [],
      ],
      currentValue,
    }
  }

  optionOf(name: string): { value: string; name: string; description?: string } {
    if (name === CUSTOM_PRESET) {
      return { value: CUSTOM_PRESET, name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }
    }
    const spec = this.resolve(name)
    return { value: name, name: spec.name ?? name, ...spec.description !== undefined ? { description: spec.description } : {} }
  }
}

// ============================================================
// 6. 演示
// ============================================================

console.log('='.repeat(60))
console.log('博客13：interaction 域 - 权限预设 + 审批 + 用户提问')
console.log('='.repeat(60))

let ctx = new Context()
await ctx.plugin(ToolRegistry)
await ctx.plugin(ApprovalService)
await ctx.plugin(UserQuestionService)
await ctx.plugin(PermissionPresetService)
registerAskUserQuestionTool(ctx)

// ============ Part 1-3: [user-approval] 审批通道 ============

// ---- Part 1: 审批 - ask 策略（answerer 批准）----
console.log('\n' + '='.repeat(60))
console.log('Part 1: 审批 - ask 策略（answerer 批准）')
console.log('='.repeat(60))

const s1 = new Session('session-1')
sessions.set('agent-1', s1)

// 注册 answerer：模拟用户点击「允许」
ctx.approval.setAnswerer(async (req) => {
  console.log(`  👤 [用户] 看到审批: ${req.toolName}（${req.reason ?? '无原因'}）`)
  console.log(`  👤 [用户] 点击「允许这一次」`)
  return 'allowed-once'
})

console.log('\n🚀 agent-1 要执行危险操作（bash），触发审批:')
const r1 = await ctx.approval.request({
  agent: 'agent-1', toolName: 'bash',
  reason: '需要删除临时文件',
})
console.log(`  ✅ 结果: ${r1}${r1 === 'allowed-once' ? '（可以执行）' : '（被拒）'}`)
console.log('  审计事件对:')
for (const e of s1.events) {
  if (e.type === 'approval/asked') console.log(`    #${e.seq} approval/asked id=${e.id} tool=${e.toolName}`)
  if (e.type === 'approval/decided') console.log(`    #${e.seq} approval/decided id=${e.id} outcome=${e.outcome}`)
}

// ---- Part 2: 审批 - 用户拒绝 ----
console.log('\n' + '='.repeat(60))
console.log('Part 2: 审批 - 用户拒绝')
console.log('='.repeat(60))

ctx.approval.setAnswerer(async (req) => {
  console.log(`  👤 [用户] 看到审批: ${req.toolName}`)
  console.log(`  👤 [用户] 点击「拒绝」`)
  return 'rejected'
})

console.log('\n🚀 agent-1 要读 /etc/passwd，用户拒绝:')
const r2 = await ctx.approval.request({
  agent: 'agent-1', toolName: 'read_file',
  reason: '读取系统密码文件',
})
console.log(`  ✅ 结果: ${r2}（不能执行）`)

// ---- Part 3: 审批 - never 策略（无人值守自动拒绝）----
console.log('\n' + '='.repeat(60))
console.log('Part 3: 审批 - never 策略（CI 无人值守）')
console.log('='.repeat(60))

// 切到 never：所有请求自动拒绝（不提示）
const sci = new Session('session-ci')
sessions.set('agent-ci', sci)
ctx.approval.setPolicy(sci, 'never')

console.log('\n🚀 agent-ci 要执行操作（never 策略，不提示用户）:')
const r3 = await ctx.approval.request({
  agent: 'agent-ci', toolName: 'bash',
  reason: 'CI 中自动执行',
})
console.log(`  ✅ 结果: ${r3}（自动拒绝）`)

// ---- Part 4: 审批 - 无 answerer（fail closed）----
console.log('\n' + '='.repeat(60))
console.log('Part 4: 审批 - 无 answerer（fail closed）')
console.log('='.repeat(60))

// 移除 answerer：模拟没有 UI 的场景
ctx.approval.setAnswerer(null as any)
const s2 = new Session('session-2')
sessions.set('agent-2', s2)

console.log('\n🚀 agent-2 请求审批（ask 策略但无 answerer）:')
const r4 = await ctx.approval.request({
  agent: 'agent-2', toolName: 'bash',
  reason: '需要写文件',
})
console.log(`  ✅ 结果: ${r4}（无 answerer → fail closed）`)

// ---- Part 5: 审批 - 取消（aborted）----
console.log('\n' + '='.repeat(60))
console.log('Part 5: 审批 - 取消（signal aborted）')
console.log('='.repeat(60))

// 注册一个"永远不答"的 answerer + 提前 abort
ctx.approval.setAnswerer(async () => {
  await new Promise(() => {})  // 挂起
  return 'allowed-once'
})
const ac = new AbortController()
const s3 = new Session('session-3')
sessions.set('agent-3', s3)
setTimeout(() => ac.abort(), 20)

console.log('\n🚀 agent-3 请求审批但被取消:')
const r5 = await ctx.approval.request({
  agent: 'agent-3', toolName: 'bash',
  reason: '慢审批',
  signal: ac.signal,
})
console.log(`  ✅ 结果: ${r5}（请求被撤回）`)

// ============ Part 6: [user-questions + tool-ask-user] 用户提问 ============

// ---- Part 6: 用户提问（provider 模式 + ask_user_question 工具）----
console.log('\n' + '='.repeat(60))
console.log('Part 6: 用户提问（provider + ask_user_question 工具）')
console.log('='.repeat(60))

// UI 注册 provider：模拟 UI 展示问题并自动回答
const disposeProvider = ctx.userQuestions.registerProvider({
  async ask(request) {
    for (const q of request.questions) {
      console.log(`  🖥️ [UI] 收到问题: ${q.question}${q.options ? `（选项: ${q.options.map(o => o.label).join(', ')}）` : ''}`)
    }
    // 模拟用户回答：第一个问题选第一个选项
    const answers = request.questions.map(q => ({
      id: q.id,
      selected: q.options && q.options.length > 0 ? [q.options[0]!.label] : [],
      ...q.options === undefined ? { custom: 'TypeScript' } : {},
    }))
    console.log(`  👤 [用户] 回答完成`)
    return { answers }
  },
})

console.log('\n🚀 模型通过 ask_user_question 工具问用户「用什么语言」:')
const result = await ctx.tools.invoke('ask_user_question', {
  questions: [
    { id: 'q1', question: '项目用什么语言？', options: [
      { label: 'TypeScript', description: 'dsh 同款' },
      { label: 'Python' },
      { label: 'Go' },
    ] },
  ],
}, { agent: 'agent-1' })
console.log(`  ✅ 工具返回: ${JSON.stringify(result)}`)

console.log('\n🚀 模型一次问两个问题（多问题 + 自由输入）:')
const result2 = await ctx.tools.invoke('ask_user_question', {
  questions: [
    { id: 'q2', question: '要保留演示文件吗？', options: [{ label: '保留' }, { label: '删除' }] },
    { id: 'q3', question: '有什么补充？' },
  ],
}, { agent: 'agent-1' })
console.log(`  ✅ 工具返回: ${JSON.stringify(result2)}`)

disposeProvider()

// ============ Part 7-11: [permission-presets] 权限预设 ============

// ---- Part 7: 初始状态 ----
console.log('\n' + '='.repeat(60))
console.log('Part 7: 初始状态（默认预设）')
console.log('='.repeat(60))

const session = new Session('session-4')
sessions.set('agent-4', session)
const select = ctx.permissionPresets.selectFor(session)
console.log(`\n📋 有效预设: ${select.currentValue}（新会话无旋钮事件 → 组合默认推导）`)
console.log('   选项:')
for (const opt of select.options) {
  console.log(`    - ${opt.name}${opt.value === select.currentValue ? ' ← 当前' : ''}`)
}

// ---- Part 8: pinInitialPermission（新会话自动填充）----
console.log('\n' + '='.repeat(60))
console.log('Part 8: 新会话自动填充初始权限（pinInitialPermission）')
console.log('='.repeat(60))

console.log('\n🔀 模拟 dsh 的 session/created：新会话触发 pin:')
ctx.permissionPresets.pinInitialPermission(session)
console.log('  事件日志:')
for (const e of session.events) {
  console.log(`    #${e.seq} ${e.type}${e.type === 'permission/preset' ? ` = ${e.preset}` : e.type === 'sandbox/mode' ? ` = ${e.mode}` : e.type === 'approval/policy' ? ` = ${e.policy}` : ''}`)
}
console.log(`\n  有效预设: ${ctx.permissionPresets.current(session)}`)

// ---- Part 9: 切换预设 ----
console.log('\n' + '='.repeat(60))
console.log('Part 9: 切换预设')
console.log('='.repeat(60))

console.log('\n🔀 切换到 danger-full-access:')
ctx.permissionPresets.set(session, 'danger-full-access')
console.log(`\n  有效预设: ${ctx.permissionPresets.current(session)}`)
console.log('  事件日志:')
for (const e of session.events) {
  console.log(`    #${e.seq} ${e.type}${e.type === 'permission/preset' ? ` = ${e.preset}` : e.type === 'sandbox/mode' ? ` = ${e.mode}` : e.type === 'approval/policy' ? ` = ${e.policy}` : ''}`)
}

// ---- Part 10: 幂等 + 自定义状态 ----
console.log('\n' + '='.repeat(60))
console.log('Part 10: 幂等 + 自定义状态')
console.log('='.repeat(60))

console.log('\n🔀 再切一次 danger-full-access:')
ctx.permissionPresets.set(session, 'danger-full-access')
console.log(`  事件数: ${session.events.length}（没变 = 幂等）`)

// 直接改旋钮到不匹配任何预设的组合
const session2 = new Session('session-5')
session2.append({ type: 'sandbox/mode', mode: 'danger-full-access' })
session2.append({ type: 'approval/policy', policy: 'ask' })  // 全访问 + ask = 无预设匹配

const select2 = ctx.permissionPresets.selectFor(session2)
console.log(`\n📋 有效预设: ${select2.currentValue}（danger-full-access + ask 不匹配任何预设）`)
console.log('   选项（追加了 custom）:')
for (const opt of select2.options) {
  console.log(`    - ${opt.name}${opt.value === select2.currentValue ? ' ← 当前' : ''}`)
}

// ---- Part 11: 未知预设报错 ----
console.log('\n' + '='.repeat(60))
console.log('Part 11: 未知预设报错')
console.log('='.repeat(60))

try {
  ctx.permissionPresets.set(session, 'unknown-preset')
} catch (error: any) {
  console.log(`  ❌ 正确报错: ${error.message}`)
}

// ============ Part 12: 域内闭环 ============

// ---- Part 12: 完整闭环（预设 → 旋钮 → 审批策略 → 审批请求）----
console.log('\n' + '='.repeat(60))
console.log('Part 12: 域内闭环（预设写旋钮，审批读旋钮）')
console.log('='.repeat(60))

// 新会话 + pin（默认 workspace-write + ask）
const sFinal = new Session('session-final')
sessions.set('agent-final', sFinal)
ctx.permissionPresets.pinInitialPermission(sFinal)
console.log(`\n🔀 初始: 预设=${ctx.permissionPresets.current(sFinal)} 审批策略=${ctx.approval.effectivePolicy(sFinal)}`)

// answerer：批准
ctx.approval.setAnswerer(async () => {
  console.log(`  👤 [用户] 点击「允许这一次」`)
  return 'allowed-once'
})

console.log('\n🚀 agent-final 请求审批（ask 策略 → 用户批准）:')
const rf1 = await ctx.approval.request({ agent: 'agent-final', toolName: 'bash', reason: '写构建脚本' })
console.log(`  ✅ 结果: ${rf1}（ask + answerer → 放行）`)

// 切到 danger-full-access（approval 旋钮 → never）
console.log('\n🔀 切换到 danger-full-access（approval 旋钮自动变 never）:')
ctx.permissionPresets.set(sFinal, 'danger-full-access')
console.log(`  有效预设: ${ctx.permissionPresets.current(sFinal)} 审批策略: ${ctx.approval.effectivePolicy(sFinal)}`)

console.log('\n🚀 agent-final 请求审批（never 策略 → 自动拒绝）:')
const rf2 = await ctx.approval.request({ agent: 'agent-final', toolName: 'bash', reason: '危险操作' })
console.log(`  ✅ 结果: ${rf2}（never → 无审批提示）`)

console.log('\n  最终事件日志:')
for (const e of sFinal.events) {
  const val = e.type === 'permission/preset' ? ` = ${e.preset}`
    : e.type === 'sandbox/mode' ? ` = ${e.mode}`
    : e.type === 'approval/policy' ? ` = ${e.policy}`
    : e.type === 'approval/asked' ? ` id=${e.id}`
    : ` id=${e.id} outcome=${e.outcome}`
  console.log(`    #${e.seq} ${e.type}${val}`)
}

console.log('\n✅ 博客13 完成！')
console.log('\n📝 与 dsh 源码对应：')
console.log('  1. ApprovalService - request() + ask/never + 审计对（interaction/user-approval/src/index.ts）')
console.log('  2. setApprovalPolicy - canonical setter（user-approval）')
console.log('  3. UserQuestionService - provider 模式 + 多问题（interaction/user-questions/src/index.ts）')
console.log('  4. ask_user_question 工具 - ctx.tools.register（interaction/tool-ask-user/src/index.ts）')
console.log('  5. PermissionPresetService - 预设表 + 写路径（interaction/permission-presets/src/index.ts）')
console.log('  6. pinInitialPermission - 新会话填充初始权限（permission-presets）')
console.log('  7. foldKnobs / effectivePermissionPreset - 从日志折叠（permission-presets）')
console.log('  8. CUSTOM_PRESET - 自定义状态（permission-presets）')
console.log('  9. fail closed - 无 answerer 时自动拒绝（user-approval）')
console.log('  10. 域内协作 - permission-presets import setApprovalPolicy（user-approval）')
