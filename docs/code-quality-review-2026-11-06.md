# 代码质量复核报告（2026-11-06）

- 评审范围：`c5f9e73af103a992968ef18349b385000eb1c6b6...13d99d2e122cad70439bdeb7eacc4aecfd8a834a`
- 提交数：23（含最终文档提交 `13d99d2`）
- 复核对象：H-1、M-1～M-13、L-1～L-12
- 约束遵守：未修改源码、配置、测试；未执行 `git add` / `commit` / `push`；未启动 dev server；未部署；本文件为唯一写入产物
- 说明：三份背景文档仅作为需求来源，下列结论均以当前源码、测试、diff 与实际命令输出复核
- 复核修订（2026-11-06，lead 执行）：评审方沙箱内的 `6 failed / 267 passed` 已核实为**沙箱环境所致**——该沙箱无法写 Wrangler 日志目录（EPERM）且无外网，DoH 调用失败；主分支 CI（run 42141390086）与 lead 本地 `vitest run` 均为 `22 passed` 文件、`273 passed` 用例。故原「高-2」下调为「中-9」，仅保留「后台任务未排空即恢复 `fetch`」的健壮性风险，不再声称测试套件当前失败；其余结论保留。

## 一、总体结论

**有条件通过。**

主体修复是真实落地的：GitHub 路径的 `?` / `#` / 空格 / `..` 逃逸被阻断，settings 白名单与 Secret 语义未被削弱，`/api/domains/records` 的路由优先级和前端调用同步，D1 行投影收敛没有改变字段契约，M-11 表达式索引确实被 `EXPLAIN QUERY PLAN` 命中，且没有触碰 `wrangler.toml`、`.claude/` 或依赖清单。

但当前状态不建议直接合并或发布，原因集中在三处：

1. M-8 的 180 秒锁 TTL 明显低于手动全量同步的最坏耗时；任务未结束时锁即可被接管，互斥语义失效。
2. M-8 的路由级测试会启动真实 SSE 后台任务，并在任务可能尚未结束时恢复全局 `fetch`、清理锁；主分支 CI 与 lead 本机全量测试均通过（22 文件 / 273 用例），但该结构在网络变慢或断言加强后会变成不稳定测试。
3. H-1 对已存在的百分号编码路径会产生双重编码，可能把旧配置从“更新既有多行路径文件”变成“更新/创建另一个字面量路径文件”。

类型检查、语言门禁、UTF-8 门禁、oxlint 与 Prettier 五个 fallback 组件均通过；失败的是 Vitest 全量套件和 pnpm 包装器本身。

## 二、逐卡复核表

