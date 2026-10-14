# DSH Webhook 通知插件（教学 demo）

一个**能跑通**的最小插件：监听真实 DSH 的会话事件总线 `session/event`，
按事件类型把通知 POST 到配置的 webhook；不同 webhook 可以订阅不同事件。

**插件代码用的是真实 DSH 的事件名与字段结构**，可以直接复制进真实项目。
完整讲解见 [`blog.md`](./blog.md)：

1. 插件是怎么嵌进 DSH 的
2. 到底用了 DSH 的什么（拦截点 / 会话事件 / 服务）
3. 原理（为什么分层、依赖注入解决什么）
4. 业务实现（逐文件）

## 跑起来

```bash
pnpm install
pnpm dev
```

实测输出：

```
[notice-webhook] 已加载 2 个 webhook
[notice-webhook] 已监听 session/event

▶ 模拟一轮对话：模型回复 → 工具失败 → 一轮结束
  📨 https://slack.example.com/hooks/xxx 收到：❌ 工具执行失败
     正文：工具 write_file 执行失败：Permission denied
[NoticeService] ✅ 通知发送成功: https://slack.example.com/hooks/xxx (2ms)
  📨 https://dingtalk.example.com/robot/send 收到：✅ 一轮对话结束
     正文：会话 session-001 的 turn turn-1 已结束
[NoticeService] ✅ 通知发送成功: https://dingtalk.example.com/robot/send (0ms)

累计发出 2 条通知
```

`main.ts` 里用假 `fetch` 顶替网络，所以离线也能跑、也能看到 webhook 收到了什么。

## 文件结构

```
src/
├── types.ts     真实会话事件结构 + 通知/配置类型
├── service.ts   NoticeService：HTTP POST + 超时 + 重试 + 绝不抛异常
├── plugin.ts    插件主体：监听 session/event，按事件类型分发通知
└── main.ts      宿主演示：注册服务 → 安装插件 → 模拟会话事件
```

## 四条业务规则

| 规则 | 在哪 | 作用 |
| --- | --- | --- |
| 两阶段关联工具名 | `toolNames.set` / `get` | 真实 `tool/result` 只带 `id` 不带 `name`，靠 `tool/call` 补 |
| 事件订阅过滤 | `w.events.includes(payload.type)` | 每个 webhook 只收自己关心的事件 |
| 级别闸门 | `order.indexOf(...)` 比较 | 生产环境只看 error 以上 |
| 失败不影响主流程 | 服务层不抛 + 插件层 `.catch()` | webhook 挂了，Agent 照常干活 |

## 复制到真实 DSH 时

| 文件 | 能否直接用 |
| --- | --- |
| `src/service.ts` | ✅ 直接复制 |
| `src/plugin.ts` | ✅ 直接复制（事件名已是真实的） |
| `src/types.ts` | ⚠️ 参考用；真实项目建议换成 DSH 自己的事件类型 |
| `src/main.ts` | ❌ 不要复制：宿主演示，含假 fetch 与假事件 |

还要做一件事：**删掉假 `fetch`**（`main.ts` 里那段 `globalThis.fetch = ...`），让真实网络生效。

装载方式见 `blog.md` 的 1.4：插件包用 `dsh.bundle.patch` 自带装载层，
目标 profile 再把它登记进 `dsh.profile.bundles`；Host 半改完要重启 Host。

## 真实 DSH 的事件对照（供参考）

会话事件（`ctx.on("session/event", (session, event) => ...)`）：
`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、
`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`。

拦截点（多数是 waterfall，签名 `(载荷, next)`，用于"插手"而非旁听）：
`agent/pre-step`、`agent/request`、`tools/pre-execute`、`tools/execute`、
`tools/post-execute`。

另有 `agent/turn-stopping`：**serial 派发**（`ctx.serial`），监听器收 `(agent)`、没有 `next`、不能短路。
