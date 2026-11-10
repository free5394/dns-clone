# 部署配置与「生产为唯一真相源」

本文回答两件事：

1. 为什么仓库里的 `wrangler.toml` **故意**与线上部署不一致；
2. 线上怎么部署，以及为什么**不做生产 / 本地双向同步**。

面向普通用户的网页部署流程见 [README](../README.md) 的「网页部署指南（纯小白教程）」一节；本文只服务维护者与想自助部署的开发者。

## 一句话口径

- 仓库提交态的 `wrangler.toml` 是**模板**：`database_id` 永远是哨兵值 `REPLACE_WITH_YOUR_D1_ID`（定义见 [GLOSSARY](../GLOSSARY.md)），真实值不入库。
- 线上部署用维护者本机的 `wrangler.prod.toml` + `.env.prod`。两者已被 `.gitignore` 的 `wrangler.*.toml` / `*.env.*` 条目忽略，**真实值不写进仓库，也不写进任何文档**。
- **生产 D1 是唯一真相源**：不做生产 ↔ 本地双向同步，本地库只作开发夹具。

## 两份配置各是什么

| 文件                               | 是否入库   | 作用                                                          | `database_id`      |
| ---------------------------------- | ---------- | ------------------------------------------------------------- | ------------------ |
| `wrangler.toml`                    | 是         | `pnpm dev` / `pnpm cf-typegen` / 自助部署模板（含逐字段注释） | 哨兵值             |
| `wrangler.prod.toml` + `.env.prod` | 否（忽略） | 维护者本机的线上部署配置与 Token                              | 真实值（只在本机） |

线上那份与仓库那份只差两处，其余字段一致：

1. **`name`**：线上是 `cf-dns-clon`，仓库是 `dns-clone`（以 `pnpm exec wrangler deployments list` 的实际输出为准）；
2. **`database_id`**：线上填真实值，仓库保留哨兵值。

## 为什么故意不一致

- **不泄露部署指纹**：公开仓库里不放真实 D1 ID；ID 配合账号信息足以定位具体资源。
- **防止误部署**：仓库配置的 `name` 与线上不同，`database_id` 又是哨兵值，直接 `pnpm run deploy` 会在 wrangler / Cloudflare 的部署期失败，发不到生产。
- **模板必须可填空**：仓库配置同时服务自助部署的人，只能保留哨兵值；真实值属于维护者本机。
- **CI 与脚本无法误触线上**：`.github/workflows/ci.yml` 没有部署步骤；只要不显式传 `--config wrangler.prod.toml`（或走 `pnpm run deploy:prod`），任何默认读 `wrangler.toml` 的命令都到不了线上 Worker。

## 部署

### 维护者：发布到线上（唯一正确路径）

前置：Node ≥ 22（`package.json#engines`）、已 `pnpm install`；本机存在 `wrangler.prod.toml`（真实 `name` / `database_id`）与 `.env.prod`（账号级 `CLOUDFLARE_API_TOKEN`，模板：Edit Cloudflare Workers）。两者均不入库；换机时按上文两处差异重建，不要从仓库找真实值。

```bash
# 1. 确认本机生产配置与凭据存在
ls wrangler.prod.toml .env.prod

# 2. 先 dry-run：验证配置、入口路径与打包，不产生上传（额外参数透传给 wrangler）
pnpm run deploy:prod --dry-run --outdir .scratch/wrangler-dry-run

# 3. 正式发布（会真实上传并切换线上版本）
pnpm run deploy:prod
```

第 2 步实测输出（wrangler 4.157.0，2026-11-09，当时经旧路径 `--config .scratch/wrangler.deploy.toml` 实测，与新命令产物等价）：

```text
Total Upload: 169.88 KiB / gzip: 42.65 KiB
Your Worker has access to the following bindings:
Binding                 Resource
env.WUYA (wuya-db)      D1 Database

--dry-run: exiting now.
```

- 发布前的闸门是第 2 步的 dry-run 加上人工确认（原 `pnpm predeploy` 占位符校验脚本已删除）。
- 第 3 步本轮**未执行**（会真实发布）。依据：与第 2 步是同一条命令，只去掉 `--dry-run`；`pnpm exec wrangler deploy --help` 确认 `--config` / `--dry-run` / `--outdir` 都是受支持参数。
- 真实 D1 ID 忘了时用 `pnpm exec wrangler d1 list` 查（需已认证；本轮未执行）。

### 自助部署自己的实例

