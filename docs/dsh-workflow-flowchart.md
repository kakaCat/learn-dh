# DSH Workflow 模块流程图（run_code 执行编排）

> 口径：**Workflow 不是一个独立包**，它是「模型在某一轮里手写 TS 程序、编排工具与子代理」的执行模式；唯一的实现入口是 `run_code` 工具。
> 本文 8 张图覆盖：总览 → `run_code` 单次执行 → `tools.*` 单次调用 → 并行调度 → subagent 派发 → 错误/超时收敛 → 与 Goal/Plan 的时序 → 选型决策。
> 图用 Mermaid 书写，GitHub / VS Code(Markdown Preview Mermaid) / Typora 可直接渲染；本机未装 `mmdc`，未导出 PNG。

---

## 0. 口径说明（哪些是运行时事实、哪些是概念表述）

| 结论 | 来源 | 可信度 |
|------|------|--------|
| `run_code({ code, description, timeoutMs?, sandbox_permissions?, justification? })`，默认 `timeoutMs=120000`、上限 `600000` | 本会话 SDK 声明 | 权威（运行时契约） |
| `timeoutMs` 覆盖「嵌套工具调用 + 审批等待」的总耗时 | 同上 | 权威 |
| `code` 是可擦除语法的 async 函数体，类型标注被剥离（type-stripped） | 同上 | 权威 |
| 每次调用跑在**全新 Node 进程**；`process.env` 起始为空；相对路径基于工作目录 | 同上 | 权威 |
| 独立**只读**调用可在 `Promise.all` 下重叠；**写**调用单独执行、按提交顺序 | 同上 | 权威 |
| 工具失败以 `ToolCallError`（带 `toolName` / `message`）reject，可 try/catch 续跑 | 同上 | 权威 |
| 只有 `return` 与 `console.log` 进入对话；图像型结果在本次运行后作为附件回传 | 同上 | 权威 |
| 嵌套工具调用各自保留自己的策略与审批；**程序不会被自动重放** | 同上 | 权威 |
| 「Workflow = 单轮生命周期 / 无持久状态 / 与 Goal、Plan 配合」 | `dsh-workflow-deep-dive.md` §1.1–1.2 | 概念表述 |
| 文中 TypeScript 伪码（`TypeScriptRuntime` / `ToolExecutor` 等） | `dsh-workflow-implementation-guide.md` | **示意实现**，非源码逐字 |
| 超时后如何处理 | `bash` 明确「转后台 job」；`run_code` 仅声明预算，**处置方式未明文** | 见 §5 图注 |

---

## 0.5 Workflow 到底实现了什么

一句话：**它把「这一步怎么干」从模型的多轮 tool-call 往返，压缩成模型自己写一段程序、在单次执行里编排完。**

| 层 | 实现的东西 | 运行时证据 |
|---|---|---|
| 执行载体 | `run_code` 工具 = 把 `code`（可擦除语法的 async 函数体）在**全新 Node 进程**里跑起来，顶层 `await`/`return` 可用 | 每次调用新进程；相对路径基于工作目录；`process.env` 起始为空 |
| 工具面 | Tools SDK：可用工具投影成 `tools.<name>(args)`，返回 canonical JSON；失败边给 `ToolCallError{toolName,message}`，可 `try/catch` 续跑 | 同上 |
| 调度 | 只读调用可并发重叠；写调用单独执行、按提交顺序；长任务可后台 job 化 | `Promise.all` 下只读重叠；`job_output` 收尾 |
| 上下文派生 | 需要独立上下文时用 `subagent` / `subagent_fork` 派出去；workflow 本体**不新建 agent** | `subagent` 默认后台，返回 `subagentId` 可续聊 |
| 隔离与授权 | 沙箱模式按**本次执行**生效（`sandbox_permissions` + `justification`）；审批与嵌套等待都计入 `timeoutMs`（默认 120s / 上限 600s） | 授权不粘到后续调用；预算含等待 |
| 输出 | `return` 值 + `console.log` 进对话；图像型结果事后作为附件回传；附 sandbox 回执 | 只有 print/return 被看见 |
| **不实现** | 无持久状态、不跨轮续跑（那是 goal 的）、不做协作模式编排（那是 plan 的）、**不是独立包或模块** | deep-dive §1.2 对比表 |

