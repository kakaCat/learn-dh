# 第3课：事件系统

## 目标

掌握 Cordis 的五种事件派发模式。

## 运行

```bash
cd lesson-03-events
pnpm install

# 主程序
pnpm run dev

# Waterfall 深入演示
pnpm run waterfall
```

## 五种派发模式

| 模式 | 等待 | 短路 | 返回值 | 用途 |
|------|------|------|--------|------|
| `emit` | ❌ | ❌ | ❌ | 通知 |
| `parallel` | ✅ | ❌ | ❌ | 并发 |
| `serial` | ✅ | ✅ | ✅ | 查找 |
| `bail` | ❌ | ✅ | ✅ | 快速判断 |
| `waterfall` | ✅ | ✅ | ✅ | 拦截 |

### emit - 触发即忘

```typescript
ctx.on('event', () => console.log('notified'))
ctx.emit('event')
```

**特点**：立即返回，不等待异步监听器

### parallel - 并发执行

```typescript
await ctx.parallel('save', data)
```

**特点**：所有监听器并发执行，等待全部完成

### serial - 串行短路

```typescript
const result = await ctx.serial('find', request)
```

**特点**：按顺序执行，遇到返回值就停止

### bail - 同步短路

```typescript
const result = ctx.bail('check', user)
```

**特点**：同步执行，不等待 Promise

### waterfall - 洋葱模型

```typescript
ctx.on('request', async (data, next) => {
  console.log('before')
  const result = await next()
  console.log('after')
  return result
})
```

**特点**：中间件链，从外到内再从内到外

## 实际应用

### 场景1：权限检查（waterfall）

```typescript
ctx.on('tools/pre-execute', async (call, next) => {
  if (!hasPermission(call.name)) {
    throw new Error('Denied')
  }
  await next()
})
```

### 场景2：缓存（waterfall）

```typescript
ctx.on('agent/request', async (req, next) => {
  const cached = cache.get(req)
  if (cached) return cached
  const result = await next()
  cache.set(req, result)
  return result
})
```

### 场景3：日志（emit）

```typescript
ctx.on('session/event', (event) => {
  logger.log(event)
})
```

## 练习

### 练习1：组合使用

创建一个请求处理链：
1. emit 记录请求日志
2. waterfall 做权限检查
3. waterfall 做缓存
4. serial 查找处理器

### 练习2：错误处理

在 waterfall 中抛出错误，观察外层如何捕获。

### 练习3：自定义事件

设计一个新的事件，选择合适的派发模式。

## 下一课

[第4课：Session 模块](../lesson-04-session/README.md)

我们将学习：
- 事件日志系统
- SessionEvent 类型
- 消息派生
