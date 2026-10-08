/**
 * Simple DH - 入口文件
 *
 * 集成所有模块
 */

import { Context } from '@cordisjs/core'
import * as session from './session'
import * as tools from './tools'
import * as systemPrompt from './system-prompt'
import * as llm from './llm'
import * as agentLoop from './agent-loop'

export { session, tools, systemPrompt, llm, agentLoop }

/**
 * 设置完整的 simple-dh
 */
export function setup(ctx: Context) {
  // 按依赖顺序加载插件
  ctx.plugin(session)
  ctx.plugin(llm)
  ctx.plugin(systemPrompt)
  ctx.plugin(tools)
  ctx.plugin(agentLoop)
}

/**
 * 创建并设置新的 Context
 */
export function create(): Context {
  const ctx = new Context()
  setup(ctx)
  return ctx
}
