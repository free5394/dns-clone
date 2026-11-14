# 代码评审报告：IP 抓取统一化（dev 未推送提交）

- **评审范围**：`git diff origin/dev...HEAD`（base：`77cafe6` origin/dev → head：`5f82a35` 本地 dev），共 23 个未推送提交、30 个文件、约 5300 行新增。
- **基准文档（Spec 真相源）**：[docs/ip-fetch-unification-plan.md](./ip-fetch-unification-plan.md)（以 HEAD 版为准）。
- **评审方式**：双轴并行评审——Standards（仓库成文编码规范）与 Spec（方案一致性），互不干扰。
- **评审日期**：2026-11-11。

## 提交清单

```
5f82a35 fix: 统一 Cron 频率口径与「IP 输入类型」术语（issue #54）
3d3fd6b fix(docs): 按评审意见收口术语与四处表述，撤回 IPv4 正则误报（issue #54）
04f6ab1 test(sync): 补 resolveRecursively 深度解析正回归用例（issue #54）
bc885c9 docs(README): 修正失效锚点与设置写入校验描述（issue #54）
64f0fc2 docs: 补齐 IP 抓取统一化的文档与升级说明（issue #54）
0898b15 fix(dns): 收口单类型上限读取并统一备注类型判据（issue #53 评审）
8e4cd07 feat(dns): 全来源按类型截断并写入变更时间备注（issue #53）
876e3e7 fix(dns): 修正 URL 类型目标的策略持久化与 0 条判定（issue #52 评审）
9553cfa feat(dns): 域名目标支持 URL 输入来源（issue #52）
f5c6275 test(github): 补删除缺 sha 的用例，堵住提取时留下的缺口
ed90986 refactor(ip): 目标行不存在时优先返回 404 而非 409
335ed61 refactor(ip): 按复审意见收敛 #51 的校验与重复实现
a6117ab feat(ip): IPv6 伴生文件与订阅代理读取（issue #51）
608e088 feat(ip): IP 源解析模式端到端贯通
14508ea docs: 修正 AGENTS.md 与方案的过期文档引用
ed1e830 test(ip): 按增量复审收敛测试真相源与用例归属
c5ee5ac fix(ip): 按 code-review 修复归一依赖与设置校验
62557ef feat(ip): 打通迁移列、行投影与单类型记录上限设置
c3f92dd fix(ip): 排除全零展开写法的未指定地址（复核补漏）
95c06b9 fix(ip): 收紧解析层正则防护与 IPv6 归一（review 修复）
6b93516 feat(ip): 新增统一内容解析层与正则防护
32db91a feat(ip): 新增共享 IPv4/IPv6 校验与提取内核
```

## Standards（编码规范轴）

### 红线专项核查（全部通过）

- **D1 绑定**：新增代码仅用 `env.WUYA`，无第二绑定名。
- **迁移**：[src/db/migrations.ts](../src/db/migrations.ts) 的 `expectedSchemas` 与 `src/db/migrations/0001_initial.sql` 同步新增列（domains 5 列、ip_sources 2 列），全部可空、不回填、不建新表，`MIGRATION_VERSION` 已递增，幂等 DDL 保持。
- **设置写入**：`MAX_IPS_PER_TYPE` 进白名单；null/空串为显式清除（读取回退默认 20），`isExplicitClear` 区分「类型错误折叠成空」与「显式清除」，空串不触碰 Secret 类键；`apiGetSettings` 回传前归一，敏感键过滤机制未动。
- **依赖**：`package.json` / `pnpm-lock.yaml` 无改动，未引入新依赖。
- **wrangler.toml**：仅注释改动（cron 频率口径），`database_id` 占位符与 `keep_vars = true` 均未触碰。
- **语言三档**：新增 throw/console/错误消息全中文；新增测试标题全中文。
- **模板 §10**（[docs/ui-templates-refactor.md](./ui-templates-refactor.md)）：未新增 CSS 令牌、未动主题脚本；`.card-actions` 首按钮仍为「同步」；无 web font / 图片；`source_url`、`parse_mode` 展示均经 `escapeHtml` 或白名单映射（`renderParseModeLabel` 原始值不进 HTML）。
- **前端行为测试**：`buildDomainSavePayload` 已按 CODING_STANDARDS「前端行为测试」提取为纯函数并注入；[test/dashboard-render.test.ts](../test/dashboard-render.test.ts) 各静态契约断言均有 `// 静态契约` 标注与豁免理由。
- **术语**：README / docs / GLOSSARY 改动未使用 `_Avoid_` 禁用词。

