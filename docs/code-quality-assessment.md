# 代码质量评估报告

> 状态提示（2026-11-07）：本文是评审当日的快照，问题清单本身不回填修复状态，避免"边改边改历史"。
> 当前状态与偏差以 [`docs/code-quality-review-2026-11-06.md`](code-quality-review-2026-11-06.md) 第七至九节为准，
> 执行拆解见 [`docs/code-quality-fix-plan.md`](code-quality-fix-plan.md)。

- 评估日期：2026-11-05
- 评估范围：当前工作树（`git status` 显示 `main...origin/main [ahead 23]`，无未提交改动）
- 评估方式：只读静态审查 + 只读统计命令；未运行测试、未安装依赖、未格式化、未执行任何 git 写操作
- 结论分级：阻断级 / 高 / 中 / 低

## 1. 概述与评估方法

本报告对 dns-clone 做只读代码质量评估。评估基准来自 `AGENTS.md`、`CODING_STANDARDS.md`、`README.md`、`docs/architecture-review.md` 与源码本身；报告区分「违反项目自带规范」与「通用最佳实践建议」。

项目当前整体质量较好：安全边界（鉴权、脱敏、SSRF、XSS）、D1 迁移、批处理失败隔离和定时任务轮转都有明确实现与回归测试。未发现阻断级问题。主要短板集中在维护性与测试深度：`src/ui/templates.js` 内嵌的仪表盘脚本函数 `getDashboardScript` 达 348 行，且该文件在 `tsconfig.json:19` 被显式排除；部分 API 端点缺少直接测试；手动全量同步路径缺少数据规模上限与并发防护。

评估过程中有一条只读统计命令被本地安全钩子拦截（涉及遍历 `git ls-files` 的 PowerShell 表达式），未重试该具体命令，改用其他等价只读统计继续；未影响结论。

## 2. 项目画像

### 2.1 技术栈

- Cloudflare Worker + D1（Cloudflare 的 Serverless SQL 数据库）
- TypeScript + JavaScript 模板
- Vitest + `@cloudflare/vitest-pool-workers`
- oxlint / Prettier / tsc
- CI：GitHub Actions

依据：

- `package.json`：
    ```
    "devDependencies": {
        "@cloudflare/vitest-pool-workers": "0.23.0",
        "@vitest/coverage-istanbul": "4.1.11",
        "esbuild": "^0.28.2",
        "oxlint": "^1.89.0",
        "prettier": "^3.9.10",
        "typescript": "7.0.2",
        "vitest": "^4.1.0",
        "wrangler": "4.151.1"
    }
    ```
- `wrangler.toml`：
    ```
    main = "src/index.ts"
    compatibility_date = "2026-05-20"
    keep_vars = true
    ```

### 2.2 规模

统计口径：`git ls-files`；行数用 .NET `ReadAllLines()` 统计。图片按行数统计无意义，仅用于文件数。

| 范围                                                                         | 文件数 |                                     行数 |
| ---------------------------------------------------------------------------- | -----: | ---------------------------------------: |
| 全部受管文件（不含 `.png`）                                                  |     74 |                                   13,333 |
| 受管文本文件（再排除 `pnpm-lock.yaml` 与生成的 `worker-configuration.d.ts`） |     73 |                                   10,049 |
| `src/`                                                                       |     21 |                                    3,442 |
| `test/`                                                                      |     18 |                                    3,796 |
| `scripts/`                                                                   |      9 |                                      806 |
| `docs/`                                                                      |      5 |                                      807 |
| `.github/`                                                                   |      2 |                                       85 |
| `img/`                                                                       |      2 | 15,521（二进制图片行数，不参与代码统计） |

TOP 热点文件：

| 文件                            | 行数 |
| ------------------------------- | ---: |
| `src/ui/templates.js`           |  933 |
| `test/api.test.ts`              |  678 |
| `test/sync.test.ts`             |  638 |
| `test/language-check.test.ts`   |  608 |
| `src/routes/api.ts`             |  499 |
| `src/sync/domains.ts`           |  489 |
| `test/templates-escape.test.ts` |  393 |
| `README.md`                     |  619 |

### 2.3 目录结构

```
src/
├── db/        D1 client 与迁移
├── routes/    API / UI / GitHub proxy 路由
├── sync/      域名同步、IP 源同步、GitHub API
├── ui/        纯 JS HTML 模板
└── util/      auth / fetch / SSRF / SSE / batch-size 等
test/          Vitest + workerd 测试
scripts/       构建、部署校验、门禁脚本
docs/          架构评审、UI 重构、agent 流程文档
```

## 3. 代码可读性

### 3.1 总体结论

中等问题 3 个，低 1 个。命名总体清晰，注释解释意图和历史修复原因，错误信息以中文为主。主要问题是 UI 模板过长、仪表盘脚本高度压缩、部分双语文日志混用。

### 3.2 问题

#### M-1【中】`getDashboardScript` 过长且压缩成超长行，可读性差

位置：`src/ui/templates.js:584-931`（区间 348 行，含空行）；函数内单行最长出现在 `src/ui/templates.js:604`，`apiFetch` 被压成一行，486 字符。同文件另有两条超过 1,200 字符的超长行：`src/ui/templates.js:354`（1,207 字符，属 `getHtmlLayout`）与 `src/ui/templates.js:561`（1,278 字符，属 `getDashboardPage`）。

