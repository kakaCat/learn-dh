# Simple DH 学习课程

从零开始，一步一步实现一个简化版的 DeepSeek Harness。

## 课程列表

### 第0课：Hello World（认识 Cordis）
**目标**：运行最简单的 Cordis 程序
**代码**：`lesson-00-hello/`
**知识点**：
- 什么是 Cordis
- 如何创建 Context
- 如何注册一个简单的插件
- 运行第一个程序

### 第1课：插件
**目标**：理解 Cordis 的插件机制
**代码**：`lesson-01-plugin/`
**知识点**：
- 插件的三种形态：函数 / 对象 / 类
- 给插件传配置
- ctx.effect() 管理插件资源

### 第2课：依赖注入
**目标**：理解插件间的依赖关系
**代码**：`lesson-02-inject/`
**知识点**：
- Service 基类
- inject 声明依赖
- Cordis 自动排序
- 可选依赖
- 通过 ctx 访问服务

### 第3课：事件系统
**目标**：理解事件的五种派发模式
**代码**：`lesson-03-events/`
**知识点**：
- emit / parallel / serial / bail / waterfall
- ctx.on() 注册监听器
- 事件过滤
- 实际应用场景

### 第4课：Session 模块
**目标**：实现事件日志系统
**代码**：`lesson-04-session/`
**知识点**：
- 什么是 append-only 日志
- SessionEvent 类型定义
- 创建、追加、查询事件
- 事件广播

### 第5课：Tools 模块
**目标**：实现工具注册和执行
**代码**：`lesson-05-tools/`
**知识点**：
- Tool 接口定义
- 注册工具
- JSON Schema 生成
- 工具执行管道

### 第6课：System Prompt 模块
**目标**：实现提示词组装
**代码**：`lesson-06-prompt/`
**知识点**：
- PromptSection 片段
- 优先级排序
- 条件片段
- 动态生成

### 第7课：LLM 适配器
**目标**：连接真实的语言模型
**代码**：`lesson-07-llm/`
**知识点**：
- LLM 接口抽象
- OpenAI API 调用
- 流式输出
- 错误处理

### 第8课：Agent Loop
**目标**：实现完整的 Agent 执行循环
**代码**：`lesson-08-agent/`
**知识点**：
- Turn / Step 概念
- 消息派生
- 工具调用循环
- 拦截点（pre-step, request, turn-stopping）

### 第9课：完整整合
**目标**：把所有模块整合成一个可用的 Agent
**代码**：`lesson-09-complete/`
**知识点**：
- 模块集成
- 配置管理
- 命令行交互
- 实际使用

## 学习路径

```
第0课 ──→ 第1课 ──→ 第2课 ──→ 第3课
  ↓
认识 Cordis    插件    依赖注入   事件

第4课 ──→ 第5课 ──→ 第6课 ──→ 第7课
  ↓
Session     Tools    Prompt    LLM

第8课 ──→ 第9课
  ↓
Agent Loop   完整系统
```

## 每课结构

每个课程目录包含：

```
lesson-XX-name/
├── README.md          # 课程说明
├── package.json       # 依赖
├── tsconfig.json      # TypeScript 配置
├── src/
│   ├── index.ts       # 入口文件
│   ├── main.ts        # 可运行的示例
│   └── ...            # 课程相关代码
```

## 前置要求

- Node.js 22+
- pnpm
- TypeScript 基础

## 开始第一课

```bash
cd lesson-00-hello
pnpm install
pnpm run dev
```
