# 第6课：System Prompt 模块

## 目标

实现提示词片段管理，理解如何动态组装 system prompt。

## 运行

```bash
cd lesson-06-prompt
pnpm install

# 主程序
pnpm run dev

# 动态演示
pnpm run dynamic
```

## 核心概念

### PromptSection 片段

```typescript
interface PromptSection {
  name: string              // 片段名称（用于去重）
  content: string           // 内容
  priority?: number         // 优先级（越小越靠前）
  condition?: () => boolean // 条件（可选）
}
```

### 优先级规则

- `0-9`: 核心身份和角色
- `10-49`: 功能说明（工具、能力）
- `50-89`: 行为约束和规则
- `90-99`: 安全和伦理规则
- `100+`: 覆盖性规则

### 条件片段

```typescript
ctx.systemPrompt.addSection({
  name: 'debug-mode',
  content: 'Debug mode is enabled.',
  priority: 10,
  condition: () => process.env.NODE_ENV === 'development',
})
```

## 动态生成

每次请求时重新组装：

```typescript
build(): string {
  const sections = Array.from(this.sections.values())
  const active = sections.filter(s => !s.condition || s.condition())
  active.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
  return active.map(s => s.content).join('\n\n')
}
```

## 实际应用

### 场景1：项目规则

```typescript
// 从 CLAUDE.md 加载
const claudeMd = await fs.readFile('CLAUDE.md', 'utf-8')
ctx.systemPrompt.addSection({
  name: 'project-rules',
  content: claudeMd,
  priority: 40,
})
```

### 场景2：工具说明

```typescript
ctx.systemPrompt.addSection({
  name: 'available-tools',
  content: () => {
    const tools = ctx.tools.list()
    return `Available tools: ${tools.join(', ')}`
  },
  priority: 25,
})
```

### 场景3：用户偏好

```typescript
ctx.systemPrompt.addSection({
  name: 'code-style',
  content: () => `Prefer ${ctx.settings.get('codeStyle')} style.`,
  priority: 50,
})
```

## 练习

### 练习1：时间敏感片段

添加一个片段，只在白天工作时间内生效。

### 练习2：工具数量提示

添加一个片段，显示当前可用的工具数量。

### 练习3：多语言

根据用户语言设置，添加不同语言的片段。

## 下一课

[第7课：LLM 适配器](../lesson-07-llm/README.md)

我们将学习：
- LLM 接口抽象
- OpenAI API 调用
- 流式输出