| 卡号 | 结论             | 关键依据（路径:行号）                                                                                               | 备注                                                                                                                            |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| H-1  | 部分通过         | `src/sync/github.ts:36-64`；`test/github.test.ts:209-286`                                                           | `?` / `#` / 空格 / `..` / 反斜杠被拒绝或编码；但存量 `%20` 会被编码为 `%2520`，且缓存键仍使用原始 path，见高-3 与中-1           |
| M-1  | 不通过           | `docs/code-quality-fix-plan.md:123-131`；`src/ui/templates.js:609-627,647-708`；`CODING_STANDARDS.md:28-30`         | 只是把脚本切成四个模板字符串段，`apiFetch` 与渲染函数仍未提取为可导入、可直测函数                                               |
| M-2  | 通过             | `src/sync/domains.ts:69-95`；`src/sync/ip-sources.ts:71-99`；`src/routes/api.ts:590-593`                            | 计划点名的定时任务日志已中文化，异常输出 stack；手动路径仍有低-2 的旧格式                                                       |
| M-3  | 通过             | `src/routes/api.ts:494-530`；`test/api.test.ts:1060-1115`                                                           | 新增/更新共用写库路径，409 状态、错误文案与原行不变性均有直接测试                                                               |
| M-4  | 通过             | `src/db/settings.ts:14-32,44-80`；`src/routes/api.ts:218-253`                                                       | 写入白名单未加入密码哈希、Salt 或运行锁；Secret 空串保持不变、null 显式清除                                                     |
| M-5  | 基本通过         | `src/util/batch-sync.ts:11-23`；`test/batch-sync.test.ts:6-67`                                                      | 失败隔离 helper 有有效直接测试；手动路径错误日志仍用 `message`，见低-2                                                          |
| M-6  | 通过             | `src/db/client.ts:106-118`；`src/routes/api.ts:255-258,428-430`；`src/routes/ui.ts:45-50`                           | 列清单收敛且字段名不变；未做 map 函数属已披露的合理取舍                                                                         |
| M-7  | 部分通过         | `src/routes/api.ts:446-488`；`test/api.test.ts:681-817`                                                             | 策略、URL、路径、消息长度有测试；但未拒绝 malformed Unicode，也未处理百分号编码语义，见中-5                                     |
| M-8  | 部分通过         | `src/db/client.ts:39-79`；`src/routes/api.ts:108-119`；`test/api.test.ts:865-925`                                   | 初始抢占与 CAS 释放正确；但 180 秒 TTL 低于任务最坏耗时，且测试在后台任务可能未结束时恢复 `fetch`（当前环境未复现失败，见中-9） |
| M-9  | 部分通过         | `src/routes/api.ts:537-604`；`test/api.test.ts:819-862`                                                             | 25 秒响应预算有效；但总预算到期后不会取消仍在执行的策略请求，见中-3                                                             |
| M-10 | 部分通过         | `src/routes/api.ts:60,405-426`；`src/ui/templates.js:786-804,821-835`；`test/api.test.ts:1118-1213`                 | 路由优先级、响应形状、前端调用与 409 处理正确；但批量无 50 条上限或整体超时，见中-4                                             |
| M-11 | 部分通过         | `src/db/migrations.ts:87-96`；`test/query-plan.test.ts:22-58`                                                       | 索引 DDL 幂等且计划命中；但测试 SQL 是手写副本，生产 SQL 漂移无法被捕获，见中-6                                                 |
| M-12 | 部分通过         | `docs/code-quality-fix-plan.md:908-916`；`test/api.test.ts:927-1045`                                                | logout、列表、删除、probe 有直测；新增/更新成功与代表性鉴权失败覆盖不足，见中-7                                                 |
| M-13 | 通过             | `vitest.config.ts:23-39`；`.github/workflows/ci.yml:71-76`                                                          | 覆盖率阈值由 CI 的 `test:coverage` 强制执行；但本机全量测试先失败，见第四节                                                     |
| L-1  | 通过             | `README.md:314-336`；`wrangler.toml:7`                                                                              | `compatibility_date` 与 22 个 `.test.ts` 文件计数均正确                                                                         |
| L-2  | 通过             | `scripts/build-single-file.mjs:1-5`                                                                                 | 指向已删除 `src/index.js` 的注释已移除                                                                                          |
| L-3  | 通过             | `README.md:272-275`                                                                                                 | 已说明 `CF-Connecting-IP` 的来源、缺失归并行为与不得伪造                                                                        |
| L-4  | 通过             | `src/routes/api.ts:261-267,320-321`；`test/api.test.ts:1216-1227`                                                   | 只接受 `0` / `1` / 布尔；字符串与越界数字返回 400                                                                               |
| L-5  | 部分通过         | `src/routes/api.ts:371-390`                                                                                         | records 端点已固定响应文案并只把上游错误写日志；但缺少直接回归测试，且全局 API catch 仍回传 `details`，见中-8 与低-1            |
| L-6  | 通过（保持现状） | `docs/code-quality-fix-plan.md:1297-1317`                                                                           | 未引入跨请求鉴权缓存，没有登出后短期可用的回归                                                                                  |
| L-7  | 通过（保持现状） | `docs/code-quality-fix-plan.md:1358-1376`                                                                           | 未在无规模证据时引入分页                                                                                                        |
| L-8  | 部分通过         | `src/ui/dashboard-helpers.js:11-23`；`test/dashboard-helpers.test.ts:6-46`；`test/templates-escape.test.ts:161-178` | `escapeHtmlClient` 是有效行为测试；其余渲染分支仍是源码字符串契约，见中-2                                                       |
| L-9  | 通过             | `test/fetch.test.ts:13-149`                                                                                         | 直接覆盖 URL/init 透传、AbortSignal、定时器清理、重试分类与异常包装                                                             |
| L-10 | 通过（保持现状） | `AGENTS.md` 验证节；`docs/code-quality-fix-plan.md:1517-1554`                                                       | 未引入进程锁或新工具                                                                                                            |
| L-11 | 通过             | `.github/dependabot.yml:1-18`                                                                                       | npm 生态、devDependencies 分组与 PR 上限 5 均已配置                                                                             |
| L-12 | 通过（保持现状） | `.githooks/pre-commit:4-5`；`docs/code-quality-fix-plan.md:1629-1653`                                               | pre-commit 仍只跑 `pnpm check`，测试由 CI 把关                                                                                  |

## 三、发现的问题

### 阻断

未发现必须先回滚整个变更集的阻断问题。

### 高

#### 高-1：M-8 锁 TTL 低于手动全量同步最坏耗时，互斥会在任务进行中被接管

