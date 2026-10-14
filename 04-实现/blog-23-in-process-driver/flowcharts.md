# InProcessDriver 详细流程图

## 1. 总体架构图

```mermaid
flowchart TB
    subgraph Parent["父 Agent 域"]
        PA[Parent Agent]
        PS[Parent Session]
        PI[Parent Inbox]
        PP[Parent Policy]
    end

    subgraph Driver["InProcessDriver"]
        DIR[startInProcessRun]
        D1[resolveChildDepth]
        D2[captureDelegatedPolicy]
        D3[agents.create]
        D4[appendPolicyOverrides]
        D5[applyChildComposition]
        D6[followup + whenIdle]
        D7[finalAssistantOutput]
    end

    subgraph Child["子 Agent 域"]
        CA[Child Agent]
        CS[Child Session]
        CI[Child Inbox]
        CP[Child Policy]
        CSP[Child SystemPrompt]
    end

    subgraph Shared["共享层 (Cordis Context)"]
        CTX[Cordis Context]
        SVC[共享服务]
        LLM[LLM]
    end

    PA --> DIR
    PS --> DIR
    PP --> D2

    DIR --> D1
    DIR --> D2
    D1 --> D3
    D2 --> D4
    D3 --> CA
    D4 --> CP
    D5 --> CSP
    CA --> D6
    D6 --> D7
    D7 --> PA

    CTX --> PA
    CTX --> CA
    CTX --> SVC

    PA --> LLM
    CA --> LLM
```

## 2. startInProcessRun 五阶段流程

```mermaid
flowchart TD
    Start([调用 startInProcessRun]) --> Phase1

    subgraph Phase1["阶段 1: 准备 (同步)"]
        P1A[resolveChildDepth<br>计算子代理深度]
        P1B{depth 超过 maxDepth?}
        P1C[throw Error<br>Delegation depth limit exceeded]
        P1D[captureDelegatedPolicyOverrides<br>捕获父代理策略]

        P1A --> P1B
        P1B -->|Yes| P1C
        P1B -->|No| P1D
    end

    Phase1 --> Phase2

    subgraph Phase2["阶段 2: 创建子代理 (同步)"]
        P2A[生成 childId<br>child-parentId-counter]
        P2B[ctx.agents.create childId]
        P2C[设置 session.meta<br>parentSession/origin/depth]

        P2A --> P2B --> P2C
    end

    Phase2 --> Phase3

    subgraph Phase3["阶段 3: 窗口 Setup (同步)"]
        P3A[appendDelegatedPolicyOverrides<br>应用继承的策略]
        P3B[applyChildComposition<br>组装 system prompt]
        P3C[注入 persona]
        P3D[应用 toolFilter]

        P3A --> P3B --> P3C --> P3D
    end

    Phase3 --> Phase4

    subgraph Phase4["阶段 4: 驱动执行 (异步)"]
        P4A[child.followup prompt]
        P4B[await child.whenIdle]
        P4C[finalAssistantOutput]
        P4D{执行成功?}
        P4E[返回 stopReason: completed]
        P4F[返回 stopReason: error]

        P4A --> P4B --> P4C --> P4D
        P4D -->|Yes| P4E
        P4D -->|No| P4F
    end

    Phase4 --> Phase5

    subgraph Phase5["阶段 5: 返回 Run Handle"]
        P5A[return id/localAgent/result/dispose]
    end

    Phase5 --> End([父 Agent 获得 SubagentRun])
    P1C --> ErrEnd([抛出异常])

    End --> WaitResult[父 Agent 可 await run.result]
    WaitResult --> Dispose[或调用 run.dispose 释放]
```

## 3. 父子通信时序图

