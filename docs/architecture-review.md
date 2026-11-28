# 架构评审：耦合枢纽与深化候选

- 状态：评审结论（可复算）
- 日期：2026-11-28
- 范围：`src/`、`scripts/`、`test/`、`docs/` 的全仓结构关系
- 方法：`/graphify` 全量知识图谱（AST 结构抽取 + 文档语义抽取）
- 基线：branch `main`，HEAD `d9308a7`；语料 111 文件 / 约 100,936 词
- 关联：`AGENTS.md`（实现红线）、`CODING_STANDARDS.md`（编码与错误响应规则）、`docs/ip-fetch-unification-plan.md`（IP 抓取与解析语义真相源）、`docs/ui-templates-refactor.md`（`templates.js` 重构方案）

本文件取代 `f53dac0` 删除的旧版《架构深化候选清单》。旧清单的 C1–C6 编号在 §5.2 保留对应关系，便于回溯。

## 0. 结论摘要

全仓 1038 节点、2250 条边、55 个社区（97% EXTRACTED / 3% INFERRED / 0% AMBIGUOUS）。真实架构耦合集中在 7 个节点：

| 节点                             | 度  | betweenness | 移除后连通分量 | 性质                               |
| -------------------------------- | --- | ----------- | -------------- | ---------------------------------- |
| `vitest`                         | 38  | 0.194       | 29 → 30（+1）  | 测试样板桥，**假信号**             |
| `src/routes/api.ts`              | 118 | 0.112       | 29 → 38（+9）  | **god module**，唯一结构性缺陷     |
| `package.json`（脚本与门禁命令） | —   | 0.068       | —              | 工具链配置枢纽                     |
| `src/sync/domains.ts`            | 66  | 0.058       | 29 → 35（+6）  | 单编排器 + 四入口，结构健康        |
| `src/sync/ip-sources.ts`         | 75  | 0.051       | 29 → 38（+9）  | 与 `domains.ts` 对称，缺独立编排器 |
| `src/ui/templates.js`            | 38  | 0.051       | 29 → 29（0）   | UI 装配根，**不是桥**              |
| `src/db/client.ts`               | 34  | 0.017       | 29 → 31（+2）  | 长尾 repository 层                 |

一句话判断：**只有 `api.ts` 是结构性缺陷**（1044 行把路由注册与全部业务处理混在一起）；其余节点都是合理的分层收敛，深化收益远小于表面度数所暗示的。

## 1. 方法与术语

### 1.1 数据来源

| 项       | 值                                                         |
| -------- | ---------------------------------------------------------- |
| 语料     | 111 文件（代码 89 / 文档 20 / 图片 2）                     |
| AST 抽取 | 640 节点 / 1580 边（`tree-sitter`，无 LLM）                |
| 语义抽取 | 415 节点 / 766 边 / 24 超边（10 个分块子代理）             |
| 最终图   | 1038 节点 / 2250 边 / 55 社区                              |
| 产出     | `graphify-out/graph.json`、`graph.html`、`GRAPH_REPORT.md` |

### 1.2 指标含义

- **度（degree）**：节点直接相连的边数。入度高 = 被大量依赖；出度高 = 依赖大量模块。
- **betweenness**：经过该节点的最短路径占比。高值 = 跨社区桥接点。
- **移除后连通分量**：删掉该节点后图被拆成几块。增量越大，越接近割点（cut vertex），即「删了会断开真实依赖」。
- **社区（community）**：聚类得到的模块群，本文件的社区名由人工按节点内容命名。

**关键读法**：度与 betweenness 高的节点未必是缺陷。`vitest` 两项都靠前，但它是测试样板边造成的统计假象；`templates.js` 移除后分量不变（+0），说明它不是桥。判断缺陷要看「移除后分量增量 + 是否跨层依赖」，不能只看排名。

## 2. 耦合枢纽

### 2.1 边数与社区分布

| 节点            | 度  | 社区数 | 社区内边 | 跨社区边 |
| --------------- | --- | ------ | -------- | -------- |
| `api.ts`        | 118 | 14     | 70       | 48       |
| `ip-sources.ts` | 75  | 13     | 16       | **59**   |
| `domains.ts`    | 66  | 10     | 41       | 25       |
| `templates.js`  | 38  | 4      | 35       | 3        |
| `client.ts`     | 34  | 6      | 12       | 22       |

`ip-sources.ts` 的跨社区边占比最高（59/75 = 79%），说明它是**被外部大量调用的服务层**；`templates.js` 相反（3/38 = 8%），是社区内部的装配根。

## 3. 逐节点结论

