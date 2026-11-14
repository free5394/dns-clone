# dns-clone

Cloudflare Worker 项目：域名克隆（DNS 同步）与 IP 聚合（推送到 GitHub）。

## Language

**哨兵值**:
`wrangler.toml` 中 `database_id` 的约定"未配置"标记 —— 取值与 `REPLACE_WITH_YOUR_D1_ID` 相同（忽略大小写与首尾空白）即视为未替换。它只为标识"忘了替换"，不代表其它取值格式有问题；格式与存在性由 wrangler / Cloudflare 在部署期负责。
_Avoid_: 占位符、placeholder、非法值、格式错误、部署就绪

**IP 输入类型**（source type）:
一个克隆目标「IP 从哪来」的分类，落库在 `domains.source_type`，取值只有两种：`domain`（直接给一个域名，靠 DNS 解析或 CNAME 克隆取 IP）与 `url`（给一个 http(s) 地址，抓正文后按解析模式取 IP）。列可空，`NULL` 与未知值在读取侧一律按 `domain` 处理，因此存量数据不需要回填。`url` 类型由 URL 的 hostname 派生 `source_domain`，且**固定关闭深度解析**（深度解析追踪的是 CNAME 链，对「抓一个 IP 列表接口」没有意义）。系统预设目标的输入类型不可切换。`ip_sources` 表没有这一列——IP 源本身就是 URL 输入，不存在域名输入。
_Avoid_: 来源类型、输入来源、输入方式、source kind、domain/url 模式

**解析模式**（parse mode）:
从抓取到的响应正文里取出 IP 的策略，落库在同名列 `parse_mode`，`domains` 与 `ip_sources` 语义一致。四个取值：`auto`（全文提取，兼容 HTML / JSON / 纯文本，默认）、`lines`（按行与逗号 / 空白切 token）、`json_path`（点路径取值）、`custom_regex`（取命名组 `ip`，没有则取捕获组 1）。参数存在 `parse_param`：只有 `json_path`（≤512 字符）与 `custom_regex`（≤200 字符）使用，其余模式归一为 `NULL`。列可空，`NULL` / 空串 / 未知值在读取侧一律按 `auto`。定义与校验集中在 `src/sync/ip-parse.ts`（`PARSE_MODES` / `normalizeParseMode` / `validateParseConfig`）。
_Avoid_: 提取方式、抓取模式、fetch mode、parser 类型

**伴生文件**（companion file）:
与某个 IP 源的**主文件**配对、承载其 IPv6 列表的 GitHub 文件。路径由主文件 `github_path` 派生：以 `.txt` 结尾则去掉尾部 `.txt` 再加 `-v6.txt`（`ip.txt` → `ip-v6.txt`），否则直接追加 `-v6`（`ip` → `ip-v6`）。派生规则由 `src/sync/github.ts` 的 `deriveCompanionPath` 唯一定义，反向识别用 `companionSourceCandidate`。IPv6 列表非空时写入/更新，为空则删除远端文件；主文件与伴生文件共用同一份 Git 路径命名空间，两者不得互相占用（保存时双向校验，冲突返回 409）。
_Avoid_: v6 文件、副文件、附属文件、第二文件
