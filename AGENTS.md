# AGENTS.md

Cloudflare Worker 项目：域名克隆（DNS 同步） + IP 聚合（推送到 GitHub）。

## 关键事实

- **运行平台**：Cloudflare Workers（运行时 workerd）。开发工具链：pnpm 11 + Node ≥ 22（Volta 锁 24）+ wrangler 4 + TypeScript strict + vitest。
- **唯一入口**：`src/index.ts`，导出 `fetch` 与 `scheduled` 两个 handler，组装 8 个模块。
- **唯一绑定**：`env.WUYA` → D1 数据库。**变量名必须为 `WUYA`（全大写）**，参见 `src/index.ts:12`。缺失会返回 `500`。
- **三个路由分支**（`src/index.ts:22-30`）：
  - `/api/*` → `handleApiRequest`（`src/routes/api.ts`）
  - 其它非根路径（除 `/login`、`/admin`）→ `handleGitHubFileProxy`（订阅器直读，`src/routes/github-proxy.ts`）
  - `/`、`/login`、`/admin` → `handleUiRequest`（`src/routes/ui.ts`）
- **定时任务**：Cron `* * * * *`（每分钟）触发 `scheduled` handler，通过 `settings.next_sync_task` 在 `domains` ↔ `ip_sources` 两种批任务间**轮转**，每批处理 `BATCH_SIZE` 条（默认 10，由 `settings.BATCH_SIZE` 配置，非数值回退到 10）且失败优先（`src/sync/domains.ts:62-80`、`src/sync/ip-sources.ts:57-76`）。**无论同步成功或失败都翻转 `next_sync_task`**，避免单点失败永久卡死。
- **数据表**（5 张）：`settings` / `domains` / `ip_sources` / `sessions` / `login_attempts`，由 `initializeAndMigrateDatabase` 幂等创建，24h 门控（`last_migrated_at`）。

## 本地开发

```bash
pnpm install              # 安装依赖（首次）
pnpm dev                  # wrangler dev 起本地 workerd（默认 8787 端口）
pnpm test                 # 跑一次测试（vitest run，workerd 内执行，约 19 秒）
pnpm test:watch           # 监听模式（改文件自动重跑）
pnpm test:coverage        # 同上 + istanbul 插桩覆盖率（text/html/lcov）
pnpm typecheck            # tsc --noEmit 严格模式检查
pnpm lint                 # oxlint 静态检查（Rust 实现，约 0.4 秒）
pnpm format               # prettier 全仓格式化
pnpm format:check         # prettier 校验（CI 用）
pnpm check                # 本机门禁：typecheck + lint + format:check（pre-commit 钩子跑的就是它）
pnpm cf-typegen           # 重新生成 worker-configuration.d.ts（gitignore）
pnpm build:single         # esbuild 打包 src/index.ts → dist/worker.bundle.js（Dashboard 部署用）
pnpm predeploy            # 校验 wrangler.toml 中 database_id 已替换占位符
pnpm deploy               # CLI 部署：load-deploy-env.cjs 注入 .env → wrangler deploy
```

- **提交前门禁（钩子）**：`prepare` 会在 `pnpm install` 时把 `core.hooksPath` 设为 `.githooks`，提交前跑 `pnpm check`（约 2 秒，不含 test）。pnpm 在 `Already up to date` 时**不跑** `prepare`，所以已有 `node_modules` 的老 clone 钩子可能没生效——执行 `git config core.hooksPath .githooks`（或 `pnpm install --force`）恢复。
- 本地 D1 数据在 `.wrangler/state/d1/`，可用 `wrangler d1 execute --local` 查询。
- 测试用 D1 迁移在 `src/db/migrations/`（`.sql` 文件），由 `vitest.config.ts` 通过 `readD1Migrations` 加载。
- **测试串行约束**：`maxWorkers: 1` + `fileParallelism: true`，避免 D1 SQLite 多进程锁冲突（`vitest.config.ts:21-22`）。
- **测试与 dev server 共存**：`pnpm test` 与本机 `pnpm dev` 同时跑时，`cloudflare-pool` 的 worker 偶发起不来（`Failed to start cloudflare-pool worker for test files …`，结果是「1 error」而不是断言失败），重跑即绿；要确定性就先停 `pnpm dev`。
- `vitest.config.ts` 用 `defineProject`（multi-project），**不是** `defineConfig`。
- **类型配置**：`tsconfig.json` 排除了 `src/ui/templates.js`（不参与 tsc 检查，走纯 JS 路径）。

