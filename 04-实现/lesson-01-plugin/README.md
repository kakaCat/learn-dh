# 第1课：插件

## 目标

理解 Cordis 插件的三种形态，学会给插件传配置，以及用 `ctx.effect()` 管理插件的资源。

## 运行

```bash
cd lesson-01-plugin
pnpm install

# 主程序：三种插件形态
pnpm run dev

# Effect 演示：插件的资源管理
pnpm run effect
```

## 什么是插件？

第0课已经见过：插件就是**接收 Context 的函数**，注册时执行一次。
但函数不是唯一形态——Cordis 接受三种形态的插件。

## 三种插件形态

### 1. 函数插件

```typescript
function myPlugin(ctx: Context) {
  ctx.provide('myService', { ... })
}

await ctx.plugin(myPlugin)
```

最简单，适合逻辑较少的插件。

### 2. 对象插件

```typescript
const myPlugin = {
  name: 'my-plugin',           // 可选：插件名，便于调试
  apply(ctx: Context) {
    ctx.provide('myService', { ... })
  }
}

await ctx.plugin(myPlugin)
```

适合需要携带元信息（名字、依赖声明等）的插件。

### 3. 类插件

```typescript
class MyPlugin {
  constructor(ctx: Context) {
    ctx.provide('myService', { ... })
  }
}

await ctx.plugin(MyPlugin)
```

适合有内部状态的插件。第2课还会介绍更规范的 `Service` 基类。

> 三种形态完全等价，选哪种取决于插件的复杂程度。

## 给插件传配置

`ctx.plugin()` 的第二个参数会作为插件的第二个形参传入：

```typescript
function greeterPlugin(ctx: Context, config: { name: string }) {
  ctx.provide('greeter', {
    greet: () => `Hello, ${config.name}!`
  })
}

await ctx.plugin(greeterPlugin, { name: 'World' })
ctx.greeter.greet()  // "Hello, World!"
```

## 插件的资源管理：Effect

插件如果要申请资源（定时器、监听器），清理代码写在哪里？
答案是 `ctx.effect()`——把 setup 和 cleanup 配对注册：

```typescript
ctx.effect(() => {
  // Setup：初始化资源
  const timer = setInterval(() => { ... }, 1000)

  // 返回 Cleanup 函数
  return () => clearInterval(timer)
})
```

**关键特性**：

- 注册时立即执行 setup
- 插件卸载（`fiber.dispose()`）时自动执行 cleanup
- 多个 effect 按 **LIFO**（后进先出）顺序清理

`ctx.plugin()` 返回的 **Fiber** 是插件的运行实例，调用 `fiber.dispose()`
即可卸载插件并触发它的所有 cleanup。

## 练习

### 练习1：三种形态互换

把 `main.ts` 里的函数插件改写成对象插件和类插件，验证行为一致。

### 练习2：带配置的插件

写一个插件，通过配置决定它注册的服务名和行为。

### 练习3：观察清理顺序

注册多个 effect，卸载插件，观察它们按什么顺序清理。

## 下一课

[第2课：依赖注入](../lesson-02-inject/README.md)

我们将学习：
- 使用 Service 类定义插件
- 如何声明依赖
- Cordis 如何自动排序
