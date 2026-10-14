# GoalRoundDriver 详细流程图

## 1. 总体架构图

```mermaid
flowchart TB
    subgraph User["用户层"]
        U1[用户输入]
        U2[用户观察]
    end

    subgraph AgentLayer["Agent 层"]
        A1[Agent 实例]
        A2[Inbox 队列]
        A3[工具执行器]
    end

    subgraph DriverLayer["Driver 层"]
        GD[GoalRoundDriver]
        SD[InProcessDriver]
    end

    subgraph StateLayer["状态管理层"]
        GM[Goal Manager]
        SM[Session Manager]
        LM[Log Manager]
    end

    subgraph LLMLayer["LLM 层"]
        LLM[Language Model]
    end

    U1 --> A2
    A2 --> A1
    A1 --> A3
    A3 --> A1
    A1 --> LLM
    LLM --> A1

    A1 -.->|idle 事件| GD
    GD --> GM
    GD -->|followup| A2
    GM --> SM
    GM --> LM

    A1 -.->|subagent 调用| SD
    SD -->|创建子 Agent| A1
```

## 2. GoalRoundDriver 核心调度流程

```mermaid
flowchart TD
    Start([Agent 进入静默状态]) --> CheckGoal{Goal 存在?}

    CheckGoal -->|No| End1([返回 undefined<br>Agent 等待用户输入])
    CheckGoal -->|Yes| CheckPhase{phase = active?}

    CheckPhase -->|No: paused| End2([返回 undefined<br>Goal 已暂停])
    CheckPhase -->|No: blocked| End3([返回 undefined<br>Goal 已阻塞])
    CheckPhase -->|No: complete| End4([返回 undefined<br>Goal 已完成])
    CheckPhase -->|Yes| CheckArm{activation = armed?}

    CheckArm -->|No: disarmed| End5([返回 undefined<br>续跑权限已移除])
    CheckArm -->|Yes| CheckBudget{还有轮数余量?<br>roundsStarted 小于 maxGoalRounds}

    CheckBudget -->|No: 预算耗尽| AutoBlock[自动调用 block<br>code: round-limit]
    AutoBlock --> LogBlock[写入会话日志<br>phase: blocked]
    LogBlock --> End6([返回 undefined<br>Goal 已自动阻塞])

    CheckBudget -->|Yes: 有余量| GenPrompt[生成续跑消息<br>renderGoalRoundPrompt]
    GenPrompt --> IncRound[round = roundsStarted + 1]
    IncRound --> ReturnResult[返回 round + prompt]

    ReturnResult --> Inject[agent.followup prompt]
    Inject --> AgentWork[Agent 继续工作]
    AgentWork --> Complete{工作完成?}

    Complete -->|Yes| UserComplete[用户调用 update_goal<br>action: complete]
    UserComplete --> SetComplete[phase: complete<br>activation: disarmed]
    SetComplete --> End7([Goal 生命周期结束])

    Complete -->|No| Start
```

## 3. Goal 状态机转换图

```mermaid
stateDiagram-v2
    [*] --> ActiveArmed: create_goal()
    ActiveArmed --> ActiveArmed: schedule() 续跑
    ActiveArmed --> PausedArmed: pause()
    PausedArmed --> ActiveArmed: resume()
    ActiveArmed --> BlockedArmed: block() / 预算耗尽
    BlockedArmed --> ActiveArmed: edit() 增加预算
    ActiveArmed --> CompleteDisarmed: complete()
    BlockedArmed --> CompleteDisarmed: complete()
    PausedArmed --> CompleteDisarmed: complete()

    state ActiveArmed {
        [*] --> Round1
        Round1 --> Round2: schedule()
        Round2 --> Round3: schedule()
        Round3 --> [*]
    }

    note right of BlockedArmed
        blockedReason:
        - code: round-limit
        - code: user-blocked
        - code: error
    end note
```

## 4. 续跑消息生成流程

```mermaid
sequenceDiagram
    participant D as Driver
    participant G as Goal Manager
    participant A as Agent
    participant L as LLM

    Note over D: Agent 进入 idle 状态

    D->>G: get(agent)
    G-->>D: GoalView

    alt goal 不存在
        D-->>A: 返回 undefined
    else phase != active
        D-->>A: 返回 undefined
    else activation != armed
        D-->>A: 返回 undefined
    else 预算耗尽
        D->>G: block(agent, {id, revision}, {code: round-limit})
        G-->>D: 已阻塞
        D-->>A: 返回 undefined
    else 可以续跑
        D->>D: renderGoalRoundPrompt(goal, round)
        Note over D: 生成 XML 格式消息
        D-->>A: 返回 {round, prompt}
        A->>A: followup(prompt)
        A->>L: 发送续跑消息
        L-->>A: 模型响应
        A->>A: 继续工作...
    end
```