## CLI 部署

```bash
# 1. 创建生产 D1 数据库（拿到 UUID）
pnpm dlx wrangler d1 create wuya-db

# 2. 把 UUID 填入 wrangler.toml 替换 database_id = "REPLACE_WITH_YOUR_D1_ID"

# 3. 在仓库根目录创建 .env，写入 CLOUDFLARE_API_TOKEN（账号级 Token："Edit Cloudflare Workers" 模板）
#    pnpm predeploy 会拦截占位符未替换的部署

# 4. 部署
pnpm predeploy
pnpm deploy
```

`wrangler.toml` 已配置 `keep_vars = true`，CLI 部署不会覆盖 Dashboard 里手动配置的 Variables / Bindings，CLI 与网页两条部署路径可混用。

## 文案三档规则（强制）

规则全文（含「测试标题属中文档、存量英文标题不动」）见 **`CODING_STANDARDS.md`** §语言三档——写码与评审共用一份，别在本文件重述。

## 风格与约定

阶段代号注释惯例见 **`CODING_STANDARDS.md`** §注释惯例。以下仍在本文件生效（实现期）：缩进 4 空格、LF 行尾、UTF-8（见 `.editorconfig`，Makefile 除外）；不引入新依赖 / 新构建工具，除非任务明确要求；KISS——避免过度工程化，改代码只碰必须碰的。

## 不要做的事

- **不要修改 `env.WUYA` 这个绑定名**——Dashboard / 控制台配置依赖它，README 已写明用户须设为 `WUYA`。
- **不要把 `database_id` 占位符替换为真实 UUID 后提交**：本地 `wrangler.toml` 必须保留 `REPLACE_WITH_YOUR_D1_ID`，`predeploy.cjs` 会拦截，把替换步骤留在用户本地。
- **不要触碰 `.claude/` 内容**（含 `plans/`、`skills/`、`scheduled_tasks.lock`），已被 `.gitignore` 整体排除。
- **不要在未经确认的情况下向仓库提交任何 Secrets**（CF API Token、GitHub Token、`.env`、`.dev.vars`）。`*.env` / `*.vars` 已在 `.gitignore`。
- **不要主动删 `worker-configuration.d.ts`**——它由 `pnpm cf-typegen` 重新生成，且已在 `.gitignore`。
- **不要把接口代码修改成会破坏 `keep_vars` 行为的形态**——Dashboard 手动配置的 Variables / Bindings 必须保留。

## 仓库结构

