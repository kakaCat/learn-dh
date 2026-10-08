# 第0课：Hello World

## 目标

运行你的第一个 Cordis 程序，理解最基本的概念。

## 运行

```bash
cd lesson-00-hello
pnpm install
pnpm run dev
```

## 预期输出

```
1️⃣  创建 Context...
2️⃣  注册插件...
🎉 Hello from plugin!
3️⃣  使用服务...
Hello, World!
4️⃣  完成！
```

## 核心概念

### 1. Context（上下文）

Context 是 Cordis 的核心，它是一个**依赖容器**：

```typescript
const ctx = new Context()
```

你可以把它想象成一个"盒子"：
- 插件可以往里面放东西（注册服务）
- 插件可以从里面拿东西（使用服务）

### 2. Plugin（插件）

插件就是一个**函数**，接收 Context 作为参数：

```typescript
function myPlugin(ctx: Context) {
  // 在这里做你想做的事
}
```

### 3. 注册插件

使用 `ctx.plugin()` 注册插件：

```typescript
ctx.plugin(myPlugin)
```

注册后，Cordis 会立即调用这个函数。

### 4. 服务

服务就是挂在 Context 上的对象：

```typescript
// 注册服务
ctx.hello = {
  say(name: string) {
    return `Hello, ${name}!`
  }
}

// 使用服务
ctx.hello.say('World')  // "Hello, World!"
```

## 练习

### 练习1：修改问候语

修改 `main.ts`，让输出变成 `"你好，世界！"`。

### 练习2：添加新功能

给 `hello` 服务添加一个新方法 `goodbye`：

```typescript
ctx.hello = {
  say(name: string) {
    return `Hello, ${name}!`
  },
  goodbye(name: string) {
    return `Goodbye, ${name}!`
  }
}
```

然后调用它：

```typescript
console.log(ctx.hello.goodbye('World'))
```

### 练习3：注册多个插件

创建第二个插件，使用第一个插件的服务：

```typescript
function greetingPlugin(ctx: Context) {
  // 使用 hello 服务
  console.log(ctx.hello.say('Cordis'))
}

ctx.plugin(helloPlugin)
ctx.plugin(greetingPlugin)
```

## 下一课

[第1课：插件](../lesson-01-plugin/README.md)

我们将学习：
- 插件的三种形态：函数 / 对象 / 类
- 给插件传配置
- 用 effect 管理插件资源
