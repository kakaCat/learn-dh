/**
 * 从 blog.md 生成两份发布产物。
 *
 * 产物一（默认）：blog-juejin.md
 *   = blog.md 的 frontmatter（SEO/GEO 模板 schema）+ 正文，链接改写为 GitHub 绝对链接。
 *   用途：带元数据的发布/归档副本。
 *
 * 产物二（--paste）：blog-juejin.paste.md
 *   = 去掉 frontmatter 与 H1 的纯正文，链接改写为 GitHub 绝对链接。
 *   用途：直接粘进掘金编辑器（掘金不读 YAML frontmatter，粘进去会渲染成正文文字）。
 *
 * 用法：
 *   node sync-juejin.mjs          # 只生成 blog-juejin.md
 *   node sync-juejin.mjs --paste  # 额外生成 blog-juejin.paste.md
 */
import { readFileSync, writeFileSync } from 'node:fs'

const REPO = 'https://github.com/kakaCat/learn-dh'
const BRANCH = 'main'

const wantPaste = new Set(process.argv.slice(2)).has('--paste')

const encodePath = path => path.split('/').map(encodeURIComponent).join('/')
const blobUrl = path => `${REPO}/blob/${BRANCH}/${encodePath(path)}`
const treeUrl = path => `${REPO}/tree/${BRANCH}/${encodePath(path)}`

const source = readFileSync(new URL('./blog.md', import.meta.url), 'utf8')

/** 相对链接 → GitHub 绝对链接（两份产物共用） */
const absolutize = md => md
  .replace(/\]\(\.\/\)/g, `](${treeUrl('04-实现/blog-20-goal')})`)
  .replace(/\]\(\.\.\/(blog-[^)/]+)\/blog\.md\)/g, (_, dir) => `](${blobUrl(`04-实现/${dir}/blog.md`)})`)
  .replace(/\s+$/, '')

const withFrontmatter = `${absolutize(source)}\n`
writeFileSync(new URL('./blog-juejin.md', import.meta.url), withFrontmatter)
console.log(`blog-juejin.md 已生成（${withFrontmatter.split('\n').length} 行，含 frontmatter）`)

if (wantPaste) {
  // 掘金不读 frontmatter，标题走发布页表单 → 两者都去掉
  let paste = source.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^#\s+.*\n/m, '')
  paste = absolutize(paste).replace(/^\s+/, '')
  const text = `${paste}\n`
  writeFileSync(new URL('./blog-juejin.paste.md', import.meta.url), text)
  console.log(`blog-juejin.paste.md 已生成（${text.split('\n').length} 行，无 frontmatter / 无 H1，掘金直接粘贴用）`)
}