### 3.1 `src/routes/api.ts` — 唯一的结构性缺陷

`src/routes/api.ts:1` 模块节点 118 度、betweenness 0.112、移除后 +9 分量，全仓第一。

**跨越三层**（`api.ts:4-48` 一次性 import 13 个模块）：

```text
路由层   src/routes/api.ts（1044 行，仅 3 个 export）
  ├─ db 层    db/client.ts、db/migrations.ts、db/settings.ts
  ├─ sync 层  sync/domains.ts、sync/ip-sources.ts、sync/ip-parse.ts、sync/github.ts
  └─ util 层  util/auth.ts、util/http.ts、util/cf.ts、util/fetch.ts、
              util/url-safety.ts、util/max-ips-per-type.ts
```

社区内 70 条边里 40 条是 `contains`（`apiLogin`、`apiSetup`、`apiSetSettings`、`writeIpSource`、`apiProbeIpSource` 等 40 个处理函数），30 条是跨层 `imports`。1044 行只导出 3 个符号，是典型的 god module。

**该拆的部分**：按 `/api/*` 资源域拆成 `routes/auth.ts`、`routes/settings.ts`、`routes/domains.ts`、`routes/ip-sources.ts`、`routes/github.ts`，`api.ts` 只保留 `handleApiRequest()` 路由分发。

**不该动的部分**：`handleApiRequest()`（32 度）本身是路由表，必须认识所有 handler；把它当作耦合缺陷是误读。

**收益可量化**：「API 路由与认证」社区 cohesion 仅 0.055（全图最低），拆解后应升到接近 `HTTP 抓取与错误`（0.50）与 `部署参数解析`（0.80）的水平。

### 3.2 `src/sync/domains.ts` — 单编排器 + 四入口

`src/sync/domains.ts:1` 66 度、betweenness 0.058、移除后 +6 分量、10 个社区（41 内部 + 25 跨社区）。25 个符号的 betweenness 全部趋近 0（最高 `syncSystemDomains` 0.0008），桥接只在模块层——说明文件本身是一个高内聚单元。

**调用结构**：

```text
syncScheduledDomains()  L157  cron 批量（失败优先 + BATCH_SIZE）
syncSingleDomain()      L196  单域名 HTTP 入口
syncAllDomains()        L221  全量
syncSystemDomains()     L268  系统域名子集
         └──────────────┬──────────────┘
                syncDomainLogic()  L494   ← 唯一写状态的地方
                   ├── resolveRecordsForDomain()   L506（含出口截断）
                   └── updateCloudflareDns()      L530
```

四个入口只负责「选哪些域名 + 怎么分批」，没有任何入口自己写 `last_sync_status`。这是正确的收敛，状态机不会因入口不同而分叉。

**状态机（4 状态 / 5 个写入点）**：

| 状态        | 写入位置                                         | 触发条件                                                                                               |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `pending`   | 仅建表默认值（`src/db/migrations.ts:49`、`:74`） | 域名刚创建，**从不再次写入**                                                                           |
| `no_change` | `domains.ts:519`                                 | 源解析为空且 `last_synced_records` 也为空                                                              |
| `no_change` | `domains.ts:534`                                 | 源有记录，但 Cloudflare 侧 diff 为空（`updateCloudflareDns` 返回 `"no_change"`，`domains.ts:711-713`） |
| `success`   | `domains.ts:542`                                 | 有 diff，PATCH 成功；同时写回 `last_synced_records`                                                    |
| `failed`    | `domains.ts:552`                                 | 任意异常，写 `last_sync_error` 后**重新抛出**                                                          |

**关键分支：空结果保护**（`domains.ts:508-527`）

```text
源解析为空
  ├─ last_synced_records 为空 → no_change（本来就没有记录）
  └─ last_synced_records 非空 → throw（源域名未找到任何可解析的记录，上次曾有记录）
                                 → failed，且【不删除现有 DNS】
```

抓取异常导致的空结果**不会**被当成「清空远端」，而是记 `failed` 并保留现状。

**设计意图**（来自图谱 rationale 节点）：状态只影响展示与批次优先级，不阻断下一轮尝试。状态机不是工作流引擎，失败只是让该域名在下一轮排到队首。

### 3.3 `src/sync/ip-sources.ts` — 与 `domains.ts` 的对称及四处不对称

`src/sync/ip-sources.ts:1` 75 度、betweenness 0.051、移除后 +9 分量、13 个社区（16 内部 + 59 跨社区）。与 `domains.ts` 在符号数（28 / 26）、总度（185 / 182）、betweenness（0.051 / 0.058）上几乎完全对称，五条横切关注点逐一对应：

