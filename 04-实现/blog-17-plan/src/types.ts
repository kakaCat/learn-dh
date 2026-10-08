/**
 * Plan 类型定义（dsh: packages/plan/plan-mode/src/types.ts + session 声明）
 *
 * plan/mode 是 log-only、whole-value-replace 的 SessionEventMap 成员：
 * 最后一条 `plan/mode` 生效（重放恢复，resume/fork 不需要实时镜像）。
 */

// ---- plan/mode 事件（dsh: SessionEventMap 声明）----
export interface PlanModeChange {
  readonly active: boolean
}

// ---- plan 投影单元状态（dsh: PlanProjection）----
export interface PlanProjection {
  readonly active: boolean
  readonly pending: boolean
}