```bash
# 1. 创建 D1 数据库，记下返回的 database_id（会真实创建资源；本轮未执行）
pnpm dlx wrangler d1 create wuya-db

# 2. 把 database_id 填入 wrangler.toml，替换哨兵值 REPLACE_WITH_YOUR_D1_ID
#    （自助部署建议同时把 name 改成你自己的 Worker 名）
$EDITOR wrangler.toml

# 3. 复制 .env.example 为 .env 并填入账号级 Token（.env 已被 .gitignore 忽略）
#    cp .env.example .env  然后改 CLOUDFLARE_API_TOKEN
#    获取：CF Dashboard → 我的个人资料 → API Tokens → Edit Cloudflare Workers

# 4. 部署（显式调用 package.json 的 deploy 脚本；哨兵值未替换会在部署期报错）
pnpm run deploy
```

`pnpm run deploy` 由 `scripts/load-deploy-env.cjs` 注入 `.env` 的 Token 并调用 `wrangler deploy`（默认读仓库根 `wrangler.toml`）。`wrangler.toml` 里的 `keep_vars = true` 会保留 Dashboard 手配的 Variables / Bindings。

### 本文命令的验证记录

> 下表为 2026-11-09 的历史记录，当时命令仍是 `.scratch/wrangler.deploy.toml` + `pnpm predeploy` 形态；本轮切换到 `pnpm run deploy:prod` 后尚未复测。

| 命令 / 检查                                                                                                     | 状态   | 结果或依据                                 |
| --------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| `ls .scratch/wrangler.deploy.toml`                                                                              | 已执行 | 文件存在（494 字节，未入库）               |
| `pnpm exec wrangler deploy --config .scratch/wrangler.deploy.toml --dry-run --outdir .scratch/wrangler-dry-run` | 已执行 | 见上方输出，exit 0                         |
| `pnpm predeploy` / `pnpm run deploy`                                                                            | 已执行 | exit 1，报哨兵值未替换                     |
| `pnpm exec wrangler deploy --help`                                                                              | 已执行 | 确认 `--config` / `--dry-run` / `--outdir` |
| `pnpm exec wrangler d1 list --help`                                                                             | 已执行 | 确认 `d1 list` 子命令存在                  |
| `pnpm exec wrangler deploy --config ...`（去掉 `--dry-run`）                                                    | 未执行 | 会真实发布                                 |
| `pnpm dlx wrangler d1 create wuya-db`                                                                           | 未执行 | 会真实创建云资源                           |
| `pnpm exec wrangler d1 list`                                                                                    | 未执行 | 需已认证账号                               |
| `.gitignore` 核对                                                                                               | 已执行 | `.scratch/` 被忽略；`.env` 被 `*.env` 忽略 |

## 生产为唯一真相源，不做双向同步

- **生产数据只认 Cloudflare D1**（绑定 `env.WUYA`）。本地 `.wrangler/state/v3/d1/` 是 `pnpm dev` 的临时夹具，可随时删除重建，不承载任何「真实」数据。
- 仓库没有、也不计划提供 `wrangler d1 export` / `import` 之类的生产 ↔ 本地同步脚本（`scripts/` 与 `package.json` 里都没有）。双向同步会把本地手滑写入放大成生产事故，而两边的 schema 版本未必同步。
- **表结构由 Worker 自己对齐**：请求入口调用 `src/db/migrations.ts` 的 `initializeAndMigrateDatabase`，用幂等 DDL + 24h 时间门控 + 迁移版本戳收敛，不依赖手工 `wrangler d1 migrations apply`。部署后首次访问即完成建表 / 补列 / 补索引。
- 需要样本数据时在本地库用后台界面造；**不要**把生产数据导出到本地，也**不要**反向回灌。
- 线上排障读 Worker 日志与 D1 控制台；需要改生产数据时直接在 D1 控制台执行 SQL，改完不需要「同步回本地」。

## 常见错误

| 现象                                                                 | 原因                                        | 处理                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `database_id 仍是未替换的占位符`（wrangler / Cloudflare 部署期报错） | 用提交态 `wrangler.toml` 直接部署           | 维护者走 `wrangler.prod.toml`（`pnpm run deploy:prod`）；自助部署填入自己的 ID |
| `--config` 报入口文件不存在                                          | 不在仓库根执行，或配置文件被移动            | 回到仓库根执行；相对路径以配置文件所在目录为基准                               |
| `未找到 .env.prod` / `未找到 wrangler.prod.toml`                     | `deploy:prod` 依赖这两个本机文件            | 分别按 `.env.example` 与提交态 `wrangler.toml` 模板创建（均不入库）            |
| `未检测到 CLOUDFLARE_API_TOKEN`                                      | 对应 `.env` / `.env.<env>` 没有该变量或为空 | 复制 `.env.example` 为对应文件，写入账号级 Token                               |
| 部署后 500 / 日志 `no such table: settings`                          | D1 绑定缺失或库未被初始化                   | 确认绑定名是 `WUYA`；更新到最新代码后首次访问会触发幂等建表                    |

日常静态校验仍是 `pnpm check`；部署前的最后一道闸门是 dry-run（`pnpm run deploy:prod --dry-run`，线上路径由脚本注入 `--config wrangler.prod.toml`）。
