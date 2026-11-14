# 代码评审报告：抓取策略门控与 API 收口（dev 未推送提交）

- **评审范围**：`git diff 83d2a44...d59455e`（base：`83d2a44` origin/dev → head：`d59455e` 本地 dev），共 7 个未推送提交、10 个文件、+454/-149。
- **Spec 真相源**：issue #67（前置检查纯重构）、#68（抓取策略 URL 适用性门控）、#69（API 不再接收 fetch_strategy）三张已关闭工单的拍板结论与 Agent Brief。
- **评审方式**：双轴并行只读子代理——Standards（仓库成文编码规范 + 重构气味基线）与 Spec（工单一致性），互不干扰；验证命令由 Lead 补跑。
- **评审日期**：2026-11-13。

## 提交清单

```
d59455e fix(ip源): 按双轴评审收敛 #69 的空值与文档口径
33b5b30 fix(ip源): API 不再接收 fetch_strategy（issue #69）
4082d76 fix(ip源): 抓取策略纳入 URL 适用性门控（issue #68）
54061a8 refactor(ip): 「无可用策略」判据改为进循环前按同一谓词计算
dbdf467 docs(ip): 按双轴评审校正「无可用策略」注释口径
9bac469 refactor(ip): 把「无可用策略」提成显式前置检查（Closes #67）
a34e3d9 refactor(test): 收口 sync.test.ts 重复 helper 并统一 domain 行工厂（引用 #59）
```

## Standards（编码规范轴）

### 成文标准硬违规：未发现

- **语言三档**（[CODING_STANDARDS.md](../CODING_STANDARDS.md)）：[src/sync/ip-sources.ts](../src/sync/ip-sources.ts) 新增 `throw new Error("[无可用IP] …")` 均为中文；新增 `it()` 标题全中文；注释中文并带 issue 溯源，符合注释惯例。
- **前端行为测试豁免**：[test/dashboard-render.test.ts](../test/dashboard-render.test.ts) 新增保存体断言已标注「静态契约（issue #42）」并说明原因，合规。
- **界面模板约束**（[docs/ui-templates-refactor.md](./ui-templates-refactor.md) §10）：[src/ui/templates.js](../src/ui/templates.js) 仅新增一行静态 `<small>` 中文说明并删除 `successfulProbeStrategy` 接线，四条硬约束均未触碰。
- **AGENTS.md 红线**：无新依赖；`fetch_strategy` 移出 API 契约同步更新了 README 字段表。

### 气味基线（判断题，非违规）

1. **可能的重复代码**：[test/api.test.ts](../test/api.test.ts) 与 [test/ip-sources-fetch.test.ts](../test/ip-sources-fetch.test.ts) 各自新增的 hostmonit `globalThis.fetch` stub 成对逐字重复（api.test.ts 两处、ip-sources-fetch.test.ts 两处）。同批 a34e3d9 刚收口 sync.test.ts 重复 helper，新用例又造对偶，建议后续提取共享 mock helper。
2. **可能的依恋别人**：[src/routes/api.ts](../src/routes/api.ts) 的 `checkCompanionConflict` 本职责是路径冲突检查，现顺带取回旧 `url`/`fetch_strategy` 快照供 `writeIpSource` 判缓存去留；策略适用性语义属 src/sync/ip-sources.ts，路由层聚拢了 #68/#69 判定逻辑，可考虑下沉。

正向一笔：`CompanionCheck.previous` 把 url 与 fetchStrategy 合成一个快照对象，是消除数据泥团的正确方向。

## Spec（工单一致性轴）

### 缺失或只做一半

1. **轻微**：#67 验收要求注释改写为「循环必跑」不变量说明，最终版注释（src/sync/ip-sources.ts:425-426「『有没有可跑的策略』必须在进循环前按同一判据算出来，不能事后拿 attempts 反推」）语义近似但措辞与验收字面不一致。低严重度，语义等价，仅记录不改。
2. **验证项**：#68/#69 验收要求「pnpm check 全绿且 ip-sources-fetch 用例不受影响」，子代理只读未跑命令——已由 Lead 补跑闭环（见下节），全绿。

### Scope creep：无实质越界

`writeIpSource` 保留缓存时加 `isStrategyApplicable` 过滤（src/routes/api.ts:838-851）超出 #69 Brief「URL 未变更保留原值」的字面范围，但属 #68 定稿改法 1「三处共用判据」中「ip_sources 写入校验」的落实，docs/ip-fetch-unification-plan.md §8.2 有记录且有测试固化（mismatch 清空 + 未登记名保留两用例）。a34e3d9 自我声明纯重构经查属实：sync.test.ts 零 `it` 增删。

### 可疑实现：未发现

- #67 前置检查判据 `FETCH_STRATEGIES[name]` 与 emptyWhenNoIps 删项行为等价（四策略恒适用使前置检查当前生产不可达，与旧注释口径一致）。
- #69 各验收点（POST 四形态落 NULL 非 400、PUT 未变更保留/变更置 NULL、GET 投影、保存体无该字段、docs/README 五策略补齐）均有对应实现与用例；`CompanionCheck` 改 previous 快照后仍复用原全表扫描，未加 D1 往返。

## 验证补跑（Lead，2026-11-13）

- `pnpm check`：七项全绿（typecheck、typecheck:test、check:language、check:utf8、lint、format:check、check:dashboard），`CHECK_EXIT=0`。
- `pnpm test`：29 个测试文件 / 590 个用例全部通过，`TEST_EXIT=0`（含 ip-sources-fetch 全部用例）。
- 测试在评审 worktree 内执行（主检出一处未跟踪文档不构成干扰），评审范围 `83d2a44...d59455e` 工作区保持干净。

## 总结论

**通过（可推送）**。零成文标准硬违规、零 Spec 实质缺口、零可疑实现；两条气味基线为判断题，建议作为后续小票处理（测试 stub 去重、判定逻辑下沉）。唯一措辞级偏差（#67 注释「循环必跑」字面）语义等价，不构成阻塞。