### 判断项（坏味道基线，Fowler《Refactoring》ch.3，均为 judgement call）

| #   | 位置                                                                                                                                     | 坏味道                         | 说明与建议                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | [src/ui/templates.js](../src/ui/templates.js)（`saveIpSource`、探测脚本）+ [src/ui/dashboard-helpers.js](../src/ui/dashboard-helpers.js) | Duplicated Code                | `parse_param` 空串归一为 null 的逻辑三处同形：`buildDomainSavePayload`、`saveIpSource`、探测请求体。域名侧已提取纯函数，IP 源侧仍内联。建议 IP 源 payload 组装同样下沉到 `dashboard-helpers.js`。 |
| S2  | [src/routes/api.ts](../src/routes/api.ts)（`apiProbeIpSource`）                                                                          | Speculative Generality         | 响应保留 `ipCount` 注明「兼容旧前端」，但仓库内唯一消费方已改用 `ipv4Count`/`ipv6Count`；探测接口需认证，外部旧调用方存疑，该字段暂无内部消费方。                                                 |
| S3  | [src/sync/ip-parse.ts](../src/sync/ip-parse.ts)（`classesOverlap`）                                                                      | Primitive Obsession            | 字符类别用 `"digit"/"word"/"any"/"lit:<char>"` 字符串前缀编码并放进 `Set<string>`。解析器内部自洽、风险低，后续扩展类别时可升级为类型联合。                                                       |
| S4  | 全链路（`parse_mode` + `parse_param`）                                                                                                   | Data Clumps                    | 两字段在表列、`StrategyTarget`、`validateParseConfig`、探测接口、两个弹窗共 6+ 处成对出现；snake_case 落库映射是两字段形态的合理理由，下次触及时可考虑收拢为 `ParseConfig` 领域类型。             |
| S5  | [src/sync/ip-sources.ts](../src/sync/ip-sources.ts)（`fetchIpsFromSource`）                                                              | Speculative Generality（存量） | 生产代码无调用方，仅测试使用（自称 `@internal`）；本次只改实现未删，符合「精准修改」，后续测试迁移后可删。                                                                                        |

## Spec（方案一致性轴）

### (a) 缺失或部分实现的需求

**F1.【高】GitHub 侧「成功但 0 条」清空语义未实现，且固化了相反行为。**

方案三处一致要求：§2 决策表「GitHub 侧 0 条 IPv4 按空内容处理（已确认允许清空远端主文件）」、§13.1「主文件按空内容处理：与远端比对后写入空内容……标记 success」、§17.1 风险 7「源站临时返回无 IP 的空页时，主文件会被写入空内容」。

实现中：

- [src/sync/ip-sources.ts](../src/sync/ip-sources.ts) 的 `fetchIpsWithStrategy`（L438-449）未传 `emptyWhenNoIps`（该选项仅在 [src/sync/domains.ts](../src/sync/domains.ts) L460 由 DNS 侧置 `true`）；
- `fetchIpsForTarget`（L425-434）在全链取得正文但 0 IP 时走 `emptyWhenNoIps === undefined` 分支，抛「[无可用IP]」；
- `syncSingleIpSource` catch 后标 `failed`，远端主文件永不清空；且 [test/ip-sources-fetch.test.ts](../test/ip-sources-fetch.test.ts) L69-80 将抛错语义固化为预期，方案 §15.1 要求的该行为测试也随功能一同缺失。

唯一能写空主文件的路径是 ipv4=0 且 ipv6>0（仅清空 IPv4 行）。这是「DNS 侧保护、GitHub 侧允许清空」刻意不对称设计的未落地部分。

**建议**：`fetchIpsWithStrategy` 及 `syncSingleIpSource` 链路传入 `emptyWhenNoIps: true`，0 条时按空内容比对写入并标 `success`；同步修正 `ip-sources-fetch.test.ts` 的 0 条用例预期，并补方案 §15.1 对应测试。

### (b) 超出方案范围（scope creep）

