# 代码质量评估——修复落地报告

> 对应评估：`docs/code-quality-assessment.md`（26 项：0 阻断 / 1 高 / 13 中 / 12 低）
> 对应计划：`docs/code-quality-fix-plan.md`（P0–P5 分批）
> 基线提交：`c5f9e73`；实现提交 22 个（不含本组文档提交），24 个文件 +1800/−235

## 一、结论

| 结论                       | 数量 | 卡号                                                    |
| -------------------------- | ---- | ------------------------------------------------------- |
| 已修复（含文档与配置）     | 20   | H-1、M-1～M-13、L-1、L-2、L-3、L-4、L-5、L-8、L-9、L-11 |
| 评估后保持现状（有意为之） | 4    | L-6、L-7、L-10、L-12                                    |
| 未修复的阻断 / 高危        | 0    | —                                                       |

测试规模：22 个测试文件、273 个用例（基线 16 文件 / 200 用例），全量通过。
覆盖率下限已按实测基线设置：lines 81 / functions 83 / statements 78 / branches 69。

## 二、逐项落地

| 卡号 | 结论               | 关键改动                                                                                                                                                                                                               | 证据                                                                       |
| ---- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| H-1  | 已修复             | `src/sync/github.ts` 新增 `assertSafeGitHubSegment` / `encodeContentPath` / `buildContentsApiUrl` / `buildRepoApiUrl`，四处 URL 拼接统一；owner/repo 白名单、path 逐段 `encodeURIComponent`、拒绝 `..`、绝对路径与空段 | `cd3da07`；`test/github.test.ts` 新增 5 例（先红：5 failed）               |
| M-1  | 已修复             | `src/ui/templates.js` 把 348 行 `getDashboardScript` 拆为四段（render / interaction / sync / bootstrap），`apiFetch` 恢复多行                                                                                          | `954b73e`；拆分前后四种页面输出逐字相等（19976 / 878 / 5356 / 30637 字符） |
| M-2  | 已修复             | 同步与探测日志统一中文，异常统一 `e instanceof Error ? e.stack : e`；写库的 `last_sync_error` 仍存 `e.message`                                                                                                         | `9ee3edc`；全量 212 用例通过                                               |
| M-3  | 已修复             | 新增 `writeIpSource` 合并新增/更新写库路径（读 JSON → 校验 → 绑定 → 唯一键 409）                                                                                                                                       | `e746ee8`；2 例冲突测试（重复 URL、PUT 撞已有 path 且字段不变）            |
| M-4  | 已修复             | 新增 `src/db/settings.ts` 作为键名与安全分组单一来源；`normalizeSettingsInput` / `validateEffectiveSettings` 两个纯函数抽出，`apiSetSettings` 由 41 行降到 13 行                                                       | `a2d41ad`、`9329a36`；`test/settings.test.ts` 17 例                        |
| M-5  | 已修复             | 新增 `src/util/batch-sync.ts` 的 `forEachIsolated`，5 处批处理循环统一失败隔离，日志文案逐字保留                                                                                                                       | `47b2358`；`test/batch-sync.test.ts` 5 例                                  |
| M-6  | 已修复             | `src/db/client.ts` 新增 `DOMAIN_COLUMNS` / `IP_SOURCE_COLUMNS`，四个列表查询改拼接常量                                                                                                                                 | `e047ba3`；时间仍在 SQL 侧格式化，字段名不变                               |
| M-7  | 已修复             | IP 源新增/更新共用 `validateIpSourceInput`：URL 长度、`github_path` 相对路径与段长、`commit_message` ≤200、`fetch_strategy` 必须命中 `FETCH_STRATEGIES`                                                                | `06fc8db`；`test/api.test.ts` 7 例（先红：6 failed）                       |
| M-8  | 已修复             | 手动全量同步互斥锁：`MANUAL_SYNC_LOCK_KEY` + 180 秒 TTL + CAS 接管 + 令牌校验释放；锁在流式响应内部释放；冲突返回 409                                                                                                  | `7b9ccb3`、`757a66d`；`test/sync-lock.test.ts` 4 例 + 路由层 2 例          |
| M-9  | 已修复             | 探测增加 25 秒总时长预算（`PROBE_TOTAL_TIMEOUT_MS` + `withProbeTimeout`），超时返回中文 400                                                                                                                            | `d4d640a`；假定时器用例先红后绿                                            |
| M-10 | 已修复             | 新增 `GET /api/domains/records` 批量端点，`fetchZoneRecords` 由单/批量端点共用，出站并发上限 4；前端一次请求后逐卡片渲染                                                                                               | `c7d9e04`；3 例（出站调用数等于域名数、单条失败隔离、未配置 400）          |
| M-11 | 已修复             | 定时取批建立表达式索引 `idx_domains_batch` / `idx_ip_sources_batch`（普通列索引压不住 CASE 排序，实测仍有 TEMP B-TREE）                                                                                                | `919eff8`；`test/query-plan.test.ts` 固化查询计划与顺序语义                |
| M-12 | 已修复             | 补 logout、`GET /api/ip_sources`、`DELETE /api/ip_sources/:id`、probe 成功与非法 URL 直测                                                                                                                              | `1e88ba7`；5 例，首跑即过                                                  |
| M-13 | 已修复             | 覆盖率阈值按实测基线下调 2 个百分点设为下限，防倒退                                                                                                                                                                    | `e8a2477`；`--coverage.thresholds.lines=99` 反证退出码 1                   |
| L-1  | 已修复             | README 结构清单：`compatibility_date` 改 2026-05-20、测试文件数改 22                                                                                                                                                   | `34effcf`                                                                  |
| L-2  | 已修复             | 删除 `scripts/build-single-file.mjs` 中指向已删除的 `src/index.js` 的注释                                                                                                                                              | `34effcf`                                                                  |
| L-3  | 已处置（文档）     | README 本地开发章节说明限流按 `CF-Connecting-IP` 分桶、缺失时归并、不得伪造                                                                                                                                            | `cd7df17`                                                                  |
| L-4  | 已修复             | `normalizeDeepResolve`：只接受 0/1/布尔，字符串与越界数字返回 400                                                                                                                                                      | `173f871`；4 例参数化校验                                                  |
| L-5  | 已修复             | 记录查询失败回固定中文文案，上游 errors 与 stack 只进 `console.error`                                                                                                                                                  | `173f871`                                                                  |
| L-6  | 保持现状           | 每请求一次会话查询；未实测到它是主要耗时前不引入 TTL 缓存                                                                                                                                                              | 计划 L-6 「维持现状」                                                      |
| L-7  | 保持现状（触发式） | 列表分页需先确认生产数据规模超过数百行                                                                                                                                                                                 | 计划 L-7 「先记录规模」                                                    |
| L-8  | 已修复             | 客户端转义提成真实函数 `escapeHtmlClient`（`src/ui/dashboard-helpers.js`），7 例行为断言；模板测试改为断言注入形态                                                                                                     | `3b43a61`                                                                  |
| L-9  | 已修复             | `test/fetch.test.ts` 9 例补 `fetchWithTimeout` / `fetchWithRetry` 直测                                                                                                                                                 | `34f650b`                                                                  |
| L-10 | 保持现状           | `pnpm test` 与本地 `dev` 并发的偶发失败已在 AGENTS.md 记录为环境约束                                                                                                                                                   | 计划 L-10 「保持现状」                                                     |
| L-11 | 已修复             | dependabot 增加 npm 生态，devDependencies 分组、PR 上限 5                                                                                                                                                              | `6d977ec`                                                                  |
| L-12 | 保持现状           | pre-commit 只跑 `pnpm check`，测试由 CI 把关（避免 `--no-verify` 绕过）                                                                                                                                                | 计划 L-12 「保持现状」                                                     |