代码：

```
function getDashboardScript(domains, ipSources, settings) {
```

```
async function apiFetch(url, options = {}) { const res = await fetch(url, { headers: { "Content-Type": "application/json", ...options.headers }, ...options }); if (!res.ok) { const errData = await res.json().catch(() => ({ error: `HTTP 错误: ${res.status}` })); if (res.status === 401) { showNotification('会话已过期，请重新登录。', 'error'); setTimeout(() => window.location.href = '/login', 2000); } throw new Error(errData.error); } try { return await res.json(); } catch (e) { return {}; } }
```

理由：一个函数同时承担数据初始化、渲染、事件绑定、API 请求、SSE 解析、设置保存等职责；且多处把完整逻辑压到单行，人工评审和 diff 定位成本高。项目文档也将其列为架构候选问题：

```
C6 | 841 行、免 tsc、免覆盖率的 templates.js 内嵌了第二套仪表盘数据逻辑
```

（见 `docs/architecture-review.md:15`；当前文件已增长到 933 行。）

影响：维护成本高、UI 行为测试难以直接覆盖函数内部逻辑。

建议：按项目规范，把非平凡浏览器脚本提取为可导入纯函数或 helper，先从 `apiFetch`、SSE 解析、列表渲染开始，不要求一次性重写。

#### M-2【中】双语文日志混用，降低排障可读性

位置：`src/sync/domains.ts:68-70`、`src/sync/domains.ts:83-88`；`src/sync/ip-sources.ts:70-73`、`src/sync/ip-sources.ts:86-91`。

代码：

```
log("Cannot run scheduled domain sync: Cloudflare settings are missing.");
```

```
log(`Found ${domainsToSync.length} domains for this sync batch (failure-first).`);
```

理由：同一条调用链内既有中文用户可见信息，也有英文日志；`CODING_STANDARDS.md` 要求 `console.*` 输出中文 user-facing 消息。项目注释说明机械语言门禁只约束新增/改动代码，因此这更像存量问题而非直接违规。

影响：用户排查日志时语言不一致。

建议：后续触碰这些行时顺手改为中文，不做纯 churn 的全量替换。

#### M-3【中】IP 源新增与更新重复度高

位置：`src/routes/api.ts:406-433` 与 `src/routes/api.ts:435-462`。

代码：

```
const { url, github_path, commit_message, fetch_strategy } = body;
if (!url || !github_path || !commit_message || !fetch_strategy) {
    return jsonResponse({ error: "缺少必填字段或尚未成功探测获取策略。" }, 400);
}
```

理由：两个函数的请求体读取、必填校验、URL 安全校验、UNIQUE 冲突处理几乎重复；差异只在 INSERT / UPDATE 和响应文案。

影响：后续新增字段或校验规则时容易只改一处。

建议：可仿照 `handleDomainMutation` 建一个共享 helper，保持现有行为不变。

#### L-1【低】README 的仓库结构描述存在陈旧信息

位置：`README.md:320`、`README.md:328`、`README.md:334`。

代码：

```
├── wrangler.toml       # Worker 配置（compatibility_date 2026-01-15，keep_vars）
```

```
├── test/                # vitest-pool-workers 测试（16 文件，workerd 内跑）
```

理由：实际 `wrangler.toml:3` 是 `compatibility_date = "2026-05-20"`；实际测试文件数为 18。README 自称用户可见字段与部署步骤真相源，结构描述与当前事实不一致。

影响：误导新用户。

建议：更新这两处数字；不必扩展成完整文件清单。

### 3.3 未发现

- 死代码标记：`git grep -nE 'TODO|FIXME|HACK' -- src test scripts` 无结果。
- 明显魔法超时：外部请求统一集中在 `src/util/fetch.ts`，多数调用点显式传 8s / 10s / 15s / 20s；未发现无解释的裸魔法值。

## 4. 可维护性

### 4.1 总体结论

中等问题 3 个，低 1 个。模块拆分方向正确，但 settings 键、同步编排和行读取仍有重复；项目自己的架构评审已提名这些问题。

### 4.2 问题

#### M-4【中】settings 键名、白名单、脱敏表和配对规则分散

位置：`src/routes/api.ts:16-25`、`src/routes/api.ts:211-213`、`src/routes/api.ts:236-241`；`src/db/client.ts:33-44`。

代码：

```
const ALLOWED_SETTINGS_KEYS = new Set([
    "CF_API_TOKEN",
    "CF_ZONE_ID",
    "GITHUB_TOKEN",
    ...
]);
```

```
const secretSettingKeys = new Set(["CF_API_TOKEN", "GITHUB_TOKEN"]);
```

```
export const SENSITIVE_SETTINGS_KEYS = new Set([
    "ADMIN_PASSWORD_HASH",
    "PASSWORD_SALT",
    ...
]);
```

理由：同一批 settings 键在路由层与 DB client 各自定义，配对不变量写在 `apiSetSettings` 内。项目架构评审已提名 C1：

