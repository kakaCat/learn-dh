# 第2课：依赖注入

## 目标

理解 Cordis 的依赖注入机制，学会声明和管理依赖关系。

## 运行

```bash
cd lesson-02-inject
pnpm install

# 主程序
pnpm run dev

# 加载顺序演示
pnpm run order
```

## 核心概念

### Service 类

前两课中，插件是一个函数。当插件需要自己的状态和方法时，
更规范的写法是继承 Cordis 提供的 `Service` 基类：

```typescript
import { Context, Service } from '@cordisjs/core'

class LoggerService extends Service {
  constructor(ctx: Context) {
    // 参数1: Context
    // 参数2: 服务名称（注册为 ctx.logger）
    // 参数3: 是否立即激活
    super(ctx, 'logger', true)
  }

  log(message: string) {
    console.log(message)
  }
}

await ctx.plugin(LoggerService)
ctx.logger.log('hello')  // 注册后即可通过 ctx.logger 访问
```

Service 本质上还是一个插件，只是用类的形式组织代码。
本课的依赖注入正是基于 Service 类工作的。

### 声明依赖

```typescript
class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myService', true)
    // 可以安全使用 ctx.database，因为 Cordis 保证它已就绪
    ctx.database.query('...')
  }
}

// 声明依赖
MyService.inject = ['database']
```

### 依赖类型

| 类型 | 语法 | 说明 |
|------|------|------|
| 必需 | `['a', 'b']` | 服务必须存在，否则不激活 |
| 可选 | `['?cache']` | 服务可以不存在 |

### 可选依赖检查

```typescript
if (ctx.cache) {
  // 使用缓存
} else {
  // 不使用缓存
}
```

## 为什么需要依赖注入？

### 传统方式（问题）

```typescript
// 需要手动管理顺序
const db = new Database()
const cache = new Cache(db)  // 必须先创建 db
const api = new Api(db, cache)  // 必须先创建 db 和 cache
```

### Cordis 方式（解决）

```typescript
// 任意顺序注册
ctx.plugin(Api)      // 依赖 db, cache
ctx.plugin(Cache)    // 依赖 db
ctx.plugin(Database) // 无依赖

// Cordis 自动排序：Database → Cache → Api
```

## 练习

### 练习1：创建依赖链

创建 A → B → C → D 的依赖链，验证 Cordis 的排序。

### 练习2：多依赖

创建一个服务同时依赖 3 个其他服务。

### 练习3：可选依赖

创建一个服务，在有缓存时使用缓存，没有时直接查询。

## 下一课

[第3课：事件系统](../lesson-03-events/README.md)

我们将学习：
- 五种事件派发模式
- 监听器注册
- 实际应用场景