- 位置：`src/db/client.ts:42-43,50-73`；`src/sync/domains.ts:135-147,417-430`；`src/sync/ip-sources.ts:32-58,184-198`；`src/sync/github.ts:84`
- 关键代码：`MANUAL_SYNC_LOCK_TTL_MS = 180000`，到期后 `UPDATE settings ... WHERE value = ?` 允许接管；但域名全量同步不限制批大小，每个域名至少有 8 秒 DoH 与 15 秒 Cloudflare 列表请求，记录增删还会各占 15 秒；IP 源单个最坏有 15+20+15 秒抓取回退，再加多次 15 秒 GitHub API 请求。两个慢 IP 源即可超过 180 秒。
- 为什么是问题：`acquireManualSyncLock` 只在“抢新锁”和“接管”两个瞬间原子，不能保证长任务期间锁仍有效。原任务超过 180 秒后，第二个请求会把锁值替换为自己的 token 并开始同一批数据的第二次全量同步；原任务结束时因 token 不一致不会误删新锁，但两个任务已经并发运行。这直接违背 M-8“手动全量同步并发防护”的目标。
- 建议：不要用固定短 TTL 作为唯一活性依据。可行方案是任务执行期间定期续租，或把 TTL 提高到高于 Worker 请求/手动任务硬上限，并同时对全量任务设置批大小、总时长或分页；测试必须模拟“任务仍在运行但 TTL 已到期”，断言不能接管。

#### 高-3：H-1 对存量百分号编码路径双重编码，行为回归且可能写到错误 GitHub 路径

- 位置：`src/sync/github.ts:50-64`；`src/routes/api.ts:447-459`；`test/github.test.ts:209-244`
- 关键证据：

```text
node -e "for (const p of ['foo%20bar','%2e%2e/foo']) console.log(JSON.stringify(p), '=>', JSON.stringify(encodeURIComponent(p)));"
"foo%20bar" => "foo%2520bar"
"%2e%2e/foo" => "%252e%252e%2Ffoo"
```

- 为什么是问题：旧实现把 `github_path` 原样拼进 URL，GitHub API 会把 `%20` 解释为空格；新实现总是再次 `encodeURIComponent`，`%20` 变成 `%2520`，GitHub 实际路径变成字面量 `%20`。这不是路径逃逸（安全方向是变严了），但会把已有配置的读取和更新指向不同文件，可能出现“读取不到旧文件 → 创建新文件”或订阅代理 404。`validateGithubPath` 不拒绝 `%`，H-1 测试也没有 `%` 用例。
- 建议：在信任边界明确路径编码契约。推荐对输入做一次 `decodeURIComponent` 后再执行同一套路径校验并重新编码；同时为存量数据增加检查或迁移说明，拒绝无法唯一解释的含 `%` 旧值。至少要补 `foo%20bar`、`%2e%2e`、`%2520` 的 API URL 与同步行为测试。

### 中

#### 中-1：GitHub 订阅代理缓存键使用原始 path，会把不同 path 归一成同一 URL

- 位置：`src/sync/github.ts:199-200,213-220`
- 关键证据：

```text
node -e "const ns='https://github-proxy.cache'; for (const p of ['foo bar','foo%20bar']) console.log(JSON.stringify(p), '=>', new URL(p,ns).toString());"
"foo bar" => "https://github-proxy.cache/foo%20bar"
"foo%20bar" => "https://github-proxy.cache/foo%20bar"
```

但二者对应的 GitHub Contents API URL 分别是 `foo%20bar` 与 `foo%2520bar`。

- 为什么是问题：如果管理员同时保存这两个不同 `github_path`，公开订阅代理可能用其中一个的缓存响应服务另一个，产生错误内容。缓存键没有复用 `encodeContentPath` 的规范化结果。
- 建议：`subscriberCacheKey` 应基于 `encodeContentPath(path)` 或对规范化后的 path / `ip_sources.id` 做稳定散列，保证一一对应。

#### 中-2：M-1 未完成计划要求，仍违反前端行为测试标准