对应主图见 §2；两个最容易踩的边界是「超时预算含审批等待」与「程序永不自动重放」。

---

## 1. 总览：Workflow 在架构中的位置

```mermaid
flowchart TD
    U["用户请求 / 自主续跑"] --> AL["Agent Loop 一轮 turn"]

    AL --> MODEL{"模型决定这一步怎么干"}

    MODEL -->|"单点动作"| DIRECT["直接工具：read / grep / bash / edit ..."]
    MODEL -->|"需要组合编排"| RC["run_code 工具面"]
    MODEL -->|"需要独立上下文的整块工作"| SA["subagent / subagent_fork"]
    MODEL -->|"跨轮持久目标"| GOAL["goal 工具组"]

    subgraph WF["Workflow 执行域（一次 run_code = 一次执行）"]
        direction TB
        RC --> VALID["1 参数与权限前置校验"]
        VALID --> PROC["2 全新 Node 进程 + 沙箱策略"]
        PROC --> EXEC["3 执行 code：await 工具 / Promise.all 并行 / try-catch"]
        EXEC --> EMIT["4 收敛输出：return + console.log"]
    end

    subgraph SDK["工具面（Tools SDK）"]
        SDK1["tools.read / glob / grep（只读，可并发）"]
        SDK2["tools.write / edit / bash（写，串行）"]
        SDK3["tools.subagent / job_output / ask_user_question"]
    end

    subgraph INFRA["基础设施层"]
        I1["Session 事件日志"]
        I2["Jobs 后台任务"]
        I3["审批通道"]
        I4["Job / job_output 收尾"]
    end

    EXEC --> SDK1
    EXEC --> SDK2
    EXEC --> SDK3
    EXEC -.-> I3
    SDK3 -.-> I2
    I2 -.-> I4
    EMIT -->|"结果回灌"| AL
    AL --> I1
    GOAL -.->|"自动续跑注入下一轮"| AL

    classDef infra fill:#eef,stroke:#88a
    classDef wf fill:#efe,stroke:#8a8
    class I1,I2,I3,I4 infra
    class VALID,PROC,EXEC,EMIT wf
```

**三条边界的读法**

- Workflow 与 Goal：Goal 管「任务往哪走」（跨轮、持久、带预算）；Workflow 管「这一步怎么干」（单次执行、无状态）。Workflow 跑在 Goal 的某一轮续跑里。
- Workflow 与 Plan：Plan 管「当前轮怎么走」（log-only 提示词引导）；Workflow 是 Plan 落地时的执行手段。
- Workflow 与 subagent：`run_code` **不产生新上下文**，它在本进程里编排；要独立上下文必须显式 `tools.subagent(...)`。

---

## 2. `run_code` 单次执行全流程（主图）