```
settings 词汇表没有归属模块：键名、白名单、脱敏表、配对不变量被 9 个调用点各自重述
```

（见 `docs/architecture-review.md:11`。）

影响：新增配置键需要修改多处，漏改会造成安全脱敏或写入白名单不一致。

建议：先收敛为模块级常量与类型，再考虑配对校验函数。

#### M-5【中】定时批同步与手动全量同步编排重复

位置：`src/sync/domains.ts:61-99`、`src/sync/domains.ts:126-154`；`src/sync/ip-sources.ts:64-97`、`src/sync/ip-sources.ts:171-196`。

代码：

```
for (const domain of domainsToSync) {
    try {
        await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
    } catch (e) {
```

```
for (const domain of domains) {
    try {
        await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
    } catch (e) {
```

理由：项目架构评审已提名 C2：「批同步编排写了 5 遍」（`docs/architecture-review.md:12`）。当前代码仍保持这一形态。

影响：批处理行为调整（如并发、取消传播、指标）需要多处修改。

建议：优先抽「失败优先取批」和「逐条吞错」两个 helper，不改变现有 SQL。

#### M-6【中】domains / ip_sources 行查询列清单重复

位置：`src/routes/api.ts:273-279`、`src/routes/api.ts:397-403`、`src/routes/ui.ts:38-47`、`src/sync/domains.ts:73-81`、`src/sync/ip-sources.ts:76-84`。

代码：

```
SELECT id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes,
       strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time,
```

```
SELECT id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, ...
```

理由：项目架构评审已提名 C3：「domain / ip_source 行的读取被 7 个 module 重写，列清单逐字重复 4 次且改名零反馈」（`docs/architecture-review.md:13`）。当前 API 路由与 UI 路由仍重复列清单。

影响：新增字段时容易遗漏某个入口。

建议：先在 DB client 层提供 row mapper / 常量列清单，保持 SQL 不变或最小变化。

#### L-2【低】测试脚本与结构描述中的旧注释未更新

位置：`scripts/build-single-file.mjs:4-5`。

代码：

```
与 src/index.js（手写单文件版）并存：后者是历史遗留，本脚本输出"模块化源码的构建产物"。
```

理由：`git ls-files 'src/*.js'` 显示当前只剩 `src/ui/templates.js`，不存在 `src/index.js`。该注释描述的历史文件已不存在，会误导维护者寻找死代码。

影响：轻微认知负担。

建议：下次触碰该脚本时删除这句过时描述。

### 4.3 未发现

- `src/db/migrations.ts` 保持幂等 DDL，并使用 `expectedSchemas` 作为结构真相源；`src/db/migrations/0001_initial.sql` 与其保持一致。未发现违反项目「调整表结构时直接修改 expectedSchemas」的红线。
- `wrangler.toml` 保留唯一 D1 binding `WUYA`、`database_id = "REPLACE_WITH_YOUR_D1_ID"`、`keep_vars = true`，符合项目部署红线。

## 5. 正确性

### 5.1 总体结论

高问题 1 个，中问题 2 个，低 2 个。关键路径（单条失败不中断批次、定时轮转、空库自举、BATCH_SIZE 钳制）均有实现和测试。主要风险在手动全量同步、URL 路径拼接和部分输入类型校验。

### 5.2 问题

#### H-1【高】GitHub API URL 未编码 `owner` / `repo` / `path`

位置：`src/sync/github.ts:38`、`src/sync/github.ts:73`、`src/sync/github.ts:123`、`src/sync/github.ts:163`。

代码：

```
const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
```

```
const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
```

理由：`owner`、`repo`、`path` 来自 settings / `ip_sources.github_path`。路由层只检查必填，未做字符集校验。若值包含 `?`、`#`、`..`、空格等，会导致请求 URL 被解释成不同路径或查询片段，得到非预期响应；不会造成 SQL 注入，但会造成功能正确性和边界问题。

影响：特殊字符配置可导致读错文件、更新失败或 GitHub 返回不可预期状态。

建议：对 path 使用 `encodeURIComponent` 或按 GitHub Contents API 要求逐段编码；`owner` / `repo` 加严格字符白名单。

#### M-7【中】IP 源 `github_path`、`commit_message`、`fetch_strategy` 缺少结构校验

位置：`src/routes/api.ts:406-462`。

代码：

```
const { url, github_path, commit_message, fetch_strategy } = body;
if (!url || !github_path || !commit_message || !fetch_strategy) {
    return jsonResponse({ error: "缺少必填字段或尚未成功探测获取策略。" }, 400);
}
```

理由：只做 truthy 检查。`fetch_strategy` 可以是任意字符串，虽然运行时会因找不到策略而回退；`github_path` 可为空格、绝对路径片段、超长字符串；`commit_message` 无长度限制。前端通常提交探测结果，但 API 层不能假设调用方总是前端。

影响：脏数据落库，后续同步或代理路径表现异常。

建议：至少校验 `fetch_strategy` 必须属于 `FETCH_STRATEGIES` 键集合，`github_path` 限制为相对安全路径格式，字段加长度上限。

#### M-8【中】手动全量同步无批大小和并发防护