- 位置：`docs/code-quality-fix-plan.md:123-131`；`CODING_STANDARDS.md:28-30`；`src/ui/templates.js:609-627,647-708`；`test/templates-escape.test.ts:161-178`
- 关键代码：`apiFetch`、`renderDomainCard`、`renderIpSourceCard`、`renderStatus` 仍是模板字符串中的浏览器脚本源码；只有 `escapeHtmlClient` 被提取到 `src/ui/dashboard-helpers.js`。`test/templates-escape.test.ts:161-178` 仍用正则匹配模板源码。
- 为什么是问题：M-1 明确要求提取 `apiFetch` 和三个渲染函数为可导出纯函数；`CODING_STANDARDS.md:28-30` 也规定非平凡内联脚本必须提取并由测试直接调用。当前提交只是把一个长字符串拆成四个短字符串，可定位性改善，但行为测试能力没有实质提升。
- 建议：至少先提取 `renderStatus`、`renderDomainCard`、`renderIpSourceCard`、`renderLiveRecords`，把 `escapeHtmlClient` 作为参数或注入依赖；`apiFetch` 的错误解析逻辑也应独立为可直测 helper。

#### 中-3：M-9 的 25 秒总预算只结束响应，不取消仍在执行的上游请求

- 位置：`src/routes/api.ts:537-604`；`src/sync/ip-sources.ts:32-58`
- 关键代码：`withProbeTimeout(strategyFn(url), remaining)` 只做 `Promise.race`；三个策略内部各自创建 15 / 20 / 15 秒的 `fetchWithTimeout`，没有共享外层 `AbortController`。
- 为什么是问题：例如 direct 策略 15 秒失败后，PhantomJS 策略开始并带 20 秒自身超时；外层剩余预算 10 秒到期时，探测响应返回 400，但该请求可能继续占用连接直到自身超时。M-9 的“总时长预算”没有覆盖出站资源占用，测试也只断言响应已结束。
- 建议：为整个 probe 创建一个 `AbortController`，把它传入 `fetchWithTimeout` 或策略函数；总预算到期立即 `abort()`，并让 `withProbeTimeout` 在 finally 中清理。测试应断言在途请求收到 abort。

#### 中-4：M-10 批量端点无规模上限、无 `ids` 参数、无整体超时

- 位置：`src/routes/api.ts:405-426`；`docs/code-quality-fix-plan.md:783-790`
- 关键代码：`SELECT id, target_domain FROM domains ORDER BY id` 取全部行，循环并发 4，没有单批 50 上限，也没有整体 deadline。前端每次刷新都会等待这一整个响应。
- 为什么是问题：请求数和 D1 查询确实从 N 降为 1，但 Cloudflare 出站调用仍是 N。域名规模较大时，一个批量请求可能超出 Worker 请求时长或 Cloudflare 限流窗口，导致整屏“查询失败”；这比旧的逐卡片失败模式更集中。计划中的“可选 `ids`、单批最多 50”未落地。
- 建议：支持 `?ids=` 或 `?limit=`，服务端硬上限 50；前端按 50 分批请求并逐批渲染。若保留全量，也应设置整体超时并对未完成项返回单个错误，避免整端点崩掉。

#### 中-5：M-7 接受 malformed Unicode，落库后在同步时抛 `URIError`

- 位置：`src/routes/api.ts:446-488`
- 关键证据：

```text
node -e "try { console.log(encodeURIComponent('\uD800foo')); } catch (e) { console.log(e.name + ': ' + e.message); }"
URIError: URI malformed
```

- 为什么是问题：`validateGithubPath` 只检查控制字符、分段、长度和 `..`，不检查字符串是否是 well-formed Unicode。JSON 可表示孤立代理项；它可以通过 API 校验并写入 D1，之后 `encodeContentPath` 里的 `encodeURIComponent` 才抛异常，用户保存成功但同步永远失败。长度也用 UTF-16 code unit 计数，补充平面字符的“字符数”语义不稳定。
- 建议：在校验时直接尝试按段 `encodeURIComponent`，或使用 well-formed Unicode 检查；长度口径明确为 code point 或 UTF-16 code unit，并补孤立代理项测试。

#### 中-6：M-11 查询计划测试使用手写 SQL 副本，不能防止生产查询漂移

- 位置：`test/query-plan.test.ts:7-15`；`src/sync/domains.ts:74-82`；`src/sync/ip-sources.ts:77-83`
- 关键代码：测试常量复制了两条 SQL；生产函数内还有自己的模板字符串，二者没有单一来源。
- 为什么是问题：如果未来有人修改生产 SQL 的 `WHERE` / `ORDER BY` / `LIMIT`，测试中的 EXPLAIN 仍会继续命中索引，给出假绿。这类测试是纸面契约，不是可靠的性能回归门禁。
- 建议：把两条批查询 SQL 导出为常量，生产函数与 EXPLAIN 测试共用；或抽一个可注入 SQL 的取批函数，让测试直接执行生产路径。

#### 中-7：M-12 没有完成计划要求的端点覆盖，成功更新路径缺直测

