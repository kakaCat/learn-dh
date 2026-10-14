# 掘金发布设置（blog-20-goal）

## 两份产物

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| [blog-juejin.md](./blog-juejin.md) | **含 frontmatter** + 正文（1049 行） | 带元数据的发布/归档副本；frontmatter 见下 |
| [blog-juejin.paste.md](./blog-juejin.paste.md) | **无 frontmatter、无 H1** 的纯正文（986 行） | **掘金编辑器直接粘贴用** |

生成命令：

```bash
cd 04-实现/blog-20-goal
node sync-juejin.mjs          # 生成 blog-juejin.md（含 frontmatter）
node sync-juejin.mjs --paste  # 再生成 blog-juejin.paste.md（纯正文）
```

> **为什么掘金要粘 paste 版**：掘金不读 YAML frontmatter，粘 `blog-juejin.md` 会把 `description: ...` 这些渲染成正文文字。

## frontmatter（已按「博客写作名称」模板 32 字段全覆盖）

schema 与 `/Users/mac/Documents/Obsidian Vault/理论/模板/写作/博客写作名称.md` 一致，字段全部填了本博客的真实值：

| 字段组 | 字段 | 本博客取值 |
| --- | --- | --- |
| 基础 | `title` / `slug` / `author` / `lang` | DeepSeek Harness 从 0 开始：20 goal模式 / `deepseek-harness-20-goal-mode` / learn-dh / zh-CN |
| 时间 | `date` / `updated` | 2026-08-21 / 2026-10-09 |
| SEO | `description` / `keywords` / `tags` / `categories` / `canonical` | 见文件；canonical 指向仓库源文件 |
| 社交 | `og_type` / `twitter_card` / `image` / `image_alt` | article / summary / **暂无封面（留空）** |
| GEO | `summary` / `topics` / `entities` / `content_type` / `target_audience` / `expertise_level` | summary 按「问题→方案→适用场景」写；content_type=tutorial |
| 索引 | `canonical` / `noindex` / `nofollow` / `sitemap_priority` / `sitemap_changefreq` | 0.8 / monthly |
| 系列 | `series` / `series_order` / `related_posts` / `toc` | DeepSeek Harness 从 0 开始 / 20 / 双向链接到 blog-21、blog-22 / true |
| 状态 | `reading_time` / `featured` / `draft` | **18 min**（实测：正文中文 7341 字，不含代码块）/ false / false |

### 与上一版 frontmatter 的差异（如实说明）

换成模板 schema 后，上一版里的 `og:` / `twitter:` / `article:` 三个嵌套块被模板的扁平字段取代。**模板没有覆盖**：`og:url`、`og:site_name`、`og:locale`、`article:published_time`。需要的话可以补回（模板没列，我没有擅自加）。

## 掘金发布页表单（frontmatter → 掘金映射）

掘金不读 frontmatter，以下字段要手填：

| `blog.md` frontmatter | 掘金落点 | 值 |
| --- | --- | --- |
| `title` | 「标题」 | DeepSeek Harness 从 0 开始：20 goal模式 |
| `summary` | 「摘要」（宜 ≤100 字） | goal 给长任务一个持久目标并自动续跑：六个关键节点——设置目标、读状态、修改状态、轮数预算、判断完成，以及最重要的续跑。 |
| `tags` | 「标签」（上限 5） | DeepSeek Harness、Agent、TypeScript、Cordis、goal |
| `categories[0]` | 「分类」 | 人工智能 |
| `image` | 「封面」 | 暂无（留空，需图时用掘金图库或后补） |

## 发布前检查清单

- [ ] 从 **`blog-juejin.paste.md`** 第一行全选复制（不是 `blog-juejin.md`）
- [ ] 标题 / 分类 / 标签 / 摘要 按上表填（标签只填 5 个）
- [ ] 5 个 ```mermaid 代码块在掘金预览里能正常渲染
- [ ] 文中 GitHub 链接指向公开仓库（kakaCat/learn-dh，已验证 200）
- [ ] 「速览（TL;DR）」在正文顶部，AI 引擎摘引的就是它

## 正文改过之后

改 `blog.md`（单一源），重跑：

```bash
cd 04-实现/blog-20-goal
node sync-juejin.mjs && node sync-juejin.mjs --paste
```

## 生成时自动处理的三处差异

| 项 | 本地源 `blog.md` | 产物 |
| --- | --- | --- |
| 相对链接 | `](./)`、`../blog-21-goal-derive/blog.md`、`../blog-22-goal-round-driver/blog.md` | GitHub 绝对链接（tree / blob） |
| frontmatter | 有（32 字段模板 schema） | `blog-juejin.md` 保留；`blog-juejin.paste.md` 剥离 |
| 正文 H1 | `# DeepSeek Harness 从 0 开始：20 goal模式` | `blog-juejin.md` 保留；`paste` 版去掉 |
