/**
 * [tool-subagent] 模型侧工具（dsh: packages/subagent/tool-subagent/src/index.ts）
 *
 * subagent 工具：模型经它委托任务给子代理。
 * 工具 + 服务配对：工具调 ctx.subagents.start（工具是模型与系统的接口，blog-05）。
 */

import type { Context } from '@cordisjs/core'

export function registerSubagentTool(ctx: Context): void {
  ctx.tools.register({
    name: 'subagent',
    description: 'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work. The subagent returns its result, not its intermediate steps.',
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('subagent tool requires a calling agent')
      // 工具 → 服务 → provider → agents.create 的完整链路
      const run = await ctx.subagents.start(args.provider ?? 'spawn', {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        ...args.persona !== undefined ? { persona: args.persona } : {},
        ...args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {},
      })
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`subagent run failed: ${result.stopReason}`)
      }
      return { runId: run.id, output: result.output.map(b => b.text).join('') }
    },
  })
}