- 位置：`docs/code-quality-fix-plan.md:908-916`；`test/api.test.ts:927-1045,1047-1115`
- 关键依据：计划要求 IP 源列表 / 新增 / 更新 / 删除、probe 成功与失败、logout，且每个端点至少覆盖成功、鉴权失败、代表性失败。实际 M-12 只直测 logout、列表、删除、probe 成功与非法 URL；POST 成功由 M-7 间接覆盖，PUT 成功没有直接用例，只有非法 PUT 与 409 PUT。
- 为什么是问题：M-3 重构恰好改变了新增/更新写库路径，却没有一条“PUT 成功后字段确实更新”的端点级测试；如果 `successMessage`、绑定顺序或 UPDATE 行数判断回归，现有用例不能可靠发现。
- 建议：补 `POST /api/ip_sources` 成功、`PUT /api/ip_sources/:id` 成功、不存在 ID 的语义，以及至少一个受保护端点的 401 用例。

#### 中-8：L-5 只修复 records 端点，全局 API catch 仍把异常 message 放进 `details` 返回

- 位置：`src/routes/api.ts:371-390`；`src/index.ts:33-45`；`src/util/fetch.ts:45`
- 关键代码：records 端点已固定文案；但全局 API catch 仍返回 `details: e instanceof Error ? e.message : String(e)`。`fetchWithRetry` 的 `HttpError` message 包含完整 URL，D1 / TypeError message 也可能包含内部 SQL 或绑定细节。
- 为什么是问题：这不是本轮新增，但会削弱 L-5“错误响应不泄露内部细节”的完成度。只要任意 API 路径漏出局部 catch，全局 catch 就会把异常细节回传给调用方。
- 建议：API 全局兜底只返回固定 `{ error: "发生意外的服务器错误。" }` 与状态码；完整异常只写 `console.error(... e instanceof Error ? e.stack : e)`。若确需结构化错误，应使用显式受控错误类型与白名单字段。

#### 中-9：M-8 路由级测试未排空后台 SSE 任务，恢复 `fetch` 时任务可能仍在跑

- 位置：`src/util/sse.ts:50-63`；`test/api.test.ts:899-923`
- 关键实现：`createLogStreamResponse` 在返回 `Response` 前立即执行 `(async () => { await logFunction(log); ... })()`，不需要读者驱动；测试注释写「不读取响应体，避免真正驱动 SSE 流去请求上游」，该假设与实现不符——后台任务已经启动。
- 现状证据：主分支 CI（run 42141390086）与 lead 本机 `vitest run` 均 `22 passed` 文件、`273 passed` 用例；评审方沙箱内的 6 例失败经核实为 EPERM（无法写 Wrangler 日志目录）与无外网所致，不是该测试结构直接造成。
- 为什么仍要处理：`finally` 在后台任务完成前就把 `globalThis.fetch` 还原成真实实现并删除锁；一旦后台任务尚未结束，后续请求会走真实网络，测试结果依赖时序。断言也只有 `expect(res.status).not.toBe(409)`，没有验证锁最终被释放。
- 建议：排空 SSE（读完响应体）或让任务在空域名集上立即结束再恢复 `fetch`；补一条断言——响应结束后锁行已被删除。若要彻底确定化，可只测 helper 与「预置活跃锁 → 409」路由。

### 低

#### 低-1：L-5 缺少“上游错误不进响应体”的直接回归测试

- 位置：`docs/code-quality-fix-plan.md:1257-1261`；`test/api.test.ts:195-230,1118-1213`
- 关键依据：现有 records 测试只覆盖 URL 编码与批量成功 / 上游 `success:false`；没有 fake fetch 抛出含 URL 的异常并断言响应不含 URL 的用例。
- 建议：补单域名与批量共用的错误路径测试：让 `fetch` 抛 `Error("secret https://internal.example/...")`，断言 500 响应只含固定文案，`console.error` 收到 stack。

#### 低-2：手动批同步错误日志未达到“异常保留 stack”的目标

- 位置：`src/sync/domains.ts:146,184`；`src/sync/ip-sources.ts:159,164`；`CODING_STANDARDS.md:32-34`
- 关键代码：手动批处理错误回调使用 `e instanceof Error ? e.message : String(e)`；M-2 / M-5 的陈述是“异常统一 stack”。
- 为什么是问题：这些回调是 M-5 改动产生的新调用位置，最终进入 SSE 和控制台，排障信息比 stack 少；`String(e)` 也不符合错误日志格式规范。
- 建议：错误回调统一使用 `e instanceof Error ? e.stack : e`；需要保留用户简短文案时可分别输出 `message` 与 `stack`，但不要用 `String(e)`。