位置：`src/routes/api.ts:63-66`、`src/routes/api.ts:90-91`；`src/sync/domains.ts:136-149`；`src/sync/ip-sources.ts:179-188`。

代码：

```
const domains = await queryAll<DomainRow>(db, "SELECT * FROM domains WHERE is_enabled = 1");
```

```
for (const domain of domains) {
    try {
        await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
```

理由：定时路径有 `BATCH_SIZE`（1..100）控制，但手动 API 全量路径一次读取所有启用行并逐条执行。两个用户同时点击按钮会创建两条长 SSE 任务；没有任务锁或去重。

影响：数据量大时容易触碰 Worker 执行时长、Cloudflare API 配额或 GitHub API 配额；重复任务浪费资源。

建议：短期加并发/运行中标记；中期给手动同步也提供分页或批参数。

#### L-3【低】登录限流在缺少 `CF-Connecting-IP` 时归并到 `unknown`

位置：`src/routes/api.ts:144`。

代码：

```
const ip = request.headers.get("CF-Connecting-IP") || "unknown";
```

理由：生产 Cloudflare 边缘会设置该头，但本地 dev / 特殊环境缺失时，所有失败尝试共享同一个 `unknown` bucket。达到 5 次后所有无 IP 客户端都会被限流。

影响：非生产环境或异常部署形态下可能误伤。

建议：保留现状也可以接受；若要改进，可在缺失时拒绝或使用更细粒度标识，并写清部署前提。

#### L-4【低】`is_deep_resolve` 未严格校验类型

位置：`src/routes/api.ts:288-296`、`src/routes/api.ts:341-354`。

代码：

```
is_deep_resolve?: number;
```

```
.bind(source, target_domain, zoneId, is_deep_resolve ?? 1, effectiveTtl, notes || null, id)
```

理由：`ttl` 有严格数值校验，而 `is_deep_resolve` 只靠 `?? 1`。传入 `"0"` 会落库为字符串，D1 / SQLite 因类型宽松不会立即报错，但类型契约与 UI 状态可能不一致。

影响：边界输入下行为依赖 SQLite 隐式转换。

建议：补一个 `0/1/boolean` 显式校验或归一化。

### 5.3 已验证的关键正确性路径

- 批量同步单条失败不中断：
    - `src/sync/domains.ts:90-98`
        ```
        try {
            await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
        } catch (e) {
            log(...)
        }
        ```
    - `src/sync/ip-sources.ts:92-96`
        ```
        await syncSingleIpSource(source.id, env, false).catch((e) => {
            log(...)
        });
        ```
- 定时任务先轮转再执行，失败不永久卡死：
    - `src/index.ts:60-74`
        ```
        const otherTask = nextTask === "domains" ? "ip_sources" : "domains";
        try {
            await setSetting(db, "next_sync_task", otherTask);
        } catch (e) { ... }
        try { ... await syncScheduledDomains(env); }
        ```
- 迁移门控与空库自举：
    - `src/db/migrations.ts:19-26`
        ```
        try {
            lastMigratedAt = await getSetting(db, "last_migrated_at");
        } catch {
            lastMigratedAt = null;
        }
        ```
- `BATCH_SIZE` 钳制：
    - `src/util/batch-size.ts:10-13`
        ```
        export function normalizeBatchSize(raw: unknown): number {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) return DEFAULT_BATCH_SIZE;
        ```

## 6. 安全性

### 6.1 总体结论

中等问题 1 个，低 1 个。认证、密码哈希、Salt / Token 脱敏、Cookie、CSRF、SQL 参数化、XSS 转义、SSRF、速率限制均符合项目红线；未发现阻断级或高危漏洞。

### 6.2 问题

#### M-9【中】IP 源 URL 探测的出站延迟上限较高，且策略串行尝试

位置：`src/routes/api.ts:469-498`；`src/sync/ip-sources.ts:31-59`。

代码：

