# DeepSeek Harness 从 0 开始：Cordis 核心概念入门

Learn the fundamental concepts of Cordis framework.

## Contents

- **Part 1: Hello World** - Basic Context and plugin concepts
- **Part 2: Three Plugin Forms** - Function, object, and class plugins

## Installation

```bash
pnpm install
```

## Run

```bash
pnpm dev
```

## What You'll Learn

- How to create a Context
- Three ways to define plugins
- Using `ctx.provide()` to register services

## Key Concepts

### Context
The core container that holds services and manages plugin lifecycle.

### Plugin Forms
1. **Function Plugin** - Simple function that receives Context
2. **Object Plugin** - Object with `name` and `apply` method
3. **Class Plugin** - Class that extends Service, accepts config

## Source Files

- `lesson-00-hello/` - Original Hello World lesson
- `lesson-01-plugin/` - Original plugin forms lesson