## 三、验证方式

| 项         | 命令                                                         | 结果                                                          |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| 全量测试   | `pnpm exec vitest run`                                       | 22 文件 / 273 用例全过                                        |
| 提交门禁   | `pnpm check`（typecheck + 语言 + UTF-8 + oxlint + prettier） | 五项全绿，oxlint 0 warning 0 error                            |
| 覆盖率     | `pnpm exec vitest run --coverage`                            | 阈值生效，低于阈值退出码 1（已反证）                          |
| 查询计划   | `EXPLAIN QUERY PLAN`（`test/query-plan.test.ts`）            | 命中表达式索引，无 `TEMP B-TREE`                              |
| 客户端脚本 | Node 侧 `new Function(script)`                               | 仪表盘脚本语法解析通过（workerd 禁 `eval`，无法在测试内求值） |

## 四、偏差与残余风险

1. **`encodeContentPath` 双重编码**：库里若已存在含 `%20` 的 `github_path`，下次同步会编码成 `%2520` 而 404。H-1 只保证「按段编码」契约，存量脏值需另行核对 `ip_sources.github_path` 是否含 `%`。
2. **`commit_message` 落库存原串**：校验按 trim 后长度判定，落库保留用户输入（含首尾空格）。属已披露的取舍，未新增卡片。
3. **客户端渲染无行为测试**：workerd 禁止 `eval` / `new Function`，`renderDomainCard` / `renderStatus` / 批量记录渲染分支只能靠源码字符串断言与 Node 侧一次性解析验证。
4. **M-10 仍为 N 次出站调用**：请求数与 D1 查询数已从 N 降到 1，但 Cloudflare DNS 记录本身仍需按域名各查一次（并发上限 4）。CF 无批量按名查询接口，这是接口上限而非实现取舍。
5. **M-8 依赖 D1 锁而非 Durable Object**：锁为 180 秒 TTL + CAS 接管，进程被强制终止时最坏要等 TTL 过期才能重新开始；对单管理员工具属可接受。
6. **L-5 的调试信息迁移**：上游错误详情从响应体移到 `console.error`，排障需看 Worker 日志而非浏览器。
7. **计划与实现的偏差（均在提交说明中记录）**：M-6 未引入 `mapDomainRow`/`mapIpSourceRow`（字段名不变、时间已在 SQL 格式化，属纯 churn）；M-5 未实现 `pickFailureFirst`（失败优先已由 SQL `ORDER BY` 完成）。

