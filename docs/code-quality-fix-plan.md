# 代码质量修复计划

- 生成日期：2026-11-05
- 输入：`docs/code-quality-assessment.md`、`AGENTS.md`、`CODING_STANDARDS.md` 与当前工作树源码
- 状态：计划文档；本文所有代码均为草案，不随本计划落地
- 行号核对：以下「当前代码位置」均于 2026-11-05 亲自打开当前工作树核对；若执行时行号漂移，以函数名与代码片段为准

## 执行摘要

本计划覆盖评估报告的 26 条问题：高 1 条、中 13 条、低 12 条。总体策略是先用测试锁住安全与运行风险，再做结构性重构，性能项先实测后改，低危项只随相关文件顺手修复。所有批次都必须保持既有安全边界与项目红线，不追求一次性大改。

---

## 一、任务卡

### H-1 GitHub API URL 未编码 / 未校验

#### 当前代码位置

- `src/sync/github.ts:38`
- `src/sync/github.ts:73`
- `src/sync/github.ts:123`
- `src/sync/github.ts:163`

关键代码（真实行）：

```
38:     const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
73:     const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
123:     const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
163:     const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
```

#### 根因

GitHub URL 构造函数把外部输入直接插入路径，缺少「路径段必须先编码且语义合法」的统一入口。

#### 修复方案

1. 在 `src/sync/github.ts` 顶部新增私有 helper，集中构造 API URL：
    - `repoSegment(value: string): string`：校验 `owner` / `repo` 只允许 `[A-Za-z0-9_.-]`，且不得为 `.`、`..` 或空串；合法后直接返回，否则抛 `Error("GitHub owner/repo 含非法字符。")`。
    - `contentPathSegments(path: string): string`：拒绝空串、反斜杠、控制字符、绝对路径片段、`..` 段、超过 255 字符；按 `/` 分割后逐段 `encodeURIComponent`，再用 `/` 连接。
2. 四处拼接统一替换为 `githubRepoUrl(owner, repo)` / `githubContentUrl(owner, repo, path)`。
3. 补 6 个回归用例：`owner` 含 `?`、`repo` 含 `#`、`path` 含空格、`path` 含 `?`、`path` 含 `#`、`path` 含 `../`。

草案（不落地）：

改前：

```
const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
```

改后：

```
const apiUrl = githubContentUrl(owner, repo, path);
```

新增 helper 草案：

```
function githubContentUrl(owner: string, repo: string, path: string): string {
    const repoPath = `${validatedRepoSegment(owner)}/${validatedRepoSegment(repo)}`;
    return `https://api.github.com/repos/${repoPath}/contents/${encodedContentPath(path)}`;
}
```

#### 影响面

- 文件：`src/sync/github.ts`、新增或扩展 `test/github.test.ts`。
- 调用方：`ensureRepoExists`、`getCurrentGitHubContent`、`updateFileOnGitHub`、`readFileForSubscriber`；间接覆盖域名同步、IP 源同步、GitHub 订阅代理。
- API 契约：HTTP 响应不变；仅非法 settings / `github_path` 从「读错文件或不可预期状态」变为明确错误。
- 前端行为：合法配置无变化；非法配置会看到同步失败日志或 API 错误。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/github.test.ts`
- 新增用例名（示例）：
    - `it("owner 含查询符时构造 URL 前先拒绝")`
    - `it("path 含 ../ 时拒绝逃逸")`
    - `it("合法 path 含空格时逐段编码")`
- 手工观察：使用包含空格的合法 path 请求 GitHub，不因空格截断而 404。

#### 风险与回滚

- 改坏后果：过严校验可能拒绝历史已存的合法 GitHub 路径（例如包含中文路径）；过松则仍有 URL 逃逸。
- 回滚：单独提交后 `git revert <commit>`；无数据库迁移，可独立回滚。

#### 预估工作量

1–2 人时。

#### 前置依赖

无。

---

### M-1 `getDashboardScript` 过长且压缩成超长行，可读性差

#### 当前代码位置

- `src/ui/templates.js:584-931`（函数区间）
- `src/ui/templates.js:604`（`apiFetch` 单行 486 字符）
- `src/ui/templates.js:354`（`getHtmlLayout` 超长行）
- `src/ui/templates.js:561`（`getDashboardPage` 超长行）

关键代码（真实行）：

```
584: function getDashboardScript(domains, ipSources, settings) {
604:   async function apiFetch(url, options = {}) { ... }
612:   function esc(s) { ... }
747:   async function fetchLiveRecords() {
```

#### 根因

模板从历史单文件迁移时保留了内嵌脚本形态，浏览器端行为没有逐步提取为可导入函数，导致渲染、请求、SSE、设置保存堆在一个函数里。

#### 修复方案

本卡只做第一阶段的低风险拆分，避免一次性重写：

1. 先提取 `apiFetch` 为模块内独立函数，并由 `getDashboardScript` 通过 `fn.toString()` 注入或直接导入到导出的 helper 中；保持脚本输出语义不变。
2. 再提取 `renderDomainCard`、`renderIpSourceCard`、`renderStatus` 为可导出纯函数，输入行数据，输出 HTML 字符串。
3. `getHtmlLayout` 与 `getDashboardPage` 的超长行按模板语义切行，不做视觉文案变更。
4. 每拆一个函数就替换一处调用并跑对应测试，不做跨函数重排。
5. 遵守 `CODING_STANDARDS.md`：所有用户可控字段输出前继续调用 `esc()`；修改前必读 `docs/ui-redesign.md` §11。

草案（不落地）：

改前（单行压缩）：

```
async function apiFetch(url, options = {}) { const res = await fetch(url, ...); ... }
```

改后（多行）：

```
async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) throw await toApiError(res);
    return await res.json().catch(() => ({}));
}
```

#### 影响面

- 文件：`src/ui/templates.js`、`test/templates-escape.test.ts`、必要时 `test/ui.test.ts`。
- 调用方：`getDashboardPage` 与仪表盘浏览器脚本；`tsconfig.json` 仍排除该 JS 文件，类型契约不变。
- API 契约：不变。
- 前端行为：应完全不变；任何 DOM 输出差异都视为回归。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/templates-escape.test.ts test/ui.test.ts`
- `pnpm check`
- 新增/改写行为用例（示例）：
    - `it("renderDomainCard 对 notes 与域名字段转义")`
    - `it("renderIpSourceCard 对 url 与 github_path 转义")`
- 人工观察：`pnpm dev` 后登录 `/admin`，确认列表、通知、同步 SSE、设置保存行为不变。

#### 风险与回滚

- 改坏后果：脚本注入顺序变化可能导致函数未定义；`toString()` 改导入时可能遗漏依赖。
- 回滚：按小提交拆分，任一行为异常 `git revert` 对应提交。

#### 预估工作量

8–16 人时。

#### 前置依赖

无硬依赖；建议在 M-12 后执行，便于用端点测试保护重构。

---

### M-2 双语文日志混用，降低排障可读性

#### 当前代码位置

- `src/sync/domains.ts:69`
- `src/sync/domains.ts:84`
- `src/sync/domains.ts:88`
- `src/sync/ip-sources.ts:72`
- `src/sync/ip-sources.ts:87`
- `src/sync/ip-sources.ts:91`

关键代码（真实行）：

```
69:         log("Cannot run scheduled domain sync: Cloudflare settings are missing.");
84:         log("No domains to sync in this batch.");
88:     log(`Found ${domainsToSync.length} domains for this sync batch (failure-first).`);
```

```
72:         log("Cannot run scheduled IP source sync: GitHub settings are missing.");
87:         log("No IP sources to sync in this batch.");
91:     log(`Found ${sourcesToSync.length} IP sources for this sync batch (failure-first).`);
```

#### 根因

同步模块从历史英文实现迁移而来，后续中文日志规范没有覆盖这些存量行，语言门禁只约束新增/改动代码。

#### 修复方案

只做逐条等义翻译，不改日志结构、级别或时间戳：

1. 缺配置：`Cloudflare / GitHub 配置缺失，跳过本轮同步。`
2. 空批：`本轮没有需要同步的域名。` / `本轮没有需要同步的 IP 源。`
3. 批量数：`本轮按失败优先选取 ${n} 个域名。` / `本轮按失败优先选取 ${n} 个 IP 源。`
4. 若测试中存在英文日志断言，同步改为中文断言；不批量改其它英文日志。

#### 影响面

- 文件：`src/sync/domains.ts`、`src/sync/ip-sources.ts`、相关测试断言。
- 调用方：定时任务日志与手动同步 SSE 日志文案。
- API 契约：不变。
- 前端行为：SSE 日志文案变中文。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/scheduled-domains.test.ts test/scheduled.test.ts test/sync.test.ts`
- `pnpm check`
- 人工观察：手动同步 SSE 中不再出现本卡列出的英文日志。

