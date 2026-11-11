# IP 抓取统一化与 DNS 绑定方案

- 状态：需求已确认，待实施
- 日期：2026-11-10
- 范围：仅方案设计，不包含代码实现
- 基线：本仓库当前工作树（`src/`、`test/`、`docs/`）

## 1. 目标

把现有的两条独立 IP 获取链路统一为一套可复用的「抓取 + 解析」流程：

1. 输入支持**域名**与 **URL** 两种；
2. URL 响应正文可能是 HTML、纯文本或 JSON；
3. 统一提取并校验 IPv4 / IPv6；
4. 结果进入两类后续处理：
    - 绑定到指定域名，生成 `A` / `AAAA` DNS 记录；
    - 上传到 GitHub 指定仓库、指定文件（IPv4 主文件 + IPv6 伴生文件）。

保留现有解析策略与既有功能，只做增量扩展。

## 2. 已确认决策

| 编号     | 决策                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入语义 | 域名 → DNS 解析（DoH，跟随 CNAME，取 A/AAAA）；URL → HTTP 抓取正文后解析。两者不交叉                                                                                                |
| 入口分工 | `domains` 支持域名与 URL；`ip_sources` 仅支持 URL                                                                                                                                   |
| 数据模型 | 不建新表、不重建表：`domains` 与 `ip_sources` 仅做可空列 `ADD COLUMN`                                                                                                               |
| 解析模式 | `auto` / `lines` / `json_path` / `custom_regex`，默认 `auto`                                                                                                                        |
| 存量源   | 未配置解析模式的 IP 源按 `auto` 处理，同时提取 IPv4 与 IPv6                                                                                                                         |
| 上限     | IPv4 / IPv6 各取前 N 条；N 来自系统设置，默认 20，范围 1–200                                                                                                                        |
| 上限范围 | 作用于**所有 DNS 来源**（含三网内置源、深度解析、URL 输入）；不约束 GitHub 文件                                                                                                     |
| TTL      | 复用 `domains.ttl` 与现有域名表单 TTL 字段，默认 60，范围 1 或 60–86400                                                                                                             |
| DNS 备注 | 仅 `A` / `AAAA` 写入 `comment: DNS Clone 变更于 YYYY-MM-DD HH:mm`（北京时间）；语义为记录集**最近一次变更时间**，仅在记录集合发生增删的同步中写入或刷新，集合未变不产生任何 `PATCH` |
| GitHub   | 主文件只写 IPv4 全量；IPv6 非空时写伴生文件（`x.txt` → `x-v6.txt`），为空时删除                                                                                                     |
| 异常语义 | 抓取失败不改动现有 DNS；0 条按现有 `failed` / `no_change` 分支；仅 IPv6 时删除旧 `A`；GitHub 侧 0 条 IPv4 按空内容处理（已确认允许清空远端主文件）                                  |
| 安全     | URL 保存与抓取双重 SSRF 校验；正文截断 512KB；`custom_regex` ≤200 字符并拒绝高风险形态；沿用现有会话鉴权                                                                            |
| 持久化   | 提取的 IP 不落库，每次同步动态获取                                                                                                                                                  |
| 调度     | 不新增任务类型：DNS 走 `domains` 批，GitHub 走 `ip_sources` 批                                                                                                                      |
| 兼容     | 保留 `internal:hostmonit:*`、深度解析、浅层 CNAME 三个分支；保留 8 个内置 IP 源与 10 个内置域名                                                                                     |

### 2.1 本次会改变既有行为的点

1. 所有 DNS 来源统一按类型截断到 N 条；存量域名若单类型记录超过 N，下一次同步会删除多余记录。
2. 记录集合发生增删的同步会为匹配的 `A` / `AAAA` 记录写入或刷新 `comment`（新增记录随创建写入）；集合未变的同步不产生任何 `PATCH`，`no_change` 语义与现状一致。
3. 存量 IP 源启用 `auto` 后，若正文含合法 IPv6，会新增伴生文件；IPv4 主文件内容不变。

## 3. 现状梳理

### 3.1 入口与调度

