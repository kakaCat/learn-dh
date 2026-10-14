/**
 * 博客24：workflow 主题 - run_code 执行编排（演示入口）
 *
 * 只做组装和演示。实现分布在 src/ 各文件：
 *   tools.ts     ToolRegistry + RwScheduler + ToolCallError（dsh-tools 的简化）
 *   run-code.ts  RunCodeService：沙箱执行 + Tools SDK 注入 + 超时预算（tool-run-code 的简化）
 *
 * 演示主线：workflow 的四个运行时事实——
 *   Part 1  只读调用并发重叠、写调用独占按序
 *   Part 2  工具失败 = ToolCallError，可 try/catch 续跑
 *   Part 3  Map-Reduce：fan-out 并行读、fan-in 汇总（真实文件）
 *   Part 4  超时预算：timeoutMs 到时即拒，程序不自动重放
 */

import { Context } from '@cordisjs/core'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { ToolRegistry, type CallTrace } from './tools.ts'
import { RunCodeService, type RunCodeOutput } from './run-code.ts'

const log = (...args: any[]) => console.log(...args)
const part = (title: string) => {
  console.log('\n' + '='.repeat(60))
  console.log(title)
  console.log('='.repeat(60))
}

/** 把调用轨迹画成时间轴：起始时刻对齐到首个调用 */
function printTrace(calls: CallTrace[]): void {
  if (calls.length === 0) return
  const t0 = Math.min(...calls.map((c) => c.start))
  log('  调用轨迹（相对首个调用，ms）：')
  for (const c of calls) {
    const s = Math.round(c.start - t0)
    const e = Math.round(c.end - t0)
    const bar = ' '.repeat(Math.round(s / 4)) + '█'.repeat(Math.max(1, Math.round((e - s) / 4)))
    log(`    ${c.tool.padEnd(6)} ${c.kind.padEnd(5)} [${String(s).padStart(4)} → ${String(e).padStart(4)}] ${c.ok ? 'ok' : 'FAIL'} ${bar}`)
  }
}

function printOutput(out: RunCodeOutput): void {
  log('  console.log 输出：', JSON.stringify(out.console))
  log('  return 值：', JSON.stringify(out.result))
  log(`  duration: ${out.duration}ms`)
}

async function main() {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(RunCodeService)

  // 注册演示工具：read/glob/fail 只读，write 写；40ms 延迟让调度行为可见
  root.tools.register({
    name: 'glob',
    readonly: true,
    delayMs: 40,
    execute: async ({ pattern }: { pattern: string }) => {
      const suffix = pattern.replace('*', '')
      const files = await readdir('src')
      return { root: 'src', paths: files.filter((f) => f.endsWith(suffix)) }
    },
  })
  root.tools.register({
    name: 'read',
    readonly: true,
    delayMs: 40,
    execute: async ({ file_path }: { file_path: string }) => {
      const text = await readFile(file_path, 'utf8')
      const lines = text.split('\n')
      return {
        path: file_path,
        totalLines: lines.length,
        todoCount: lines.filter((l) => l.includes('TODO')).length,
      }
    },
  })
  root.tools.register({
    name: 'write',
    readonly: false,
    delayMs: 40,
    execute: async ({ file_path, content }: { file_path: string; content: string }) => {
      await writeFile(file_path, content, 'utf8')
      return { path: file_path, operation: 'create' }
    },
  })
  root.tools.register({
    name: 'fail',
    readonly: true,
    execute: async () => {
      throw new Error('模拟的工具内部错误')
    },
  })

  // ── Part 1：只读并发重叠，写调用独占按序 ─────────────────────
  part('Part 1：Promise.all 下只读重叠、写调用独占')
  const out1 = await root.runCode.execute({
    description: '并行读三个文件，中间夹一次写',
    code: `
      // 三个独立只读调用：并发重叠
      const [a, b, c] = await Promise.all([
        tools.read({ file_path: 'src/tools.ts' }),
        tools.read({ file_path: 'src/run-code.ts' }),
        tools.read({ file_path: 'src/main.ts' }),
      ]);
      console.log('三个文件行数: ' + [a, b, c].map(f => f.totalLines).join(', '));

      // 写调用独占执行，其后的读要等它结束
      await tools.write({ file_path: 'demo-artifact.txt', content: 'workflow demo' });
      const check = await tools.glob({ pattern: '*.ts' });

      return { files: [a, b, c].map(f => f.path), globbed: check.paths.length };
    `,
  })
  printOutput(out1)
  printTrace(out1.calls)

  // ── Part 2：ToolCallError 可 catch，失败后续跑 ───────────────
  part('Part 2：工具失败 = ToolCallError，try/catch 续跑')
  const out2 = await root.runCode.execute({
    description: '故意失败两次再继续',
    code: `
      const results = [];
      try {
        await tools.fail({});
      } catch (error) {
        console.log('捕获: ' + error.name + ' / tool=' + error.toolName);
        results.push({ tool: error.toolName, ok: false });
      }
      try {
        await tools.read({ file_path: 'src/not-exist.ts' });
      } catch (error) {
        if (error.name === 'ToolCallError') {
          results.push({ tool: error.toolName, ok: false, error: error.message });
        } else {
          throw error;
        }
      }
      // 失败不阻断：继续正常调用
      const ok = await tools.read({ file_path: 'src/tools.ts' });
      results.push({ tool: 'read', ok: true, lines: ok.totalLines });
      return results;
    `,
  })
  printOutput(out2)

  // ── Part 3：Map-Reduce（fan-out 并行读、fan-in 汇总）─────────
  part('Part 3：Map-Reduce —— 统计 src/ 下所有 TS 文件')
  const out3 = await root.runCode.execute({
    description: '并行读取所有源文件并汇总',
    code: `
      // Map：fan-out 并行读取
      const files = (await tools.glob({ pattern: '*.ts' })).paths;
      const contents = await Promise.all(
        files.map(f => tools.read({ file_path: 'src/' + f }))
      );

      // Reduce：fan-in 汇总
      const totalLines = contents.reduce((sum, c) => sum + c.totalLines, 0);
      const totalTodos = contents.reduce((sum, c) => sum + c.todoCount, 0);

      console.log('扫描 ' + files.length + ' 个文件');
      return { totalFiles: files.length, totalLines, totalTodos };
    `,
  })
  printOutput(out3)
  printTrace(out3.calls)

  // ── Part 4：超时预算 ────────────────────────────────────────
  part('Part 4：timeoutMs 到时即拒，程序不自动重放')
  try {
    await root.runCode.execute({
      description: '故意超时',
      timeoutMs: 200,
      code: `
        console.log('开始执行长任务...');
        await new Promise(r => setTimeout(r, 5000));
        return '永远不会到达这里';
      `,
    })
  } catch (error) {
    log('  run_code 拒绝：', error instanceof Error ? error.message : error)
  }

  await rm('demo-artifact.txt', { force: true })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