````
for (const [strategyName, strategyFn] of Object.entries(FETCH_STRATEGIES)) {
    try {
        const ips = await strategyFn(url);
    ```

理由：三个策略分别最长 15s、20s、15s，串行总等待可达约 50s。该端点已鉴权，且每个 fetch 有超时，所以不是无界等待；但在 Workers 请求模型下属于较长占用。

影响：探测失败时请求长时间占用；频繁操作会放大资源消耗。

建议：给整个探测流程一个总超时或减少策略组合；保留鉴权与 SSRF 校验。

#### L-5【低】错误 message 可能包含上游详情并返回给已登录管理员

位置：`src/routes/api.ts:377-394`。

代码：
````

return jsonResponse({ error: `获取记录失败: ${e instanceof Error ? e.message : String(e)}` }, 500);

````

理由：非 API 路径已按规范返回固定文案；API 路径允许返回 message，不含 stack。此处会把 Cloudflare API 或网络错误 message 拼给前端。暴露面限于已登录管理员，风险低。

影响：可能泄露上游 URL / 状态细节。

建议：保持当前 API 错误格式，但对上游异常可改成固定文案 + 控制台记录 stack。

### 6.3 已验证的安全点

- 密码哈希：
  - `src/util/auth.ts:20-35`
    ```
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" },
    ```
  - 旧格式登录成功后升级：
    ```
    if (result.upgradedHash) await setSetting(db, "ADMIN_PASSWORD_HASH", result.upgradedHash);
    ```
    （`src/routes/api.ts:167-168`）
- 会话：
  - `src/routes/api.ts:177`
    ```
    session=${token}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=86400
    ```
- 鉴权覆盖：
  - `src/routes/api.ts:49-56`
    ```
    if (path === "/api/status" && method === "GET") ...
    if (path === "/api/setup" && method === "POST") ...
    if (path === "/api/login" && method === "POST") ...
    if (!(await isAuthenticated(request, db))) return jsonResponse({ error: "未授权" }, 401);
    ```
  - 其余端点均在 `isAuthenticated` 之后分发。
- 敏感字段过滤：
  - `src/db/client.ts:33-48`
    ```
    export const SENSITIVE_SETTINGS_KEYS = new Set([
        "ADMIN_PASSWORD_HASH",
        "PASSWORD_SALT",
        "CF_API_TOKEN",
        "GITHUB_TOKEN",
    ]);
    ```
- SQL 注入：
  - 业务 SQL 使用 `.bind(...)`；唯一动态表名 / 列定义来自 `migrations.ts` 内部常量：
    ```
    db.prepare(`CREATE TABLE IF NOT EXISTS ${tableName} (${expectedSchemas[tableName].join(", ")});`)
    ```
    （`src/db/migrations.ts:65-67`）
- HTML / 模板注入：
  - 服务端 `escapeHtml`：`src/ui/templates.js:4-18`
  - 脚本上下文 `safeJsonForScript`：`src/ui/templates.js:20-25`
  - 客户端 `esc`：`src/ui/templates.js:611-612`
- CSRF / CORS：
  - Cookie `SameSite=Strict`；未发现 `Access-Control-Allow-Origin` 或 CORS 配置。
- SSRF：
  - `src/util/url-safety.ts:74-113` 的 `assertSafeHttpUrl` 覆盖协议、IPv4 归一化、私网、CGNAT、metadata 等。
- Secrets：
  - `wrangler.toml` 只有占位符 `REPLACE_WITH_YOUR_D1_ID`。
  - `.gitignore` 忽略 `*.vars`、`*.env` 等。
- 日志泄露：
  - 非 API 全局兜底返回固定文案，不暴露 stack：
    ```
    return new Response("服务器内部错误，请稍后重试。", { status: 500 });
    ```
    （`src/index.ts:42-44`）
  - `console.error` 均使用 `e instanceof Error ? e.stack : e`，未发现 `String(e)` 传给 `console.*`。

## 7. 性能

### 7.1 总体结论

中等问题 2 个，低 2 个。定时任务有批大小控制，UI 首屏查询并行执行，订阅器有边缘缓存；主要问题是 UI 逐域名请求 Cloudflare 记录（N+1）、登录鉴权每请求两次 D1 查询、部分表缺少针对任务排序的索引。

### 7.2 问题

#### M-10【中】仪表盘逐域名请求 DNS 记录，形成 N+1 外部 API 调用

位置：`src/ui/templates.js:747-757`。

代码：
````

for (const el of placeholders) {
const id = el.dataset.domainId;
try {
const records = await apiFetch('/api/domains/' + id + '/records');

```

理由：每个域名卡片一次 API 请求；服务端每个请求又访问 D1 读取 token / zone / domain，再调用 Cloudflare。10 个域名即 10 个 Worker 子请求、10 次 Cloudflare API 调用、30 次 D1 查询。

影响：域名数量增加时首屏慢、外部 API 配额消耗大。

建议：提供批量 records 端点或使用 `last_synced_records` 缓存渲染，点击时再刷新。

#### M-11【中】`domains` / `ip_sources` 定时批查询缺少任务排序索引

位置：`src/sync/domains.ts:73-81`、`src/sync/ip-sources.ts:76-84`、`src/db/migrations.ts:84-87`。

代码：
```

ORDER BY
CASE last_sync_status WHEN 'failed' THEN 0 ELSE 1 END,
last_synced_time ASC
LIMIT ?

```

```

await db.prepare("CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at)").run();

```

理由：当前只创建 `login_attempts` 索引；`domains` 与 `ip_sources` 的失败优先排序需扫描后排序。小规模无碍，但表增长后每个 cron 都做全表排序。

影响：定时任务 CPU / D1 开销随表增长上升。

建议：用 `EXPLAIN QUERY PLAN` 验证后再决定是否加部分索引，如 `last_sync_status` / `last_synced_time` 组合索引。

#### L-6【低】鉴权每请求至少 1 次会话查询，UI/API 复合请求会重复查询

位置：`src/util/auth.ts:112-122`。

代码：
```

const session = (await db.prepare("SELECT expires_at FROM sessions WHERE token = ?").bind(token).first()) as {

```

理由：`sessions.token` 是 PRIMARY KEY，单次查询成本很低。但 UI /admin 先鉴权一次，后续页面脚本又调用多个受保护 API，每个 API 再鉴权，会话查询重复发生。

影响：常规规模下可忽略。

建议：暂不优化；若未来 API 调用密集，可考虑短 TTL 缓存或合并鉴权数据查询。

#### L-7【低】公共 / 管理列表无分页

位置：`src/routes/api.ts:272-279`、`src/routes/api.ts:397-403`；`src/routes/ui.ts:38-47`、`src/routes/ui.ts:56-64`。

代码：
```

FROM domains ORDER BY is_system DESC, target_domain

```

```

FROM ip_sources ORDER BY github_path

````

理由：所有行一次性返回。当前产品假设数据规模小，`BATCH_SIZE` 也只作用于定时任务。

影响：数据量大时响应体积和渲染成本增加。

建议：先明确预期规模；若可能超过数百条，再加分页。

### 7.3 未发现

- 无谓等待：外部 fetch 均经 `fetchWithTimeout` / `fetchWithRetry`，未发现裸 `fetch` 的服务端调用。
- 订阅器缓存：
  - `src/sync/github.ts:152-188` 使用 `caches.default`，命中直接返回；上游成功才写缓存。
- UI 首屏 D1 查询并行：
  - `src/routes/ui.ts:38-47`、`src/routes/ui.ts:68-72` 使用 `Promise.all`。

## 8. 测试覆盖

### 8.1 总体结论

中等问题 2 个，低 3 个。测试体系成熟：18 个测试文件、219 个用例，覆盖鉴权、限流、并发 setup、迁移幂等、批处理、轮转、SSRF、XSS、SSE、GitHub proxy。明显缺口是部分 API 端点无直接测试、覆盖率阈值全为 0、部分 UI 行为测试仍是源码字符串契约。

### 8.2 测试画像

- 测试框架：Vitest + `@cloudflare/vitest-pool-workers`
- 测试文件：18 个
- 测试用例：219 个（按 `\b(it|test)\(` 统计；其中中文标题 124 个、英文标题 95 个）
- 测试代码行数：3,796 行
- 覆盖率配置：Istanbul，阈值全部 0
  - `vitest.config.ts:29-36`
    ```
    thresholds: {
        lines: 0,
        functions: 0,
        statements: 0,
        branches: 0,
    },
    ```

### 8.3 问题

#### M-12【中】多个 API 端点缺少直接测试

位置：`src/routes/api.ts:58-104`、`src/routes/api.ts:184-189`、`src/routes/api.ts:406-498`。

代码：
````

if (method === "POST" && path === "/api/logout") return await apiLogout(request, db);

```

```

if (method === "POST" && path === "/api/ip_sources/probe") return await apiProbeIpSource(request);

```

理由：在 `test/` 中检索 `apiLogout`、`apiProbe`、`apiAddIpSource`、`apiUpdateIpSource`、`apiDeleteIpSource`、`/api/sync`、`/api/domains/sync_system`、`/api/ip_sources/sync_all` 均无结果。现有 `test/api.test.ts` 主要覆盖 login、setup、settings、domains 列表/新增/更新、records 编码和 404。

影响：IP 源 CRUD、探测、登出、手动同步端点的回归依赖间接覆盖，重构风险较高。

建议：优先补 IP 源 CRUD 与 probe 的行为测试；登出可用一个 Cookie 清除断言覆盖。

#### M-13【中】覆盖率阈值全为 0，CI 不会因覆盖率下降失败

位置：`vitest.config.ts:26-36`。

代码：
```

coverage: {
...
thresholds: {
lines: 0,
functions: 0,
statements: 0,
branches: 0,
},
},

```

理由：CI 运行 `pnpm test:coverage`（`.github/workflows/ci.yml`），但阈值为 0 意味着覆盖率不构成质量门禁。注释说明这是阶段性选择，不是疏漏。

影响：删除关键分支不会导致 CI 失败，只要其他测试未碰它。

建议：先输出当前覆盖率基线，再设置不低于当前值的小步阈值；避免一次性设置过高造成挫败。

#### L-8【低】部分 UI 测试仍是源码字符串契约，不是行为测试

位置：`test/templates-escape.test.ts:161-178`。

代码：
```

expect(html).toMatch(/function esc\(s\)/);
expect(html).toMatch(/title="\$\{esc\(item\.last_sync_error/);
expect(html).not.toMatch(/toast\.innerHTML/);

```

理由：`CODING_STANDARDS.md` 明确要求：源码字符串包含某个分支、选择器或正则，只算静态契约，不算行为测试。该文件同时也有较好的行为测试（如 `consumeSseEvents`），但 dashboard 渲染逻辑仍大量依赖源码正则。

影响：重构合法实现会导致测试失败；错误实现只要包含指定字符串也可能通过。

建议：把 `renderDomainCard` / `renderIpSourceCard` / `renderStatus` 提取为可导入函数后直接断言输出。

#### L-9【低】`fetchWithTimeout` / `fetchWithRetry` 无直接单元测试

位置：`src/util/fetch.ts:13-61`。

代码：
```

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {

```

理由：`git grep -n 'fetchWithTimeout\|fetchWithRetry' -- test` 只命中 `test/github.test.ts:2` 的注释，没有直接测试。当前行为被间接覆盖。

影响：超时、4xx 不重试、408/429 重试、指数退避等契约变更不易发现。

建议：补 timers / fake fetch 测试，重点断言重试矩阵。

#### L-10【低】测试存在已知确定性风险：与本地 dev server 并发时偶发失败

位置：`AGENTS.md` 验证节。

代码：
```

`pnpm test` 与本机 `pnpm dev` 同跑时，worker 偶发启动失败；需要确定性结果时先停 dev server。

```

理由：这是项目文档明确记录的环境约束。本次评估按要求未运行测试，因此未复现；只将其列为已知确定性风险。

影响：CI 不受影响；本地同时跑 dev server 时可能出现非代码性失败。

建议：保留现状；跑测试前先停 dev server。

### 8.4 覆盖亮点

- 并发 setup 竞态：`test/api.test.ts:84-172` 手写 D1 边界代理打开竞态窗口，断言恰一成功一 403，并验证最终凭据。
- 登录限流：`test/api.test.ts:235-311` 覆盖 5 分钟内第 6 次失败 429、成功登录清除失败记录。
- 迁移幂等与空库自举：`test/migrations.test.ts:7-23`、`test/migrations.test.ts:57-85`。
- 批处理与轮转：`test/scheduled-domains.test.ts:77-184`、`test/scheduled.test.ts:8-50`。
- XSS / 脱敏：`test/templates-escape.test.ts`、`test/ui.test.ts:88-129`。
- SSRF：`test/url-safety.test.ts`，31 个用例。

## 9. 依赖与项目结构

### 9.1 总体结论

低问题 2 个。依赖数量少且全部为 devDependencies；无 runtime npm 依赖；pnpm lockfile 有 integrity；CI 与本地检查项基本一致。未发现未使用依赖。

### 9.2 依赖画像

- 直接依赖：8 个，全部为 devDependencies。
- lockfile 顶层 packages：655 个（含 pnpm 自身二进制包）。
- 版本：
  - 精确：`@cloudflare/vitest-pool-workers@0.23.0`、`@vitest/coverage-istanbul@4.1.11`、`typescript@7.0.2`、`wrangler@4.151.1`
  - caret range：`esbuild@^0.28.2`、`oxlint@^1.89.0`、`prettier@^3.9.10`、`vitest@^4.1.0`
- lockfile 当前解析：
  - `esbuild@0.28.2`
  - `oxlint@1.89.0`
  - `prettier@3.9.10`
  - `typescript@7.0.2`
  - `vitest@4.1.11`
  - `wrangler@4.151.1`

依赖使用位置：

| 依赖 | 使用位置 |
| --- | --- |
| `@cloudflare/vitest-pool-workers` | `vitest.config.ts`、测试环境 |
| `@vitest/coverage-istanbul` | `vitest.config.ts` coverage provider |
| `esbuild` | `scripts/build-single-file.mjs` |
| `oxlint` | `pnpm lint` |
| `prettier` | `pnpm format` / `format:check` |
| `typescript` | `pnpm typecheck` |
| `vitest` | `test/**` |
| `wrangler` | dev / typegen / deploy / vitest config |

### 9.3 问题

#### L-11【低】npm 依赖没有自动更新机制

位置：`.github/dependabot.yml:1-12`。

代码：
```

updates: - package-ecosystem: "github-actions"
directory: "/"
schedule:
interval: "weekly"

```

理由：Dependabot（GitHub 依赖更新机器人）只覆盖 GitHub Actions，npm / pnpm 依赖更新「另议」。虽然 lockfile 保证当前安装可复现，但没有自动提醒机制发现新版本或安全公告。

影响：依赖老化风险。

建议：为 npm 生态添加 weekly Dependabot，分组 devDependencies，减少 PR 噪音。

#### L-12【低】本地 `pnpm check` 不跑测试，测试只由 CI 把关

位置：`.githooks/pre-commit:8-15`。

代码：
```

# 为什么不含 test：全套测试约 20 秒，放在提交路径上会让人用 --no-verify 绕过，反而削弱门禁。

# 测试仍由 CI 把关。

```

理由：这是项目有意做出的权衡，不是违反规范；本地 `pnpm check` 与 CI 分步检查的五项一致，但 CI 额外跑 coverage 测试。

影响：本地提交可能未跑测试就推送，直到 CI 才发现。

建议：保留现状；如果测试时间下降，可考虑提供 `pnpm check:all` 手动入口。

### 9.4 未发现

- 未使用依赖：8 个直接依赖均有脚本或源码引用。
- 本地已知安全公告：本次只做本地可判断部分，未联网查询 advisory，不能宣称「无已知漏洞」；仅确认 lockfile 有完整 integrity hash。
- CI 与本地门禁一致性：CI 依次执行 typegen、typecheck、language、utf8、lint、format check、coverage test，与 `pnpm check` 的五项及 `pnpm test:coverage` 对齐。

## 10. 优先级汇总

| 等级 | 数量 | 问题 |
| --- | ---: | --- |
| 阻断级 | 0 | — |
| 高 | 1 | H-1 GitHub API URL 未编码 / 未校验 |
| 中 | 13 | M-1 UI 长函数与超长行；M-2 双语文日志；M-3 IP 源 CRUD 重复；M-4 settings 词汇分散；M-5 同步编排重复；M-6 行查询重复；M-7 IP 源输入结构校验不足；M-8 手动全量同步无并发防护；M-9 探测总耗时高；M-10 records N+1；M-11 任务排序索引缺失；M-12 API 端点测试缺口；M-13 覆盖率阈值全 0 |
| 低 | 12 | L-1 README 陈旧；L-2 构建脚本陈旧注释；L-3 unknown IP 限流；L-4 is_deep_resolve 类型校验；L-5 API 错误 message；L-6 重复鉴权查询；L-7 列表无分页；L-8 UI 静态契约测试；L-9 fetch 工具无直接测试；L-10 本地 dev 并发偶发；L-11 npm 无自动更新；L-12 pre-commit 不跑测试 |

建议处理顺序：

1. 先修 H-1：GitHub URL 编码与 `owner` / `repo` / `path` 校验，并补回归测试。
2. 再修 M-7 / M-8 / M-9：输入校验、手动同步资源上限、探测总超时，降低运行风险。
3. 补 M-12 中 IP 源 CRUD / probe / logout / 手动同步端点测试。
4. 处理 M-1 / M-4 / M-5 / M-6：按项目架构评审顺序先做 settings 归属模块，再拆模板与同步 helper。
5. 性能项 M-10 / M-11 需先实测规模与 `EXPLAIN QUERY PLAN`，避免盲目加索引或批量端点。
6. 低优先级项可在后续触碰相关文件时顺手处理，避免纯 churn。

## 11. 附录：执行过的只读检查命令与结果摘要

以下命令均在仓库根目录执行，均无写入副作用；输出摘要手工归纳。

1. `git status --short --branch`
   - 结果：`main...origin/main [ahead 23]`，无未提交改动。
2. `Get-Content -Encoding UTF8 -Raw AGENTS.md`
   - 结果：读取项目红线、验证与评审规则。
3. `Get-Content -Encoding UTF8 -Raw CODING_STANDARDS.md`
   - 结果：语言三档、模板转义、错误日志与 API 错误响应规范。
4. `Get-Content -Encoding UTF8 -Raw package.json`
   - 结果：8 个 devDependencies；check / test / coverage 脚本。
5. `Get-Content -Encoding UTF8 -Raw wrangler.toml`
   - 结果：唯一 D1 binding `WUYA`；占位符 `database_id`；`keep_vars = true`。
6. `Get-Content -Encoding UTF8 -Raw src/db/migrations.ts`
   - 结果：幂等 DDL、`expectedSchemas`、24h 门控、login_attempts 清理。
7. `git ls-files` + .NET `ReadAllLines()` 统计
   - 结果：受管非图片文件 74 个、13,333 行；排除 lock/generated 后 73 个、10,049 行。
8. `git grep -n "String(e)" -- src test scripts`
   - 结果：仅 API / 日志 message 场景，未发现 `console.*` 使用 `String(e)`。
9. `git grep -nE 'TODO|FIXME|HACK' -- src test scripts`
   - 结果：无。
10. `git grep -n "escapeHtml" -- src test`
    - 结果：模板与测试均覆盖 escapeHtml；关键动态字段已转义。
11. `git grep -nE 'innerHTML|insertAdjacentHTML' -- src test`
    - 结果：UI 使用 `innerHTML` 的位置均由 `render*` helper 生成并调用 `esc()`。
12. `git grep -nE '\$\{[^}]*\}.*(SELECT|...)|(`...`)' -- src`
    - 结果：动态 SQL 仅出现在 migrations 内部常量；业务 SQL 均 `.bind()`。
13. `Select-String -Path test/*.test.ts -Pattern '\b(it|test)\('`
    - 结果：219 个用例。
14. `git grep -n 'CREATE INDEX' -- src`
    - 结果：仅 `idx_login_attempts_ip_time`。
15. `Get-Content -Encoding UTF8 -Raw .github/workflows/ci.yml`
    - 结果：CI 与本地门禁 + coverage 测试对齐。
16. `Get-Content -Encoding UTF8 -Raw .github/dependabot.yml`
    - 结果：仅 GitHub Actions 生态自动更新。
17. `Get-Content -Encoding UTF8 -Raw vitest.config.ts`
    - 结果：coverage 阈值全 0。
18. `git grep -nE 'fetch\(' -- src`
    - 结果：服务端外部 fetch 统一走 `src/util/fetch.ts`。
19. `git grep -nE 'apiLogout|apiProbe|apiAddIp|apiUpdateIp|apiDeleteIp|/api/sync|/api/ip_sources/sync_all' -- test`
    - 结果：无直接测试命中。
20. `git grep -n 'fetchWithTimeout\|fetchWithRetry' -- test`
    - 结果：仅注释命中，无直接单测。
21. `git log -10 --format=...`
    - 结果：最近提交为 2026-10-23 的文档与门禁修复。
22. `git diff -- src/ui/templates.js` / `git status`
    - 结果：工作树与 HEAD 对该文件无差异；早期 PowerShell `Measure-Object` 统计与 .NET `ReadAllLines` 差异来自统计方式，最终采用 .NET 计数。

说明：另有一条遍历 `git ls-files` 的 PowerShell 统计命令被本地安全钩子拦截；按安全提示未重试该具体命令，改用其他等价只读统计完成。
```
