# Issue tracker：GitHub

本仓库的 issue 与 spec 存放在 GitHub Issues（`sbwkl/any2api`）。所有操作使用 `gh` CLI。

## 约定

- **创建**：`gh issue create --title "..." --body "..."`，多行 body 用 heredoc。
- **读取**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列表**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label` / `--state` 过滤。
- **子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（gh 2.94+）。旧版：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`；不支持子 issue 时在子 issue body 顶部写 `Part of #<parent>`。
- **阻塞**：优先用 GitHub 原生 issue 依赖：`gh issue create --blocked-by <n>,<n>` 或 `gh issue edit <child> --add-blocked-by <blocker>`（gh 2.94+）。旧版：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`（blocker 的数据库 id，不是 #号）。不可用时在子 issue body 顶部写 `Blocked by: #<n>`；所有 blocker 关闭才算解除。
- **统计未关闭阻塞**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（0 = 可开始）。
- **评论**：`gh issue comment <number> --body "..."`。
- **标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭**：先评论解释，再 `gh issue close <number>`。

仓库从 `git remote -v` 推断；在克隆目录内运行 `gh` 自动定位。只向用户自己的仓库建 issue。

## PR 作为 triage 入口

**PRs as a request surface: no.**

## 技能说「发布到 issue tracker」时

创建 GitHub issue。

## 技能说「读取相关 ticket」时

按上面的「读取」执行。

## Wayfinding 操作

- **Map**：一个带 `wayfinder:map` 标签的 issue，承载 Notes / Decisions-so-far / Fog。
- **子 ticket**：以 sub-issue 挂到 map；标签 `wayfinder:<type>`（research / prototype / grilling / task）；认领后 assign 给执行者。
- **阻塞**：见约定。
- **Frontier**：列出 map 的未关闭子 issue，剔除有未关闭阻塞或无 assignee 者，取 map 顺序第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`。
- **解决**：评论答案 → 关闭 → 在 map 的 Decisions-so-far 追加指针。