```mermaid
sequenceDiagram
    autonumber
    participant P as 父 Agent
    participant D as InProcessDriver
    participant C as 子 Agent
    participant S as 子 Session
    participant L as LLM

    P->>D: startInProcessRun({parent, prompt, persona, toolFilter})

    Note over D: 阶段 1-3 (同步)
    D->>D: resolveChildDepth()
    D->>D: captureDelegatedPolicyOverrides()
    D->>C: ctx.agents.create(childId)
    D->>C: 设置 session.meta
    D->>C: appendDelegatedPolicyOverrides()
    D->>C: applyChildComposition()

    D-->>P: 返回 SubagentRun (立即)

    Note over D,C: 阶段 4 (异步，不阻塞父 Agent)

    D->>C: followup({type: text, text: prompt})
    C->>S: 写入用户消息
    C->>L: 发送请求
    L-->>C: 模型响应

    loop 工具调用循环
        C->>C: 调用工具 (read/grep/...)
        C->>S: 写入工具结果
        C->>L: 继续请求
        L-->>C: 模型响应
    end

    C->>S: 写入最终助手消息
    C->>C: emit('idle')
    D->>C: whenIdle() resolve
    D->>S: finalAssistantOutput()
    S-->>D: 返回最终输出文本

    D-->>P: result Promise resolve
    Note over P: {output, stopReason: 'completed'}

    P->>D: 可选: run.dispose()
```

## 4. 策略委托流程

```mermaid
flowchart LR
    subgraph T0["T0: 委托前"]
        PA0[父 Agent<br>policy: workspace-write]
    end

    subgraph T1["T1: 捕获策略"]
        CAP[captureDelegated<br>PolicyOverrides]
        SNAP[快照<br>sandbox: workspace-write<br>timeout: 5000]
    end

    subgraph T2["T2: 创建子代理"]
        CH[子 Agent]
        APPLY[appendDelegated<br>PolicyOverrides]
        CHP[子代理策略<br>sandbox: workspace-write]
    end

    subgraph T3["T3: 父代理变更策略"]
        PACHANGE[父 Agent 修改<br>policy: danger-full-access]
    end

    subgraph T4["T4: 结果"]
        R1[父代理: danger-full-access]
        R2[子代理: workspace-write ✅<br>不受影响]
    end

    PA0 --> CAP
    CAP --> SNAP
    SNAP --> APPLY
    APPLY --> CHP
    CH --> CHP

    PA0 --> PACHANGE
    PACHANGE --> R1
    CHP --> R2

    SNAP -.->|浅拷贝隔离| APPLY
```

## 5. 深度控制流程

```mermaid
flowchart TD
    Start([父 Agent 调用 subagent]) --> Read{读取 parent.session.meta<br>.delegationDepth}

    Read -->|存在| GetDepth[parentDepth = 值]
    Read -->|不存在| DefaultDepth[parentDepth = 0]

    GetDepth --> Calc[childDepth = parentDepth + 1]
    DefaultDepth --> Calc

    Calc --> GetLimit{maxDepth 参数?}
    GetLimit -->|提供| UseParam[limit = maxDepth]
    GetLimit -->|未提供| UseDefault[limit = 3<br>DEFAULT_MAX_DEPTH]

    UseParam --> Compare
    UseDefault --> Compare

    Compare{childDepth 超过 limit?}
    Compare -->|Yes| Throw[throw Error<br>Delegation depth limit exceeded]
    Compare -->|No| Proceed[继续创建子代理]

    Throw --> Reject([委托被拒绝])
    Proceed --> SetMeta[设置子代理<br>delegationDepth = childDepth]

    SetMeta --> Case1{childDepth = 1?}
    Case1 -->|Yes| L1[一级子代理<br>典型: 独立任务委托]
    Case1 -->|No| Case2{childDepth = 2?}
    Case2 -->|Yes| L2[二级子代理<br>典型: 子任务再拆分]
    Case2 -->|No| L3[三级子代理<br>极少使用]

    L1 --> Next[子代理可继续委托<br>直到达到上限]
    L2 --> Next
    L3 --> Next
```

## 6. 并发子代理执行流程