## 5. 预算管理时序图

```mermaid
sequenceDiagram
    participant U as 用户
    participant A as Agent
    participant D as Driver
    participant G as Goal Manager

    U->>A: 创建 Goal (maxGoalRounds: 3)
    A->>G: create_goal()
    G-->>A: {phase: active, roundsStarted: 0}

    loop 自动续跑
        A->>A: 工作完成，进入 idle
        A->>D: emit('idle')
        D->>D: schedule()

        alt roundsStarted < maxGoalRounds
            D-->>A: {round: N, prompt}
            A->>A: followup(prompt)
            A->>G: incrementRound()
            G-->>A: roundsStarted: N
        else 预算耗尽
            D->>G: block({code: round-limit})
            G-->>A: phase: blocked
        end
    end

    Note over U,G: 3 轮后预算耗尽

    U->>A: get_goal()
    A-->>U: {phase: blocked, blockedReason: {...}}

    alt 选项 1: 增加预算
        U->>A: update_goal(action: edit, max_goal_rounds: 5)
        A->>G: update()
        G-->>A: {phase: active, maxGoalRounds: 5}
    else 选项 2: 完成 Goal
        U->>A: update_goal(action: complete)
        A->>G: update()
        G-->>A: {phase: complete}
    end
```

## 6. 竞态保护（CAS）流程

```mermaid
flowchart TD
    subgraph 时刻T1
        T1A[Driver 读取 goal]
        T1B[revision: 5]
    end

    subgraph 时刻T2
        T2A[用户调用 update_goal]
        T2B[revision: 5 → 6]
    end

    subgraph 时刻T3
        T3A[Driver 调用 block]
        T3B[传入 revision: 5]
    end

    T1A --> T1B
    T2A --> T2B
    T3A --> T3B

    T1B -.->|并发| T2B
    T2B -.->|并发| T3B

    T3B --> Check{revision 匹配?}
    Check -->|No: 5 ≠ 6| Reject[拒绝操作<br>抛出 REVISION_MISMATCH]
    Check -->|Yes| Execute[执行 block]

    Reject --> ReRead[Driver 重新读取<br>获取最新 revision]
    ReRead --> ReSchedule[重新 schedule]
```

## 7. 完整生命周期流程

```mermaid
journey
    title Goal 完整生命周期
    section 创建阶段
        用户输入目标: 5: 用户
        创建 Goal: 5: Agent
        状态 active+armed: 5: System
    section 自动续跑
        第 1 轮工作: 4: Agent
        静默检测: 5: Driver
        第 2 轮工作: 4: Agent
        静默检测: 5: Driver
        第 3 轮工作: 4: Agent
    section 预算耗尽
        检测 roundsStarted >= max: 5: Driver
        自动 block: 3: System
        通知用户: 2: Agent
    section 用户决策
        查看状态: 5: 用户
        增加预算 或 完成: 4: 用户
    section 完成
        最终工作: 4: Agent
        调用 complete: 5: Agent
        状态 complete+disarmed: 5: System
```

## 8. 与 InProcessDriver 协作流程

```mermaid
flowchart LR
    subgraph Goal["Goal 模式 (GoalRoundDriver)"]
        direction TB
        G1[Round 1: 分析需求]
        G2[Round 2: 委托子代理]
        G3[Round 3: 整合结果]
        G4[Round 4: 完成]

        G1 --> G2 --> G3 --> G4
    end

    subgraph Sub["子代理 (InProcessDriver)"]
        direction TB
        S1[子代理 A<br>实现模块 A]
        S2[子代理 B<br>实现模块 B]
        S3[子代理 C<br>实现模块 C]

        S1 -.->|并行| S2
        S2 -.->|并行| S3
    end

    G2 -->|startInProcessRun| S1
    G2 -->|startInProcessRun| S2
    G2 -->|startInProcessRun| S3

    S1 -->|result| G3
    S2 -->|result| G3
    S3 -->|result| G3
```

---

## 渲染说明

以上流程图使用 **Mermaid** 语法，可以在以下平台渲染：

- **GitHub**: 直接支持 Mermaid 渲染
- **VS Code**: 安装 "Markdown Preview Mermaid Support" 插件
- **在线工具**: https://mermaid.live/
- **Notion**: 支持 Mermaid 代码块

### 嵌入博客

把要用的那张图整段复制到博客对应章节即可（下例是一张可直接渲染的最小图）：

```mermaid
flowchart TD
    A[Agent 静默] --> B{Goal active 且 armed?}
    B -->|是| C[followup 续跑消息]
    B -->|否| D[进入等待]
```