```
.
├── README.md             # 用户面向的部署教程（网页 4 步 + 开发者模式，覆盖全部 API/表结构）
├── CODING_STANDARDS.md   # 评审期规则真相之源（语言三档 / 注释惯例 / 模板转义 / 日志 / 错误响应）
├── wrangler.toml         # Worker 配置（compatibility_date 2026-01-15，keep_vars，observability，cron）
├── tsconfig.json         # TypeScript strict（exclude src/ui/templates.js）
├── vitest.config.ts      # cloudflareTest + D1 迁移绑定 + maxWorkers=1
├── package.json          # 脚本：dev / test / typecheck / lint / format / deploy / cf-typegen / build:single / predeploy
├── .editorconfig         # 4 空格 / LF / UTF-8
├── .prettierrc.json      # Prettier 配置（与 .editorconfig 对齐）
├── .oxlintrc.json        # oxlint 配置（correctness=error，suspicious/perf=warn）
├── .gitignore            # 排除 .claude/、*.env、*.vars、.wrangler/、dist/、coverage/、worker-configuration.d.ts
├── .github/
│   ├── dependabot.yml    # 每周检查 github-actions 版本更新（只覆盖 actions 生态）
│   └── workflows/
│       └── ci.yml            # push main / PR 上跑 typecheck + lint + format:check + test
├── docs/
│   ├── ui-redesign.md    # 界面诊断 + 目标设计系统 + 实施记录 + §11 已知陷阱（动 UI 前先读）
│   ├── architecture-review.md  # 架构深化候选 C1–C6 清单（wayfinder chart 的种子）
│   ├── handoff/          # 跨会话交接文档（按时间戳命名，见「交接文档」一节）
│   └── agents/           # issue-tracker / triage-labels / domain 约定
├── scripts/
│   ├── build-single-file.mjs  # esbuild 打包 src/index.ts → dist/worker.bundle.js（Dashboard 部署入口）
│   ├── predeploy.cjs          # 部署前校验 wrangler.toml 中 database_id 占位符已替换
│   └── load-deploy-env.cjs    # pnpm deploy 前置：注入 .env 到 wrangler 环境
├── src/                  # 17 个 .ts + 1 个 .js（templates.js 纯 JS 模板）
│   ├── index.ts          # Worker 入口（fetch + scheduled handler）
│   ├── db/               # client.ts（D1 封装）+ migrations.ts（幂等建表，含 5 张表 DDL）+ migrations/*.sql（测试用）
│   ├── routes/           # api.ts（REST）/ ui.ts（页面）/ github-proxy.ts（订阅代理）
│   ├── sync/             # domains.ts（DNS 克隆）/ ip-sources.ts（IP 抓取）/ github.ts（GitHub API 封装）
│   ├── ui/               # templates.js（HTML 模板字符串，tsc 不参与）
│   └── util/             # auth（PBKDF2）/ http / http-error / log / sse / fetch（带超时退避）/ cf / url-safety（SSRF）/ run-with-log
├── test/                 # vitest-pool-workers 测试（14 个 spec 文件 + global-setup.ts + apply-migrations.ts）
└── img/                  # README 截图
```

`src/index.ts` 导入的 8 个模块（按文件路径）：

```
./db/migrations.ts        # initializeAndMigrateDatabase
./db/client.ts            # getSetting, setSetting
./util/http.ts            # jsonResponse
./sync/domains.ts         # syncScheduledDomains
./sync/ip-sources.ts      # syncScheduledIpSources
./routes/api.ts           # handleApiRequest
./routes/github-proxy.ts  # handleGitHubFileProxy
./routes/ui.ts            # handleUiRequest
```

## 模块职责速记

- **routes/api.ts**：所有 `/api/*` 端点；登录用 PBKDF2 sha256（`auth.ts`），限流 5 分钟内失败 5 次返 429；`/api/settings` 写入走白名单（6 个 key）+ 配对校验（CF Token + Zone ID 必须同时，GitHub Token + Owner + Repo 必须同时）。
- **routes/github-proxy.ts**：订阅器直读；只做「白名单查询 + 设置校验 + 调 GitHub module」（C4：缓存与超时/退避已移入 `sync/github.ts`）。
- **routes/ui.ts**：首页 / `/login` / `/admin` 页面渲染，调用 `ui/templates.js` 生成 HTML。
- **sync/domains.ts**：三种模式分流（`resolveRecordsForDomain`）—— `internal:hostmonit:yd/dx/lt` 内置三网；`is_deep_resolve=1` 深度解析 CNAME 链（最多 10 层）；`is_deep_resolve=0` 浅层克隆（同 CNAME）。
- **sync/ip-sources.ts**：`fetch_strategy` 三选一（`direct_regex` / `phantomjs_cloud` / `proxy_codetabs`）；`/api/ip_sources/probe` 用于自动探测可用策略。
- **sync/github.ts**：GitHub 访问的唯一出口（`githubApiRequest`：认证 / User-Agent / Accept / 15s 超时 / 1 次退避重试）；自动创建私有仓库（如不存在）→ 推送 IP 文件 → 订阅器读（读穿边缘缓存，缓存键与 `Cache-Control: public, max-age=60, s-maxage=300` 也在此）。
- **util/url-safety.ts**：`assertSafeHttpUrl` 拦 SSRF（拒绝内网/回环/链路本地/CGNAT/云元数据，含十进制、十六进制、IPv4-mapped IPv6 绕过形式）。
- **util/auth.ts**：PBKDF2-HMAC-SHA256（100k 迭代）+ 旧版单轮 SHA-256 登录后自动升级（`legacyHashPassword` 不导出）。