| 维度           | `domains.ts`                                                                           | `ip-sources.ts`                                      |
| -------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 定时入口       | `syncScheduledDomains` L157                                                            | `syncScheduledIpSources` L152                        |
| 单条入口       | `syncSingleDomain` L196                                                                | `syncSingleIpSource` L215                            |
| 批量入口       | `syncAllDomains` L221                                                                  | `syncAllIpSources` L320                              |
| 系统子集入口   | `syncSystemDomains` L268                                                               | 无（`ip_sources` 表无 `is_system` 列）               |
| 批量排序       | `CASE last_sync_status WHEN 'failed' THEN 0 ELSE 1 END, last_synced_time ASC` L172-174 | 同表达式 L168-169                                    |
| 批量索引       | `idx_domains_batch`（`src/db/migrations.ts:109`）                                      | `idx_ip_sources_batch`（`src/db/migrations.ts:112`） |
| 抢锁           | 路由层 `withManualSyncLock`（`api.ts:100`、`:102`）                                    | 路由层 `withManualSyncLock`（`api.ts:129`）          |
| 续租 / 释放    | `domains.ts:231/260`、`:278/310`（`try/finally`）                                      | `ip-sources.ts:330/353`（`try/finally`）             |
| 单条入口不加锁 | 是                                                                                     | 是                                                   |
| 批量容错       | `forEachIsolated` L188                                                                 | `forEachIsolated` L180、`:339`                       |

锁协议完全一致：**路由层抢锁 → 批量函数内续租与释放 → 单条入口不加锁**（单条由路由的 `withManualSyncLock` 串行化）。

**四处真实不对称**：

1. **编排器形态**：`domains.ts` 有独立导出的 `syncDomainLogic(domain, token, zoneId, db, log, ctx)`（L494），4 个入口共享；`ip-sources.ts` 把编排内联为局部 `syncLogic(log)`（L223），且 `syncSingleIpSource` 返回 `Promise<Response | void>`（L221），绑定 HTTP。后果：`syncAllIpSources` 批量调用时被迫传 `returnLogs / signal / waitUntil` 三个 HTTP 参数（L343），单测必须走 `runWithOptionalLog` 完整路径。

2. **入口数量 4 vs 3**：`domains` 表有 `is_system` 列，需要 `syncSystemDomains` 单独入口；`ip_sources` 没有该列。这是数据模型决定的，不是遗漏。

3. **状态写入形态**：`domains` 按 `updateCloudflareDns` 返回值三分支写；`ip-sources` 用 `wroteSomething` 布尔聚合成二分（L296），单个参数化 `UPDATE ... status = ?`（L299）。`ip-sources` 有**双文件**（主文件 + IPv6 伴生文件），「部分成功」统一记 `success`；`domains` 只有单目标，不存在中间态。

4. **空结果语义正好相反**（最需要注意）：

    | 模块                             | 空结果时                     | 原因                              |
    | -------------------------------- | ---------------------------- | --------------------------------- |
    | `domains.ts:508-527`             | 保留现状，记 `failed`        | DNS 是**线上配置**，清空即事故    |
    | `ip-sources.ts:253-258` + `:270` | 清空远端主文件，记 `success` | GitHub 文件是**镜像**，清空可接受 |

    这条差异在 `docs/ip-fetch-unification-plan.md` 的异常语义 rationale 里有记录，但 `ip-sources.ts` 代码里没有一行注释点明「与 `domains` 相反」，重构时最容易被误统一。

### 3.4 `src/db/client.ts` — 长尾 repository 层

`src/db/client.ts:1` 34 度、betweenness 0.017、移除后 +2 分量、6 个社区（12 内部 + 22 跨社区）。21 个符号总度 151，均值 7.19，分布长尾：

| 符号                            | 位置 | 出  | 入  | 度  |
| ------------------------------- | ---- | --- | --- | --- |
| `client.ts`（模块）             | L1   | 21  | 13  | 34  |
| `getSetting()`                  | L16  | 0   | 23  | 23  |
| `getCfApiSettings()`            | L148 | 1   | 15  | 16  |
| `getGitHubSettings()`           | L154 | 1   | 10  | 11  |
| `setSetting()`                  | L21  | 0   | 9   | 9   |
| `createManualSyncLockRenewer()` | L119 | 1   | 7   | 8   |
| `releaseManualSyncLock()`       | L87  | 0   | 7   | 7   |
| `DomainRow`                     | L191 | 0   | 6   | 6   |
| `getSafeSettings()`             | L139 | 1   | 5   | 6   |
| 其余 12 个                      | —    | 0-1 | 1-4 | 1-4 |

