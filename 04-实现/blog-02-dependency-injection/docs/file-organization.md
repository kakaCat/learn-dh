# Cordis 项目文件组织方式

## 方式1：单文件（学习/演示用）

```typescript
// main.ts
import { Context, Service } from '@cordisjs/core'

// 所有服务定义在一个文件
class DatabaseService extends Service { ... }
class CacheService extends Service { ... }
CacheService.inject = ['database']

const ctx = new Context()
ctx.plugin(DatabaseService)
ctx.plugin(CacheService)
```

**适用场景：**
- 学习演示
- 小型脚本
- 快速原型

---

## 方式2：多文件（推荐用于实际项目）

### 目录结构
```
src/
├── services/
│   ├── database.ts      # DatabaseService
│   ├── cache.ts         # CacheService
│   └── api.ts           # ApiService
├── types.ts             # 类型扩展
└── main.ts              # 入口
```

### types.ts - 类型扩展集中管理
```typescript
import type { DatabaseService } from './services/database'
import type { CacheService } from './services/cache'
import type { ApiService } from './services/api'

declare module '@cordisjs/core' {
  interface Context {
    database: DatabaseService
    cache: CacheService
    api: ApiService
  }
}
```

### services/database.ts
```typescript
import { Context, Service } from '@cordisjs/core'

export class DatabaseService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'database', true)
  }

  query(sql: string): string {
    return `DB result for: ${sql}`
  }
}

// 导出时可以选择：
export default DatabaseService  // 默认导出
// 或者
export { DatabaseService }      // 命名导出
```

### services/cache.ts
```typescript
import { Context, Service } from '@cordisjs/core'

export class CacheService extends Service {
  private data = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'cache', true)
    // 使用依赖
    const result = ctx.database.query('SELECT * FROM config')
  }

  set(key: string, value: string) {
    this.data.set(key, value)
  }

  get(key: string): string | undefined {
    return this.data.get(key)
  }
}

// 声明依赖
CacheService.inject = ['database']

export default CacheService
```

### services/api.ts
```typescript
import { Context, Service } from '@cordisjs/core'

export class ApiService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'api', true)
  }

  fetch(endpoint: string): string {
    const cached = this.ctx.cache.get(endpoint)
    if (cached) return `Cache hit: ${cached}`
    return this.ctx.database.query(`SELECT * FROM ${endpoint}`)
  }
}

ApiService.inject = ['database', 'cache']

export default ApiService
```

### main.ts - 入口文件
```typescript
import { Context } from '@cordisjs/core'
import './types'  // 导入类型扩展

import DatabaseService from './services/database'
import CacheService from './services/cache'
import ApiService from './services/api'

async function main() {
  const ctx = new Context()

  // 注册服务
  ctx.plugin(DatabaseService)
  ctx.plugin(CacheService)
  ctx.plugin(ApiService)

  // 等待激活
  await new Promise(resolve => setImmediate(resolve))

  // 使用服务
  const result = ctx.api.fetch('/users')
  console.log(result)
}

main()
```

---

## 方式3：插件式组织（大型项目）

### 目录结构
```
src/
├── plugins/
│   ├── database/
│   │   ├── index.ts
│   │   └── service.ts
│   ├── cache/
│   │   ├── index.ts
│   │   └── service.ts
│   └── api/
│       ├── index.ts
│       └── service.ts
└── main.ts
```

### plugins/database/index.ts
```typescript
import { Context } from '@cordisjs/core'
import { DatabaseService } from './service'

export * from './service'

// 导出插件函数
export default function(ctx: Context) {
  ctx.plugin(DatabaseService)
}
```

### plugins/cache/index.ts
```typescript
import { Context } from '@cordisjs/core'
import { CacheService } from './service'

export * from './service'

export default function(ctx: Context) {
  ctx.plugin(CacheService)
}

// 插件级别的依赖声明
export const inject = ['database']
```

### main.ts
```typescript
import { Context } from '@cordisjs/core'
import database from './plugins/database'
import cache from './plugins/cache'
import api from './plugins/api'

const ctx = new Context()

// 以插件方式注册
ctx.plugin(database)
ctx.plugin(cache)
ctx.plugin(api)
```

---

## 对比

| 方式 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| **单文件** | 简单直观 | 难以维护 | 学习、演示 |
| **多文件** | 清晰分离 | 需要管理导入 | 中小型项目 |
| **插件式** | 高度模块化 | 目录结构复杂 | 大型项目、可复用插件 |

---

## 推荐实践

1. **学习阶段**：单文件，快速理解概念
2. **实际开发**：多文件，每个服务独立文件
3. **开源插件**：插件式，可单独发布

**当前演示代码**：单文件方式，便于理解依赖注入机制
**实际项目建议**：多文件方式，清晰易维护