## 关键约定细节

评审期判定规则（怎么写日志、API 与非 API 的错误响应、模板转义）见 **`CODING_STANDARDS.md`**；以下实现期红线留在这里：

- **绑定名优先级**：所有运行时逻辑都通过 `env.WUYA` 访问 D1，**任何**模块都不要引入第二个绑定名。
- **配置写入**：设置接口忽略未在白名单的字段；`null` 显式清空字段；脱敏返回（`getSafeSettings` 剔除 `ADMIN_PASSWORD_HASH` / `PASSWORD_SALT` / `CF_API_TOKEN` / `GITHUB_TOKEN`）。
- **批量同步**：单条失败不中断整批；按 `last_sync_status='failed' ASC, last_synced_time ASC` 选目标。
- **数据库迁移门控**：24h 内跳过整套 DDL；超过 1 小时的 `login_attempts` 自动清理。

## 相关资源

- `README.md` 是面向最终用户的部署 4 步流程（网页）+ 开发者 CLI 模式 + API 文档 + 数据表结构 + 故障排查。**所有用户可见字段的含义以 README 为准**。
- `CODING_STANDARDS.md` 是评审期规则（语言三档、注释惯例、模板转义、错误日志格式、错误响应）的单一真相之源；`/code-review` 的 Standards 轴从这里取规则。
- `docs/architecture-review.md` 是架构深化候选清单（C1–C6 + 状态）；下次 `/wayfinder` chart 可直接拿它做地图种子。
- `wrangler.toml` 是部署相关真相之源（cron 表达式、绑定名、compatibility_date）；改这些前先核对 README 同步。
- `src/db/migrations.ts` 是表结构的真相之源；新增字段时**直接改 `expectedSchemas`**（idempotent DDL），不要手工 ALTER。
- `vitest.config.ts` 是测试环境配置真相之源；改动需保持 `maxWorkers: 1`（D1 SQLite 锁约束）。
- `docs/ui-redesign.md` 是界面层的真相之源（诊断 D1–D10 + 目标设计系统 + P1/P2/P3 实施记录）。**动 `src/ui/templates.js` 前先读它**，别重新做审美诊断。

## 界面（UI）专项

动 `src/ui/templates.js`（或任何界面模板）前**必读** `docs/ui-redesign.md` §11 已知陷阱（agent 版）——Pico v2 令牌特异性、CSS 落点、首帧主题脚本、同步按钮选择器契约四条 gotcha 与会被测试断言的可见文案清单都在那里，本文件不再重述。

## 交接文档

跨会话的交接文档放 **`docs/handoff/`**（随仓库走，可被新 clone 的 agent 读到），不要写进 `.scratch/`——后者已被 `.gitignore` 排除，只留给截图、探针脚本、种子数据这类一次性产物。

- 命名：`YYYYMMDD-HHMMSS-mmm-<主题>.md`（时间戳精确到毫秒，便于排序；示例见目录内现有文件）。
- 内容边界：只写「接手必须先知道的东西」——当前状态一句话、未完成/待决定项、会踩坑的技术事实、验证环境怎么起、建议技能。**不要重复** `README.md` / `docs/ui-redesign.md` / 提交信息里已有的细节，用路径引用。
- 增量交接：后一份只写「从那之后变了什么 + 还欠什么」，并指向前一份，避免整篇重写。
- 脱敏：不得写入口令、Token、真实 `database_id`、UUID、邮箱。

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `free5394/dns-clone` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles, label strings equal to their names (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

single-context（根目录一份 `GLOSSARY.md`，架构决定放 `docs/adr/`——**按需创建，当前不存在**）。See `docs/agents/domain.md`.