Top 3（`getSetting`、`getCfApiSettings`、`getGitHubSettings`）占符号扇入的 43%（50/116）。`getSetting()` 是全仓库设置读取的唯一入口（23 个调用点、横跨 5 个社区），属于合理收敛。

文件内部四段：D1 查询原语（L7）→ 设置读写（L16-38、L139-165）→ 手动同步锁（L40-137，约占 41%）→ 行类型与列常量（L167-234）。

**边界问题**：`client.ts` 与 `src/db/settings.ts`（144 行）同时承担「设置」职责，但切分不齐——`getSafeSettings()` 是安全视图，却在 `client.ts`；`normalizeSettingsInput()` 在 `settings.ts`。

### 3.5 `src/ui/templates.js` — UI 装配根

`src/ui/templates.js:1` 38 度、betweenness 0.051，但**移除后连通分量不变**（29 → 29），不是割点。38 条边中 35 条在「仪表盘 UI 与设置」社区内部，只有 3 条跨社区：

| 目标社区       | 目标节点                             | 关系           | 性质                                 |
| -------------- | ------------------------------------ | -------------- | ------------------------------------ |
| 界面模板重构   | `scripts/check-dashboard-script.mjs` | `imports_from` | 静态契约门禁读取 `templates.js` 源码 |
| 功能测试计划   | `M10 公开首页`、`M11 管理后台 UI`    | `references`   | 测试方案引用页面                     |
| 需求规格与追踪 | `REQ-UI 页面与交互`                  | `references`   | 需求文档引用                         |

依赖方向是 `routes/ui.ts → templates.js → dashboard-{helpers,render,api}.js + max-ips-per-type.ts`，即 UI 层的装配根。

**两处事实需要修正**：

- `docs/ui-templates-refactor.md` §3.1 记录 `templates.js` 为 988 行 / 65,378 字节；实际现在是 **1125 行 / 75,602 字节**（+137 行 / +10,224 字节），§3.1 的行号分段表已整体失效。
- 重构未开始：目标目录 `src/ui/styles/`、`src/ui/layout/`、`src/ui/client/` 均不存在。

**三类耦合**（详见 `docs/ui-templates-refactor.md` §3.2）：字符串层（CSS 与浏览器 JS 同处模板字符串）、契约层（`id` / `class` / `onclick` 无工具校验）、注入层（`toString()` + `keep_names` 垫片，6 个注入点）。注入层最危险：服务端测试全绿时浏览器整段脚本仍可能 `ReferenceError` 中止。

### 3.6 `vitest` — 测试样板桥（假信号）

`package.json:46` 的外部引用概念节点 38 度、betweenness 0.194（全图第一），但**移除后只 +1 分量**。36 个 import 方里 35 个是 `test/*.ts`、2 个是 vitest 配置、1 个是 `package.json`。每条路径长度都是 2（`vitest → 测试文件 → 生产符号`）。

它排到 God Nodes 第 1 纯因测试样板边，不代表核心抽象。**看架构耦合应忽略此节点**，改看 `api.ts → domains.ts → ip-sources.ts → ip-parse.ts` 这条链。

## 4. 跨域一致性风险

### 4.1 CASE 表达式复制

`domains.ts:172-174` 的 `ORDER BY` 与 `src/db/migrations.ts:109` 的 `idx_domains_batch` 是同一段 CASE 的复制；`ip-sources.ts:168-169` 与 `migrations.ts:112` 同理。只改一边不会报错，只会让索引静默失效（退化为全表排序）。

### 4.2 空结果语义相反

见 §3.3 第 4 点。`domains` 保护、`ip-sources` 清空，是刻意的方向相反，但代码注释未点明，重构时风险最高。

### 4.3 `no_change` 语义重载

三个不同原因（源无记录 / Cloudflare 内容一致 / 空结果保护的前置状态）共用一个状态值，仪表盘只能统一显示「内容一致」（`src/ui/dashboard-render.js:21-32`）。运营侧无法区分「该域名本身就没有记录」与「本次抓取失败但被兜住」。

### 4.4 `pending` 是单向死状态

全仓只有建表默认值会写入 `pending`，没有任何 `UPDATE` 回到它。域名一旦同步过，即使后来禁用再启用，也永远显示上次的终态；「待定」只出现在从未同步过的行。

## 5. 深化候选

### 5.1 按收益排序

