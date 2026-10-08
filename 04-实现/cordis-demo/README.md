# Cordis 控制流演示

这个目录包含 Cordis 控制流的可视化演示代码。

## 文件说明

- `demo.ts` - 全面演示五种派发模式、依赖注入、作用域隔离
- `waterfall-visual.ts` - 洋葱模型的详细可视化
- `package.json` - 依赖配置
- `tsconfig.json` - TypeScript 配置

## 运行

```bash
# 安装依赖
pnpm install

# 运行完整演示
pnpm run demo

# 运行 waterfall 可视化
pnpm run waterfall
```

## 演示内容

### 1. 五种派发模式

#### emit - 触发即忘
```typescript
ctx.emit('user-login', userId)
// 立即返回，不等待监听器
```

#### parallel - 并发执行
```typescript
await ctx.parallel('save-data', data)
// 等待所有监听器完成
```

#### serial - 串行执行
```typescript
const handler = await ctx.serial('find-handler', request)
// 按顺序执行，遇到返回值即停止
```

#### bail - 同步短路
```typescript
const result = ctx.bail('check-permission', user)
// 同步执行，不等待 Promise
```

#### waterfall - 洋葱模型
```typescript
await ctx.waterfall('process', data, async () => {
  // 核心逻辑
})
// 中间件链，从外到内再从内到外
```

### 2. 依赖注入

```typescript
class CacheService {
  constructor(ctx: Context) {
    // 可以使用 database
    ctx.database.query(...)
  }
}
CacheService.inject = ['database']

// Cordis 自动排序
ctx.plugin(CacheService)     // 等待 database
ctx.plugin(DatabaseService)  // 先激活
```

### 3. 作用域隔离

```typescript
// 父级
ctx.config = { theme: 'light' }

// 子级（继承）
const child1 = ctx.extend()
child1.config.theme // 'light'

// 子级（覆盖）
const child2 = ctx.extend({ config: { theme: 'dark' } })
child2.config.theme // 'dark'

// 父级不受影响
ctx.config.theme // 'light'
```

### 4. Effect 生命周期

```typescript
ctx.effect(() => {
  console.log('setup')
  return () => console.log('cleanup')
})

ctx.dispose() // 自动清理，LIFO 顺序
```

## Waterfall 可视化

`waterfall-visual.ts` 演示了一个完整的 HTTP 请求处理流程：

```
缓存层 (检查缓存)
  ↓
认证层 (验证用户)
  ↓
日志层 (记录开始)
  ↓
限流层 (检查频率)
  ↓
核心逻辑 (处理请求)
  ↑
限流层 (更新计数)
  ↑
日志层 (记录完成)
  ↑
认证层 (清理信息)
  ↑
缓存层 (保存缓存)
```

每一层都可以：
- 短路（不调用 next）
- 修改请求
- 修改响应
- 记录日志
- 清理资源

## 输出示例

运行 `pnpm run waterfall` 会看到：

```
🚀 开始处理 HTTP 请求
======================================================================
请求: GET /api/users/123

┌─────────────────────────────────────┐
│  [缓存层] 进入                      │
└─────────────────────────────────────┘
  检查缓存: /api/users/123
  ❌ 缓存未命中，继续向内层...
  ↓
  ┌─────────────────────────────────────┐
  │  [认证层] 进入                      │
  └─────────────────────────────────────┘
    检查用户认证...
    ✅ 认证通过
    ↓
    ┌─────────────────────────────────────┐
    │  [日志层] 进入                      │
    └─────────────────────────────────────┘
      📝 请求开始: GET /api/users/123
      👤 用户: user-123
      ↓
      ... (继续向内)
```

## 学习建议

1. 先运行 `pnpm run demo` 看完整演示
2. 再运行 `pnpm run waterfall` 深入理解洋葱模型
3. 修改代码，添加自己的监听器
4. 尝试不同的派发模式组合

## 关键概念

- **emit**: 通知，不等待
- **parallel**: 并发，等待所有
- **serial**: 串行，可短路
- **waterfall**: 洋葱，可拦截
- **依赖注入**: 自动排序
- **作用域**: 原型链继承
- **Effect**: LIFO 清理