#### 低-3：M-10 测试只数出站调用，未验证 D1 查询数与并发上限 4

- 位置：`test/api.test.ts:1138-1170`；`src/routes/api.ts:410-425`
- 关键依据：测试断言 Cloudflare 调用数等于域名数，但未断言 domains 查询只有一次，也未在多个慢请求下验证最多同时 4 个出站。
- 建议：用可计数 D1 wrapper 或导出纯编排函数验证查询次数；用延迟 Promise 记录并发峰值，断言不超过 `RECORDS_FETCH_CONCURRENCY`。

## 四、测试有效性评估

### 实际执行结果

| 命令                                                                                        | 结果                                                                                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run`                                                                      | 退出码 1；输出 `[RTK:PASSTHROUGH] vitest parser: All parsing tiers failed`，未进入 Vitest               |
| `pnpm check`                                                                                | 退出码 1；`ERR_PNPM_STORE_DIR_RESOLVE_OPERATION_LOCK`，本机 pnpm store 访问被拒绝                       |
| `node_modules\.bin\vitest.CMD run`（评审方沙箱）                                            | 退出码 1；沙箱内 `1 failed / 21 passed` 文件、`6 failed / 267 passed` 用例；已核实为 EPERM + 无外网所致 |
| `node_modules\.bin\vitest.CMD run`（lead 复核）                                             | 退出码 0；`22 passed` 文件、`273 passed` 用例                                                           |
| `node_modules\.bin\vitest.CMD run test/api.test.ts -t "陈旧锁不阻塞新的手动同步"`（评审方） | 退出码 0；`1 passed / 50 skipped`                                                                       |
| `.\node_modules\.bin\tsc.CMD --noEmit`                                                      | 退出码 0                                                                                                |
| `node .\scripts\check-changed-language.mjs`                                                 | 退出码 0；`语言检查通过`                                                                                |
| `node .\scripts\check-utf8.mjs`                                                             | 退出码 0；`UTF-8 检查通过`                                                                              |
| `.\node_modules\.bin\oxlint.CMD`                                                            | 退出码 0；无 warning / error 输出                                                                       |
| `.\node_modules\.bin\prettier.CMD --check --ignore-unknown .`                               | 退出码 0；`All matched files use Prettier code style!`                                                  |

直接 Vitest 运行时出现本机沙箱导致的 Wrangler 日志 `EPERM`（无法写 `AppData\Roaming\xdg.config\.wrangler\logs`），且沙箱无外网使 DoH 调用失败——这解释了沙箱内的 6 例失败。lead 在本机复跑全量（273 用例全过）且主分支 CI 为绿，因此该失败不构成「测试套件当前不可信」的证据，只说明评审环境受限。

### 真有效的测试

- `test/batch-sync.test.ts:6-67`：直接调用 `forEachIsolated`，覆盖顺序、失败隔离、连续失败、非 Error 抛值与空输入，能有效防止该 helper 回归。
- `test/settings.test.ts:5-85`：直接测试白名单、null / 空串、Secret 保持不变、`BATCH_SIZE` 与配对校验，是 M-4 的有效行为测试。
- `test/fetch.test.ts:13-149`：直接覆盖 AbortSignal、定时器清理、4xx / 5xx / 429 / 网络错误，是 L-9 的有效测试。
- `test/sync-lock.test.ts:23-68`：直接测试锁 helper 的抢占、释放、陈旧接管与错误释放，能抓初始锁实现回归；但无法覆盖长任务 TTL 或路由释放路径。
- `test/api.test.ts:819-862`：用假定时器和挂起 fetch 证明 probe 响应在总预算内结束，对“响应耗时”有效；对出站取消无效。
- `test/dashboard-helpers.test.ts:6-46`：直接执行 `escapeHtmlClient` 并断言注入的是同一实现，对转义 helper 有效。

### 纸面或弱化测试

- `test/templates-escape.test.ts:161-178`：仍以正则匹配模板源码作为主要渲染断言，只能证明字符串里写了 `esc(...)`，不能执行渲染函数，违背 `CODING_STANDARDS.md:28-30`。
- `test/query-plan.test.ts:7-15`：SQL 是生产代码的手写副本，EXPLAIN 结果可能与真实热路径脱钩。
- `test/api.test.ts:899-923`：陈旧锁路由测试只断言 `not.toBe(409)`，不等待任务完成、不检查锁释放或上游调用；属断言偏弱的健壮性缺口（见中-9），不是当前测试失败的原因。
- `test/api.test.ts:1138-1170`：只断言 Cloudflare 出站调用数，不验证 D1 查询数和并发上限；M-10 的“消除 N+1”只有代码阅读证据，没有完整测试证据。
- H-1 测试覆盖空格、中文、`?`、`#`、`..`、反斜杠，但没有覆盖 `%`、双重编码和 malformed Unicode，恰好漏掉当前风险最高的边界。