## 五、提交清单

```
06fc8db feat(ip_sources): 为新增与更新增加输入结构校验
173f871 fix(api): 校验深解析开关取值并收敛记录查询错误文案
1e88ba7 test(api): 补齐 logout、ip_sources 列表与删除、probe 的成功与非法 URL 用例
34effcf docs: 校正 README 结构清单与构建脚本注释
34f650b test(util): 为 fetchWithTimeout 与 fetchWithRetry 补充直接测试
3b43a61 test(ui): 把客户端转义助手提成真实函数并做行为断言
47b2358 refactor(sync): 抽出批同步的失败隔离编排
6d977ec chore(deps): 让 dependabot 跟踪 npm 依赖
757a66d fix(ui): 手动同步冲突时展示服务端提示而非裸状态码
7b9ccb3 feat(sync): 为手动全量同步增加互斥锁与 409 冲突响应
919eff8 perf(db): 为定时取批建立表达式索引并固化查询计划
9329a36 refactor(settings): 抽出设置清洗与配对校验的纯函数
954b73e refactor(ui): 把仪表盘客户端脚本拆成四段便于定位
9ee3edc fix(sync): 统一同步日志为中文并保留异常堆栈
a2d41ad refactor(settings): 收敛 settings 键名与安全分组的单一来源
c7d9e04 perf(ui): 仪表盘记录改为一次批量请求取回
cd3da07 fix(github): 为 Contents API 路径按段编码并校验 owner/repo
cd7df17 docs: 说明登录限流依赖 CF-Connecting-IP
d4d640a fix(probe): 为 IP 源探测增加 25 秒总时长预算
e047ba3 refactor(db): 收敛 domains 与 ip_sources 的行投影列清单
e746ee8 refactor(ip_sources): 合并新增与更新的写库路径
e8a2477 chore(coverage): 为覆盖率设置基于实测基线的下限阈值
```