```mermaid
flowchart TB
    Start([父 Agent 需要并行处理 3 个任务]) --> Fork

    subgraph Fork["并行委托"]
        F1[startInProcessRun Task A]
        F2[startInProcessRun Task B]
        F3[startInProcessRun Task C]
    end

    Fork --> Parallel

    subgraph Parallel["并行执行 (各自独立)"]
        direction LR
        subgraph WA["Workstream A"]
            A1[创建 Child A] --> A2[执行 Task A] --> A3[产生 Output A]
        end
        subgraph WB["Workstream B"]
            B1[创建 Child B] --> B2[执行 Task B] --> B3[产生 Output B]
        end
        subgraph WC["Workstream C"]
            C1[创建 Child C] --> C2[执行 Task C] --> C3[产生 Output C]
        end
    end

    Parallel --> Join[Promise.all<br>等待所有结果]

    Join --> Collect[收集结果]
    Collect --> Aggregate[父 Agent 汇总]

    Aggregate --> Decision{需要继续?}
    Decision -->|Yes| Start
    Decision -->|No| End([返回最终结果])

    A3 -.->|context 隔离| Join
    B3 -.->|context 隔离| Join
    C3 -.->|context 隔离| Join
```

## 7. 子代理 System Prompt 组装流程

```mermaid
flowchart TD
    Start([applyChildComposition]) --> P1

    subgraph Part1["Part 1: 基础提示"]
        B1[继承父代理 systemPrompt.base]
    end

    subgraph Part2["Part 2: 人格设定"]
        P2A{有 persona?}
        P2B[追加 ## Persona 段落]
        P2C[跳过]
    end

    subgraph Part3["Part 3: 子代理指令"]
        I1[追加 ## Subagent Instructions]
        I2[• 独立完成任务]
        I3[• 返回结构化结果]
        I4[• 不与用户直接通信]
        I5[• 输出供父代理消费]
    end

    subgraph Part4["Part 4: 工具约束"]
        T1{有 toolFilter?}
        T2{有 allow?}
        T3[追加 Allowed tools 列表]
        T4{有 block?}
        T5[追加 Blocked tools 列表]
        T6[跳过]
    end

    Start --> P1
    B1 --> P2A
    P2A -->|Yes| P2B
    P2A -->|No| P2C
    P2B --> I1
    P2C --> I1
    I1 --> I2 --> I3 --> I4 --> I5
    I5 --> T1
    T1 -->|Yes| T2
    T1 -->|No| T6
    T2 -->|Yes| T3
    T2 -->|No| T4
    T3 --> T4
    T4 -->|Yes| T5
    T4 -->|No| T6
    T5 --> Merge
    T6 --> Merge

    Merge[合并所有段落] --> Apply[child.systemPrompt.base = 结果]
    Apply --> End([子代理配置完成])
```

## 8. SubagentRun 生命周期

```mermaid
stateDiagram-v2
    [*] --> Created: startInProcessRun()
    Created --> Running: followup(prompt)
    Running --> ToolLoop: LLM 响应
    ToolLoop --> Running: 工具调用完成
    Running --> Idle: emit('idle')
    Idle --> Settled: finalAssistantOutput()

    Settled --> Completed: stopReason = completed
    Settled --> Errored: stopReason = error
    Settled --> Aborted: stopReason = aborted

    Completed --> Disposed: dispose()
    Errored --> Disposed: dispose()
    Aborted --> Disposed: dispose()

    Disposed --> [*]

    note right of Running
        子代理独立执行
        父代理可并行做其他事
    end note

    note right of Settled
        result Promise resolve
        父代理获得 output
    end note
```

## 9. 错误处理流程

