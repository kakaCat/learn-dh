# 依赖注入的几种方式

## 1. 构造函数注入（Constructor Injection）

**最常见的方式**，Cordis 就是这种。

```typescript
class UserService {
  constructor(private database: Database) {}
  
  getUser(id: string) {
    return this.database.query(`SELECT * FROM users WHERE id = ${id}`)
  }
}

// 使用时：
const db = new Database()
const userService = new UserService(db)
```

**优点：**
- 依赖关系明确
- 强制提供依赖
- 不可变性（依赖一旦注入不能改变）

**Cordis 的特点：**
```typescript
class CacheService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'cache', true)
    // 通过 ctx 访问依赖
    this.ctx.database.query('...')
  }
}
CacheService.inject = ['database']  // 声明式依赖
```

---

## 2. 属性注入（Property Injection）

**通过属性赋值注入依赖**。

```typescript
class UserService {
  database!: Database  // 使用 ! 表示会被外部赋值
  
  getUser(id: string) {
    return this.database.query(`SELECT * FROM users WHERE id = ${id}`)
  }
}

// 使用时：
const userService = new UserService()
userService.database = new Database()  // 属性注入
```

**优点：**
- 灵活，可以延迟注入
- 可以替换依赖

**缺点：**
- 依赖不明确
- 容易忘记注入导致运行时错误

---

## 3. 方法注入（Method Injection）

**通过方法参数传入依赖**。

```typescript
class UserService {
  getUser(id: string, database: Database) {
    return database.query(`SELECT * FROM users WHERE id = ${id}`)
  }
}

// 使用时：
const userService = new UserService()
const db = new Database()
userService.getUser('123', db)
```

**优点：**
- 最灵活
- 每次调用可以用不同的依赖

**缺点：**
- 如果每个方法都需要，会很繁琐

---

## 4. 装饰器注入（Decorator Injection）

**TypeScript/NestJS 常用的方式**。

```typescript
import { Injectable, Inject } from '@nestjs/common'

@Injectable()
class UserService {
  constructor(
    @Inject('DATABASE') private database: Database
  ) {}
  
  getUser(id: string) {
    return this.database.query(`SELECT * FROM users WHERE id = ${id}`)
  }
}

// 在模块中注册：
@Module({
  providers: [
    { provide: 'DATABASE', useClass: Database },
    UserService
  ]
})
```

**优点：**
- 语法优雅
- 框架自动管理依赖
- 支持多种注入方式（类、值、工厂）

**缺点：**
- 需要装饰器支持（实验性特性）
- 框架绑定强

---

## 5. 服务定位器（Service Locator）

**通过容器查找依赖**。

```typescript
class ServiceLocator {
  private services = new Map()
  
  register(name: string, service: any) {
    this.services.set(name, service)
  }
  
  get(name: string) {
    return this.services.get(name)
  }
}

class UserService {
  constructor(private locator: ServiceLocator) {}
  
  getUser(id: string) {
    const db = this.locator.get('database')  // 动态查找
    return db.query(`SELECT * FROM users WHERE id = ${id}`)
  }
}
```

**优点：**
- 灵活
- 可以动态替换服务

**缺点：**
- 依赖隐藏（不知道需要哪些服务）
- 类型安全差
- 被认为是反模式

---

## 6. 依赖注入容器（DI Container）

**使用专门的容器管理依赖**。

### InversifyJS 示例：
```typescript
import { Container, injectable, inject } from 'inversify'

@injectable()
class Database {
  query(sql: string) { /* ... */ }
}

@injectable()
class UserService {
  constructor(@inject('Database') private database: Database) {}
  
  getUser(id: string) {
    return this.database.query(`SELECT * FROM users WHERE id = ${id}`)
  }
}

// 容器配置：
const container = new Container()
container.bind('Database').to(Database)
container.bind('UserService').to(UserService)

// 使用：
const userService = container.get<UserService>('UserService')
```

### TSyringe 示例：
```typescript
import { injectable, inject, container } from 'tsyringe'

@injectable()
class Database {
  query(sql: string) { /* ... */ }
}

@injectable()
class UserService {
  constructor(private database: Database) {}  // 自动注入
  
  getUser(id: string) {
    return this.database.query(`SELECT * FROM users WHERE id = ${id}`)
  }
}

// 使用：
const userService = container.resolve(UserService)
```

**优点：**
- 自动解析依赖关系
- 支持生命周期管理（单例、瞬态等）
- 解耦强

---

## 7. 函数式依赖注入

**不使用类，通过闭包或高阶函数**。

```typescript
// 工厂函数
function createUserService(database: Database) {
  return {
    getUser(id: string) {
      return database.query(`SELECT * FROM users WHERE id = ${id}`)
    }
  }
}

// 使用：
const db = new Database()
const userService = createUserService(db)
```

**或者使用柯里化：**
```typescript
const getUser = (database: Database) => (id: string) => {
  return database.query(`SELECT * FROM users WHERE id = ${id}`)
}

// 使用：
const db = new Database()
const getUserWithDb = getUser(db)
getUserWithDb('123')
```

**优点：**
- 简单
- 不需要框架
- 函数式风格

---

## 对比总结

| 方式 | Cordis | NestJS | Angular | InversifyJS | 函数式 |
|------|--------|--------|---------|-------------|--------|
| **注入方式** | 构造函数+声明 | 装饰器 | 装饰器 | 装饰器+容器 | 函数参数 |
| **类型安全** | ✅ 强 | ✅ 强 | ✅ 强 | ✅ 强 | ✅ 强 |
| **自动解析** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **学习曲线** | 低 | 中 | 高 | 中 | 低 |
| **框架绑定** | 中 | 强 | 强 | 弱 | 无 |

---

## Cordis 的特点

```typescript
class CacheService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'cache', true)
    // 依赖通过 ctx 访问
    this.ctx.database.query('...')
  }
}
// 声明式依赖
CacheService.inject = ['database']
```

**特点：**
1. **声明式依赖**：`inject = ['database']`
2. **自动排序**：根据依赖图计算加载顺序
3. **Context 注入**：所有依赖通过 `ctx` 访问
4. **可选依赖**：`inject = ['?cache']`
5. **生命周期管理**：自动激活/停用

**适用场景：**
- 插件系统
- 模块化应用
- 需要动态加载/卸载服务的场景

---

## 选择建议

- **小型项目/库**：函数式注入或手动构造函数注入
- **NestJS 项目**：装饰器注入
- **Angular 项目**：Angular DI
- **插件系统**：Cordis
- **需要复杂依赖管理**：InversifyJS 或 TSyringe
- **不想引入框架**：手动构造函数注入
