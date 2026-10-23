# AGENTS.md

Cloudflare Worker：域名克隆（DNS 同步）+ IP 聚合（推送 GitHub）。

本文件只保留导航、实现红线和无法从配置直接读取的约束；版本、脚本、路由、表结构与模块细节从源码和配置查证。

## 查证入口

- 运行脚本与工具版本：`package.json`；部署配置：`wrangler.toml`；表结构真相源：`src/db/migrations.ts`。
- 用户可见字段、API 与部署步骤：`README.md`。
- 编码、日志、错误响应与测试规则：`CODING_STANDARDS.md`。
- 修改 `src/ui/templates.js` 或任何界面模板前，必读 `docs/ui-redesign.md` §11。
- 架构深化候选：`docs/architecture-review.md`；跨模块领域术语先看 `GLOSSARY.md`。
- Issue 流程：`docs/agents/issue-tracker.md`；triage 标签：`docs/agents/triage-labels.md`；领域文档约定：`docs/agents/domain.md`。

## 实现红线

- 所有持久化访问继续使用唯一 D1 绑定 `env.WUYA`；不要引入第二个绑定名。
- `wrangler.toml` 的 `database_id` 在提交态保留占位符 `REPLACE_WITH_YOUR_D1_ID`，替换步骤留给用户本地。
- 部署配置保持 `keep_vars = true`，Dashboard 手配的 Variables / Bindings 必须保留。
- 不提交任何 Secrets；不触碰已被忽略的 `.claude/`。
- 调整表结构时直接修改 `src/db/migrations.ts` 的 `expectedSchemas`，保持幂等 DDL。
- 设置写入遵守白名单；`null` 显式清除，空字符串不得误清已配置 Secret；密码哈希、Salt 与 Token 不得回传。
- 批量同步时单条失败不得中断整批；迁移保持 24h 门控并清理超过 1h 的 `login_attempts`。
- 定时同步轮转必须无论当前批成功或失败都切换到下一类任务，避免单点失败永久卡死。
- 不引入新依赖或构建工具，除非任务明确要求；改动只碰请求所需范围。

## 验证

- `pnpm test` 与本机 `pnpm dev` 同跑时，worker 偶发启动失败；需要确定性结果时先停 dev server。
- 提交前跑 `pnpm check`（typecheck、语言门禁、UTF-8 门禁、lint、format check）；pre-commit 钩子与 CI 跑同一条命令，实际检查的文件集合见下面两条。
- 语言门禁：默认有暂存内容看暂存，否则看工作树；`LANGUAGE_CHECK_BASE` 优先，有值时改看 `base...HEAD`——验证未提交改动时不要设它。
- UTF-8 门禁：有暂存内容时只扫暂存文件，无暂存时扫全仓受管文本文件（含存量，跳过真二进制），拦非法 UTF-8 与 BOM。本地 pre-commit 因此只看本次提交的文件，CI 检出后无暂存才等于全仓查。
- 标语言的 Markdown 围栏会被 Prettier 重排；需要原样保留时删除语言标注或加 `<!-- prettier-ignore -->`。
- Prettier 没有 parser 的文件不受行尾门禁覆盖；需要归一索引时使用 `git add --renormalize <path>`。

## 评审

- 实现完成先提交，再按固定范围评审；评审期间冻结改动。
- 复审范围使用明确的 base 与 head hash，例如 `git diff <base-hash>...<head-hash>`；base 从 `git merge-base main HEAD` 获取，避免移动靶。
- 长评审报告写入仓库中的文件或用 issue 引用传递，避免大段粘贴占用上下文；报告中保留可复查的路径、行号和提交范围。

## 交接

跨会话交接文档放在 `docs/handoff/`，不要写进 `.scratch/`。

- 命名：`YYYYMMDD-HHMMSS-mmm-<主题>.md`。
- 只写接手必需的信息：当前状态、未决项、技术坑、验证方式与建议技能。
- 后续交接只写增量并指向上一份，不重写已记录内容。
- 不写入口令、Token、真实 `database_id`、UUID 或邮箱。
