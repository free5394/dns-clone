# dns-clone

Cloudflare Worker 项目：域名克隆（DNS 同步）与 IP 聚合（推送到 GitHub）。

## Language

**哨兵值**:
`wrangler.toml` 中 `database_id` 的约定"未配置"标记 —— 取值与 `REPLACE_WITH_YOUR_D1_ID` 相同（忽略大小写与首尾空白）即视为未替换。判定它只为拦住"忘了替换"，不代表其它取值格式有问题。
_Avoid_: 占位符、placeholder、非法值、格式错误

**部署就绪**:
`wrangler.toml` 通过 `scripts/predeploy.cjs` 校验的状态：每个 `[[d1_databases]]`（含 `[[env.<name>.d1_databases]]`）的 `database_id` 都已替换哨兵值且非空。它**不含**取值格式判定 —— 格式与存在性由 wrangler / Cloudflare 在部署期负责。
_Avoid_: 配置正确、校验通过