```mermaid
flowchart TD
    START(["模型调用 run_code"]) --> A1{"code 语法可擦除<br/>非空 / 无 enum namespace"} 
    A1 -->|否| E1["调用失败：工具参数错误<br/>模型改写法重试"]
    A1 -->|是| A2{"本次执行需要<br/>更高沙箱权限？"}

    A2 -->|是，且未给 sandbox_permissions| E2["拒绝：需 sandbox_permissions + justification<br/>（本会话审批提示已关闭，越权即拒）"]
    A2 -->|是，且已给出| A3["按 justification 走一次审批<br/>审批通过才继续"]
    A2 -->|否，按当前策略| A3

    A3 --> A4["每次调用 = 全新 Node 进程<br/>cwd = 会话工作目录；process.env 起始为空"]
    A4 --> A5["剥离类型标注，包成 async 函数体执行<br/>顶层 await / return 可用"]

    A5 --> A6{"code 内部动作"}

    A6 -->|"await tools.xxx(...)"| B1["进入工具调用生命周期<br/>（见 §3）"]
    A6 -->|"Promise.all([...])"| B2["只读重叠 / 写串行<br/>（见 §4）"]
    A6 -->|"await tools.subagent(...)"| B3["派发独立上下文子代理<br/>（见 §5）"]
    A6 -->|"await import('node:fs') 等"| B4["Node API 直取<br/>受本次沙箱策略约束"]
    A6 -->|"console.log(...)"| B5["缓冲进本次运行的输出"]

    B1 --> C1{"工具返回还是抛错"}
    C1 -->|"成功"| C2["拿到 canonical JSON 值"]
    C1 -->|"失败"| C3["reject ToolCallError<br/>带 toolName + message"]
    C3 --> C4{"代码里有 try/catch？"}
    C4 -->|有| C2
    C4 -->|无| E3["本次运行失败<br/>错误上报给模型（程序不会自动重放）"]

    C2 --> A7{"还有步骤 / 还有预算？"}
    B2 --> A7
    B3 --> A7
    B4 --> C5{"超预算或异常？"}
    C5 -->|否| A7
    C5 -->|是| E3
    B5 --> A7

    A7 -->|"还有"| A6
    A7 -->|"完成，或 timeoutMs 到期"| OUT["收敛输出"]

    OUT --> O1["return 值（值本身进对话）"]
    OUT --> O2["console.log 文本（进程序输出）"]
    OUT --> O3["图像型子结果：本次运行后作为附件回传"]
    OUT --> O4["sandbox 回执：mode / denied / enforcement"]

    O1 --> NEXT["进入模型下一步：读输出 → 决定继续 / 收尾 / 报错"]
    O2 --> NEXT
    O3 --> NEXT
    O4 --> NEXT
    E3 --> NEXT
    E2 --> NEXT
    E1 --> NEXT

    classDef fail fill:#fee,stroke:#c66
    classDef ok fill:#efe,stroke:#6a6
    class E1,E2,E3 fail
    class O1,O2,O3,O4,NEXT ok
```

**关键时序点**

1. **前置校验先于执行**：语法、权限、审批都在分配进程之前，避免「跑了一半才发现越权」。
2. **一次审批 = 一次执行**：`sandbox_permissions` 的授权只覆盖本程序这一次运行，不粘到后续调用。
3. **超时预算含等待**：`timeoutMs` 计的是墙上时间，把审批弹框、嵌套工具、子代理前台等待全算进去——长任务应显式调大或改走后台（`run_in_background` / jobs）。
4. **失败不重放**：早段副作用可能已经落盘；重试前先 inspect。

---

## 3. 单次 `tools.*` 调用的生命周期

```mermaid
flowchart TD
    T0(["代码里 await tools.name(args)"]) --> T1{"工具在本次<br/>可用清单里？"}
    T1 -->|否| X1["ToolCallError<br/>（未知工具名）"]
    T1 -->|是| T2{"参数可无损 JSON 序列化？"}
    T2 -->|否| X2["ToolCallError<br/>（参数非法）"]
    T2 -->|是| T3{"调用类别"}

    T3 -->|"只读且标注为安全并发"| P1["可与其它只读调用重叠<br/>Promise.all 真并发"]
    T3 -->|"写 / 变更"| P2["单独执行，按提交顺序<br/>不与任何调用重叠"]
    T3 -->|"需要人/审批"| P3["挂起等作答<br/>计入本次 timeoutMs 预算"]

    P1 --> T4{"嵌套策略检查<br/>（沙箱 / 白名单 / 权限）"}
    P2 --> T4
    P3 --> T4

    T4 -->|"被拒"| X3["回执 = 策略拒绝<br/>不换姿势重试同一条命令"]
    T4 -->|"通过"| T5["工具自身执行"]

    T5 --> T6{"结果类型"}
    T6 -->|"普通 JSON 值"| R1["作为 canonical JSON 返回给代码"]
    T6 -->|"带图像"| R2["附件在本次 run_code 之后回传<br/>代码拿到的是元数据"]
    T6 -->|"后台任务"| R3["立即返回 jobId<br/>后续 job_output 读取"]
    T6 -->|"失败"| R4["reject ToolCallError{toolName,message}"]

    R1 --> RET(["回到用户代码继续"])
    R2 --> RET
    R3 --> RET
    R4 --> RET
    X1 --> RET
    X2 --> RET
    X3 --> RET

    classDef err fill:#fee,stroke:#c66
    class X1,X2,X3,R4 err
```

**嵌套调用保留自己的策略**：`run_code` 不是「一次性提权通道」——里面每个工具仍各自过自己的沙箱与审批面；被拒就是被拒，不要换写法绕。

