# dns-clone

Cloudflare Worker 项目：域名克隆（DNS 同步）与 IP 聚合（推送到 GitHub）。

## Language

**哨兵值**:
`wrangler.toml` 中 `database_id` 的约定"未配置"标记 —— 取值与 `REPLACE_WITH_YOUR_D1_ID` 相同（忽略大小写与首尾空白）即视为未替换。它只为标识"忘了替换"，不代表其它取值格式有问题；格式与存在性由 wrangler / Cloudflare 在部署期负责。
_Avoid_: 占位符、placeholder、非法值、格式错误、部署就绪

**伴生文件**（companion file）:
与某个 IP 源的**主文件**配对、承载其 IPv6 列表的 GitHub 文件。路径由主文件 `github_path` 派生：以 `.txt` 结尾则去掉尾部 `.txt` 再加 `-v6.txt`（`ip.txt` → `ip-v6.txt`），否则直接追加 `-v6`（`ip` → `ip-v6`）。派生规则由 `src/sync/github.ts` 的 `deriveCompanionPath` 唯一定义，反向识别用 `companionSourceCandidate`。IPv6 列表非空时写入/更新，为空则删除远端文件；主文件与伴生文件共用同一份 Git 路径命名空间，两者不得互相占用（保存时双向校验，冲突返回 409）。
_Avoid_: v6 文件、副文件、附属文件、第二文件