| 编号 | 问题                                                         | 方案                                                                                      | 强度             | 状态   |
| ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------- | ------ |
| A1   | `api.ts` 1044 行把路由与全部业务处理混在一起，118 度         | 按 `/api/*` 资源域拆出 5 个 handler 模块，`api.ts` 只留路由分发                           | Strong           | 仅提名 |
| A2   | 空结果语义两域相反，代码无注释                               | 在 `ip-sources.ts:253` 附近补「镜像清空 vs 线上配置保护」注释并指向计划文档               | Strong（低成本） | 仅提名 |
| A3   | CASE 表达式四份复制（两处查询 + 两个索引）                   | 抽成共享常量                                                                              | Strong（低成本） | 仅提名 |
| A4   | `ip-sources.ts` 缺独立编排器，批量入口被迫传 HTTP 参数       | 抽 `syncIpSourceLogic(source, gh, db, log)`，与 `syncDomainLogic` 对齐                    | Worth exploring  | 仅提名 |
| A5   | `no_change` 语义重载                                         | 拆成 `unchanged` 与 `source_empty` 两个值，或写入可区分的标记                             | Worth exploring  | 仅提名 |
| A6   | `pending` 无回收路径                                         | `is_enabled` 由 0 变 1 时重置为 `pending`                                                 | Worth exploring  | 仅提名 |
| A7   | `client.ts` 手动同步锁占 41%                                 | 抽 `src/db/sync-lock.ts`（6 个符号零向外依赖，`test/sync-lock.test.ts` 已是现成测试边界） | Worth exploring  | 仅提名 |
| A8   | `getSafeSettings()` 与 `normalizeSettingsInput()` 分居两文件 | `getSafeSettings()` / `getFullSettings()` 迁入 `src/db/settings.ts`                       | Speculative      | 仅提名 |
| A9   | `templates.js` 1125 行、四段脚本混在一处                     | 按 `docs/ui-templates-refactor.md` §5 的 S1 → S2 → S3 顺序拆分（S1 门禁必须先落地）       | Speculative      | 仅提名 |

### 5.2 与旧清单的对应

| 旧编号 | 旧问题                                         | 本次对应                                                                                   |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| C1     | settings 词汇表没有归属模块                    | A8（边界问题仍在）                                                                         |
| C2     | 批同步编排写了 5 遍                            | A4（`domains` / `ip-sources` 编排器形态不一致）                                            |
| C3     | domain / ip_source 行读取被 7 个 module 重写   | 图谱显示列清单已收敛到 `client.ts:167`、`:209`，仅 4 个导入点，**已显著改善**              |
| C4     | GitHub 访问两套实现                            | **done**（issue #1 / `dfc04df`），图谱确认 `readFileForSubscriber` 已归入 `sync/github.ts` |
| C5     | 纯函数层层转发                                 | 本次未观测到新的 seam 重复，暂不提名                                                       |
| C6     | 841 行 `templates.js` 内嵌第二套仪表盘数据逻辑 | A9（现为 1125 行，`dashboard-api.js` 已抽出部分逻辑）                                      |

## 6. 复现与增量更新

```bash
# 全量重建（已有 graphify-out/ 时）
graphify --update

# 任意具体问题
graphify query "为什么 api.ts 桥接 14 个社区"

# 两点最短路径
graphify path "api.ts" "client.ts"

# 单符号解释
graphify explain "syncDomainLogic"
```

图谱产物在 `graphify-out/`（`graph.json`、`graph.html`、`GRAPH_REPORT.md`、`manifest.json`）。该目录是生成物，已由 `.gitignore` 整体忽略；需要归档时用 `graphify --update` 重建。

## 7. 已知局限

- **92 个弱连接节点**（≤1 连接），主要是依赖项与配置键，未纳入本次结论。
- **1 个 `.sql` 未解析**：缺 `tree_sitter_sql`，`src/db/migrations/0001_initial.sql` 未参与抽取。
- **18 个代码文件只有文件级节点**：多为 `test/*.ts`，无导出符号；已核实 89 个代码文件全部有节点，无静默漏读。
- **图健康告警**：1 条自环边；91/96 条多重边在简单图构建时按端点折叠（属正常折叠，不是丢边）；无悬空/缺失端点。
- **社区名为人工命名**：基于节点标签推断，可能有个别命名不够精确。
- **betweenness 为无向简单图口径**：对高扇出的叶子型枢纽会偏高（`vitest` 即典型），需结合「移除后分量增量」交叉判断。

## 8. 变更记录

- v1（2026-11-28）：初版。基于 `/graphify` 全量图谱（1038 节点 / 2250 边 / 55 社区）重建，取代 `f53dac0` 删除的旧版候选清单。