---

## 4. 并行调度：只读重叠、写串行

```mermaid
sequenceDiagram
    autonumber
    participant C as run_code 程序
    participant H as 执行调度器
    participant RO as 只读执行槽
    participant RW as 写执行槽
    participant J as Jobs / 通知

    C->>H: Promise.all 并发投递 读A + 读B + grep C + subagent D
    H->>RO: A、B、C 判定为只读安全 → 并发投递
    H->>J: D 派生独立上下文，异步跑
    RO-->>H: 三者各自完成（顺序不保证）
    H-->>C: Promise 全部 resolve

    Note over C,H: 只读重叠是"允许"，不是"保证"——harness 决定实际并行度

    C->>H: await tools.write(...) / await tools.edit(...)
    H->>RW: 单独占用，按提交顺序
    Note over H,RW: 期间不接受其它写调用并行

    C->>H: 未 await 的写调用（先发起后等待）
    H-->>C: 仍按提交顺序单独执行——别用「不 await」制造并发假象

    J-->>C: 子代理结束 → 收到通知（无需轮询）
    C->>J: 需要中间产物时 job_output(job_id, wait?)
```

**写法要点**

| 想做的事 | 正确写法 | 常见错误 |
|---------|---------|---------|
| 批量读文件 | `await Promise.all(paths.map(p => tools.read({file_path:p})))` | 串行 for 循环逐个 await（慢 N 倍） |
| 批量派子代理 | `run_in_background: true` 默认，拿到 id 后继续干别的 | 前台等待（占满本次 `timeoutMs`） |
| 写文件 | 顺序 await，逐条校验 | 并发 `Promise.all` 写同一片区域（顺序不定） |
| 长任务 | 后台 job + `job_output` 收尾 | 死等前台，撞 600000ms 上限 |

---

## 5. 派发子代理：`subagent` 与 `subagent_fork`

```mermaid
flowchart TD
    S0(["run_code 内 await tools.subagent(prompt)"]) --> S1{"选哪种子代理"}

    S1 -->|"subagent：不带本次对话上下文"| S2["prompt 必须自包含<br/>目标 + 输入 + 交付物形态"]
    S1 -->|"subagent_fork：继承本对话已完成回合"| S3["prompt 只写新增要求<br/>（看不到当前进行中的回合）"]

    S2 --> S4["创建子会话 + 独立事件日志"]
    S3 --> S4
    S4 --> S5{"run_in_background"}

    S5 -->|"true（默认）"| S6["登记后台 job，立即返回<br/>→ {kind:'background', jobId}"]
    S5 -->|"false（仅当下一步依赖结果）"| S7["前台跑完整 loop<br/>→ {kind:'foreground', runId, output}"]

    S6 --> S8["本程序继续干别的；<br/>子代理完成时收到通知"]
    S7 --> S9["直接拿 output 继续"]

    S8 --> S10{"需要再对话？"}
    S9 --> S10
    S10 -->|"是"| S11["send_message(agent_id, ...)<br/>从上次上下文继续"]
    S10 -->|"否，且跑偏了"| S12["interrupt_agent(agent_id)<br/>立即返回，不等停止"]
    S10 -->|"否"| S13["整理产出 / 清理"]

    classDef bg fill:#eef,stroke:#88a
    class S6,S8 bg
```

**与 Workflow 的分工（一句话）**：能用纯编排解决的别开子代理（省一次上下文装载）；需要「独立上下文 + 独立预算 + 可继续对话」的整块工作才派 `subagent`。

---

## 6. 错误、超时与收敛