- [index.ts](../src/index.ts#L30-L52)：`/api/*` 进路由层，其余非静态路径进订阅器代理。
- [index.ts](../src/index.ts#L54-L87)：`scheduled` 在 `domains` 与 `ip_sources` 两类任务间轮转；先写 `next_sync_task` 再执行，失败也会轮转。
- 手动同步互斥锁：[api.ts](../src/routes/api.ts#L122-L133) 抢锁失败返回 409，锁在任务 `finally` 释放。

### 3.2 IP 抓取与 GitHub 链路

- [ip-sources.ts](../src/sync/ip-sources.ts#L43-L47)：唯一提取函数 `extractIpv4`，仅 IPv4，段值 ≤255 过滤。
- [ip-sources.ts](../src/sync/ip-sources.ts#L50-L100)：五个策略，每个策略内部直接调用 `extractIpv4`：
    - `direct_regex`、`phantomjs_cloud`、`proxy_codetabs`、`jina_reader`、`hostmonit_api`。
- [ip-sources.ts](../src/sync/ip-sources.ts#L307-L367)：`fetchIpsWithStrategy` 负责 SSRF 校验、策略回退、IPv4 数值排序、回退策略持久化。
- [ip-sources.ts](../src/sync/ip-sources.ts#L148-L222)：`syncSingleIpSource` 抓取后 `ips.join("\n")` 与远端比对，无变化标 `no_change`，否则 `updateFileOnGitHub`。
- [github.ts](../src/sync/github.ts#L150-L231)：`getCurrentGitHubContent`（404→null）、`updateFileOnGitHub`（GET sha → PUT base64）。
- [github-proxy.ts](../src/routes/github-proxy.ts)：订阅器只按 `github_path` 白名单读主文件。

**现状结论**：GitHub 链路只有 IPv4，没有 IPv6，也没有伴生文件。

### 3.3 域名解析与 DNS 链路

- [domains.ts](../src/sync/domains.ts#L52-L66)：`getDnsFromDoh` 走 Cloudflare DoH，失败返回空数组。
- [domains.ts](../src/sync/domains.ts#L338-L407)：`resolveRecordsForDomain` 四个分支：
    - `internal:hostmonit:*`：三网优选 IP（HTML 表格解析），同批缓存，失败保留上次成功缓存；
    - `is_deep_resolve=1`：递归跟随 CNAME，最终取 A/AAAA；
    - 否则：浅层克隆，只取 CNAME。
- [domains.ts](../src/sync/domains.ts#L552-L585)：`resolveRecursively` 内联 IPv4 / IPv6 正则校验（该内联正则已由本方案 §7.1 的共享内核取代，见 §7.3）。
- [domains.ts](../src/sync/domains.ts#L282-L345)：`syncDomainLogic` 解析 → 空结果判定 → `updateCloudflareDns` → 状态落库。
- [domains.ts](../src/sync/domains.ts#L427-L529)：`updateCloudflareDns` 分页拉取、差异比对、分块增删；固定 `proxied=false`，TTL 取域名行，**不写 `comment`**。

**现状结论**：域名链路有三种解析方式，浅层克隆不产出 IP；所有来源都没有记录数上限，也没有更新时间备注。

### 3.4 数据、设置与校验

- [migrations.ts](../src/db/migrations.ts#L37-L72)：5 张表；`domains` 有 `ttl`（默认 60）、`last_synced_records`、行级同步状态；`ip_sources` 有 `url NOT NULL UNIQUE`、`github_path NOT NULL UNIQUE`。
- [migrations.ts](../src/db/migrations.ts#L9-L35)：`MIGRATION_VERSION` 版本门控 + 24h 时间门控；新增列必须同步加版本号。
- [client.ts](../src/db/client.ts#L165-L173)：`DOMAIN_COLUMNS` 与 `IP_SOURCE_COLUMNS` 是行投影单一来源。
- [settings.ts](../src/db/settings.ts#L36-L49)：写入白名单；`BATCH_SIZE` 已有整数范围校验范例。
- [api.ts](../src/routes/api.ts#L315-L398)：域名新增/更新校验；`source_domain` 仅允许 hostname 或 `internal:hostmonit:(yd|dx|lt)`；目标前缀为单 label 或 `@`；TTL 规则见 [api.ts](../src/routes/api.ts#L357-L365)。
- [api.ts](../src/routes/api.ts#L513-L538)：IP 源校验：URL 走 SSRF + 2048 上限，路径归一 + 512 上限，提交信息 1–200，策略白名单。
- [api.ts](../src/routes/api.ts#L621-L670)：探测接口按策略串行尝试，总预算 25s，返回 `strategy / ipv4Count / ipv6Count / sampleIps / sampleIpv6`。
- [url-safety.ts](../src/util/url-safety.ts#L74-L113)：SSRF 防护覆盖十进制、十六进制、IPv4-mapped、私有段、元数据域名。

### 3.5 UI 与测试

- [templates.js](../src/ui/templates.js#L549-L563)：系统设置表单分 fieldset。
- [templates.js](../src/ui/templates.js#L566)：域名弹窗已有 `TTL (秒)` 字段（`min=60 max=86400`，默认 60），以及深度解析开关。
- [templates.js](../src/ui/templates.js#L567)：IP 源弹窗仅 URL / GitHub 路径 / Commit 信息三个字段。
- [dashboard-render.js](../src/ui/dashboard-render.js#L26-L60)：`renderDomainCard` 与 `renderIpSourceCard` 负责卡片展示。
- 测试体系：`test/*.test.ts` + `test/apply-migrations.ts`，覆盖 API、同步、迁移、模板转义、GitHub 代理等。

## 4. 现状与目标差距

| 维度         | 现状                                | 目标                                                   |
| ------------ | ----------------------------------- | ------------------------------------------------------ |
| DNS 输入     | 域名 / 内置三网源                   | 域名 / URL / 内置三网源                                |
| GitHub 输入  | URL                                 | URL（不变）                                            |
| IPv6         | 仅深度解析产出 AAAA；GitHub 无 IPv6 | 所有输入统一提取 IPv4 + IPv6                           |
| 解析规则     | 策略内部写死 IPv4 正则              | 可配置 `auto` / `lines` / `json_path` / `custom_regex` |
| DNS 记录上限 | 无                                  | IPv4 / IPv6 各 N 条，N 默认 20                         |
| DNS 备注     | 不写                                | `A` / `AAAA` 写记录集最近一次变更时间                  |
| GitHub IPv6  | 无                                  | 伴生文件，空则删除                                     |
| 表结构       | 无 URL→DNS、无解析配置              | 两个表各加可空列                                       |

## 5. 目标流程

### 5.1 DNS 链路

```text
添加/编辑目标（域名或 URL）
  → 定时/手动同步
    → 域名：DoH 解析（跟随 CNAME）→ A / AAAA / CNAME
    → URL ：策略链抓正文 → parseContent(parse_mode, parse_param) → IPv4 / IPv6
    → 产出 IP 的分支各自过共享内核：校验 → 去重 → 规范化 → 排序
      （三网与深度解析同口径；CNAME 分支不产出 IP，不参与校验与排序）
    → 出口统一按 MAX_IPS_PER_TYPE 截断（排序先于截断，故「前 N」即序最小的 N 条）
    → 与 Cloudflare 现有记录比对
       ├ 缺失：新增（带 comment）
       ├ 多余：删除
       └ 匹配：TTL/proxied 一致则保留
    → 本次有增删 → 匹配记录 PATCH comment；无增删 → 不产生任何写操作
    → 状态写回 domains
```

### 5.2 GitHub 链路

```text
添加/编辑 IP 源（URL + GitHub 路径 + Commit 信息 + 解析模式）
  → 定时/手动同步
    → 策略链抓正文 → parseContent → IPv4 / IPv6
    → 主文件：IPv4 全量 → 与远端比对 → 无变化 no_change / 有变化 PUT
    → 伴生文件：IPv6 非空 → 比对/PUT；IPv6 为空且远端存在 → DELETE
    → 状态写回 ip_sources
```

## 6. 输入与抓取

### 6.1 域名输入

- 复用 [getDnsFromDoh](../src/sync/domains.ts#L52-L66)。
- 深度解析：复用 [resolveRecursively](../src/sync/domains.ts#L552-L585)，跟随 CNAME 直到最终 A/AAAA；无最终 IP 时回退为 CNAME 记录。最终 A/AAAA 过共享内核校验、去重、规范化与排序（§7.3）。
- 浅层克隆：只取 CNAME，不参与 IP 上限与备注。
- 域名输入不抓取网页正文，不读取解析配置。

### 6.2 URL 输入

- 保存时 `assertSafeHttpUrl`，长度 ≤2048。
- 抓取时再次 `assertSafeHttpUrl`，沿用现有五个策略：
    - `direct_regex`：直连取正文；
    - `phantomjs_cloud`：渲染后取 HTML；
    - `proxy_codetabs`：代理取正文；
    - `jina_reader`：Jina Reader 取正文；
    - `hostmonit_api`：仅 hostmonit 域名适用。
- 策略改为「返回原始文本」，由统一解析层提取 IP；正文截断到 512KB 后再解析。
- 回退链的「策略成功」定义为：取得正文 **且** 统一解析后提取到至少 1 个 IP；任一条件不满足（含 HTTP 200 但正文无 IP）视为未命中，继续尝试下一策略，与现有回退语义保持一致。
- 策略回退顺序、缓存策略优先、回退后持久化 `fetch_strategy` 的行为保持不变。

### 6.3 同批缓存

- `SyncContext` 增加 URL 结果缓存：键为 `url + parse_mode + parse_param`。
- 同一批内多个目标引用同一 URL 时只抓取一次。
- 抓取失败时保留上次成功缓存；从未成功过才向上抛错（与三网分支 FIX-16 语义一致）。
- 全链取得过正文但解析均为 0 IP 时不写缓存（与 FIX-15 语义一致），返回空记录集合交由 `syncDomainLogic` 判定。

## 7. 解析与 IP 处理

### 7.1 新增共享模块

**`src/util/ip.ts`**

- `isValidIpv4(text)`
- `isValidIpv6(text)`：锚定全串匹配 + 结构校验（`::` 至多一次、展开后组数 ≤8、每段 ≤4 位十六进制）。不复用 `domains.ts` 原有的无锚定正则——该正则只在 DoH 场景碰巧可用（每条应答恰为一个干净 IP），放到任意正文上会放行 `::before`、`IP=::1` 等子串误匹配；方案落地后该内联正则已删除，DoH 分支同样改走本内核。
- `normalizeIpv6(text)`：去方括号、转小写；含 `%zone` 或非法形态返回 null。
- `extractIpv4(text)` / `extractIpv6(text)`：全局匹配提取候选，逐项经 `isValidIpv4` / `isValidIpv6` 严格过滤，再 `Set` 去重。
- `sortIpv4(list)`：数值升序（沿用现有比较器）。
- `sortIpv6(list)`：规范化后字典序。
- `truncatePerType({ ipv4, ipv6 }, max)`：各自截断。

**`src/sync/ip-parse.ts`**

- `ParseMode` 类型与 `PARSE_MODES` 白名单。
- `parseContent(text, mode, param)`：返回 `{ ipv4, ipv6 }`。
- `validateParseConfig(mode, param)`：保存与探测共用。
- `isSafeRegexPattern(pattern)`：ReDoS 静态拦截。

### 7.2 解析模式

| 模式           | 规则                                                                                                                              | 适用正文                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `auto`（默认） | 全文同时跑 IPv4 / IPv6 正则                                                                                                       | HTML、JSON、纯文本           |
| `lines`        | 按行切分，行内按逗号/空白分 token，逐 token 严格校验                                                                              | 一行一个或逗号分隔的 IP 列表 |
| `json_path`    | `JSON.parse` 后按点路径取值（如 `data.ips`、`result.0.ip`）；值为字符串或字符串数组，逐项严格校验；解析失败或路径不存在视为未匹配 | API JSON                     |
| `custom_regex` | 用户正则，取捕获组 1 或命名组 `ip`；`matchAll` 后逐项严格校验                                                                     | 任意                         |

### 7.3 校验、去重、排序、截断

1. 提取后逐项严格校验：IPv4 四段 0–255；IPv6 锚定全串结构校验（`isValidIpv6`，见 7.1）+ 规范化。
2. IPv4 / IPv6 各自去重；IPv6 按 RFC 5952 规范写法去重（`2001:db8::1` 与 `2001:db8:0:0:0:0:0:1` 视为同一地址），`::` 与 IPv4-mapped 不产出 AAAA。
3. IPv4 数值升序；IPv6 规范化后字典序。
4. DNS 侧各取前 N 条；GitHub 侧不截断。**排序必须早于截断**，否则「前 N」不是序最小的 N 条。
5. 适用分支：三网（`internal:hostmonit:*`）与深度解析同口径；浅层 CNAME 分支不产出 IP，不参与校验、排序与截断。

### 7.4 `custom_regex` 防护

保存时即拒绝，不只依赖运行期：

- 长度 ≤200 字符；
- `new RegExp(pattern)` 构造失败返回 400；
- 拒绝嵌套量词等高风险形态（如 `(a+)+`、`(a*)*`、`(a|a)*`）；
- 仅允许 `g` 标志（实现内部固定使用）；
- 运行期正文截断 512KB 作为兜底。

## 8. 数据模型与配置

### 8.1 `domains` 新增列（全部可空，仅 `ADD COLUMN`）

| 列               | 类型 | 语义                                                                               |
| ---------------- | ---- | ---------------------------------------------------------------------------------- |
| `source_type`    | TEXT | `url` 表示 URL 输入；NULL / `domain` 表示域名输入                                  |
| `source_url`     | TEXT | `source_type=url` 时的完整 URL；域名类型为 NULL                                    |
| `parse_mode`     | TEXT | 仅 URL 类型使用；NULL 视为 `auto`                                                  |
| `parse_param`    | TEXT | `json_path` 的点路径或 `custom_regex` 的正则；其余模式为 NULL                      |
| `fetch_strategy` | TEXT | 仅 URL 类型使用；策略回退命中后持久化（与 `ip_sources` 行为对称），NULL 表示未指定 |

- URL 类型下，`source_domain` 存 URL 的 hostname，仅用于展示与现有非空约束。
- URL 类型下，策略回退命中后把实际生效策略持久化到 `fetch_strategy`（与 `ip_sources` 行为对称），下一轮优先尝试；域名类型该列为 NULL。API 不接收该字段，仅回退写入与 GET 投影展示。
- 不新增唯一约束；`UNIQUE(target_domain)` 保持不变。
- 系统预设域名（`is_system=1`）不允许切换输入类型，沿用现有"源域名不可修改"的保护。

### 8.2 `ip_sources` 新增列（全部可空）

| 列            | 类型 | 语义                                     |
| ------------- | ---- | ---------------------------------------- |
| `parse_mode`  | TEXT | NULL 视为 `auto`                         |
| `parse_param` | TEXT | `json_path` 点路径或 `custom_regex` 正则 |

`url` / `github_path` 的 NOT NULL、UNIQUE 约束保持不变。

### 8.3 迁移

- `MIGRATION_VERSION` 更新为新值（如 `2026-11-10-ip-fetch-unification`），确保已部署实例立即执行。
- 在 `expectedSchemas` 中追加列定义，幂等 `ADD COLUMN` 自动生效。
- 不需要数据回填：NULL 即默认语义。

### 8.4 新增设置项

| 键                 | 默认 | 范围       | 说明                        |
| ------------------ | ---- | ---------- | --------------------------- |
| `MAX_IPS_PER_TYPE` | 20   | 1–200 整数 | DNS 侧 IPv4 / IPv6 各自上限 |

- 加入 [settings.ts](../src/db/settings.ts#L36-L49) 的 `WRITABLE_SETTING_KEYS`。
- 写入校验与 `BATCH_SIZE` 同风格：非法值整批拒绝并返回 400。
- 读取时非法/缺失回退默认 20（与 `normalizeBatchSize` 同风格）。
- `getSafeSettings` 会自动带出该键，无需新增敏感字段处理。

## 9. 接口定义

### 9.1 域名新增 / 更新

`POST /api/domains`、`PUT /api/domains/:id`

```jsonc
{
    "source_type": "url", // 可选；缺省 "domain"
    "source_url": "https://example.com/ips.json", // source_type=url 时必填
    "parse_mode": "json_path", // 可选；缺省 "auto"
    "parse_param": "data.ips", // json_path / custom_regex 必填
    "target_domain_prefix": "myip",
    "ttl": 300,
    "notes": "备用出口",
}
```

- `source_type=domain`：沿用现有 `source_domain` 校验，忽略 `source_url` / `parse_*`。
- `source_type=url`：`source_domain` 由 `new URL(source_url).hostname` 派生；`is_deep_resolve` 强制为 0。
- 校验失败返回 400，文案为简体中文。
- `GET /api/domains` 投影增加 `source_type`、`source_url`、`parse_mode`、`parse_param`、`fetch_strategy`（回退持久化值，仅展示）。

### 9.2 IP 源新增 / 更新

`POST /api/ip_sources`、`PUT /api/ip_sources/:id`

```jsonc
{
    "url": "https://example.com/ip_list.txt",
    "github_path": "Cloudflare.txt",
    "commit_message": "Update Cloudflare IPs",
    "fetch_strategy": "direct_regex",
    "parse_mode": "auto",
    "parse_param": null,
}
```

- 保留现有 URL / 路径 / 提交信息 / 策略校验。
- 新增解析配置校验。
- 保存时校验伴生文件路径：长度 ≤512、与其它 `github_path` 不冲突。
- `GET /api/ip_sources` 投影增加 `parse_mode`、`parse_param`。

### 9.3 探测

`POST /api/ip_sources/probe`

```jsonc
{
    "url": "https://example.com/ips.json",
    "parse_mode": "json_path",
    "parse_param": "data.ips",
}
```

响应：

```jsonc
{
    "success": true,
    "strategy": "direct_regex",
    "ipv4Count": 12,
    "ipv6Count": 3,
    "sampleIps": ["1.1.1.1", "..."],
    "sampleIpv6": ["2606:4700::1", "..."],
}
```

- 探测总预算 25 秒、策略串行顺序保持不变。
- 解析配置非法时直接 400，不进入抓取。
- 不返回 `ipCount`：该字段是早期「IPv4 单一计数」时代的兼容别名，与 `ipv4Count` 同值冗余，仓库内前端已全部改用 `ipv4Count`/`ipv6Count`，故删除（issue #58）。仅当出现**可举证的**外部调用方依赖该别名时，才允许以显式别名形式恢复，并在本票补记依赖方证据。

### 9.4 系统设置

`POST /api/settings`

```jsonc
{ "MAX_IPS_PER_TYPE": 30 }
```

- 与现有设置合并保存；非法值 400。

### 9.5 校验矩阵

| 字段                    | 规则                                                                                                                | 失败处理  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | --------- |
| `source_type`           | `domain` / `url` / NULL                                                                                             | 400       |
| `source_url`            | URL 类型必填；`assertSafeHttpUrl`；长度 ≤2048                                                                       | 400       |
| `source_domain`（派生） | hostname 形态校验                                                                                                   | 400       |
| `parse_mode`            | 四模式白名单；NULL/空串 → `auto`                                                                                    | 400       |
| `parse_param`           | `json_path` / `custom_regex` 必填；`json_path` ≤512、`custom_regex` ≤200 且过正则防护                               | 400       |
| `target_domain_prefix`  | 单 label 或 `@`（现有规则）                                                                                         | 400       |
| `ttl`                   | 1 或 60–86400（现有规则）                                                                                           | 400       |
| `github_path`           | 现有归一 + ≤512                                                                                                     | 400       |
| 伴生路径                | 派生后 ≤512；双向冲突校验：派生路径不与现有 `github_path` 冲突，且新 `github_path` 不得等于任何既有源的派生伴生路径 | 400 / 409 |
| `MAX_IPS_PER_TYPE`      | 1–200 整数                                                                                                          | 400       |

## 10. 模块与文件改动清单

| 文件                            | 类型 | 职责                                                                                                                         |
| ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/util/ip.ts`                | 新增 | IPv4/IPv6 校验、归一、提取、排序、截断（独立内核，不搬用 `domains.ts` 的无锚定正则）                                         |
| `src/sync/ip-parse.ts`          | 新增 | 四种解析模式、点路径取值、正则防护、统一解析入口                                                                             |
| `src/db/migrations.ts`          | 修改 | `domains` 5 列、`ip_sources` 2 列、`MIGRATION_VERSION`                                                                       |
| `src/db/client.ts`              | 修改 | `DOMAIN_COLUMNS`、`IP_SOURCE_COLUMNS` 追加新列                                                                               |
| `src/db/settings.ts`            | 修改 | `MAX_IPS_PER_TYPE` 白名单、整数校验、读取归一                                                                                |
| `src/sync/ip-sources.ts`        | 修改 | 策略返回文本；统一解析；返回 IPv4 + IPv6；伴生文件写入/删除                                                                  |
| `src/sync/github.ts`            | 修改 | 新增 `deleteFileOnGitHub`（GET sha → DELETE，404 静默）                                                                      |
| `src/sync/domains.ts`           | 修改 | URL 输入分支、同批 URL 缓存、三网与深度解析统一走 IP 内核校验与排序、所有 DNS 来源统一截断、`A`/`AAAA` 备注写入与刷新        |
| `src/routes/api.ts`             | 修改 | 域名/来源输入校验、SQL 列扩展、探测扩展、设置校验                                                                            |
| `src/routes/github-proxy.ts`    | 修改 | 订阅代理白名单扩展至派生伴生路径（`x.txt` → `x-v6.txt`），读行为与主文件一致                                                 |
| `src/ui/templates.js`           | 修改 | 域名弹窗输入类型/URL/解析配置；IP 源弹窗解析配置；设置页上限；探测展示 v4/v6；实施前必读 `docs/ui-templates-refactor.md` §10 |
| `src/ui/dashboard-render.js`    | 修改 | 域名卡片展示 URL 来源与解析模式；IP 源卡片展示解析模式                                                                       |
| `README.md`                     | 修改 | 功能说明、API 文档、表结构、设置项                                                                                           |
| `GLOSSARY.md`                   | 修改 | 新增"IP 输入类型 / 解析模式 / 伴生文件"等术语                                                                                |
| `test/ip-util.test.ts`          | 新增 | 校验、归一、去重、排序、截断                                                                                                 |
| `test/ip-parse.test.ts`         | 新增 | 四种解析模式正反例、路径非法、正则防护、512KB 截断                                                                           |
| `test/ip-sources-fetch.test.ts` | 扩展 | 策略返回文本、v4/v6 结果、回退、伴生文件                                                                                     |
| `test/sync.test.ts`             | 扩展 | URL→DNS、缓存、截断、备注、异常语义                                                                                          |
| `test/api.test.ts`              | 扩展 | 新字段校验矩阵、投影、探测响应                                                                                               |
| `test/settings.test.ts`         | 扩展 | `MAX_IPS_PER_TYPE` 校验与回退                                                                                                |
| `test/migrations.test.ts`       | 扩展 | 新列幂等迁移                                                                                                                 |
| `test/github.test.ts`           | 扩展 | `deleteFileOnGitHub` 404/成功                                                                                                |
| `test/github-proxy.test.ts`     | 扩展 | 伴生路径可经代理读取；未登记路径 404；主文件与伴生文件缓存互不污染                                                           |
| `test/dashboard-render.test.ts` | 扩展 | 新字段展示与转义                                                                                                             |

不新增依赖、不新增表、不新增 D1 绑定、不新增 Secret。

## 11. 完整调用链

### 11.1 DNS 手动同步

```text
POST /api/domains/:id/sync
  → syncSingleDomain
    → syncDomainLogic
      → resolveRecordsForDomain
         ├ source_type=url
         │   → assertSafeHttpUrl
         │   → 策略链（返回正文）
         │   → parseContent(parse_mode, parse_param)
         │   → 严格校验 / 去重 / 排序
         ├ internal:hostmonit:*
         │   → fetchThreeNetworkIps → A[]
         ├ is_deep_resolve=1
         │   → resolveRecursively → A / AAAA / CNAME
         └ 浅层克隆 → CNAME
      → limitIpRecords(maxPerType)          // 仅 A/AAAA
      → updateCloudflareDns
         → 分页拉取现有记录
         → 差异比对（type/content/proxied/ttl）
         → 无增删：不产生任何写操作，返回 no_change
         → 有增删：PATCH 匹配记录 comment → DELETE 多余 → POST 新增（带 comment）
         // 备注 PATCH 排在集合变更之前，见 §13.1「备注 PATCH 失败 → 记录集合不变」
      → UPDATE domains（status / last_synced_records）
```

### 11.2 DNS 定时同步

```text
scheduled
  → next_sync_task = domains
    → syncScheduledDomains（失败优先 + BATCH_SIZE）
      → 读取 MAX_IPS_PER_TYPE（一次）
      → forEachIsolated(syncDomainLogic)
```

### 11.3 GitHub 手动同步

```text
POST /api/ip_sources/:id/sync
  → syncSingleIpSource
    → fetch 策略链（返回正文）
    → parseContent → { ipv4, ipv6 }
    → 主文件：ipv4.join("\n") → 比对 → PUT / no_change
    → 伴生路径：deriveIpv6Path(github_path)
       ├ ipv6 非空 → 比对 → PUT
       └ ipv6 为空 → 远端存在则 DELETE
    → UPDATE ip_sources（status）
```

### 11.4 调度轮转

保持不变：[index.ts](../src/index.ts#L63-L85) 在 `domains` 与 `ip_sources` 之间轮转，失败也轮转。

## 12. 校验、绑定、记录生成与状态

### 12.1 校验与去重

- URL：保存与抓取双重 SSRF；正文截断 512KB。
- IP：逐项严格校验；IPv4 四段 0–255；IPv6 锚定全串结构校验 + 规范化。
- 去重：IPv4 / IPv6 各自 `Set`。

### 12.2 绑定

- 仅限已配置的单个 Zone，目标为 `前缀 + Zone 名`。
- `target_domain` 的 UNIQUE 约束继续防止重复绑定。
- URL 类型绑定的展示名为 URL hostname；卡片展示完整 `source_url`。
- 系统预设域名不允许切换输入类型。

### 12.3 记录生成

- `A`（IPv4）、`AAAA`（IPv6）。
- `proxied=false`；TTL 取 `domains.ttl`。
- IPv4 / IPv6 先按 §7.3 校验、去重、排序，再各取前 N 条（N 默认 20）。
- CNAME 分支保持不变，不参与校验、排序、截断与备注。

### 12.4 变更时间备注

- 语义：`comment` 表示该记录集**最近一次变更时间**，不是最近一次同步时间。
- 格式：`DNS Clone 变更于 YYYY-MM-DD HH:mm`（北京时间，≤100 字符）。
- 仅 `A` / `AAAA` 写入；`CNAME` 不写。
- 仅当本次同步的记录集合发生增删时写入或刷新：
    - 新增记录随创建请求写入 `comment`；
    - 本次发生增删时，为匹配（保留）的记录 `PATCH /dns_records/:id` 刷新 `comment`。
- 记录集合未变的同步（`no_change`）**不产生任何 `PATCH`**，既有 `comment` 保持不变。
- 备注精确到分钟：同一分钟内的多次变更同步不会对同一记录重复 `PATCH`。

### 12.5 状态管理

不新增任务表、不新增状态机：

| 链路   | 状态字段                                                                                    |
| ------ | ------------------------------------------------------------------------------------------- |
| DNS    | `domains.last_sync_status` / `last_sync_error` / `last_synced_time` / `last_synced_records` |
| GitHub | `ip_sources.last_sync_status` / `last_sync_error` / `last_synced_time`                      |

## 13. 异常、日志与幂等

### 13.1 异常语义

| 场景             | DNS 侧                                                           | GitHub 侧                                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 抓取抛错         | 标 `failed`，**不改动现有 DNS 记录**                             | 标 `failed`，不提交                                                                                                                                                                                                                        |
| 成功但 0 条      | 上次有记录 → `failed`；上次为空 → `no_change`                    | 主文件按空内容处理：与远端比对后写入空内容（远端既有内容会被清空）。状态按通用口径由「本轮有没有写入」决定：写入了 → `success`，远端本来就是空内容 → `no_change`。与 DNS 侧刻意不对称：`ip_sources` 无 `last_synced_records`，不引入两分支 |
| 混合路径         | 不涉及（抓取层同上两行同一判定）                                 | 部分策略抛错 + 部分策略取得正文但 0 条：算「成功但 0 条」，**同样会清空远端主文件**。只要有一条策略成功取到正文，就不因其它策略的异常改判 `failed`，否则源站换页/代理抖动会把一次真实清空误记成抓取失败                                    |
| 仅 IPv6          | 生成 `AAAA`，删除旧 `A`                                          | 主文件写入空内容、伴生文件写入                                                                                                                                                                                                             |
| 仅 IPv4          | 生成 `A`，删除旧 `AAAA`                                          | 伴生文件为空则删除                                                                                                                                                                                                                         |
| 伴生文件写入失败 | 不涉及                                                           | 标 `failed`，下一轮按内容比对收敛                                                                                                                                                                                                          |
| 备注 PATCH 失败  | 视为本次同步失败，记录集合不变（`PATCH` 仅发生在有增删的同步中） | 不涉及                                                                                                                                                                                                                                     |
| 单条失败         | 不中断整批                                                       | 不中断整批                                                                                                                                                                                                                                 |

### 13.2 日志

- 统一 `beijingTimeLog` + SSE。
- 日志只写策略名、v4/v6 数量、目标域名/路径、错误摘要，不写正文内容。
- 解析失败时同时报告 IPv4 / IPv6 均未匹配。
- 备注写入/刷新记录条数（仅发生在有增删的同步中）。

### 13.3 幂等与重复执行

- GitHub：内容比对后跳过重复提交。
- DNS：记录集合比对后跳过重复增删；备注仅在记录集合变更时写入，未变不产生 `PATCH`（同分钟内多次变更同步对同一记录不重复 `PATCH`）。
- 伴生文件：内容相同跳过；为空且不存在时跳过删除。
- 手动同步锁防并发；批任务失败优先排序保证最终收敛。
- 动态抓取不落库，不存在缓存失效问题。

## 14. 权限与安全

- 所有新能力都在现有 `isAuthenticated` 之后，无新增公开端点。
- URL 保存与每次抓取都执行 `assertSafeHttpUrl`。
- 正文截断 512KB；`custom_regex` 长度与形态双重限制。
- 继续使用唯一 D1 绑定 `WUYA`；不新增 Secret、不回传 Token。
- 设置写入继续走白名单；`MAX_IPS_PER_TYPE` 只允许整数 1–200。
- UI 新增字段全部走现有转义函数，防止 XSS。
- 不记录响应正文、不把第三方错误体透传给浏览器。
- 已知边界：`assertSafeHttpUrl` 不剥离 URL userinfo，与现有 `ip_sources.url` 行为一致；本期不新增处理。

## 15. 测试与验收

### 15.1 单元测试

1. `test/ip-util.test.ts`
    - IPv4 段值边界、非法值拒绝；
    - IPv6 合法/非法、去方括号、大小写归一；
    - IPv6 误匹配反例：`::before`、`arr[::2]`、`IP=::1`、`[::1]:8080` 不得通过校验或被提取；
    - `::ffff:` 不重复计数；
    - 排序与截断。
2. `test/ip-parse.test.ts`
    - `auto` 处理 HTML / JSON / 纯文本；
    - `lines` 处理换行、逗号、空白；
    - `json_path` 处理对象、数组、`0` 索引、非法路径、非 JSON；
    - `custom_regex` 捕获组与命名组；
    - 512KB 截断；
    - ReDoS 形态拒绝。
3. `test/ip-sources-fetch.test.ts`
    - 策略返回文本后统一解析；
    - IPv4 / IPv6 结果与排序；
    - 回退命中与聚合错误文案；
    - 伴生路径派生与冲突检查；
    - 「成功但 0 条」返回空结果而非抛错（`emptyWhenNoIps`），不传该选项时仍抛 `[无可用IP]` 并逐条标注未匹配。
4. `test/github.test.ts`
    - `deleteFileOnGitHub` 成功、404 静默、非 404 透传。
5. `test/settings.test.ts`
    - `MAX_IPS_PER_TYPE` 合法/非法/缺失回退。
6. `test/migrations.test.ts`
    - 新列幂等 `ADD COLUMN`、版本门控。
7. `test/api.test.ts`
    - 域名与 IP 源新字段校验矩阵；
    - 投影包含新列；
    - 探测响应 v4/v6；
    - URL 类型派生 hostname；
    - 系统域名禁止切换输入类型。
8. `test/sync.test.ts`
    - URL→DNS 生成 A/AAAA；
    - 同批缓存只抓一次；
    - 三网与深度解析统一走 IP 内核校验与排序（乱序取最小 N、`::`/mapped/重复项不产出）；
    - 所有 DNS 来源截断；
    - 备注写入与 PATCH（仅有增删的同步写入，`no_change` 不产生任何 PATCH）；
    - 抓取失败不改记录、0 条两分支、仅 IPv6 删除旧 A；
    - IP 源「成功但 0 条」：三策略皆空正文时主文件写空内容并标 `success` 且清空 `last_sync_error`、连续两轮 0 条次轮转 `no_change`、全部策略抛错仍 `failed` 且不发 PUT/DELETE、混合路径算 0 条。
9. `test/github-proxy.test.ts`
    - 伴生路径可经订阅代理读取，读行为与主文件一致；
    - 未登记路径（含未登记的 `-v6` 形态）仍返回 404；
    - 主文件与伴生文件缓存键互不污染。
10. `test/dashboard-render.test.ts`
    - 新字段展示与转义。

### 15.2 集成测试

沿用 `test/apply-migrations.ts` + D1 测试环境，跑通：

```text
添加 URL 类型目标（json_path）
  → 探测
  → 手动同步（mock 抓取与 Cloudflare API）
  → 断言 A/AAAA 数量、排序、截断
  → 断言 comment 写入
  → 再次同步（记录集合未变）断言 no_change 且不产生任何 PATCH
```

### 15.3 验收标准

- `pnpm verify` 全绿。
- 存量 8 个 IP 源：未出现 IPv6 时，主文件内容逐字节不变。
- 存量域名：浅层克隆逻辑不变；三网与深度解析改为走共享内核，属**有意收紧**——`%zone`、`::`、全零展开、IPv4-mapped 与越界 IPv4 会被过滤，结果按 §7.3 去重排序；另新增截断与备注。
- 新增 URL 输入可完成「抓取 → 解析 → 绑定 → DNS 记录」闭环。
- GitHub IPv6 伴生文件按规则创建与删除。
- IPv6 伴生文件可经订阅代理读取，未登记路径仍 404。
- 迁移在既有库上幂等，二次执行不报错。
- 不新增依赖、不新增表、不新增 Secret。

### 15.4 回归重点

- `internal:hostmonit:*` 三网分支与缓存语义。
- 浅层 CNAME 分支。
- 订阅器代理主文件读取。
- 手动同步锁与定时轮转。
- 设置页既有字段保存。

## 16. 实施步骤（按依赖排序）

1. **IP 基础模块**：新增 `src/util/ip.ts` 与单测。
2. **解析模块**：新增 `src/sync/ip-parse.ts` 与单测（四种模式 + 正则防护）。
3. **迁移与投影**：`migrations.ts` 加列、版本号；`client.ts` 投影；迁移测试。
4. **设置项**：`settings.ts` 加 `MAX_IPS_PER_TYPE` 与校验；设置测试。
5. **GitHub 链路**：策略改为返回文本、统一解析、伴生文件写入/删除；`github.ts` 加删除能力；`github-proxy.ts` 白名单扩展至伴生路径；相关单测。
6. **DNS 链路**：`domains.ts` 加 URL 分支、同批缓存、全来源截断、备注写入与刷新；同步测试。
7. **API 层**：域名/IP 源/探测/设置校验与 SQL 扩展；API 测试。
8. **UI 层**：域名弹窗、IP 源弹窗、设置页、卡片展示；渲染与转义测试。
9. **文档**：更新 `README.md`、`GLOSSARY.md`。
10. **整体验证**：`pnpm verify`，并做 `pnpm dev` 手工走查。

## 17. 风险、边界与迁移

### 17.1 风险

1. **存量域名记录减少**：上限统一生效后，单类型超过 N 条的存量域名会在下一次同步删除多余记录。这是已确认行为，需要在发布说明中提示。
2. **备注写入调用量**：`comment` 仅在记录集合发生增删的同步中写入或刷新（新增随创建写入、匹配记录按需 `PATCH`），集合未变的同步不产生任何额外调用，常态调用量与现状持平。
3. **存量 IP 源新增伴生文件**：`auto` 提取 IPv6 后可能出现 `-v6.txt` 文件；主文件不受影响。
4. **伴生路径冲突**：派生路径可能与另一条源的 `github_path` 相同，保存时校验并返回 409。
5. **源站可用性**：URL 输入动态抓取，源站故障会导致该域名同步 `failed`；现有记录保留，恢复后自动收敛。
6. **正则防护不完备**：静态黑名单不能证明无 ReDoS，运行期 512KB 截断与超时是兜底。
7. **GitHub 空内容清空文件**：源站临时返回无 IP 的空页时，主文件会被写入空内容（远端既有内容被清空），订阅者将拉到空文件；下一轮抓取成功后自动收敛。该行为为已确认决策。

### 17.2 明确边界

- 仅一个 Cloudflare Zone，不支持任意第三方域名。
- 域名输入不产出 GitHub；GitHub 入口仅 URL。
- 输入仅域名与 URL，不含文件上传或粘贴文本。
- 不持久化提取的 IP。
- 不新增定时任务类型。
- 订阅代理白名单扩展至派生伴生路径（`x.txt` → `x-v6.txt`），读行为、缓存键与缓存策略与主文件一致；未登记路径仍 404。
- 不引入新依赖。

### 17.3 迁移说明

- 新列全部可空，旧数据无需回填。
- `MIGRATION_VERSION` 更新后，已部署实例首次请求即执行迁移，不受 24h 门控延迟。
- 回滚只需回退代码；新增列保留不影响旧代码读取（列表接口使用显式列投影，同步路径 `SELECT *` 对多余列无感知）。
