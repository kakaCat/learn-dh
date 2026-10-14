# blog-21-goal-derive

[blog-20-goal](../blog-20-goal/blog.md) 的深挖篇：**goal 的 derive 引擎**（会话日志 → 严格折叠 → 投影单元 → 会话投影注册表）。

- 正文：[blog.md](./blog.md)
- **没有独立 `src/`**：本篇是源码走读，可运行代码沿用 blog-20-goal，运行方式不变：

```bash
cd ../blog-20-goal
pnpm install
pnpm dev
```

本篇引用的真实源码（本机 dsh checkout）：

- `packages/goal/goal/src/fold.ts`——纯折叠与严格重放
- `packages/goal/goal/src/index.ts`——`goalProjectionDefinition` / `applyGoalProjection`
- `packages/session/session-projection/src/index.ts`——`SessionProjectionRegistry`