```mermaid
flowchart TD
    Start([子代理执行]) --> Try[try 块开始]

    Try --> Followup[child.followup prompt]
    Followup --> Wait[await child.whenIdle]

    Wait --> ErrCheck{发生异常?}

    ErrCheck -->|No| Extract[finalAssistantOutput]
    Extract --> Success[return completed]

    ErrCheck -->|Yes: 工具错误| Catch[catch 块]
    ErrCheck -->|Yes: 超时| Catch
    ErrCheck -->|Yes: 上下文溢出| Catch
    ErrCheck -->|Yes: LLM 错误| Catch

    Catch --> BuildMsg[构造错误消息<br>Subagent error: message]
    BuildMsg --> Fail[return stopReason: error]

    Success --> ParentRead
    Fail --> ParentRead

    ParentRead{父代理如何反应?}
    ParentRead -->|检查 stopReason| Decision{completed?}
    Decision -->|Yes| UseOutput[使用 output]
    Decision -->|No| HandleErr[处理错误<br>重试/降级/上报]

    UseOutput --> Dispose[dispose 释放资源]
    HandleErr --> Dispose
    Dispose --> End([结束])
```

## 10. 与 GoalRoundDriver 协作全景图

```mermaid
flowchart TB
    subgraph GoalMode["Goal 模式骨架 (GoalRoundDriver)"]
        direction TB
        R1["Round 1: 分析需求<br>读写文件、理解任务"]
        R2["Round 2: 并行委托<br>调用 3 个 subagent"]
        R3["Round 3: 整合结果<br>汇总子代理产物"]
        R4["Round 4: 验证<br>运行测试"]
        R5["Round 5: 完成<br>update_goal(complete)"]

        R1 --> R2 --> R3 --> R4 --> R5
    end

    subgraph Subagents["并行子代理 (InProcessDriver)"]
        direction LR
        SA["子代理 A<br>实现模块A<br>--独立session--"]
        SB["子代理 B<br>实现模块B<br>--独立session--"]
        SC["子代理 C<br>实现模块C<br>--独立session--"]
    end

    R2 -->|startInProcessRun| SA
    R2 -->|startInProcessRun| SB
    R2 -->|startInProcessRun| SC

    SA -->|output A| R3
    SB -->|output B| R3
    SC -->|output C| R3

    R3 -.->|如果任务更多| R2
    R5 -.->|Goal 结束| Done([完成])

    subgraph Legend["说明"]
        L1["Goal 提供: 持久化、自动续跑、预算控制"]
        L2["InProcess 提供: 上下文隔离、并行、深度控制"]
    end
```

## 11. 决策流程：何时用哪个 Driver

```mermaid
flowchart TD
    Start([接到新任务]) --> Q1{任务需要多轮迭代?}

    Q1 -->|Yes| Q2{需要保持上下文连贯?}
    Q1 -->|No| Q3{可以拆分为独立子任务?}

    Q2 -->|Yes| UseGoal[使用 GoalRoundDriver<br>create_goal]
    Q2 -->|No| Q4{子任务会污染主上下文?}

    Q3 -->|Yes| Q5{需要并行执行?}
    Q3 -->|No| DirectExec[直接在同一 Agent 执行]

    Q4 -->|Yes| UseInProcess[使用 InProcessDriver<br>subagent]
    Q4 -->|No| DirectExec

    Q5 -->|Yes| UseBoth[组合使用<br>Goal + 并行 subagent]
    Q5 -->|No| UseInProcess

    UseGoal --> Example1[例: 写 20 篇博客系列]
    UseInProcess --> Example2[例: 审查 5 个文件]
    UseBoth --> Example3[例: 大型重构<br>Goal 骨架 + 并行实现]
    DirectExec --> Example4[例: 修改一个配置项]
```

---

## 渲染说明

以上流程图使用 **Mermaid** 语法：

| 图表类型 | 用途 | 语法关键字 |
|---------|------|-----------|
| `flowchart` | 流程图、架构图 | `flowchart TB/TD/LR` |
| `sequenceDiagram` | 时序图、交互流程 | `sequenceDiagram` |
| `stateDiagram-v2` | 状态机 | `stateDiagram-v2` |
| `journey` | 用户旅程 | `journey` |
| `subgraph` | 分组 | `subgraph Name ... end` |

### 渲染平台

- **GitHub / GitLab**: 原生支持
- **VS Code**: 安装 Mermaid 插件
- **在线预览**: https://mermaid.live/
- **Typora**: 原生支持