```mermaid
flowchart TD
    E0(["本次 run_code 期间出现异常"]) --> E1{"异常类型"}

    E1 -->|"工具失败"| A["ToolCallError<br/>toolName + message"]
    A --> A1{"代码内 try/catch？"}
    A1 -->|有| A2["降级继续：记录失败项，产出不完整但可用的结果"]
    A1 -->|无| A3["程序中止 → 错误上报模型"]

    E1 -->|"权限/沙箱拒绝"| B["策略拒绝回执<br/>不换姿势重试"]
    E1 -->|"预算到期"| C["timeoutMs 用尽"]
    C --> C1["bash：命令转后台 job<br/>用 job_output 收尾"]
    C --> C2["run_code 自身：只声明预算<br/>处置方式未明文 → 先 inspect 副作用，再决定是否重试"]

    E1 -->|"用户取消 / 中止"| D["本次执行中断<br/>已完成的副作用仍然存在"]

    A3 --> Z["模型侧收敛动作"]
    B --> Z
    C1 --> Z
    C2 --> Z
    D --> Z
    A2 --> Z
    Z --> Z1["1 先看已有输出与落盘产物，不盲目重跑"]
    Z1 --> Z2["2 判断是参数错 / 权限错 / 规模错"]
    Z2 --> Z3{"规模错？"}
    Z3 -->|是| Z4["拆批：分批 + 后台 job + 增量读取"]
    Z3 -->|否| Z5["修正后重试一次"]

    classDef warn fill:#ffe,stroke:#cc6
    classDef fail fill:#fee,stroke:#c66
    class C1,C2,D warn
    class A3,B fail
```

**硬规则**：程序**不会被自动重放**。任何重试都是模型显式的新调用，且必须建立在「已确认上次副作用范围」之上。

---

## 7. 与 Goal / Plan 的协作时序

```mermaid
sequenceDiagram
    autonumber
    participant U as 人
    participant G as Goal 状态机（跨轮持久）
    participant A as Agent Loop（本轮）
    participant P as Plan 模式（log-only）
    participant W as Workflow（run_code 一次执行）
    participant T as 工具面 / 子代理

    U->>G: create_goal(objective, max_goal_rounds)
    loop 自动续跑（受轮次预算）
        G->>A: 注入目标 + 轮次读数 + 授权边界
        A->>P: 需要协作时进 plan 模式（exit_plan_mode 获批）
        P-->>A: 本轮怎么走
        A->>W: run_code(code, description, timeoutMs)
        W->>T: 只读并发 / 写串行 / 派 subagent
        T-->>W: 结果 / ToolCallError
        W-->>A: return + console.log（+ 图像附件）
        A->>G: 汇报进展；未完成则请求下一轮
    end
    G->>U: 完成 / blocked（附具体阻塞条件）
```

---

## 8. 选型决策：什么时候才该用 Workflow

```mermaid
flowchart TD
    Q0{"这一步要干的事"} --> Q1{"1–2 次工具调用就够？"}
    Q1 -->|是| A1["直接工具调用<br/>（read / edit / bash）"]
    Q1 -->|否| Q2{"需要条件分支 / 循环 / 数据整形？"}
    Q2 -->|否| A2["几次直接调用串行即可"]
    Q2 -->|是| Q3{"需要独立上下文或独立预算？"}
    Q3 -->|是| A3["subagent 承担<br/>（可 fork 继承上下文）"]
    Q3 -->|否| Q4{"需要跨轮自动续跑 / 预算与授权？"}
    Q4 -->|是| A4["goal 管目标，Workflow 管单轮打法"]
    Q4 -->|否| A5["run_code：一次执行编排<br/>只读并发 + 写串行 + try/catch"]

    classDef pick fill:#efe,stroke:#6a6
    class A5,A3,A4 pick
```

---

## 9. 一页速查

| 维度 | Workflow（run_code） |
|------|---------------------|
| 生命周期 | 单次执行，无持久状态 |
| 状态存放 | Session 事件日志 / 台账文件（不在 workflow 内） |
| 上下文 | 与当前会话同一进程，不新建 agent |
| 并发规则 | 只读可重叠；写单独、按提交顺序 |
| 错误通道 | `ToolCallError{toolName,message}`，可 catch |
| 预算 | `timeoutMs` 默认 120000、上限 600000，含审批与嵌套等待 |
| 隔离 | 每次调用全新 Node 进程；`process.env` 起始为空 |
| 提权 | `sandbox_permissions` + `justification`，仅本次执行有效 |
| 重放 | 永不自动重放；重试前先 inspect |
| 输出通道 | `return` + `console.log`；图像结果事后作为附件回传 |

**关联文档**：`docs/dsh-workflow-deep-dive.md`（概念与模式）、`docs/dsh-workflow-implementation-guide.md`（示意实现与案例）、`03-执行流程/01-turn-flow.md`（一轮 turn 的完整流程）。