| #           | 位置                                                                      | 说明                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2.【极低】 | [wrangler.toml](../wrangler.toml)                                         | 注释修正（「每分钟」→「每 30 分钟」），crons 值未变——不在方案 §10 清单，无行为影响，属顺手修正。                                                     |
| F3.【极低】 | [src/routes/api.ts](../src/routes/api.ts)（`normalizeDomainSourceInput`） | 域名 URL 变更时丢弃历史 `fetch_strategy`——方案 §8.1 只定义回退持久化，未要求变更时清空；属合理防御但超出方案文本，建议在方案 §8.1 补一句认可该行为。 |

### (c) 看似实现但语义可能有误

**F4.【中】`custom_regex` 全空白参数可保存。**

[src/sync/ip-parse.ts](../src/sync/ip-parse.ts) `validateParseConfig`：`json_path` 做了 trim 空判定并去首尾空白保存（L59-70），`custom_regex` 只查 `param.length === 0`（L77-79），全空白串（如 `"  "`）可通过必填/≤200/可构造/安全四关落库，运行期永远 0 匹配——正是方案注释（ip-parse.ts L62）自己点名要防的「能保存、永远取不到」，两模式行为不对称。

**建议**：`custom_regex` 与 `json_path` 对齐，先 `trim()` 判空，保存值统一去首尾空白。

**F5.【低】深度解析 AAAA 未接新内核。**

方案 §10「IPv6 正则从 domains.ts 迁入」实为「新增内核、原处保留」：`resolveRecursively`（[src/sync/domains.ts](../src/sync/domains.ts) L576-580）仍用旧无锚定正则（含 `%zone` 分支），产出不经 `canonicalizeIpv6` 去重、不排除 `::`/全零展开/IPv4-mapped。方案 §7.1 认可旧正则适用 DoH 场景，实际危害低，但「迁入」字面未完成——建议要么改方案措辞为「新增内核、DoH 深度解析沿用旧正则」，要么接入内核。

**F6.【低】三网/深度解析分支截断前不排序。**

方案 §5.1 流程图（「校验→去重→排序→各取前 N」）位于全分支汇合处；实现仅 URL 分支经 `parseContent` 排序，三网（domains.ts L396-397）与深度解析（L581-584）按原始顺序截断，「前 N」非数值最小 N。方案 §7.3 排序写在解析层语境，属模糊地带——建议在方案中明确三网/深度解析分支是否参与排序，或统一接入。

### 正面确认（抽样）

- `json_path` 512 / `custom_regex` 200 上限（ip-parse.ts L19-21）；
- IPv6 锚定全串结构校验、`::`/全零展开/mapped 排除（[src/util/ip.ts](../src/util/ip.ts) L41-148）；
- 策略回退链成功判定 = 取得正文 + ≥1 个有效 IP（ip-sources.ts L401-410，§6.2）;
- 同批 URL 缓存键含归一模式且命中也落库策略（domains.ts L143-146、L430-441）；
- 备注 PATCH→DELETE→POST 顺序及 no_change 零 PATCH、同分钟去重、PATCH 失败集合不变（domains.ts L718-776，[test/sync.test.ts](../test/sync.test.ts) L1537-1695 全覆盖）；
- 伴生路径删除 404 幂等（[src/sync/github.ts](../src/sync/github.ts) L267-295）；
- 代理白名单主路径与 IPv6 伴生路径正推确认、缓存键隔离（[src/routes/github-proxy.ts](../src/routes/github-proxy.ts) L20-25，测试 L225-283）；
- 迁移列、行投影、设置白名单、null 清除、1-200 校验（migrations.ts / client.ts / settings.ts L100-130）；
- 系统域名禁切类型 403（api.ts L478-486）；
- 方案 §15.1 十个测试文件全部落位；§15.2 端到端串联被拆为组件级测试，无单一「添加→探测→同步→再同步 no_change」用例（部分满足，低风险）。

## 总结

- **Standards 轴**：0 项硬违反；5 项低风险判断项，最值得收口的是 S1（IP 源侧 `parse_param` 归一逻辑三处重复）与 S2（无消费方的 `ipCount` 兼容字段）。
- **Spec 轴**：6 项发现（1 缺失 + 2 超范围 + 3 语义偏差）；最严重的是 **F1**——方案明确要求的「GitHub 侧 0 条按空内容处理并标记 success」未实现，且测试固化了相反行为，建议推送前修复。