#### 风险与回滚

- 改坏后果：仅日志文案风险；若测试过度匹配旧英文文本会误报。
- 回滚：`git revert` 单提交。

#### 预估工作量

0.5–1 人时。

#### 前置依赖

无；但原则是触碰 M-5 / M-8 相关同步文件时顺手执行，避免纯 churn。

---

### M-3 IP 源新增与更新重复度高

#### 当前代码位置

- `src/routes/api.ts:406-433`（新增）
- `src/routes/api.ts:435-462`（更新）

关键代码（真实行）：

```
406: async function apiAddIpSource(request: Request, db: D1Database): Promise<Response> {
414:     const { url, github_path, commit_message, fetch_strategy } = body;
415:     if (!url || !github_path || !commit_message || !fetch_strategy) {
416:         return jsonResponse({ error: "缺少必填字段或尚未成功探测获取策略。" }, 400);
```

```
435: async function apiUpdateIpSource(request: Request, db: D1Database, id: number): Promise<Response> {
443:     const { url, github_path, commit_message, fetch_strategy } = body;
444:     if (!url || !github_path || !commit_message || !fetch_strategy) {
445:         return jsonResponse({ error: "缺少必填字段或尚未成功探测获取策略。" }, 400);
```

#### 根因

新增与更新端点先各自实现，后续未按 `handleDomainMutation` 的既有模式收敛，导致读取、校验、UNIQUE 处理重复。

#### 修复方案

1. 新增私有 helper `parseIpSourceInput(body)`：复用 M-7 的结构校验，返回 `IpSourceInput` 或错误响应。
2. 新增 `persistIpSource(db, input, id?)`：按 `id` 是否存在执行 INSERT / UPDATE，保留现有成功文案差异（`IP源添加成功。` / `IP源更新成功。`）与 409 文案。
3. `apiAddIpSource` / `apiUpdateIpSource` 只保留读 body、调用 helper、返回响应。
4. 依赖 M-7 先补测试再重构，避免「重构 + 新校验」混在一个提交。

草案（不落地）：

```
async function apiAddIpSource(request: Request, db: D1Database): Promise<Response> {
    const body = await readJsonBody(request);
    if (body === null) return BAD_JSON();
    const input = await parseIpSourceInput(body);
    if (input instanceof Response) return input;
    return await insertIpSource(db, input);
}
```

#### 影响面