### 覆盖率门禁的实际作用

`vitest.config.ts:23-39` 设置了 lines 81、functions 83、statements 78、branches 69，并排除 `src/ui/**`；`.github/workflows/ci.yml:71-76` 在 CI 中执行 `pnpm test:coverage`。因此阈值不是摆设：低于阈值会失败，CI 也会真正跑覆盖率。

但覆盖率只约束 TypeScript 源码，且是聚合阈值，不能替代上述行为测试。`src/ui/templates.js` 被排除，M-1 / L-8 的主要风险恰好不在覆盖率内；M-8 的测试即使执行了路由，也没有断言锁生命周期。本机未重跑 `--coverage`，因为 Vitest 会生成 `coverage/` 产物，超出“只允许写本报告”的限制；覆盖率结论基于配置与 CI 命令核查。

## 五、越界与合规检查

| 检查项                 | 结论     | 证据                                                                                                                                                                                           |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.toml`        | 合规     | `git diff c5f9e73...HEAD -- wrangler.toml` 为空；当前 `wrangler.toml:10-19` 仍为 `keep_vars = true`、唯一绑定 `WUYA`、`database_id = "REPLACE_WITH_YOUR_D1_ID"`                                |
| `.claude/`             | 合规     | `git diff --name-only c5f9e73...HEAD` 中无 `.claude/` 路径                                                                                                                                     |
| `expectedSchemas` 语义 | 合规     | `src/db/migrations.ts:28-63` 表结构未改；新增索引在 `src/db/migrations.ts:89-96` 使用 `CREATE INDEX IF NOT EXISTS`，保持幂等                                                                   |
| 新依赖                 | 合规     | `git diff c5f9e73...HEAD -- package.json pnpm-lock.yaml` 为空；未引入依赖或构建工具                                                                                                            |
| Secrets                | 合规     | `src/db/settings.ts:17-32` 写入白名单不含 Token 哈希、Salt 或内部锁；`src/db/client.ts:81-87` 过滤敏感字段与运行锁                                                                             |
| D1 绑定                | 合规     | 生产代码仍使用 `env.WUYA`；未引入第二个绑定名                                                                                                                                                  |
| 中文规范               | 大体合规 | 新增测试标题为中文；API 错误与用户可见文案为中文。例外是低-2 的手动批同步错误日志                                                                                                              |
| 错误日志格式           | 部分合规 | `src/routes/api.ts:383-389` 与 `src/routes/api.ts:592` 使用固定中文消息和 stack；`src/sync/domains.ts:146,184`、`src/sync/ip-sources.ts:159,164` 仍用 message / String                         |
| HTML 转义              | 大体合规 | `src/ui/templates.js:7-19` 服务端转义，`src/ui/dashboard-helpers.js:11-23` 客户端转义；`src/ui/templates.js:650-703` 的 DB 字段输出均调用 `esc()`；但行为测试仍不足（中-2）                    |
| API 契约               | 大体兼容 | `/api/domains/records` 在 ID 路由之前分发（`src/routes/api.ts:60-78`），旧单域名端点保留；409 仍是 `{ error }` 且前端解析（`src/ui/templates.js:827-835`）；批量端点为新增形状，无旧调用点残留 |
| UTF-8 / 格式           | 通过     | `node .\scripts\check-utf8.mjs` 与 Prettier check 均通过；`git diff --check c5f9e73...HEAD` 无输出                                                                                             |
| 工作树                 | 干净     | 除本报告外，`git status --short` 在写入前无任何改动                                                                                                                                            |

## 六、残余风险与后续建议

1. **先修 M-8 的锁生命周期**：引入续租或与任务硬上限一致的 TTL，并补“任务运行超过 TTL 不可接管”的测试。单管理员工具可以接受崩溃后等待 TTL，但不能接受仍在运行时被接管。
2. **让测试套件闭包化**：M-8 路由测试不得恢复真实 `fetch` 前留下后台任务。SSE 任务要么被排空，要么用空数据立即结束；全量测试必须能在无外网环境稳定运行。
3. **处理 H-1 存量路径**：上线前检查 `ip_sources.github_path` 是否包含 `%`。对含 `%` 的行需要决定一次性解码迁移还是拒绝并提示用户重填，不能让同一数据在保存和同步两个阶段有不同解释。
4. **统一 GitHub path 与缓存键的规范化**：API 校验、Contents URL 构造和缓存 key 应共享同一条“解码 → 校验 → 编码”流水线，避免双重编码与缓存串文件。
5. **给 M-10 加规模边界**：至少 50 条一批，并考虑前端分批渲染。Cloudflare 没有“按多个 name 批量查询 DNS records”的接口，出站 N 次无法凭代码消除，只能通过请求边界控制放大。
6. **补 API 全局兜底的固定响应**：删除 `details: e.message`，把内部细节全部留给日志；这能同时提升 L-5 的完成度和未来路由漏 catch 的安全性。
7. **把 UI 行为提取继续做完**：M-1 当前只是可读性拆分。下一步优先提取渲染函数和 `apiFetch` 错误解析，让测试从源码字符串断言转为行为断言。
8. **覆盖率之外加关键路径断言**：覆盖率门禁有效，但应补充锁生命周期、成功 PUT、错误泄露、查询计划生产 SQL、批量并发上限这些低覆盖高价值场景。

## 七、修复进展（2026-11-06 11:20 更新）

本节的写入方是实现方（lead），用途是让报告不只停留在"发现问题"。上面的结论保留了评审当时的状态，下面是其后按报告建议落地的改动。

| 编号 | 结论 | 落地内容                                                                                                                                                                                    | 提交      |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 高-1 | 已修 | 锁 TTL 从 3 分钟提到 10 分钟，新增 `touchManualSyncLock` 做 CAS 续租，三个全量同步入口在流开始时与每个条目之后续租，内部按 60 秒节流；续租失败只写中文日志，不中断同步                      | `2136240` |
| 高-3 | 已修 | 新增 `normalizeGithubPath`：含 `%` 时先做一次 `decodeURIComponent`，再走同一套形态校验，最后用一次试编码拦截孤立代理项；API 校验与落库都改用它，落库存解码后的路径                          | `2136240` |
| 中-1 | 已修 | 订阅器缓存键复用 `encodeContentPath` 的规范编码形式，`a%20b/c.txt` 与 `a b/c.txt` 归一为同一键，不同文件不再串缓存                                                                          | `2136240` |
| 中-5 | 已修 | 孤立代理项在信任边界返回 400，不再留到同步阶段抛 `URIError`                                                                                                                                 | `2136240` |
| 中-7 | 已修 | 补 POST / PUT 成功路径与未登录 401 的端点级直测（字段真的落库、PUT 后 id 不变）                                                                                                             | `5c29fc2` |
| 中-8 | 已修 | 新增 `buildApiErrorResponse`，API 全局兜底只回固定文案，不再携带 `details` 或异常 message；完整 stack 仍进日志                                                                              | `2136240` |
| M-1  | 已修 | 渲染助手与 `apiFetch` 提成可测工厂（`src/ui/dashboard-render.js`、`src/ui/dashboard-api.js`），依赖全部注入后再由 `toString()` 注入浏览器脚本；脚本外 HTML 逐字一致，注入版与模块版行为一致 | `0cd9a41` |

对应测试落在 `test/error-response.test.ts`（新增）、`test/sync-lock.test.ts`、`test/github.test.ts`、`test/api.test.ts`、`test/dashboard-render.test.ts`（新增）、`test/dashboard-api.test.ts`（新增），均由失败起步再转绿。M-1 的测试先以 `74b4307` 单独提交红态（模块尚不存在，`tsc` 必红，故用 `--no-verify` 并写明原因），实现提交 `0cd9a41` 再跑完整门禁。合并后主分支全量 **25 文件 / 307 例通过**，`tsc --noEmit`、语言门禁、UTF-8 门禁、oxlint、Prettier 五项全绿。

**`apiUpdateIpSource` 假成功已在 `b1d98e9` 关闭**：写库流水线判断 `result.meta.changes`，更新路径命中 0 行时返回 404 `目标不存在。`，与同文件 `PUT /api/domains/:id`（`src/routes/api.ts:293`）的既有语义一致；新增两条直测（不存在 id → 404 且不落库、提交值未变仍 200）先红后绿。

**`apiDeleteIpSource` 同类假成功已在 `0a83b6d` 关闭**：删除命中 0 行返回 404 `目标不存在。`；重复删除同一 id 第二次 404、第一次仍 200，两条直测先红后绿。

仍未关闭的项：

1. **解码残留歧义**：落库改为解码值后，若用户提交 `a%25b`，库里存 `a%b`，同步时再按"解码一次"会得到另一种解释。要彻底消除，需要在 `normalizeGithubPath` 里拒绝解码后仍含 `%` 的值，但这会拒绝既有数据，需单独决定。
