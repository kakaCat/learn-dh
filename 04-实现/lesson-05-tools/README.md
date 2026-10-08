# 第5课：Tools 模块

## 目标

实现工具注册、Schema 生成和执行管道。

## 运行

```bash
cd lesson-05-tools
pnpm install

# 主程序
pnpm run dev

# 管道演示
pnpm run pipeline
```

## 核心概念

### Tool 接口

```typescript
interface Tool {
  description: string           // 给模型看的描述
  parameters: JSONSchema        // 参数定义
  execute: (args) => Promise<unknown>  // 执行函数
}
```

### 注册工具

```typescript
ctx.tools.register('echo', {
  description: 'Echo text',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' }
    },
    required: ['text']
  },
  async execute(args) {
    return args.text
  }
})
```

### 执行管道

```
pre-execute  →  权限检查、参数验证
     ↓
execute      →  实际执行
     ↓
post-execute →  记录日志、格式化结果
```

### 拦截点

```typescript
// 权限检查
ctx.on('tools/pre-execute', async (call, next) => {
  if (!approved) throw new Error('Denied')
  await next()
})

// 记录日志
ctx.on('tools/post-execute', async (result, next) => {
  logger.log(result)
  await next()
})
```

## OpenAI Schema

工具需要转换为 OpenAI 格式：

```typescript
{
  type: 'function',
  function: {
    name: 'echo',
    description: 'Echo text',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' }
      }
    }
  }
}
```

## 练习

### 练习1：创建文件工具

创建一个 `read_file` 工具，读取文件内容。

### 练习2：添加权限控制

在 pre-execute 中添加权限检查，只允许特定工具。

### 练习3：结果缓存

在 post-execute 中缓存工具结果，相同参数直接返回缓存。

## 下一课

[第6课：System Prompt 模块](../lesson-06-prompt/README.md)

我们将学习：
- 提示词片段管理
- 优先级排序
- 动态生成