- 文件：`src/routes/api.ts`、`test/api.test.ts`。
- 调用方：`/api/ip_sources` 的 POST / PUT 路由。
- API 契约：成功、400、409 状态与文案保持不变（M-7 新增的结构校验除外）。
- 前端行为：合法输入不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/api.test.ts`
- 既有 / 新增用例覆盖：新增成功、更新成功、缺字段 400、非法 `fetch_strategy` 400、UNIQUE 409。
- 人工观察：后台编辑 IP 源后保存成功。

#### 风险与回滚

- 改坏后果：新增 / 更新响应文案或状态码漂移；UNIQUE 冲突判断被误改。
- 回滚：`git revert` 该重构提交。

#### 预估工作量

1.5–3 人时（若 M-7 测试已完成取低值）。

#### 前置依赖

M-7。

---

### M-4 settings 键名、白名单、脱敏表和配对规则分散

#### 当前代码位置

- `src/routes/api.ts:16-25`
- `src/routes/api.ts:211-213`
- `src/routes/api.ts:236-241`
- `src/db/client.ts:37-43`

关键代码（真实行）：

```
17: const ALLOWED_SETTINGS_KEYS = new Set([
18:     "CF_API_TOKEN",
...
25: ]);
```

```
212:     const secretSettingKeys = new Set(["CF_API_TOKEN", "GITHUB_TOKEN"]);
236:     const configKeys = ["CF_API_TOKEN", "CF_ZONE_ID", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"];
```

```
38: export const SENSITIVE_SETTINGS_KEYS = new Set([
39:     "ADMIN_PASSWORD_HASH",
...
43: ]);
```

#### 根因

settings 是跨路由、DB 与同步模块的领域词汇，但一直没有归属模块，安全不变量散在调用点。

#### 修复方案

1. 在 `src/db/client.ts` 或新文件 `src/db/settings.ts` 中收敛词汇表：
    - `SETTING_KEYS`：类型与常量清单。
    - `WRITABLE_SETTING_KEYS`：替代路由白名单。
    - `SECRET_SETTING_KEYS`：`CF_API_TOKEN`、`GITHUB_TOKEN`。
    - `SENSITIVE_SETTINGS_KEYS`：继续包含密码哈希、Salt、Token。
    - `CF_CONFIG_KEYS`、`GITHUB_CONFIG_KEYS`。
2. 先导出常量并替换调用点，不改变任何语义。
3. 再把 `apiSetSettings` 的 null / 空串语义与配对校验提取为 `normalizeSettingsInput` / `validateEffectiveSettings`。
4. 严禁把 `ADMIN_PASSWORD_HASH`、`PASSWORD_SALT`、Token 加入写入白名单；不改变 null 清除与空串语义。
5. 保持密码哈希、Salt 与 Token 不回传前端。

#### 影响面

- 文件：`src/db/client.ts`（或新 `src/db/settings.ts`）、`src/routes/api.ts`、相关测试。
- 调用方：设置读取、写入、脱敏、配对校验。
- API 契约：不变；新增配置键仍需显式扩展词汇表。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/api.test.ts test/ui.test.ts test/templates-escape.test.ts`
- `pnpm check`
- 用例覆盖：Token 空串保持不变、null 清除、非白名单忽略、敏感字段不回传、Cloudflare / GitHub 配对校验。

#### 风险与回滚

- 改坏后果：白名单、脱敏表或 null 语义漂移会造成安全问题。
- 回滚：分两步提交（词汇表收敛、校验提取），出问题只 revert 对应提交。

#### 预估工作量

3–6 人时。

#### 前置依赖

无硬依赖；建议在 M-12 后执行，先补设置端点行为测试。

---

### M-5 定时批同步与手动全量同步编排重复

#### 当前代码位置

- `src/sync/domains.ts:61-99`（定时）
- `src/sync/domains.ts:126-154`（手动全量）
- `src/sync/ip-sources.ts:64-97`（定时）
- `src/sync/ip-sources.ts:171-196`（手动全量）

关键代码（真实行）：

```
90:     for (const domain of domainsToSync) {
91:         try {
92:             await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
```

```
143:         for (const domain of domains) {
144:             try {
145:                 await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
```

```
92:     for (const source of sourcesToSync) {
93:         await syncSingleIpSource(source.id, env, false).catch((e) => {
```

```
184:         for (const source of sources) {
185:             await syncSingleIpSource(source.id, env, false).catch((e) =>
```

#### 根因

批同步的核心不变量（失败优先取批、逐条吞错）在 domains 与 ip_sources 两套模块中分别手写，没有共享 helper。

#### 修复方案

1. 抽两个纯编排 helper（可放 `src/util/batch-sync.ts`）：
    - `pickFailureFirst<T>(rows: T[]): T[]`：处理排序输入。
    - `forEachIsolated<T>(items: T[], run: (item: T) => Promise<void>, onError: (item: T, e: unknown) => void)`：保证单条失败继续。
2. domains / ip_sources 的定时与手动路径只保留取数和日志差异。
3. 手动路径是否加并发防护由 M-8 单独处理，本卡不引入并发。
4. 保持定时任务失败后仍切换到下一类任务的红线。

#### 影响面

- 文件：`src/sync/domains.ts`、`src/sync/ip-sources.ts`、新增 helper、测试。
- 调用方：定时同步、手动全量同步、手动系统域名同步中相同模式的位置。
- API 契约：不变。
- 前端行为：SSE 日志顺序保持逐条串行。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/sync.test.ts test/scheduled-domains.test.ts test/scheduled.test.ts`
- 新增用例：第二项抛错后第三项仍执行；失败项记录错误但循环完成。

#### 风险与回滚

- 改坏后果：错误吞噬范围扩大、批处理提前终止或定时轮转被破坏。
- 回滚：`git revert` 单提交；helper 无持久化状态。

#### 预估工作量

3–5 人时。

#### 前置依赖

M-8（先锁定手动同步行为，再收敛编排）。

---

### M-6 domains / ip_sources 行查询列清单重复

#### 当前代码位置

- `src/routes/api.ts:273-279`
- `src/routes/api.ts:397-403`
- `src/routes/ui.ts:38-47`
- `src/sync/domains.ts:73-81`
- `src/sync/ip-sources.ts:76-84`

关键代码（真实行）：

```
273:     const query = `
274:       SELECT id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes,
275:              strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time,
```

```
400:             "SELECT id, url, github_path, commit_message, fetch_strategy, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled FROM ip_sources ORDER BY github_path"
```

```
40:                 "SELECT id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled, is_system FROM domains ORDER BY is_system DESC, target_domain"
```

#### 根因

行结构知识分散在 API、UI 与同步模块，列清单没有由 DB 层提供单一来源。

#### 修复方案

1. 在 `src/db/client.ts` 定义：
    - `DOMAIN_COLUMNS`、`IP_SOURCE_COLUMNS` 常量。
    - `mapDomainRow(row)`、`mapIpSourceRow(row)`：只做字段选择与 `last_synced_time` 格式化，不改变字段名。
2. 先替换 API / UI 查询的列清单；同步路径若依赖 `SELECT *` 的完整列，可用显式列清单替换。
3. 公开列表与同步行结构保持字段名不变，避免前端契约变化。
4. 若 M-11 最终需要新增索引，不改列清单，只改迁移。

#### 影响面

- 文件：`src/db/client.ts`、`src/routes/api.ts`、`src/routes/ui.ts`、`src/sync/domains.ts`、`src/sync/ip-sources.ts`。
- 调用方：域名 / IP 源列表、仪表盘 SSR、同步取数。
- API 契约：JSON 字段名与顺序不做语义变更（顺序如被测试断言需同步调整）。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/api.test.ts test/ui.test.ts test/sync.test.ts`
- `pnpm check`
- 断言列表 JSON 字段与关键格式化时间仍存在。

#### 风险与回滚

- 改坏后果：漏列导致 UI 或同步逻辑读 `undefined`；不同入口字段形状漂移。
- 回滚：按模块小提交，逐个 revert。

#### 预估工作量

3–5 人时。

#### 前置依赖

无硬依赖；建议在 M-12 后执行。

---

### M-7 IP 源 `github_path`、`commit_message`、`fetch_strategy` 缺少结构校验

#### 当前代码位置

- `src/routes/api.ts:406-462`

关键代码（真实行）：

```
414:     const { url, github_path, commit_message, fetch_strategy } = body;
415:     if (!url || !github_path || !commit_message || !fetch_strategy) {
416:         return jsonResponse({ error: "缺少必填字段或尚未成功探测获取策略。" }, 400);
```

#### 根因

API 层把前端表单的探测结果当作可信输入，只检查 truthy，没有在信任边界做类型、格式与长度约束。

#### 修复方案

1. 定义 `IpSourceInput` 与校验函数：
    - `url`：字符串，先 `assertSafeHttpUrl`，再限制 2048 字符。
    - `github_path`：字符串；拒绝空串、首尾空白、反斜杠、控制字符、`..` 段、以 `/` 开头；每段 1–255 字符；总长 1–512 字符。
    - `commit_message`：非空字符串，trim 后 1–200 字符。
    - `fetch_strategy`：必须为 `Object.keys(FETCH_STRATEGIES)` 之一。
2. 新增 / 更新共用该校验；错误文案中文且具体到字段。
3. 补测试后再改实现。

草案（不落地）：

改前：

```
if (!url || !github_path || !commit_message || !fetch_strategy) {
    return jsonResponse({ error: "缺少必填字段或尚未成功探测获取策略。" }, 400);
}
```

改后：

```
const input = validateIpSourceInput({ url, github_path, commit_message, fetch_strategy });
if (!input.ok) return jsonResponse({ error: input.error }, 400);
```

#### 影响面

- 文件：`src/routes/api.ts`、`src/sync/ip-sources.ts`（导入 `FETCH_STRATEGIES`）、`test/api.test.ts`。
- 调用方：IP 源新增与更新。
- API 契约：新增非法输入返回 400 及具体中文错误。
- 前端行为：正常探测结果可保存；手工构造脏数据被拒绝。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/api.test.ts`
- 新增用例：非法策略 400、空格 path 400、`../` path 400、超长 commit_message 400、合法输入 200。

#### 风险与回滚

- 改坏后果：校验过严拒绝既有合法数据；错误文案破坏前端依赖。
- 回滚：`git revert` 单提交；无数据迁移。

#### 预估工作量

1.5–3 人时。

#### 前置依赖

无。

---

### M-8 手动全量同步无批大小和并发防护

#### 当前代码位置

- `src/routes/api.ts:63-66`
- `src/routes/api.ts:90-91`
- `src/sync/domains.ts:136-149`
- `src/sync/ip-sources.ts:179-188`

关键代码（真实行）：

```
63:     if (method === "POST" && path === "/api/sync")
64:         return syncAllDomains(env, true, request.signal) as Promise<Response>;
```

```
90:     if (method === "POST" && path === "/api/ip_sources/sync_all")
91:         return syncAllIpSources(env, true, request.signal) as Promise<Response>;
```

```
136:         const domains = await queryAll<DomainRow>(db, "SELECT * FROM domains WHERE is_enabled = 1");
143:         for (const domain of domains) {
```

```
179:         const sources = await queryAll<IpSourceRow>(db, "SELECT * FROM ip_sources WHERE is_enabled = 1");
184:         for (const source of sources) {
```

#### 根因

手动同步从「全量」语义直接实现，没有继承定时任务的 `BATCH_SIZE` 钳制，也没有任务级互斥。

#### 修复方案

短期（本卡必做）：

1. 为手动同步增加运行中标记，可用 settings 键 `MANUAL_SYNC_RUNNING`，但不得加入前端可见设置白名单。
2. 任务开始用 D1 原子更新或 `INSERT OR IGNORE` 抢占锁；结束（成功 / 失败 / abort）在 `finally` 中释放。
3. 已有任务运行时返回 `409 {"error":"手动同步任务正在执行，请稍后再试。"}`。
4. 抢锁必须考虑陈旧锁：用时间戳与最大任务时长比较，超时才允许接管，避免异常中断后永久锁死。
5. 保持逐条失败隔离，不因单条失败结束整批。
6. 若引入新的 settings 键，需确认它不回传敏感字段；普通运行标记可回传状态，但不得破坏设置写入白名单。

中期（另行立项，不并入本卡）：

- 手动任务分页 / 批参数。

#### 影响面

- 文件：`src/routes/api.ts`、`src/sync/domains.ts`、`src/sync/ip-sources.ts`、测试。
- 调用方：三个手动全量同步端点与 UI 按钮。
- API 契约：并发重复请求可能返回 409。
- 前端行为：重复点击会收到 409 提示；正常单任务输出不变。
- 数据库结构：优先复用 settings；如必须建表，只能修改 `src/db/migrations.ts` 的 `expectedSchemas` 并保持幂等 DDL。

#### 验证方式

- `pnpm test -- test/api.test.ts test/sync.test.ts`
- 新增用例：首个任务运行中时第二个请求 409；任务完成后锁释放；模拟陈旧锁可接管。
- 人工观察：连点两个同步按钮，只出现一条 SSE 任务，另一个提示冲突。

#### 风险与回滚

- 改坏后果：锁未释放会阻塞后续手动同步；锁实现不原子会双跑。
- 回滚：单独提交后 `git revert`；若引入迁移，回滚前确认 DDL 幂等不会破坏数据。

#### 预估工作量

4–8 人时。

#### 前置依赖

M-12（先补手动同步端点行为基线）。

---

### M-9 IP 源 URL 探测的出站延迟上限较高，且策略串行尝试

#### 当前代码位置

- `src/routes/api.ts:469-498`
- `src/sync/ip-sources.ts:31-59`

关键代码（真实行）：

```
480:     for (const [strategyName, strategyFn] of Object.entries(FETCH_STRATEGIES)) {
481:         try {
482:             const ips = await strategyFn(url);
```

```
33:         const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 15000);
46:             20000
54:         const res = await fetchWithTimeout(proxyUrl, {}, 15000);
```

#### 根因

探测端点复用「抓取时按策略串行回退」的实现，没有为交互式探测设置总超时或策略并发上限。

#### 修复方案

1. 保留 SSRF 校验与鉴权。
2. 为 probe 增加总超时（建议 20–25 秒），可用 `AbortController` / `Promise.race` 实现；超时返回固定中文错误。
3. 先实测三种策略耗时分布，再决定是否并发或减少组合；不得为了速度绕过安全校验。
4. 若并发执行，须限制最大并发为 2–3，首个成功策略返回，并取消其余请求；失败日志不回传给前端。
5. 保存后的同步路径仍保持串行回退，不因本卡改变。

#### 影响面

- 文件：`src/routes/api.ts`、`src/sync/ip-sources.ts`、测试。
- 调用方：`/api/ip_sources/probe` 与后台探测按钮。
- API 契约：超时返回 400 或 504（实现前需定稿；建议 504 更符合网关超时语义，但需与前端提示兼容）。
- 前端行为：慢源不再无限占用按钮等待。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/api.test.ts`
- 用 fake fetch / fake strategies 新增：总超时触发、首个成功即返回、失败后回退。
- 人工观察：坏 URL 的探测按钮在总超时内恢复并显示错误。

#### 风险与回滚

- 改坏后果：过短总超时导致慢但可用的源永远无法探测；并发实现可能放大上游压力。
- 回滚：`git revert` 单提交。

#### 预估工作量

2–4 人时。

#### 前置依赖

M-12（probe 行为测试）；L-9（fetch 工具测试可作为超时实现的回归基础，非硬阻塞）。

---

### M-10 仪表盘逐域名请求 DNS 记录，形成 N+1 外部 API 调用

#### 当前代码位置

- `src/ui/templates.js:747-757`

关键代码（真实行）：

```
747:   async function fetchLiveRecords() {
748:     const placeholders = document.querySelectorAll('.records-placeholder');
749:     for (const el of placeholders) {
750:       const id = el.dataset.domainId;
751:       try {
752:             const records = await apiFetch('/api/domains/' + id + '/records');
```

#### 根因

仪表盘首屏按卡片逐个调用现有单域名 records 端点，服务端缺少一次批量获取的聚合入口。

#### 修复方案

先实测再改：

1. 基线：在本地或可控数据量（10、50 个启用域名）下记录首屏请求数、D1 查询数、总耗时与 Cloudflare API 调用数。
2. 若确认瓶颈，新增 `GET /api/domains/records` 批量端点：
    - 一次读取 settings 与域名列表；
    - 按 id 逐个调用 Cloudflare，但复用 token / zone；
    - 返回 `{ [domainId]: { records?, error? } }`，单域名失败不中断批量结果；
    - 可选传入 `ids`，限制单批最多 50 个。
3. 前端 `fetchLiveRecords` 改为一次批量请求后逐卡片渲染；单条错误显示「查询失败」。
4. 不新增并发库；如需并发用 `Promise.allSettled` 与固定小并发。
5. 若基线显示当前规模足够小，可只缓存 `last_synced_records` 并点击刷新，暂不做批量端点。

#### 影响面

- 文件：`src/routes/api.ts`、`src/ui/templates.js`、`test/api.test.ts`、`test/templates-escape.test.ts`。
- 调用方：仪表盘首屏；旧单域名端点保留。
- API 契约：新增端点；既有单域名响应不变。
- 前端行为：网络面板由 N 个 `/records` 请求变为 1 个批量请求。
- 数据库结构：不变；若缓存落库则必须改 `expectedSchemas` 并保持幂等。

#### 验证方式

- `pnpm test -- test/api.test.ts test/templates-escape.test.ts`
- 基线与改后对比记录写入提交说明或 issue。
- 人工观察：10 个域名首屏网络请求数下降，失败卡片显示错误且其它卡片正常。

#### 风险与回滚

- 改坏后果：批量端点超时导致整屏无记录；Cloudflare 限流被一次性放大。
- 回滚：前端可先回退为逐域名请求，`git revert` 两端提交即可。

#### 预估工作量

6–10 人时（含基线实测）。

#### 前置依赖

M-12；建议在 M-1 的 `apiFetch` / 渲染 helper 拆出后执行。

---

### M-11 `domains` / `ip_sources` 定时批查询缺少任务排序索引

#### 当前代码位置

- `src/sync/domains.ts:73-81`
- `src/sync/ip-sources.ts:76-84`
- `src/db/migrations.ts:84-87`

关键代码（真实行）：

```
76:         ORDER BY
77:             CASE last_sync_status WHEN 'failed' THEN 0 ELSE 1 END,
78:             last_synced_time ASC
79:         LIMIT ?`;
```

```
86: await db.prepare("CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at)").run();
```

#### 根因

迁移阶段只处理了登录限流索引，任务取批的排序表达式没有做查询计划验证，导致表增长后可能全表扫描排序。

#### 修复方案

1. 先在可控 D1 / 本地 workerd 环境执行：
    - `EXPLAIN QUERY PLAN SELECT id FROM domains WHERE is_enabled=1 ORDER BY CASE ... LIMIT 10;`
    - ip_sources 同查询。
2. 记录当前行数、计划与耗时基线。
3. 只有确认 `SCAN` + `SORT` 是主要成本时才加索引；候选索引为 `(is_enabled, last_sync_status, last_synced_time)`。
4. 结构变更只能修改 `src/db/migrations.ts` 的 `expectedSchemas`，DDL 使用 `CREATE INDEX IF NOT EXISTS`，保持幂等；同步检查迁移测试的 `expectedSchemas` 断言。
5. 加索引后重跑 `EXPLAIN QUERY PLAN`，必须观察到索引使用且写入成本可接受。

#### 影响面

- 文件：`src/db/migrations.ts`、`test/migrations.test.ts`、必要时迁移 SQL fixture。
- 调用方：定时任务取批查询。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：可能新增两个索引；不新增第二 D1 绑定，`database_id` 保持占位符。

#### 验证方式

- `pnpm test -- test/migrations.test.ts test/scheduled-domains.test.ts test/scheduled.test.ts`
- 提交中保留改前 / 改后 `EXPLAIN QUERY PLAN` 输出摘要。
- `pnpm check`

#### 风险与回滚

- 改坏后果：索引写入成本超过收益；SQLite 优化器不采用新索引；迁移失败影响启动。
- 回滚：代码 `git revert`；已创建索引如无影响可保留到下一版清理，删除索引也必须走幂等 DDL 与独立提交。

#### 预估工作量

3–6 人时（含基线与验证）。

#### 前置依赖

无硬依赖；必须在取得基线数据后执行。

---

### M-12 多个 API 端点缺少直接测试

#### 当前代码位置

- `src/routes/api.ts:58-104`
- `src/routes/api.ts:184-189`
- `src/routes/api.ts:406-498`

关键代码（真实行）：

```
58:     if (method === "POST" && path === "/api/logout") return await apiLogout(request, db);
89:     if (method === "POST" && path === "/api/ip_sources/probe") return await apiProbeIpSource(request);
90:     if (method === "POST" && path === "/api/ip_sources/sync_all")
91:         return syncAllIpSources(env, true, request.signal) as Promise<Response>;
```

#### 根因

测试按历史回归需求累积，新增的 IP 源 CRUD、probe、logout 与手动同步端点没有同步补行为测试。

#### 修复方案

1. 在 `test/api.test.ts` 补端点级测试，优先顺序：
    - IP 源列表 / 新增 / 更新 / 删除；
    - probe 成功、URL 不安全、全策略失败；
    - logout 删除 session 并设置过期 Cookie；
    - 手动同步 SSE 基线与单条失败不中断。
2. 外部 fetch 用现有测试模式注入 fake；不引入新依赖。
3. 测试标题使用中文。
4. 每个端点至少覆盖成功、鉴权失败、一个代表性失败路径。
5. 不追求一次性补满全部低频分支，先覆盖评估点名的端点。

#### 影响面

- 文件：`test/api.test.ts`（必要时拆新测试文件）、被测路由的 fake 依赖。
- 调用方：无生产代码改动。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/api.test.ts`
- `pnpm test:coverage`
- 新增用例均通过，且可在覆盖率报告中看到对应路由行被执行。

#### 风险与回滚

- 改坏后果：测试与实现耦合过紧导致重构误报；fake Cloudflare / GitHub 行为偏离真实。
- 回滚：测试提交可独立 revert，不影响生产。

#### 预估工作量

8–14 人时。

#### 前置依赖

无。

---

### M-13 覆盖率阈值全为 0，CI 不会因覆盖率下降失败

#### 当前代码位置

- `vitest.config.ts:23-36`

关键代码（真实行）：

```
23:         coverage: {
...
31:             thresholds: {
32:                 lines: 0,
33:                 functions: 0,
34:                 statements: 0,
35:                 branches: 0,
36:             },
```

#### 根因

项目阶段性选择零阈值以避免初期挫败，尚未建立可执行的全局覆盖率基线。

#### 修复方案

1. 先跑 `pnpm test:coverage` 取当前基线，记录 lines / functions / statements / branches 四项数值与日期。
2. 在 M-12 补齐重点端点后重跑基线。
3. 设置不高于当前值的保守阈值（例如当前 76% 时设 75%），保留 1 个百分点缓冲。
4. 阈值写入 `vitest.config.ts`，注释说明基线日期与来源。
5. 不得在没有基线数据时拍非零数值。

#### 影响面

- 文件：`vitest.config.ts`、必要时 CI 日志说明。
- 调用方：`pnpm test:coverage` 与 CI。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test:coverage`
- 故意删除一个关键分支（验证后恢复），确认覆盖率门禁会失败；或用临时降低阈值验证配置生效。

#### 风险与回滚

- 改坏后果：阈值过高阻塞正常提交；覆盖率口径因 include/exclude 变化而跳变。
- 回滚：`git revert` 配置提交。

#### 预估工作量

1–2 人时（不含 M-12 本身）。

#### 前置依赖

M-12。

---

### L-1 README 的仓库结构描述存在陈旧信息

#### 当前代码位置

- `README.md:320`
- `README.md:334`

关键代码（真实行）：

```
320: ├── wrangler.toml       # Worker 配置（compatibility_date 2026-01-15，keep_vars）
334: ├── test/                # vitest-pool-workers 测试（16 文件，workerd 内跑）
```

#### 根因

配置与测试文件增长后，README 的结构清单没有同步维护。

#### 修复方案

1. `compatibility_date` 改为读取 `wrangler.toml` 当前值：`2026-05-20`。
2. 测试文件数改为当前受管 `*.test.ts` 数量；执行 `git ls-files 'test/*.test.ts' | Measure-Object` 或等价只读命令确认。
3. 只改这两处，不扩展文件清单。

#### 影响面

- 文件：`README.md`。
- 调用方：无。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- 人工比对 `README.md:320` 与 `wrangler.toml:3` 一致。
- 重新统计测试文件数并比对 README。
- `pnpm check`

#### 风险与回滚

- 改坏后果：再次写错数字。
- 回滚：`git revert` 单提交。

#### 预估工作量

0.2–0.5 人时。

#### 前置依赖

无；建议随相关文档修改顺手处理。

---

### L-2 测试脚本与结构描述中的旧注释未更新

#### 当前代码位置

- `scripts/build-single-file.mjs:3`

关键代码（真实行）：

```
3: // 与 src/index.js（手写单文件版）并存：后者是历史遗留，本脚本输出"模块化源码的构建产物"。
```

#### 根因

历史单文件入口删除后，脚本头部注释没有同步删除。

#### 修复方案

删除第 3 行整句过时描述，保留第 1–2 行用途说明；不改构建逻辑。

#### 影响面

- 文件：`scripts/build-single-file.mjs`。
- 调用方：无。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm build`（若 `package.json` 存在该脚本；执行前查证脚本名）。
- `pnpm check`
- `git grep -n "src/index.js" -- scripts` 无残留。

#### 风险与回滚

- 改坏后果：仅注释风险。
- 回滚：`git revert` 单提交。

#### 预估工作量

0.1–0.3 人时。

#### 前置依赖

无；仅在触碰该脚本时执行。

---

### L-3 登录限流在缺少 `CF-Connecting-IP` 时归并到 `unknown`

#### 当前代码位置

- `src/routes/api.ts:144`

关键代码（真实行）：

```
144:     const ip = request.headers.get("CF-Connecting-IP") || "unknown";
```

#### 根因

限流键依赖 Cloudflare 边缘注入头，非生产或异常部署缺少该头时退化成共享 bucket。

#### 修复方案

保持现状为默认选项，只补部署前提说明：

1. 在 README 部署说明中明确：生产必须经 Cloudflare Worker 正常入口访问，`CF-Connecting-IP` 由边缘提供。
2. 本地 dev 若复现共享限流，重启测试环境或等待 5 分钟窗口结束。
3. 不建议改为拒绝请求，因为本地开发与测试会受影响；也不引入伪造头信任。
4. 若未来必须改进，另行设计基于 D1 全局失败窗口的兜底，不并入本计划。

#### 影响面

- 文件：`README.md`。
- 调用方：无代码调用方。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- 人工检查 README 部署段落明确说明该头来源与本地 dev 行为。
- `pnpm check`

#### 风险与回滚

- 改坏后果：文档表述过严导致用户误以为非 Cloudflare 部署受支持。
- 回滚：`git revert` 文档提交。

#### 预估工作量

0.2–0.5 人时。

#### 前置依赖

无。

---

### L-4 `is_deep_resolve` 未严格校验类型

#### 当前代码位置

- `src/routes/api.ts:288-296`
- `src/routes/api.ts:341-354`

关键代码（真实行）：

```
291:         is_deep_resolve?: number;
...
296:     const { source_domain, target_domain_prefix, is_deep_resolve, ttl, notes } = body;
```

```
345:                 .bind(source, target_domain, zoneId, is_deep_resolve ?? 1, effectiveTtl, notes || null, id)
353:                 .bind(source, target_domain, zoneId, is_deep_resolve ?? 1, effectiveTtl, notes || null)
```

#### 根因

域名新增 / 更新只对 `ttl` 做严格数值校验，布尔标志依赖 `?? 1` 和 SQLite 宽松类型。

#### 修复方案

1. 新增 `normalizeDeepResolve(value: unknown): number | null`：
    - `undefined`：返回 `null`，由调用点使用默认 1；
    - `0` / `false` / `"0"`：返回 0（如决定只接受 JSON number，则 `"0"` 返回错误）；
    - `1` / `true` / `"1"`：返回 1；
    - 其它返回错误。
2. 建议先只接受 `0` / `1` / `boolean`，拒绝字符串，保持 API 类型严格；若前端存在字符串提交，先查证后兼容。
3. `UPDATE` 时若字段缺省，保持读取现有行值或维持当前默认语义；以当前代码实际行为为准，不扩大语义。
4. 补非法类型 400 测试。

#### 影响面

- 文件：`src/routes/api.ts`、`test/api.test.ts`。
- 调用方：域名新增 / 更新。
- API 契约：非法类型从落库变为 400。
- 前端行为：正常 checkbox / number 提交不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/api.test.ts`
- 新增用例：`is_deep_resolve` 为 `"0"`、`2`、`null` 时返回 400 或按定稿语义返回预期值。

#### 风险与回滚

- 改坏后果：默认值语义改变导致编辑域名时意外重置深解析。
- 回滚：`git revert` 单提交。

#### 预估工作量

0.5–1.5 人时。

#### 前置依赖

无。

---

### L-5 错误 message 可能包含上游详情并返回给已登录管理员

#### 当前代码位置

- `src/routes/api.ts:377-394`

关键代码（真实行）：

```
392:     } catch (e) {
393:         return jsonResponse({ error: `获取记录失败: ${e instanceof Error ? e.message : String(e)}` }, 500);
394:     }
```

#### 根因

API 通用兜底为了排障便利直接拼接上游异常 message，没有区分「可控文案」与「上游细节」。

#### 修复方案

1. 该 catch 改为固定中文文案：`获取记录失败，请稍后重试。`
2. 用 `console.error("获取 DNS 记录失败", e instanceof Error ? e.stack : e)` 记录完整 stack。
3. Cloudflare API 自身 `success: false` 分支也评估是否改为固定文案 + 日志，避免拼接 `data.errors`。
4. 不改变 `jsonResponse(errorObj, status)` 结构，不暴露 stack。

#### 影响面

- 文件：`src/routes/api.ts`、`test/api.test.ts`。
- 调用方：`GET /api/domains/:id/records`。
- API 契约：500 错误 message 固定，不再包含上游 URL / 状态细节。
- 前端行为：管理员看到统一错误提示。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/api.test.ts`
- 新增用例：fake fetch 抛含 URL 的错误，响应不包含该 URL，status 为 500。
- `pnpm check`

#### 风险与回滚

- 改坏后果：排障信息减少；必须确认日志仍保留 stack。
- 回滚：`git revert` 单提交。

#### 预估工作量

0.5–1 人时。

#### 前置依赖

无；建议与 M-12 的 records 测试同批执行。

---

### L-6 鉴权每请求至少 1 次会话查询，UI/API 复合请求会重复查询

#### 当前代码位置

- `src/util/auth.ts:112-122`

关键代码（真实行）：

```
112: export async function isAuthenticated(request: Request, db: D1Database): Promise<boolean> {
113:     const token = getCookie(request, "session");
114:     if (!token) return false;
115:     const session = (await db.prepare("SELECT expires_at FROM sessions WHERE token = ?").bind(token).first()) as {
```

#### 根因

会话校验按请求独立执行，且 `sessions.token` 是主键，单次成本极低，因此没有引入缓存。

#### 修复方案

维持现状，不做代码改动：

1. 在性能实测未显示 D1 会话查询是主要耗时前，不引入 TTL 缓存。
2. 若 M-10 批量端点落地后仍发现密集 API 每请求鉴权占比高，再评估：
    - 只在单个请求处理内复用鉴权结果；
    - 不做跨请求共享缓存，避免登出与过期语义复杂化。
3. 本卡只要求不因其它重构增加额外鉴权查询。

#### 影响面

- 文件：无（默认方案）。
- 调用方：所有受保护 API。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test`
- 人工确认现有行为不变；若未来改，新增登出立即失效与过期 session 立即 401 测试。

#### 风险与回滚

- 改坏后果：若未来加缓存，登出后短时间内仍可访问。
- 回滚：未来改动按独立提交 revert。

#### 预估工作量

0 人时（保持现状）；未来评估 2–4 人时。

#### 前置依赖

无；若未来实施，依赖 M-10 的性能基线。

---

### L-7 公共 / 管理列表无分页

#### 当前代码位置

- `src/routes/api.ts:272-279`
- `src/routes/api.ts:397-403`
- `src/routes/ui.ts:38-47`
- `src/routes/ui.ts:56-64`

关键代码（真实行）：

```
277:       FROM domains ORDER BY is_system DESC, target_domain
```

```
401:             "SELECT id, url, github_path, commit_message, fetch_strategy, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled FROM ip_sources ORDER BY github_path"
```

```
58:                 "SELECT source_domain, target_domain, notes, last_synced_time, is_system FROM domains WHERE is_enabled = 1 AND last_sync_status IN ('success', 'no_change') ORDER BY is_system DESC, notes"
```

#### 根因

产品当前假设域名与 IP 源规模小，列表 API / SSR 直接一次返回全部行，没有设定规模触发线。

#### 修复方案

1. 先记录当前生产 / 测试数据规模；低于数百条时维持现状。
2. 若预期超过 500 行：
    - API 增加 `page` / `pageSize`（默认 pageSize 100，上限 200）；
    - SSR 首屏只取前 100 条，并提供「查看更多」走 API；
    - 排序保持不变。
3. 不做无限滚动复杂状态；用最简单的页码查询。
4. 若实施，补边界测试：第 0 / 1 页、超出范围、非法 pageSize。

#### 影响面

- 文件：`src/routes/api.ts`、`src/routes/ui.ts`、`src/ui/templates.js`、测试。
- 调用方：列表 API 与首页 / 后台 SSR。
- API 契约：如实施则新增查询参数；旧无参调用返回第一页并带分页元信息。
- 前端行为：大列表分批展示。
- 数据库结构：不变；如需索引先走 M-11 的实测流程。

#### 验证方式

- `pnpm test -- test/api.test.ts test/ui.test.ts`
- 人工插入 250 条测试数据，确认请求与响应体积下降。

#### 风险与回滚

- 改坏后果：分页元信息破坏前端渲染；排序不稳定导致跨页重复。
- 回滚：`git revert` 前后端提交。

#### 预估工作量

0 人时（未达触发线）；若实施 5–8 人时。

#### 前置依赖

无；实施前需规模数据。

---

### L-8 部分 UI 测试仍是源码字符串契约，不是行为测试

#### 当前代码位置

- `test/templates-escape.test.ts:161-178`

关键代码（真实行）：

```
161:     it("客户端渲染器源码对 DB 字段一律经过 esc()，通知改用 textContent (I2)", () => {
164:         expect(html).toMatch(/function esc\(s\)/);
166:         expect(html).toMatch(/title="\$\{esc\(item\.last_sync_error/);
177:         expect(html).not.toMatch(/toast\.innerHTML/);
```

#### 根因

仪表盘渲染函数未导出，测试只能断言生成脚本源码包含指定字符串，导致测试与实现文本强耦合。

#### 修复方案

1. 依赖 M-1 拆出 `renderDomainCard` / `renderIpSourceCard` / `renderStatus`。
2. 测试直接导入这些函数，输入含 `<script>`、引号、空值的行数据，断言输出 HTML 已转义。
3. `showNotification` 的 `textContent` 行为保留少量源码契约或改为直接调用导出的 DOM helper 测试。
4. 删除被行为测试替代的正则断言，不做全量测试重写。

#### 影响面

- 文件：`src/ui/templates.js`、`test/templates-escape.test.ts`。
- 调用方：模板导出面扩大。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/templates-escape.test.ts`
- 新增 / 改写用例对恶意输入断言输出包含 `&lt;script&gt;` 等转义结果。
- `pnpm check`

#### 风险与回滚

- 改坏后果：导出函数后误以为所有模板脚本都被测试覆盖，遗漏事件绑定行为。
- 回滚：与 M-1 对应提交一起 revert。

#### 预估工作量

2–4 人时（在 M-1 拆分后）。

#### 前置依赖

M-1。

---

### L-9 `fetchWithTimeout` / `fetchWithRetry` 无直接单元测试

#### 当前代码位置

- `src/util/fetch.ts:13-61`

关键代码（真实行）：

```
13: export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
...
34: export async function fetchWithRetry(
...
47:             if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
```

#### 根因

工具函数由调用方间接覆盖，重试矩阵与超时契约从未建立直接单测。

#### 修复方案

1. 新增 `test/fetch.test.ts`，用可注入 fake `fetch`（通过模块 mock 或包装参数，不引入依赖）。
2. 断言：
    - 超时触发 abort 并抛错；
    - 2xx 直接返回；
    - 400 / 403 不重试；
    - 408 / 429 / 500 按配置重试；
    - 网络错误重试；
    - 最后一次仍失败时抛最后错误；
    - 退避时间可被 fake timer 控制。
3. 不修改生产函数；若发现实现缺陷，另开修复提交并加回归用例。

#### 影响面

- 文件：新增 `test/fetch.test.ts`。
- 调用方：无生产改动。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm test -- test/fetch.test.ts`
- `pnpm test:coverage`
- `pnpm check`

#### 风险与回滚

- 改坏后果：测试对全局 fetch mock 清理不完整导致其它测试受污染。
- 回滚：删除测试提交或 `git revert`。

#### 预估工作量

2–4 人时。

#### 前置依赖

无。

---

### L-10 测试存在已知确定性风险：与本地 dev server 并发时偶发失败

#### 当前代码位置

- `AGENTS.md` 验证节

关键代码（真实行）：

```
pnpm test 与本机 pnpm dev 同跑时，worker 偶发启动失败；需要确定性结果时先停 dev server。
```

#### 根因

本地 dev 与 workerd 测试环境竞争同类本地资源，项目已记录为环境约束而非代码缺陷。

#### 修复方案

保持现状：

1. 需要确定性结果时先停本地 dev server，再跑 `pnpm test`。
2. 不引入进程锁或新工具。
3. 在跨会话交接文档中提醒当前是否占用 dev 端口。
4. CI 不受影响，无需改 CI。

#### 影响面

- 文件：无。
- 调用方：本地开发流程。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- 停 dev server 后执行 `pnpm test`，结果稳定。
- 若偶发仍出现，记录复现命令与错误到 issue，再另行诊断。

#### 风险与回滚

- 改坏后果：无代码风险；误加锁会降低本地体验。
- 回滚：无。

#### 预估工作量

0 人时（流程约束）。

#### 前置依赖

无。

---

### L-11 npm 依赖没有自动更新机制

#### 当前代码位置

- `.github/dependabot.yml:1-9`

关键代码（真实行）：

```
1: # 只覆盖 github-actions 生态：action 版本漂移目前没有任何机制兜底（2026 的 Node 20
2: # 弃用警告就是这么撞上的，机理见 .github/workflows/ci.yml 的注释）。npm / pnpm 依赖
3: # 更新另议；按周检查，避免给自己刷 PR 噪音。
...
6:     - package-ecosystem: "github-actions"
```

注：当前文件实际注释为「2026-10 的 Node 20」；本卡以亲自读到的当前内容为准，评估报告摘要中的年份引述不影响问题本身。

#### 根因

项目当时为避免 PR 噪音，只给 GitHub Actions 开启 Dependabot，npm 依赖选择人工评估。

#### 修复方案

1. 在 `.github/dependabot.yml` 增加 `package-ecosystem: "npm"`，`directory: "/"`，weekly。
2. 使用 Dependabot grouping 将 devDependencies 分组，减少 PR 数量。
3. 不改变 lockfile 版本策略，不在本卡手工升级依赖。
4. 更新顶部注释说明 npm 已纳入。
5. 合并 PR 前仍需跑 `pnpm check` 与 `pnpm test:coverage`。

#### 影响面

- 文件：`.github/dependabot.yml`。
- 调用方：GitHub 仓库维护流程。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- 人工检查 YAML 语法（可用现有 CI 检查流程或 GitHub Dependabot 配置页面）。
- 观察 1 个周期内 Dependabot 是否创建分组 PR。
- `pnpm check`（配置变更本身也应跑仓库门禁）。

#### 风险与回滚

- 改坏后果：PR 噪音增加；依赖自动升级引入不兼容版本。
- 回滚：`git revert` 配置提交并关闭自动 PR。

#### 预估工作量

0.5–1 人时。

#### 前置依赖

无。

---

### L-12 本地 `pnpm check` 不跑测试，测试只由 CI 把关

#### 当前代码位置

- `.githooks/pre-commit:4-5`

关键代码（真实行）：

```
4: # 为什么不含 test：全套测试约 20 秒，放在提交路径上会让人用 --no-verify 绕过，反而削弱门禁。
5: # 测试仍由 CI 把关。
```

#### 根因

项目权衡「提交速度与钩子可遵守性」，有意不在 pre-commit 跑全套测试。

#### 修复方案

保持现状：

1. pre-commit 继续只跑 `pnpm check`。
2. 涉及生产逻辑的提交，提交前手动跑 `pnpm test` 或 `pnpm test:coverage`。
3. 不新增 `pnpm check:all`，除非未来测试总时长明显下降且维护者明确需要。
4. CI 继续作为测试强制门禁。

#### 影响面

- 文件：无。
- 调用方：本地开发流程。
- API 契约：不变。
- 前端行为：不变。
- 数据库结构：不变。

#### 验证方式

- `pnpm check` 通过；生产逻辑提交前手动 `pnpm test` 通过。
- CI 测试步骤保持存在。

#### 风险与回滚

- 改坏后果：本地漏跑测试导致 CI 失败，成本可接受。
- 回滚：无。

#### 预估工作量

0 人时（维持既有权衡）。

#### 前置依赖

无。

---

## 二、分批里程碑

### P0 立即修：安全输入边界（1.5–3 人时）

- 目标：消除 GitHub URL 拼接逃逸，并锁定 IP 源输入信任边界。
- 任务：H-1、M-7。
- 顺序：先补 H-1 URL 构造测试 → 修 helper → 再补 M-7 校验测试 → 修 IP 源输入。
- 出口标准（DoD）：
    1. `pnpm test -- test/github.test.ts test/api.test.ts` 通过。
    2. 非法 `owner` / `repo` / `path` / `fetch_strategy` / `github_path` 均有失败先行测试并通过。
    3. 合法含空格 path 被逐段编码，不再改变查询或片段语义。
    4. `pnpm check` 通过。
- 预估周期：0.5 个工作日内完成。

### P1 运行稳定性（7–13 人时）

- 目标：手动同步不双跑、探测不无限等待、日志可读。
- 任务：M-12 的手动同步 / probe 测试子集、M-8、M-9、M-2。
- 顺序：先补测试基线 → 实现任务锁 → 实现探测总超时 → 顺手翻译日志。
- 出口标准（DoD）：
    1. `pnpm test -- test/api.test.ts test/sync.test.ts` 通过。
    2. 并发第二个手动同步请求返回 409，任务完成后锁释放，陈旧锁可接管。
    3. probe 总耗时不超过定稿上限，超时有测试覆盖。
    4. 单条同步失败仍不中断整批，定时轮转仍正常。
    5. 本批触点的同步日志为中文，`pnpm check` 通过。
- 预估周期：1–2 个工作日。

### P2 测试补强（10–17 人时）

- 目标：补齐评估点名端点测试，建立覆盖率基线并设置保守阈值。
- 任务：M-12（完整）、M-13、L-9。
- 顺序：先 API 行为测试 → fetch 工具单测 → 跑覆盖率基线 → 设置阈值。
- 出口标准（DoD）：
    1. `pnpm test -- test/api.test.ts test/fetch.test.ts` 通过。
    2. IP 源 CRUD、probe、logout、手动同步端点均有直接行为测试。
    3. `pnpm test:coverage` 输出四项基线，阈值不高于基线且为非零。
    4. `pnpm check` 通过。
- 预估周期：2–3 个工作日。

### P3 结构性重构（17–32 人时）

- 目标：按项目架构评审收敛 settings、同步编排、行查询与 UI 长函数，不改变外部行为。
- 任务：M-4、M-5、M-6、M-3、M-1、L-8。
- 顺序：settings 词汇 → 行查询 → IP 源 CRUD helper → 同步编排 → UI 拆分与行为测试替换。
- 出口标准（DoD）：
    1. `pnpm test` 通过（先停本地 dev server）。
    2. `pnpm check` 通过。
    3. settings 白名单 / 脱敏 / null 语义测试全部通过，敏感字段不回传。
    4. 同步批处理失败隔离与轮转测试全部通过。
    5. UI 列表、SSE、设置保存人工验证不变。
    6. `renderDomainCard` / `renderIpSourceCard` / `renderStatus` 有直接行为测试。
- 预估周期：3–5 个工作日。

### P4 性能（9–20 人时）

- 目标：先实测、后优化，避免无依据加索引或扩大外部 API 调用。
- 任务：M-10、M-11、（M-8 中期分页另行立项，不并入本批）。
- 顺序：记录 records 请求数与耗时 → 记录 D1 行数与 `EXPLAIN QUERY PLAN` → 仅对确认瓶颈实施批量端点 / 索引。
- 出口标准（DoD）：
    1. 改前 / 改后基线数据保存在提交说明或 issue。
    2. 10 域名首屏 records 请求数下降为 1（若确认实施 M-10）。
    3. `EXPLAIN QUERY PLAN` 显示新索引被使用（若确认实施 M-11）。
    4. `pnpm test` 与 `pnpm check` 通过。
- 预估周期：2–4 个工作日，取决于实测结果。

### P5 顺手清理（触发式，0–5.5 人时）

- 目标：低危项只在触碰相关文件时修复，不做纯 churn。
- 任务：L-1、L-2、L-3、L-4、L-5、L-6、L-7、L-8、L-10、L-11、L-12。
- 触发原则：
    - L-8 只随 M-1 拆分执行，已在 P3 排入。
    - L-4 / L-5 随 API 输入与错误处理相关提交执行。
    - L-1 / L-2 / L-3 随文档或脚本触点执行。
    - L-6 / L-7 / L-10 / L-12 保持现状，不主动改。
    - L-11 若维护者接受 PR 噪音，可独立小提交执行。
- 出口标准（DoD）：
    1. 每个实际执行的低危项有独立提交与对应验证命令记录。
    2. 未执行项在任务看板保持「暂缓 / 触发式」状态。
    3. `pnpm check` 通过。
- 预估周期：随 P0–P4 触点完成，不单独排期；独立执行时合计 0.5–1 个工作日。

---

## 三、依赖关系

文本箭头含义：`A → B` 表示 B 被 A 阻塞，需先完成 A。

```
M-7 → M-3
M-12 → M-4
M-12 → M-8
M-12 → M-9
M-12 → M-13
M-12 → M-10
M-1 → L-8
M-8 → M-5
M-10 基线 → L-6（未来若优化鉴权缓存）
数据规模基线 → L-7（未来若实施分页）
```

补充说明：

- H-1、M-7、M-11、M-12、L-1、L-2、L-3、L-4、L-5、L-9、L-10、L-11、L-12 无前置任务卡。
- M-1 与 M-4、M-6 没有硬依赖，但建议在 M-12 后执行，用测试保护重构。
- M-10 建议等待 M-1 拆出 `apiFetch` / 渲染 helper 后再改前端，但这属于工程顺序建议，不是硬阻塞。
- L-6、L-7、L-10、L-12 的默认方案是保持现状，因此当前无人时消耗。

---

## 四、全局约束与工作流

### 项目红线

每一批执行前必须逐条确认：

1. 所有持久化访问继续使用唯一 D1 绑定 `env.WUYA`；不得引入第二个绑定名。
2. `wrangler.toml` 的 `database_id` 保持 `REPLACE_WITH_YOUR_D1_ID` 占位符；替换步骤只写在用户本地，不提交真实 ID。
3. 部署配置保持 `keep_vars = true`，不得删除 Dashboard 手配 Variables / Bindings。
4. 不提交任何 Secrets；不触碰已被忽略的 `.claude/`。
5. 调整表结构或索引时，只修改 `src/db/migrations.ts` 的 `expectedSchemas`，DDL 必须幂等；不得另建迁移真相源。
6. 批量同步时单条失败不得中断整批；重构 M-5 / M-8 时必须保留失败隔离测试。
7. 迁移保持 24h 门控，并继续清理超过 1h 的 `login_attempts`。
8. 定时同步轮转无论当前批成功或失败，都必须切换到下一类任务。
9. settings 写入继续遵守白名单；`null` 显式清除，空字符串不得误清已配置 Secret。
10. 密码哈希、Salt 与 Token 不得回传前端。
11. 不引入新依赖或构建工具；本计划所有方案均基于现有依赖。
12. 修改 `src/ui/templates.js` 或任何界面模板前，先读 `docs/ui-redesign.md` §11。
13. 代码注释、错误提示、日志与文档使用简体中文；技术术语首次出现按「英文原词（简体中文释义）」标注。

### 工作流

1. 每张任务卡先写失败测试（有明确测试方案的卡片），再改实现；纯文档或保持现状卡片除外。
2. 每个批次内按小提交切分：一个提交只解决一张任务卡或一个明确子步骤。
3. 提交信息使用简体中文，并在正文引用任务卡编号与验证结果。
4. 提交前执行 `pnpm check`；涉及生产逻辑时提交前另跑 `pnpm test`，并先停本地 dev server。
5. 实现完成先提交，再按固定范围评审；评审期间冻结改动。
6. 复审范围使用明确的 base 与 head hash：base 从 `git merge-base main HEAD` 获取，评审 diff 用 `git diff <base-hash>...<head-hash>`。
7. 长评审报告写入仓库文件或 issue，不在对话中大段粘贴。
8. 跨会话交接写 `docs/handoff/YYYYMMDD-HHMMSS-mmm-<主题>.md`，只写接手必需信息，不写口令、Token、真实 `database_id`、UUID 或邮箱。
9. 计划执行中出现评估外新问题时，先记录到「评估外补充发现」同类附录或 issue，不得默默扩大当前提交范围。

---

## 五、明确不做的事

1. 不引入新依赖或构建工具，包括并发控制库、分页库、日期库、测试 mock 库。
2. 不为低危项做纯 churn 改动；L-1 / L-2 / L-3 等只随相关文件触点执行。
3. 不在没有基线数据时给覆盖率设置非零阈值；必须先跑 `pnpm test:coverage`。
4. 不在没有 `EXPLAIN QUERY PLAN` 与行数基线时直接加 M-11 索引。
5. 不在没有首屏请求数 / 耗时基线时直接实现 M-10 批量端点。
6. 不顺手扩大重构范围：M-3 只收敛 IP 源 CRUD，M-4 只收敛 settings，M-5 只收敛批处理编排，M-6 只收敛行查询。
7. 不改变 settings 白名单、null / 空串语义与敏感字段脱敏行为。
8. 不移除或绕过批处理失败隔离、定时轮转、迁移门控与 `login_attempts` 清理。
9. 不把 `database_id` 占位符替换成真实值，不提交 Secrets。
10. 不把 `templates.js` 一次性重写成新框架；只做函数级拆分。
11. 不为 L-6 / L-7 / L-10 / L-12 增加新配置或工具；默认保持现状。
12. 不在全仓范围内批量改写存量英文日志或测试标题，只改本计划触点。

---

## 六、验收总表

| 任务编号 | 完成判据                                                                                                                                 | 验收人 / 方式                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| H-1      | `pnpm test -- test/github.test.ts` 通过；非法 owner / repo / path 与合法空格 path 用例通过；四处 URL 拼接均走统一 helper                 | 实现者自测 + 代码评审人检查 diff       |
| M-1      | `pnpm test -- test/templates-escape.test.ts test/ui.test.ts` 与 `pnpm check` 通过；`apiFetch` 与三个渲染函数已拆出；后台手工冒烟行为不变 | 实现者自测 + UI 评审人人工冒烟         |
| M-2      | 同步测试通过；本卡列出的 6 条日志为中文且语义等价                                                                                        | 实现者自测 + 日志抽查                  |
| M-3      | `pnpm test -- test/api.test.ts` 通过；新增 / 更新共用输入与持久化 helper，状态码与文案不变                                               | 实现者自测 + 代码评审人                |
| M-4      | settings 相关测试通过；白名单 / 脱敏 / 配对规则单一来源；敏感字段不回传                                                                  | 实现者自测 + 安全评审人                |
| M-5      | 批处理与轮转测试通过；第二项失败后第三项仍执行                                                                                           | 实现者自测 + 代码评审人                |
| M-6      | API / UI / 同步列表测试通过；行字段形状不变，列清单来自 DB 层单一来源                                                                    | 实现者自测 + 代码评审人                |
| M-7      | `pnpm test -- test/api.test.ts` 通过；非法策略、非法 path、超长 commit_message 均 400                                                    | 实现者自测 + 代码评审人                |
| M-8      | 并发手动同步第二个请求 409；任务完成释放锁；陈旧锁可接管；单条失败不中断                                                                 | 实现者自测 + 代码评审人 + 手工连点按钮 |
| M-9      | probe 总超时用例通过；坏 URL 在定稿上限内返回错误；SSRF 测试仍通过                                                                       | 实现者自测 + 代码评审人                |
| M-10     | 基线数据记录；若实施，10 域名首屏 records 请求数降为 1，单域名失败不影响其它卡片                                                         | 实现者自测 + 性能数据复核人            |
| M-11     | 改前 / 改后 `EXPLAIN QUERY PLAN` 与行数记录；若加索引，迁移测试通过且幂等                                                                | 实现者自测 + 数据库评审人              |
| M-12     | IP 源 CRUD、probe、logout、手动同步端点直接测试全部通过                                                                                  | 实现者自测 + 测试评审人                |
| M-13     | `pnpm test:coverage` 通过；阈值来自记录的基线且不为 0                                                                                    | 实现者自测 + CI 结果                   |
| L-1      | README 日期与测试文件数与当前仓库一致                                                                                                    | 维护者抽查                             |
| L-2      | `git grep -n "src/index.js" -- scripts` 无结果；构建脚本行为不变                                                                         | 实现者自测                             |
| L-3      | README 明确 `CF-Connecting-IP` 来源与本地 dev 限流行为                                                                                   | 维护者抽查                             |
| L-4      | 非法 `is_deep_resolve` 输入返回 400 或按定稿语义处理；合法输入行为不变                                                                   | 实现者自测 + 代码评审人                |
| L-5      | records 500 错误为固定中文文案且不包含上游 URL；日志保留 stack                                                                           | 实现者自测 + 安全评审人                |
| L-6      | 保持现状；无新增鉴权查询；现有测试通过                                                                                                   | 代码评审人确认 diff 无改动             |
| L-7      | 未达触发线时保持现状；若实施，250 条数据分页测试通过                                                                                     | 维护者基于规模数据决定                 |
| L-8      | 渲染函数行为测试直接断言转义输出；被替代的源码正则断言删除                                                                               | 实现者自测 + UI 评审人                 |
| L-9      | `pnpm test -- test/fetch.test.ts` 通过；重试矩阵与超时契约覆盖                                                                           | 实现者自测 + 测试评审人                |
| L-10     | 停 dev server 后 `pnpm test` 稳定通过                                                                                                    | 实现者执行并记录                       |
| L-11     | Dependabot 配置含 npm weekly 分组；后续周期生成分组 PR                                                                                   | 维护者观察 GitHub                      |
| L-12     | pre-commit 保持 `pnpm check`；CI 测试步骤存在                                                                                            | 维护者确认流程                         |

---

## 附录：评估外补充发现

核对源码时未发现必须先于 26 张任务卡修复的新问题，也没有某条修复会直接踩到 AGENTS.md 红线。需要注意两点执行前提，但不单列为新问题：

1. `vitest.config.ts:29` 的 coverage `exclude` 排除了 `src/ui/**` 与 `src/index.js`；M-1 / L-8 的 UI 重构不会被覆盖率阈值保护，必须依赖行为测试与人工冒烟。
2. M-11 若新增索引，必须同步检查 `test/migrations.test.ts` 对 `expectedSchemas` 的断言；只改 SQL 不改 `expectedSchemas` 会违反项目结构真相源规则。
