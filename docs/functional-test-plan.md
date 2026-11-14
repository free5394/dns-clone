# dns-clone 功能测试方案（AI agent 可执行版）

- 状态：待执行（执行后回填 §9 报告）
- 日期：2026-11-14
- 版本：v1
- 范围：`src/` 下全部已实现功能（API、同步、UI、定时任务），含正常流程、异常流程、关键边界
- 基线：本仓库当前工作树（branch `dev`）；技术栈 Cloudflare Worker（无服务器边缘运行时）+ D1（Cloudflare 的 SQLite 数据库服务）
- 执行者：AI agent（可重复执行）；复核人按 §9 报告验收
- 关联文档：`AGENTS.md`（实现红线）、`CODING_STANDARDS.md`（编码与错误响应规则）、`docs/ip-fetch-unification-plan.md`（IP 抓取与解析语义的真相源）

## 0. 执行者契约（动手前必读）

### 0.1 硬性约定

1. 一次只跑一个用例组；每完成一个用例**立即**追加一行到 `results.jsonl`，禁止批量补记。
2. 判定只有四种：`PASS` / `FAIL` / `BLOCKED` / `SKIP`，定义见 0.4，不存在「大概通过」。
3. 任何 `FAIL` 必须附证据（请求、响应原文、HTTP 状态码、日志或截图）。无证据的 FAIL 视为无效，重跑一次再判。
4. **不改产品代码**。发现缺陷只记录不修复。标 `[E2]` 的用例会触碰真实 Cloudflare / GitHub 资源，失败即停该组并记录，不得重试风暴（同一用例最多重试 1 次）。
5. 每个阶段结束写一条 checkpoint 到 `run.log`，格式见 0.3。
6. 禁止 `git commit` / `git push` / 部署；禁止 `git restore .`、`git checkout .`、`git clean -fd`（本仓库曾因此丢掉未提交改动）。
7. 禁止读取 `~/.dsh/.credentials.yaml`；凭据只从环境变量或用户当次提供的内容获取，不入库、不进日志。
8. 用例表「预期结果」列是**唯一判定依据**；文案按逐字符匹配（含中文全角标点），该行写明「包含」时按子串匹配。

### 0.2 占位符与变量

执行前导出（E1 本地只需前两项）：

| 变量                           | 含义                                         | 来源                                    |
| ------------------------------ | -------------------------------------------- | --------------------------------------- |
| `BASE_URL`                     | 被测入口，E1 默认 `http://127.0.0.1:8787`    | `pnpm dev` 输出                         |
| `TEST_PASSWORD`                | 测试管理员密码，长度 8–1024                  | 执行者自定，E1 首次 `/api/setup` 时设置 |
| `CF_API_TOKEN`                 | Cloudflare API Token（「编辑区域 DNS」模板） | 用户提供，仅 E2                         |
| `CF_ZONE_ID`                   | 目标区域 ID                                  | 用户提供，仅 E2                         |
| `ZONE_NAME`                    | 该区域已托管的域名                           | 用户提供，仅 E2                         |
| `GITHUB_TOKEN`                 | 具备目标仓库读写权限的 Token                 | 用户提供，仅 E2                         |
| `GITHUB_OWNER` / `GITHUB_REPO` | 测试仓库归属与名称                           | 用户提供，仅 E2                         |
| `RUN_DIR`                      | `.scratch/functional-test/<RUN_ID>`          | §4.1 创建                               |

> 缺少 E2 凭据时，所有 `[E2]` 用例判 `BLOCKED` 并在报告 §5 统计，不得用假 Token 冒充通过。

### 0.3 中断与恢复

每个阶段结束把下面一行写入 `$RUN_DIR/run.log`：

```text
[CHECKPOINT] stage=P3 case=TC-DOM-14 result=PASS pass=13 fail=0 blocked=0 ts=2026-11-14T15:02:11+08:00
```

恢复执行时先 `tail -n 5 $RUN_DIR/run.log`，从最后一个 checkpoint 的**下一个**用例继续；已 PASS 的用例不重跑（除 §8 的回归集要求）。

### 0.4 判定定义

| 判定      | 条件                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `PASS`    | 实际结果与「预期结果」逐字符一致，且证据已落盘                                        |
| `FAIL`    | 状态码或响应体与预期不符；即使行为「看起来合理」也算 FAIL（以文档为准，不以直觉为准） |
| `BLOCKED` | 环境或凭据不足导致无法判定（如缺 CF Token、外部源不可达）；必须写明阻塞原因           |
| `SKIP`    | 按 §1.3 明确排除的项，或经用户书面同意跳过；SKIP 需在报告列出                         |

## 1. 测试目标与范围

### 1.1 目标

1. 验证 13 个功能模块（§3）在正常流程下全部可用，API 与 UI 行为一致。
2. 验证全部写入路径的校验矩阵：错误输入必须被拒绝，且返回的**状态码与中文文案**与实现一致（§5 逐条列出）。
3. 验证鉴权边界：未登录一律 401、会话过期失效、登录失败限流生效。
4. 验证同步链路的隔离性：单条失败不中断整批；失败与成功状态正确落库；并发手动同步被互斥锁挡住。
5. 产出可复核的证据链与缺陷清单，形成 §9 报告，缺陷可被第三方按记录复现。

### 1.2 范围内

- HTTP API：`/api/status`、`/api/setup`、`/api/login`、`/api/logout`、`/api/settings`、`/api/domains*`、`/api/ip_sources*`、未知端点 404。
- 同步逻辑：深度解析、浅层克隆、URL 抓取、系统内置三网源、IP 源抓取与 GitHub 推送、SSE（Server-Sent Events，服务端事件流）进度流。
- 订阅代理：`/{owner}/{repo}/{path}`。
- UI：初始化页、登录后后台三页（域名克隆 / GitHub 上传 / 系统设置）、公开首页、表单联动与按钮禁用条件。
- 平台行为：D1 迁移门控、`scheduled` 定时任务轮转、`login_attempts` 清理。
- 边界：长度上限（URL 2048、GitHub 路径 512、提交信息 200、正则 200、JSON 路径 512）、数值范围（TTL、BATCH_SIZE 1–100、MAX_IPS_PER_TYPE 1–200）、空值与 `null` 语义、CNAME 深度 10 层、正文截断 512KB。

### 1.3 范围外（不判缺陷）

| 项目                                          | 原因                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 性能与压力测试（并发数、QPS 上限）            | 需要负载模型，另立方案                                                                   |
| 安全渗透（越权横向、注入攻击面挖掘）          | 另立安全评审；本方案只验证既定 SSRF（Server-Side Request Forgery，服务端请求伪造）黑名单 |
| 多浏览器 / 移动端兼容矩阵                     | 本方案只要求 Chromium 内核浏览器单点验证                                                 |
| `wrangler` 部署流水线本身（构建、发布、回滚） | 属发布流程，不在功能范围                                                                 |
| Cloudflare / GitHub 上游服务自身故障注入      | 不可控外部依赖，只在 §5 记录可观测表现                                                   |

### 1.4 完成定义（DoD）

同时满足才算本轮测试完成：

1. §5 全部用例都有判定（PASS / FAIL / BLOCKED / SKIP），无 `PENDING`。
2. 每条 FAIL 在 `defects.jsonl` 有对应条目，且 `TC` 编号双向可查。
3. §8 规定的回归集在缺陷修复后**重跑并全绿**（仅当本轮有缺陷修复时）。
4. §9 报告已回填，含统计表、缺陷表、阻塞项与结论。

## 2. 测试环境与前置条件

### 2.1 环境画像

| 编号 | 环境                            | 入口                    | 数据                                            | 凭据                          | 适用用例                                                                  |
| ---- | ------------------------------- | ----------------------- | ----------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| E1   | 本地 workerd（`pnpm dev`）      | `http://127.0.0.1:8787` | 本地 D1，落在 `.wrangler/state/d1/`，与线上隔离 | 无需真实 CF / GitHub          | 全部不触达外部网络的用例（默认主体）                                      |
| E2   | 预发布 Worker 或本地 + 真实凭据 | 用户提供的 URL 或 E1    | 真实 D1                                         | CF Token + Zone、GitHub Token | 标 `[E2]` 的用例：域名写入派生、记录查询、真实同步、GitHub 推送、订阅代理 |

说明：产品代码没有「离线 mock 开关」，外部 HTTP 依赖（Cloudflare API、GitHub API、抓取源）只能靠真实凭据或不可达自然失败来覆盖。因此 E1 覆盖校验、鉴权、UI、数据库与 404/401 类路径，E2 覆盖真实读写外部资源的路径。

### 2.2 前置检查（逐条执行，任一失败先修环境）

```bash
node -v                 # 期望 v22 以上（仓库 volta 固定 24）
pnpm -v                 # 期望 11 以上
pnpm install            # 首次或依赖变更后
pnpm check              # 期望 exit=0；记录耗时
pnpm test               # 期望全绿；记录用例数与耗时
echo exit=$?
```

> `pnpm test` 与 `pnpm dev` 同时运行时 worker 偶发启动失败，需要确定性结果时**先停 dev server** 再跑测试。
> 只跑单个测试文件用 `pnpm exec vitest run test/<file>.test.ts`；`pnpm test -- <file>` 不会过滤，会跑全量。

### 2.3 状态重置（每次全新一轮执行前）

E1 清空本地库，恢复「未初始化」状态：

1. 停掉 `pnpm dev`（Ctrl+C）。
2. 删除本地 D1 状态目录：`rm -rf .wrangler/state/v3/d1`（Windows 可用 `Remove-Item -Recurse -Force .wrangler\state\v3\d1`）。
3. 重新 `pnpm dev`，访问 `/api/status` 期望 `{"isInitialized":false}`。

E2 不得重置用户数据；如需干净区域，由用户新建独立测试区域与仓库。

### 2.4 凭据与安全

- 测试密码、Token 一律用环境变量传入，禁止写入仓库文件、`results.jsonl` 或日志。
- 证据目录里出现的 `Set-Cookie` 必须先脱敏（把 session 值替换为 `<REDACTED>`）再落盘。
- 禁止读取 `~/.dsh/.credentials.yaml`。

### 2.5 已知平台坑（会直接导致误判，先读）

| 坑                                            | 现象                                                                   | 处理                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session` Cookie 带 `Secure` 属性             | 用 `curl -c/-b` 在 `http://` 下会存不下/不回传，表现为所有鉴权接口 401 | **不要用 cookie jar**，登录后从 `Set-Cookie` 提取 token，后续用 `-H "Cookie: session=$SESSION"` 显式传 |
| Windows Git Bash 下 `chmod`、POSIX 权限位无效 | 钩子/脚本「看起来可执行」但实际不生效                                  | 钩子可用性用「跑一遍看退出码」判定，不看权限位                                                         |
| SSE 长连接                                    | `curl` 默认等到连接关闭，期间无输出会像卡住                            | 用 `curl -sS -N --max-time <秒>` 并 `tee` 到文件；把事件序列当证据，不要用 `-s` 静默                   |
| 中文输出乱码                                  | Windows 控制台代码页不匹配                                             | 命令前 `export LANG=zh_CN.UTF-8`，或将响应体写入文件后用 `read` 工具读取                               |
| 外部源不可达                                  | 探测/同步用例超时或全策略失败                                          | 判 `BLOCKED` 并记录目标 URL 与错误，不判产品缺陷                                                       |

## 3. 功能模块清单

| 编号 | 模块                    | 源码位置                                                                                       | 对外入口                                                                                   | 用例前缀  | 外部依赖                                     |
| ---- | ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------- | -------------------------------------------- |
| M1   | 初始化与鉴权            | `src/routes/api.ts`（setup / login / logout）、`src/util/auth.ts`                              | `GET /api/status`、`POST /api/setup`、`POST /api/login`、`POST /api/logout`                | `TC-AUTH` | 无                                           |
| M2   | 系统设置                | `src/routes/api.ts`（settings 读写）、`src/util/batch-size.ts`、`src/util/max-ips-per-type.ts` | `GET/POST /api/settings`                                                                   | `TC-SET`  | 保存 CF 配置时调 Cloudflare API              |
| M3   | 域名克隆目标 CRUD       | `src/routes/api.ts:433` 起 `handleDomainMutation`                                              | `GET/POST /api/domains`、`PUT/DELETE /api/domains/{id}`                                    | `TC-DOM`  | 写入需 CF 配置（派生 `target_domain`）       |
| M4   | DNS 记录查询            | `src/routes/api.ts`（records）                                                                 | `GET /api/domains/{id}/records`、`GET /api/domains/records`                                | `TC-REC`  | CF                                           |
| M5   | 域名同步                | `src/sync/domains.ts`                                                                          | `POST /api/domains/{id}/sync`、`POST /api/sync`、`POST /api/domains/sync_system`（均 SSE） | `TC-SYN`  | CF + DoH 解析                                |
| M6   | IP 源 CRUD              | `src/routes/api.ts:660` 起                                                                     | `GET/POST /api/ip_sources`、`PUT/DELETE /api/ip_sources/{id}`                              | `TC-IPS`  | 无                                           |
| M7   | IP 源探测               | `src/sync/ip-sources.ts`（策略探测）                                                           | `POST /api/ip_sources/probe`                                                               | `TC-PRB`  | 外网抓取源                                   |
| M8   | IP 源同步与 GitHub 推送 | `src/sync/ip-sources.ts`、`src/sync/github.ts`                                                 | `POST /api/ip_sources/{id}/sync`、`POST /api/ip_sources/sync_all`（SSE）                   | `TC-IPU`  | 外网 + GitHub                                |
| M9   | 订阅代理                | `src/routes/github-proxy.ts`                                                                   | `GET /{owner}/{repo}/{path}`                                                               | `TC-PRX`  | GitHub                                       |
| M10  | 公开首页                | `src/routes/ui.ts`、`src/ui/templates.js`                                                      | `GET /`                                                                                    | `TC-PUB`  | 无                                           |
| M11  | 管理后台 UI             | `src/ui/templates.js`、`src/routes/ui.ts`                                                      | `GET /admin`                                                                               | `TC-UI`   | 无                                           |
| M12  | 定时任务与迁移          | `src/index.ts`（`scheduled`）、`src/db/migrations.ts`                                          | Cloudflare Cron `0,30 * * * *`                                                             | `TC-SCH`  | 触发需 E2 或 `wrangler dev --test-scheduled` |
| M13  | 错误响应与兜底          | `src/index.ts` 全局兜底、`src/util/error-response`                                             | 任意路径                                                                                   | `TC-ERR`  | 无                                           |

## 4. 执行准备

### 4.1 目录结构

```text
.scratch/functional-test/<RUN_ID>/
├── run.log                 # checkpoint 与阶段摘要
├── results.jsonl           # 每个用例一行判定
├── defects.jsonl           # 每个缺陷一行（§7 字段）
├── session.txt             # 登录后的 session token（脱敏前，禁止入库）
├── api.sh                  # 本文件 §4.2 的请求封装
└── evidence/<TC-ID>/       # 每个用例一份：req.txt、resp.txt、code.txt、可选的 sse.log / shot.png
```

创建命令：

```bash
export RUN_ID=$(date +%Y%m%d-%H%M%S)
export RUN_DIR=".scratch/functional-test/$RUN_ID"
mkdir -p "$RUN_DIR/evidence"
: > "$RUN_DIR/results.jsonl"; : > "$RUN_DIR/defects.jsonl"; : > "$RUN_DIR/run.log"
```

### 4.2 请求封装（写入 `$RUN_DIR/api.sh`，每轮 source 一次）

```bash
# 用法：source $RUN_DIR/api.sh；然后 call GET /api/domains 或 call POST /api/domains '{"...":...}'
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
JV_EVID=""   # 当前用例证据目录，执行用例前设置：JV_EVID=$RUN_DIR/evidence/TC-DOM-01

call() {
  local method="$1" path="$2" body="${3:-}"
  local code
  if [ -n "$body" ]; then
    code=$(curl -sS -o "$JV_EVID/resp.txt" -w "%{http_code}" -X "$method" "$BASE_URL$path" \
      -H "Content-Type: application/json" -H "Cookie: session=$SESSION" --data "$body")
    printf "%s %s\nBODY: %s\n" "$method" "$path" "$body" > "$JV_EVID/req.txt"
  else
    code=$(curl -sS -o "$JV_EVID/resp.txt" -w "%{http_code}" -X "$method" "$BASE_URL$path" \
      -H "Cookie: session=$SESSION")
    printf "%s %s\n" "$method" "$path" > "$JV_EVID/req.txt"
  fi
  printf "%s\n" "$code" > "$JV_EVID/code.txt"
  printf "HTTP %s %s %s\nBODY: %s\n" "$code" "$method" "$path" "$(cat "$JV_EVID/resp.txt")"
}

# SSE：单独函数，避免 call 的响应缓冲
call_sse() {
  local path="$1"
  curl -sS -N --max-time 120 -H "Accept: text/event-stream" -H "Cookie: session=$SESSION" \
    "$BASE_URL$path" | tee "$JV_EVID/sse.log"
}
```

> 若 shell 不支持 `local`，把函数体改成 `#!/usr/bin/env bash` 脚本执行；Windows 下用 Git Bash 运行。

### 4.3 断言方式

判定靠人眼/agent 比对，不做脚本断言，避免把断言逻辑写进被测仓库。比对三件事：

1. `code.txt` 的 HTTP 状态码；
2. `resp.txt` 中的 `error` / `success` 文案；
3. 需要时查库（见 4.4）确认持久化副作用。

### 4.4 查库（E1）

本地 D1 用 wrangler 查询（`pnpm dev` 运行中可用 `--local`）：

```bash
pnpm exec wrangler d1 execute wuya-db --local --command "SELECT id,target_domain,source_type,source_domain,ttl,is_deep_resolve,last_sync_status FROM domains ORDER BY id;"
pnpm exec wrangler d1 execute wuya-db --local --command "SELECT id,url,github_path,commit_message,fetch_strategy,parse_mode FROM ip_sources ORDER BY id;"
pnpm exec wrangler d1 execute wuya-db --local --command "SELECT key,value FROM settings ORDER BY key;"
pnpm exec wrangler d1 execute wuya-db --local --command "SELECT ip,success,created_at FROM login_attempts ORDER BY created_at DESC LIMIT 20;"
```

> 查询结果里的 `ADMIN_PASSWORD_HASH`、`PASSWORD_SALT` 属敏感值，落盘前打码；`sessions` 表只允许查数量，不导出 token。

## 5. 测试用例设计

### 5.0 公共约定

- 每个用例开始前：`JV_EVID="$RUN_DIR/evidence/<TC-ID>"; mkdir -p "$JV_EVID"`。
- 表中 `POST /api/setup` 之类均相对 `$BASE_URL`；请求体为 JSON，用单引号包裹整段。
- 登录一次即可复用 `$SESSION`；会话 24h 有效，遇到 401 先判断是会话过期（重新登录）还是缺陷（记录）。
- 标 `[E2]` 的用例需要真实 CF / GitHub 凭据，缺凭据判 `BLOCKED`。
- 「输入数据」列给出**最小充分输入**；省略的字段按实现默认值处理，需要验证默认值时用 4.4 查库确认。

### 5.1 M1 初始化与鉴权（`TC-AUTH`）

| 用例编号   | 类型 | 优先 | 步骤                                                             | 输入数据                           | 预期结果                                                                                                                                                                                 |
| ---------- | ---- | ---- | ---------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-AUTH-01 | 正常 | P0   | 清库后 `call GET /api/status`                                    | 无                                 | 200，响应体 `{"isInitialized":false}`                                                                                                                                                    |
| TC-AUTH-02 | 边界 | P0   | `call POST /api/setup`，密码 7 字符                              | `{"password":"1234567"}`           | 400，`{"error":"密码长度必须为 8 到 1024 个字符之间。"}`                                                                                                                                 |
| TC-AUTH-03 | 边界 | P0   | `call POST /api/setup`，密码 8 字符                              | `{"password":"12345678"}`          | 200，`{"success":true}`；再查 `/api/status` 为 `{"isInitialized":true}`                                                                                                                  |
| TC-AUTH-04 | 边界 | P1   | 密码 1024 字符再次 setup 前先重置库；用 1025 字符                | 1025 个 `a`                        | 400，同 TC-AUTH-02 文案                                                                                                                                                                  |
| TC-AUTH-05 | 异常 | P0   | 已初始化后再次 `call POST /api/setup`                            | `{"password":"12345678"}`          | 403，`{"error":"应用已经初始化。"}`                                                                                                                                                      |
| TC-AUTH-06 | 异常 | P1   | 清库后 `call POST /api/setup`，请求体为非法 JSON                 | `{bad json`                        | 400，`{"error":"请求体不是合法 JSON。"}`                                                                                                                                                 |
| TC-AUTH-07 | 异常 | P0   | 清库后（未初始化）`call POST /api/login`                         | `{"password":"12345678"}`          | 400，`{"error":"应用尚未初始化。"}`                                                                                                                                                      |
| TC-AUTH-08 | 正常 | P0   | 初始化后 `call POST /api/login`，正确密码                        | `{"password":"<TEST_PASSWORD>"}`   | 200，体含 `"success":true`；响应头 `Set-Cookie` 含 `session=`、`HttpOnly`、`Secure`、`Path=/`、`SameSite=Strict`、`Max-Age=86400`。把 token 写入 `$RUN_DIR/session.txt` 并导出 `SESSION` |
| TC-AUTH-09 | 异常 | P0   | `call POST /api/login`，错误密码                                 | `{"password":"wrong-password"}`    | 401，`{"error":"密码无效。"}`；查 `login_attempts` 新增一条 `success=0`                                                                                                                  |
| TC-AUTH-10 | 异常 | P0   | 不传 Cookie `call GET /api/domains`                              | 无                                 | 401，`{"error":"未授权"}`                                                                                                                                                                |
| TC-AUTH-11 | 边界 | P0   | 连续 5 次错误密码后，第 6 次仍用错误密码                         | `{"password":"wrong-password"}` ×6 | 前 5 次均 401；第 6 次 429，`{"error":"尝试过于频繁，请稍后再试。"}`                                                                                                                     |
| TC-AUTH-12 | 正常 | P1   | 触发限流后，用**正确密码**再登录                                 | `{"password":"<TEST_PASSWORD>"}`   | 仍 429（限流先于密码校验）；等待 5 分钟窗口后可 200，且 `login_attempts` 中该 IP 的失败记录被清空                                                                                        |
| TC-AUTH-13 | 正常 | P0   | 正确登录后用旧 token `call POST /api/logout`                     | 无                                 | 200；响应头 `Set-Cookie` 为 `session=;` + `Expires=Thu, 01 Jan 1970 00:00:00 GMT`；再用同一 token 访问 `/api/domains` 得 401                                                             |
| TC-AUTH-14 | 边界 | P1   | 伪造 `-H "Cookie: session=00000000-0000-0000-0000-000000000000"` | 无                                 | 401，`{"error":"未授权"}`                                                                                                                                                                |
| TC-AUTH-15 | 边界 | P2   | 手工把 `sessions.expires_at` 改为过去时间后访问                  | 无                                 | 401，且该 session 行被删除（查库确认）                                                                                                                                                   |

> TC-AUTH-11/12 会污染限流窗口，执行顺序放在本组最后；之后若需继续登录，先等 5 分钟或用另一个 `CF-Connecting-IP`（E1 下可用 `-H "CF-Connecting-IP: 203.0.113.9"` 隔离桶，仅用于测试分流）。

### 5.2 M2 系统设置（`TC-SET`）

| 用例编号  | 类型 | 优先 | 步骤                                                         | 输入数据                                                                                                    | 预期结果                                                                                                                                                                                                                                 |
| --------- | ---- | ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-SET-01 | 正常 | P0   | 登录后 `call GET /api/settings`                              | 无                                                                                                          | 200；响应体**不含** `ADMIN_PASSWORD_HASH`、`PASSWORD_SALT`、`CF_API_TOKEN`、`GITHUB_TOKEN`、`HOSTMONIT_API_KEY`、`MANUAL_SYNC_LOCK_KEY`；含 `MAX_IPS_PER_TYPE`、`zoneName`、`CF_CONFIGURED`、`GITHUB_CONFIGURED`、`HOSTMONIT_CONFIGURED` |
| TC-SET-02 | 正常 | P0   | `call POST /api/settings` 设置批大小                         | `{"BATCH_SIZE":10}`                                                                                         | 200，体含 `"success":true`；查库 `settings.BATCH_SIZE=10`                                                                                                                                                                                |
| TC-SET-03 | 边界 | P0   | 依次提交 `BATCH_SIZE` 为 1 / 100 / 0 / 101 / "10.5"          | `{"BATCH_SIZE":1}`、`{"BATCH_SIZE":100}`、`{"BATCH_SIZE":0}`、`{"BATCH_SIZE":101}`、`{"BATCH_SIZE":"10.5"}` | 1 与 100 → 200；0 / 101 / "10.5" → 400，`{"error":"BATCH_SIZE 必须为 1 到 100 之间的整数。"}`，且库中旧值不变                                                                                                                            |
| TC-SET-04 | 边界 | P0   | 依次提交 `MAX_IPS_PER_TYPE` 为 1 / 200 / 0 / 201             | 见左                                                                                                        | 1 与 200 → 200；0 / 201 → 400，`{"error":"MAX_IPS_PER_TYPE 必须为 1 到 200 之间的整数。"}`                                                                                                                                               |
| TC-SET-05 | 边界 | P1   | `MAX_IPS_PER_TYPE` 提交空串                                  | `{"MAX_IPS_PER_TYPE":""}`                                                                                   | 200；该行被清除；再 `GET /api/settings` 返回归一默认 `20`                                                                                                                                                                                |
| TC-SET-06 | 异常 | P0   | 提交非白名单键                                               | `{"FOO":"bar","BATCH_SIZE":10}`                                                                             | 200（不报错），但查库无 `FOO` 行，`BATCH_SIZE` 正常写入                                                                                                                                                                                  |
| TC-SET-07 | 边界 | P0   | 先写入 Secret，再用空串提交同一 Secret                       | `{"GITHUB_TOKEN":"ghp_test_placeholder"}` 然后 `{"GITHUB_TOKEN":""}`                                        | 两次均 200；查库 `GITHUB_TOKEN` 仍为 `ghp_test_placeholder`（空串不得误清 Secret）；`GITHUB_CONFIGURED` 保持 true 的前提是 owner/repo 也齐                                                                                               |
| TC-SET-08 | 边界 | P0   | 用 `null` 显式清除 Secret                                    | `{"GITHUB_TOKEN":null,"GITHUB_OWNER":null,"GITHUB_REPO":null}`                                              | 200；三行被删除；`GITHUB_CONFIGURED` 变 false；`/admin` 的「添加IP源」按钮回到 disabled（联动 TC-UI-05）                                                                                                                                 |
| TC-SET-09 | 异常 | P1   | 设置非 Secret 键为空串                                       | `{"BATCH_SIZE":""}`                                                                                         | 200 且该行被清除；读取时回退默认 10（不影响功能）                                                                                                                                                                                        |
| TC-SET-10 | 异常 | P0   | 只填 CF 两个键中的一个                                       | `{"CF_API_TOKEN":"placeholder-token"}`                                                                      | 400，`{"error":"Cloudflare API 令牌和区域 ID 必须同时配置。"}`                                                                                                                                                                           |
| TC-SET-11 | 异常 | P0   | GitHub 三件套只填两个                                        | `{"GITHUB_TOKEN":"x","GITHUB_OWNER":"o"}`                                                                   | 400，`{"error":"GitHub Token、Owner、Repo 必须同时配置。"}`                                                                                                                                                                              |
| TC-SET-12 | 边界 | P0   | 非法 BATCH_SIZE 与合法 GitHub 三件套同时提交（验证整批拒绝） | `{"GITHUB_TOKEN":"x","GITHUB_OWNER":"o","GITHUB_REPO":"r","BATCH_SIZE":999}`                                | 400 BATCH_SIZE 文案；查库 `GITHUB_OWNER` 未写入                                                                                                                                                                                          |
| TC-SET-13 | 异常 | P1   | `[E2]` 用无效 CF Token 提交配置                              | `{"CF_API_TOKEN":"invalid","CF_ZONE_ID":"<CF_ZONE_ID>"}`                                                    | 400，错误文案以 `Cloudflare API 验证失败: ` 开头（后半段随上游返回变化，按「包含」判定）                                                                                                                                                 |
| TC-SET-14 | 正常 | P1   | `[E2]` 提交有效 CF 配置                                      | `{"CF_API_TOKEN":"<CF_API_TOKEN>","CF_ZONE_ID":"<CF_ZONE_ID>"}`                                             | 200；`GET /api/settings` 的 `zoneName` 为 `<ZONE_NAME>`、`CF_CONFIGURED` 为 true                                                                                                                                                         |
| TC-SET-15 | 正常 | P1   | 切换三网源并观察联动                                         | `{"THREE_NETWORK_SOURCE":"api.uouin.com"}`                                                                  | 200；响应的 `data`/日志中出现 `sync_system` 触发痕迹（若无同步目标则无副作用）；公开首页展示名变为对应名称（联动 TC-PUB-03）                                                                                                             |
| TC-SET-16 | 边界 | P2   | 提交非法 `THREE_NETWORK_SOURCE` 值                           | `{"THREE_NETWORK_SOURCE":"foo.example"}`                                                                    | 200 保存；公开页展示为「未知」（该键无白名单校验，记录实际行为）                                                                                                                                                                         |

### 5.3 M3 域名克隆目标 CRUD（`TC-DOM`）

前置：已登录；`[E2]` 用例需 CF 配置就绪（TC-SET-14 通过）。

| 用例编号  | 类型 | 优先 | 步骤                                                                                   | 输入数据                                                                                                                                 | 预期结果                                                                                                                                            |
| --------- | ---- | ---- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-DOM-01 | 异常 | P0   | `call POST /api/domains`，类型非法                                                     | `{"source_type":"cname","source_domain":"example.com"}`                                                                                  | 400，`{"error":"source_type 必须为 domain 或 url。"}`                                                                                               |
| TC-DOM-02 | 异常 | P0   | URL 类型缺 `source_url`                                                                | `{"source_type":"url","source_domain":"a"}`                                                                                              | 400，`{"error":"URL 类型必须填写 source_url。"}`                                                                                                    |
| TC-DOM-03 | 边界 | P0   | URL 长度 2048 与 2049 各一次（用 `python -c` 或 `printf` 生成 `http://e.com/` + 填充） | 2049 字符 URL                                                                                                                            | 2048 → 通过长度校验（可能因 E1 无 CF 报 400 配置文案）；2049 → 400，`{"error":"URL 长度不能超过 2048 个字符。"}`                                    |
| TC-DOM-04 | 异常 | P0   | URL 指向内网                                                                           | `{"source_type":"url","source_url":"http://127.0.0.1/x"}`                                                                                | 400，`{"error":"不允许访问内网或元数据地址。"}`；同组再验 `http://169.254.169.254/latest/meta-data/`、`http://10.0.0.1/`、`http://[::1]/`，文案相同 |
| TC-DOM-05 | 异常 | P1   | 非 http(s) 协议                                                                        | `{"source_type":"url","source_url":"ftp://example.com/a"}`                                                                               | 400，`{"error":"仅允许 http/https 协议。"}`                                                                                                         |
| TC-DOM-06 | 异常 | P1   | URL 格式不可解析                                                                       | `{"source_type":"url","source_url":"http://"}`                                                                                           | 400，`{"error":"URL 格式无效。"}`                                                                                                                   |
| TC-DOM-07 | 异常 | P0   | domain 源非法                                                                          | `{"source_type":"domain","source_domain":"bad_domain!"}`                                                                                 | 400，`{"error":"源域名格式无效。"}`                                                                                                                 |
| TC-DOM-08 | 异常 | P1   | 内置源前缀非法                                                                         | `{"source_type":"domain","source_domain":"internal:hostmonit:xx"}`                                                                       | 400，`{"error":"内置源域名格式无效。"}`                                                                                                             |
| TC-DOM-09 | 边界 | P1   | 目标前缀非法                                                                           | `{"source_type":"domain","source_domain":"a.example.com","target_domain_prefix":"a.b"}`                                                  | 400，`{"error":"目标前缀必须是单个 DNS label 或 @。"}`                                                                                              |
| TC-DOM-10 | 边界 | P0   | TTL 五连测：1 / 59 / 60 / 86400 / 86401                                                | 分别提交                                                                                                                                 | 1、60、86400 → 通过 TTL 校验；59 与 86401 → 400，`{"error":"TTL 必须为 1（自动）或 60 到 86400 之间的整数。"}`                                      |
| TC-DOM-11 | 异常 | P0   | `is_deep_resolve` 非法值                                                               | `{"is_deep_resolve":2}`                                                                                                                  | 400，`{"error":"is_deep_resolve 必须为 0 或 1。"}`                                                                                                  |
| TC-DOM-12 | 异常 | P0   | E1 无 CF 配置时创建合法目标                                                            | `{"source_type":"domain","source_domain":"a.example.com"}`                                                                               | 400，`{"error":"Cloudflare API 未配置，请先在「系统设置」填写 API 令牌与区域 ID。"}`                                                                |
| TC-DOM-13 | 正常 | P0   | `[E2]` 创建 domain 类型目标                                                            | `{"source_type":"domain","source_domain":"a.example.com","target_domain_prefix":"t1","ttl":600,"notes":"功能测试"}`                      | 200，`{"success":true,"message":"目标添加成功。"}`；查库 `target_domain=t1.<ZONE_NAME>`、`zone_id` 非空、`is_system=0`、`last_sync_status=pending`  |
| TC-DOM-14 | 边界 | P1   | `[E2]` 前缀留空                                                                        | `{"source_type":"domain","source_domain":"a.example.com","target_domain_prefix":""}`                                                     | 200；查库 `target_domain=<ZONE_NAME>`（前缀归一为 `@`）                                                                                             |
| TC-DOM-15 | 正常 | P1   | `[E2]` 创建 URL 类型目标并强制浅层                                                     | `{"source_type":"url","source_url":"https://example.com/ip.txt","is_deep_resolve":1}`                                                    | 200；查库 `source_type=url` 且 `is_deep_resolve=0`（URL 类型强制浅层）                                                                              |
| TC-DOM-16 | 异常 | P1   | `[E2]` 重复目标                                                                        | 与 TC-DOM-13 同 prefix 再提交一次                                                                                                        | 409，`{"error":"目标域名已存在。"}`                                                                                                                 |
| TC-DOM-17 | 正常 | P1   | `[E2]` 更新自建目标的 ttl 与备注                                                       | `PUT /api/domains/<id>`，`{"source_type":"domain","source_domain":"a.example.com","target_domain_prefix":"t1","ttl":120,"notes":"已改"}` | 200，`{"success":true,"message":"目标更新成功。"}`；查库 ttl=120、notes=已改                                                                        |
| TC-DOM-18 | 异常 | P0   | 更新不存在的 id                                                                        | `PUT /api/domains/999999`，合法体                                                                                                        | 404，`{"error":"目标不存在。"}`                                                                                                                     |
| TC-DOM-19 | 异常 | P1   | `[E2]` 删除系统预设                                                                    | 先 `GET /api/domains` 找 `is_system=1` 的行，`DELETE /api/domains/<id>`                                                                  | 403，`{"error":"删除失败，目标为系统预设或不存在。"}`                                                                                               |
| TC-DOM-20 | 异常 | P1   | `[E2]` 系统预设切换输入类型                                                            | `PUT /api/domains/<system-id>`，`{"source_type":"url","source_url":"https://example.com/a.txt"}`                                         | 403，`{"error":"系统预设域名不允许切换输入类型。"}`                                                                                                 |
| TC-DOM-21 | 异常 | P1   | `[E2]` 系统预设改源域名                                                                | `PUT /api/domains/<system-id>`，`{"source_type":"domain","source_domain":"other.example.com"}`                                           | 403，`{"error":"系统预设域名的源域名不可修改。"}`                                                                                                   |
| TC-DOM-22 | 正常 | P0   | `[E2]` 删除自建目标                                                                    | `DELETE /api/domains/<id>`（TC-DOM-13 建的那条）                                                                                         | 200，体含 `"success":true`；再 `GET /api/domains` 列表不含该行                                                                                      |
| TC-DOM-23 | 正常 | P1   | `[E2]` 列表排序                                                                        | `call GET /api/domains`                                                                                                                  | 200；数组前段为 `is_system=1` 的行，其后按 `target_domain` 升序；每行含 `id`、`target_domain`、`source_type`、`is_enabled`、`last_sync_status`      |
| TC-DOM-24 | 边界 | P2   | `[E2]` URL 变更后策略失效                                                              | 先建 URL 目标并同步一次（留下 `fetch_strategy`），再 `PUT` 改 `source_url`                                                               | 200；查库 `fetch_strategy` 为 NULL（URL 变更即失效，需重新探测）                                                                                    |

### 5.4 M4 DNS 记录查询（`TC-REC`）

| 用例编号  | 类型 | 优先 | 步骤                          | 输入数据                                      | 预期结果                                                                                                                        |
| --------- | ---- | ---- | ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| TC-REC-01 | 异常 | P0   | E1 无 CF 配置时查询单条       | `call GET /api/domains/1/records`             | 400，`{"error":"Cloudflare API 未配置。"}`                                                                                      |
| TC-REC-02 | 异常 | P0   | 查询不存在的目标              | `call GET /api/domains/999999/records`        | 404，`{"error":"目标不存在。"}`                                                                                                 |
| TC-REC-03 | 正常 | P1   | `[E2]` 查询已同步目标的记录   | `call GET /api/domains/<id>/records`          | 200；体含记录数组，每条含 `type`、`name`、`content`、`ttl`、`id`                                                                |
| TC-REC-04 | 正常 | P1   | `[E2]` 批量查询（前端首屏用） | `call GET /api/domains/records`               | 200；以 `domainId` 为键的映射，或 `{success:true,data:[...]}`（按实际结构记录）；未配置 CF 的域显示失败占位                     |
| TC-REC-05 | 边界 | P2   | `[E2]` 批量查询混入不存在 id  | `GET /api/domains/records?ids=<valid>,999999` | 200；不存在的 id 对应项为失败/空，不导致整体 500                                                                                |
| TC-REC-06 | 异常 | P2   | `[E2]` 上游异常模拟           | 临时把 `CF_API_TOKEN` 改为无效值后查询        | 500，`{"error":"Cloudflare API 返回错误，请稍后重试。"}`（若为网络层失败则 `{"error":"获取记录失败，请稍后重试。"}`，记录原文） |

### 5.5 M5 域名同步（`TC-SYN`）

前置：`[E2]`；目标已建（TC-DOM-13）。SSE 用 `call_sse` 采集，证据保存 `sse.log`。首次执行本组时，把未在文中固化的错误文案原文回填附录 A。

| 用例编号  | 类型 | 优先 | 步骤                                  | 输入数据                                                     | 预期结果                                                                                                                                                                             |
| --------- | ---- | ---- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-SYN-01 | 正常 | P0   | `[E2]` 单条同步浅层目标               | `POST /api/domains/<id>/sync`                                | 200，`Content-Type` 为事件流；日志含 `======== 开始同步: <target> ========`、`模式: 浅层克隆 (直接克隆CNAME)`、`✔ 成功同步 <target> (内容已更新)。`；查库 `last_sync_status=success` |
| TC-SYN-02 | 正常 | P0   | `[E2]` 深度解析目标同步               | 目标 `is_deep_resolve=1`，`POST /api/domains/<id>/sync`      | 日志含 `模式: 深度解析 (追踪CNAME)`；同步后记录中无 CNAME 链残留（最终为 A/AAAA 或按实现输出）                                                                                       |
| TC-SYN-03 | 正常 | P0   | 紧接 TC-SYN-01 再同步一次（内容未变） | 同上                                                         | 日志含 `✔ 成功同步 <target> (内容一致)。`；查库 `last_sync_status=no_change`                                                                                                         |
| TC-SYN-04 | 正常 | P1   | `[E2]` URL 抓取目标同步               | 目标 `source_type=url`，`source_url` 指向可访问的 IP 列表    | 日志含 `模式: URL 抓取 (<url>)`；成功后 SAN（记录集）含抓到的 A/AAAA                                                                                                                 |
| TC-SYN-05 | 正常 | P1   | `[E2]` 内置三网源同步                 | 目标 `source_domain=internal:hostmonit:yd`                   | 日志含 `模式: 系统内置源 (三网优选IP - yd, 来源: <source>)`；成功或失败都记录实际结果（外网依赖）                                                                                    |
| TC-SYN-06 | 异常 | P0   | `[E2]` 源域名不可解析                 | 目标 `source_domain=nonexistent-<rands>.invalid`             | 日志含 `❌ 同步 <target> 失败: `；查库 `last_sync_status=failed`；现有 DNS 记录未被清空                                                                                              |
| TC-SYN-07 | 正常 | P0   | `[E2]` 全量同步                       | `POST /api/sync`（SSE）                                      | 日志含 `发现 N 个已启用的目标需要同步。` 与 `本轮按失败优先选取 N 个域名。`；N 与库内启用目标数一致                                                                                  |
| TC-SYN-08 | 异常 | P0   | `[E2]` 批量中一条失败不影响其余       | 准备 2 个目标：1 个正常、1 个不可解析，`POST /api/sync`      | 同一批次内正常目标仍输出 `✔ 成功同步`，失败目标输出 `❌`；两者状态分别落库 success / failed                                                                                          |
| TC-SYN-09 | 异常 | P0   | 并发互斥                              | 先发起一个 `POST /api/sync`（不等待结束），立即再发一个      | 第二个返回 409，`{"error":"手动同步任务正在执行，请稍后再试。"}`；第一个结束后再发一次可 200（锁已释放）                                                                             |
| TC-SYN-10 | 边界 | P1   | 禁用目标参与批量                      | 把某目标 `is_enabled=0`（查库或 UI 开关）后 `POST /api/sync` | 日志含 `域名 <target> 已被禁用，跳过同步。`；该行 `last_synced_time` 不变                                                                                                            |
| TC-SYN-11 | 边界 | P1   | `[E2]` CNAME 深度超限                 | 构造 11 层 CNAME 链（若难以构造则记录 BLOCKED 并说明）       | 日志含 `错误：解析深度超过 10 层，可能存在CNAME循环。中止解析 <domain>。`；同步判 failed                                                                                             |
| TC-SYN-12 | 边界 | P0   | `[E2]` 单类型上限截断                 | 设置 `MAX_IPS_PER_TYPE=2`，源返回 ≥5 个 A 记录，同步         | 日志含 `按单类型上限 2 截断记录: 5 → 2`；云端该目标 A 记录恰好 2 条                                                                                                                  |
| TC-SYN-13 | 正常 | P1   | `[E2]` 变更备注                       | 观察 TC-SYN-01 产生的 A/AAAA 记录 `comment`                  | 以 `DNS Clone 变更于 ` 开头，后接 `YYYY-MM-DD HH:mm`（北京时间）；CNAME 记录无该备注                                                                                                 |
| TC-SYN-14 | 正常 | P0   | `[E2]` 集合不变不产生写入             | 连续两次同步后对比记录 `id` 与 `comment`                     | 第二次后记录 `id` 不变、`comment` 时间戳不变（未发生 PATCH）                                                                                                                         |
| TC-SYN-15 | 异常 | P1   | 同步计划日志                          | 在源记录与云端差异较大时同步                                 | 日志含 `计划删除 N 条记录, 添加 M 条记录。`，N/M 与实际差异一致；无差异时含 `记录无变化，无需操作。`                                                                                 |
| TC-SYN-16 | 正常 | P1   | `[E2]` 三网系统同步入口               | `POST /api/domains/sync_system`                              | 200 SSE；仅对内置三网目标执行，日志中不出现普通目标                                                                                                                                  |
| TC-SYN-17 | 边界 | P2   | 目标记录为空且源为空                  | 目标源返回 0 个 IP，同步                                     | 记录实际分支（`failed` 或 `no_change`）与日志原文，回填附录 A；不得静默清空既有记录                                                                                                  |
| TC-SYN-18 | 正常 | P1   | SSE 传输形态                          | 观察 `sse.log`                                               | 每行以 `data:` 开头（或为事件流标准格式），前端日志面板逐行追加；连接在任务结束后关闭                                                                                                |

### 5.6 M6 IP 源 CRUD（`TC-IPS`）

| 用例编号  | 类型 | 优先 | 步骤                                    | 输入数据                                                                                                                       | 预期结果                                                                                                                                          |
| --------- | ---- | ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-IPS-01 | 异常 | P0   | `call POST /api/ip_sources`，url 为空串 | `{"url":"","github_path":"ips/a.txt","commit_message":"test"}`                                                                 | 400，`{"error":"URL 不能为空。"}`                                                                                                                 |
| TC-IPS-02 | 异常 | P0   | url 指向内网                            | `{"url":"http://192.168.1.1/a","github_path":"ips/a.txt","commit_message":"test"}`                                             | 400，`{"error":"不允许访问内网或元数据地址。"}`                                                                                                   |
| TC-IPS-03 | 边界 | P1   | url 长度 2049                           | 2049 字符 URL                                                                                                                  | 400，`{"error":"URL 长度不能超过 2048 个字符。"}`                                                                                                 |
| TC-IPS-04 | 异常 | P0   | `github_path` 传数字                    | `{"url":"https://example.com/a.txt","github_path":123,"commit_message":"test"}`                                                | 400，`{"error":"GitHub 文件路径不能为空。"}`                                                                                                      |
| TC-IPS-05 | 异常 | P0   | `github_path` 以 `/` 开头或含 `..`      | `github_path` 分别为 `/a.txt`、`a/../b.txt`                                                                                    | 400，文案以 `GitHub 文件路径` 开头（记录原文并回填附录 A）                                                                                        |
| TC-IPS-06 | 边界 | P1   | `github_path` 长度 513                  | 513 字符（含层级分隔）                                                                                                         | 400，`{"error":"GitHub 文件路径总长必须在 1–512 个字符之间。"}`                                                                                   |
| TC-IPS-07 | 异常 | P2   | `github_path` 首尾带空格                | `" ips/a.txt "`                                                                                                                | 400，`{"error":"GitHub 文件路径首尾不能包含空白。"}`                                                                                              |
| TC-IPS-08 | 边界 | P1   | 伴生路径超长                            | 主路径 505 字符 + `.txt`（派生加 `-v6` 后 >512）                                                                               | 400，`{"error":"派生出的 IPv6 伴生文件路径超过 512 个字符，请缩短 GitHub 文件路径。"}`                                                            |
| TC-IPS-09 | 异常 | P2   | 伴生路径非法                            | 主路径使其派生结果触发非法形态（如首段超 255）                                                                                 | 400，文案以 `派生出的 IPv6 伴生文件路径非法：` 开头                                                                                               |
| TC-IPS-10 | 异常 | P0   | `commit_message` 为空                   | `{"commit_message":""}` 其余合法                                                                                               | 400，`{"error":"提交信息长度必须在 1–200 个字符之间。"}`                                                                                          |
| TC-IPS-11 | 边界 | P1   | `commit_message` 200 与 201 字符        | 200 个 `a` / 201 个 `a`                                                                                                        | 200 → 通过；201 → 400，同 TC-IPS-10 文案                                                                                                          |
| TC-IPS-12 | 正常 | P0   | 创建合法 IP 源（未探测）                | `{"url":"https://example.com/ips.txt","github_path":"ips/test-a.txt","commit_message":"测试新增"}`                             | 200，`{"success":true,"message":"IP源添加成功。"}`；查库 `fetch_strategy` 为 NULL、`parse_mode=auto`                                              |
| TC-IPS-13 | 异常 | P0   | 重复 URL                                | 与 TC-IPS-12 同 url、不同 github_path                                                                                          | 409，`{"error":"该URL或GitHub文件路径已存在。"}`                                                                                                  |
| TC-IPS-14 | 异常 | P1   | 主/伴生路径互相冲突                     | 先建 `github_path=ips/b.txt`，再建 `github_path=ips/b-v6.txt`                                                                  | 第二次 409，`{"error":"该 GitHub 文件路径与已有IP源 ips/b.txt 的 IPv6 伴生文件路径互相冲突。"}`                                                   |
| TC-IPS-15 | 正常 | P1   | 更新 IP 源备注路径                      | `PUT /api/ip_sources/<id>`，`{"url":"https://example.com/ips.txt","github_path":"ips/test-b.txt","commit_message":"测试更新"}` | 200，`{"success":true,"message":"IP源更新成功。"}`；查库路径已改                                                                                  |
| TC-IPS-16 | 异常 | P0   | 更新不存在 id                           | `PUT /api/ip_sources/999999`，合法体                                                                                           | 404，`{"error":"目标不存在。"}`                                                                                                                   |
| TC-IPS-17 | 正常 | P0   | 删除 IP 源                              | `DELETE /api/ip_sources/<id>`                                                                                                  | 200，`{"success":true,"message":"IP源删除成功。"}`；`GET /api/ip_sources` 不再含该行                                                              |
| TC-IPS-18 | 异常 | P1   | 解析模式非法                            | `{"parse_mode":"xml"}`                                                                                                         | 400，文案含 `解析模式`（记录原文并回填附录 A）                                                                                                    |
| TC-IPS-19 | 异常 | P0   | `json_path` 模式缺路径                  | `{"parse_mode":"json_path","parse_param":""}`                                                                                  | 400，`{"error":"json_path 模式必须填写 JSON 点路径。"}`                                                                                           |
| TC-IPS-20 | 边界 | P1   | `json_path` 三段非法                    | `".a"`、`"a.b."`、`"a..b"`                                                                                                     | 均 400，`{"error":"JSON 点路径不能以点开头或结尾，也不能包含连续的点造成空段。"}`                                                                 |
| TC-IPS-21 | 边界 | P1   | `json_path` 超 512                      | 513 字符路径                                                                                                                   | 400，`{"error":"JSON 点路径长度不能超过 512 个字符。"}`                                                                                           |
| TC-IPS-22 | 边界 | P0   | `custom_regex` 超 200                   | 201 字符正则                                                                                                                   | 400，`{"error":"正则表达式长度不能超过 200 个字符。"}`                                                                                            |
| TC-IPS-23 | 异常 | P0   | `custom_regex` 语法错误                 | `"(\d+"`                                                                                                                       | 400，`{"error":"正则表达式无法构造，请检查语法后重试。"}`                                                                                         |
| TC-IPS-24 | 异常 | P0   | `custom_regex` 高风险形态               | `"(a+)+"`、`"(a                                                                                                                | a)+b"`                                                                                                                                            |
| TC-IPS-25 | 边界 | P1   | `auto` / `lines` 模式的 param 归一      | `{"parse_mode":"auto","parse_param":"ignored"}`                                                                                | 200；查库 `parse_param` 为 NULL                                                                                                                   |
| TC-IPS-26 | 正常 | P1   | 列表读取                                | `call GET /api/ip_sources`                                                                                                     | 200；每行含 `id`、`url`、`github_path`、`commit_message`、`fetch_strategy`、`parse_mode`、`is_enabled`、`last_sync_status`；按 `github_path` 升序 |

### 5.7 M7 IP 源探测（`TC-PRB`）

| 用例编号  | 类型 | 优先 | 步骤                       | 输入数据                                                                        | 预期结果                                                                                 |
| --------- | ---- | ---- | -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| TC-PRB-01 | 异常 | P1   | 请求体非法 JSON            | `{bad`                                                                          | 400，`{"error":"请求体不是合法 JSON。"}`                                                 |
| TC-PRB-02 | 异常 | P0   | 缺 url                     | `{"parse_mode":"auto"}`                                                         | 400，`{"error":"缺少用于探测的 URL 参数。"}`                                             |
| TC-PRB-03 | 异常 | P0   | url 指向内网               | `{"url":"http://127.0.0.1/ips.txt"}`                                            | 400，`{"error":"不允许访问内网或元数据地址。"}`                                          |
| TC-PRB-04 | 异常 | P1   | 解析配置非法先于探测       | `{"url":"https://example.com/a.txt","parse_mode":"json_path","parse_param":""}` | 400，`{"error":"json_path 模式必须填写 JSON 点路径。"}`（不得先发起网络请求）            |
| TC-PRB-05 | 正常 | P0   | 探测可访问的纯文本 IP 列表 | `{"url":"<可访问的 IP 列表 URL>","parse_mode":"lines"}`                         | 200；体含 `"success":true`、`strategy`（非空字符串）、`ipv4Count`≥1、`sampleIps` 数组 ≥1 |
| TC-PRB-06 | 异常 | P0   | 探测全策略失败             | `{"url":"https://example.com/empty-<rand>.txt"}`（404 页面）                    | 400，`{"error":"所有探测方案均失败，无法从此URL提取IP。"}`                               |
| TC-PRB-07 | 边界 | P2   | 探测超预算                 | 指向极慢响应的 URL（或不可路由公网地址模拟）                                    | 400，文案以 `IP 源探测超时：` 开头，含 `25 秒预算`（实际耗时约 25s，记录实测秒数）       |
| TC-PRB-08 | 正常 | P1   | 探测成功后保存联动         | 先探测成功，再 `POST /api/ip_sources` 同 url                                    | 200；查库 `fetch_strategy` 等于探测返回的 `strategy`（保存时复用探测结果）               |

### 5.8 M8 IP 源同步与 GitHub 推送（`TC-IPU`）

前置：`[E2]`，GitHub 三件套已配置，测试仓库为专用空仓库。同步用 `call_sse`。

| 用例编号  | 类型 | 优先 | 步骤                     | 输入数据                                                                 | 预期结果                                                                                         |
| --------- | ---- | ---- | ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| TC-IPU-01 | 正常 | P0   | 单条同步并推送 IPv4      | `POST /api/ip_sources/<id>/sync`                                         | 200 SSE；GitHub 上 `github_path` 文件内容为 IPv4 列表（每行一个），commit message 为配置或默认值 |
| TC-IPU-02 | 正常 | P0   | IPv6 伴生文件写入        | 源同时含 IPv6，同步 `ips/test-a.txt`                                     | 仓库出现 `ips/test-a-v6.txt`，内容为 IPv6 列表                                                   |
| TC-IPU-03 | 边界 | P1   | 源无 IPv6 时删除伴生文件 | 源只含 IPv4，先造出伴生文件再同步                                        | 伴生文件被删除，主文件正常更新                                                                   |
| TC-IPU-04 | 边界 | P1   | 源解析出 0 条 IPv4       | 源为纯 IPv6 或空内容                                                     | 主文件按空内容处理（清空），不报错中断；日志记录实际分支                                         |
| TC-IPU-05 | 异常 | P0   | 抓取失败不改远端         | 把源 URL 改为不可访问地址后同步                                          | 日志报失败；GitHub 上原文件内容**未被修改**；查库 `last_sync_status=failed`                      |
| TC-IPU-06 | 正常 | P1   | 批量同步                 | `POST /api/ip_sources/sync_all`（SSE）                                   | 逐个源输出进度；每个源独立成败                                                                   |
| TC-IPU-07 | 异常 | P0   | 批量中单条失败不中断     | 2 个源：1 个可访问、1 个不可访问，`sync_all`                             | 可访问源仍成功推送；不可访问源单独失败；整批不中断                                               |
| TC-IPU-08 | 边界 | P2   | 单条失败后轮转不卡死     | 让唯一 IP 源持续失败，触发两次定时任务（间隔 30 分钟或手动 `scheduled`） | 第二次仍会执行任务（任务类型轮转照常），不因失败永久停摆                                         |
| TC-IPU-09 | 边界 | P1   | 上限不约束 GitHub 文件   | 设置 `MAX_IPS_PER_TYPE=2`，源含 10 个 IPv4，同步                         | 推送文件含全部 10 条（上限只作用于 DNS 记录）                                                    |
| TC-IPU-10 | 异常 | P1   | GitHub Token 无效        | 把 `GITHUB_TOKEN` 改为无效值后同步                                       | 明确失败日志；远端文件不变；不产生 500 崩溃页                                                    |
| TC-IPU-11 | 正常 | P2   | 已启用/禁用开关          | 将 `is_enabled=0` 后 `sync_all`                                          | 该源被跳过（日志含跳过或数量不包含该源），状态不变                                               |
| TC-IPU-12 | 边界 | P2   | 解析模式生效             | 源为 JSON 且 `parse_mode=json_path`、`parse_param=data.ips`              | 只提取该路径下 IP；与 `auto` 结果对比记录差异                                                    |

### 5.9 M9 订阅代理（`TC-PRX`）

| 用例编号  | 类型 | 优先 | 步骤                    | 输入数据                                                                     | 预期结果                                                                                                 |
| --------- | ---- | ---- | ----------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| TC-PRX-01 | 正常 | P0   | `[E2]` 访问已同步的文件 | `GET /<GITHUB_OWNER>/<GITHUB_REPO>/ips/test-a.txt`                           | 200；正文为文件内容（`text/plain` 或同等）；响应头含 `Cache-Control` 且包含 `max-age=60`、`s-maxage=300` |
| TC-PRX-02 | 异常 | P0   | 访问不在管理范围的路径  | `GET /other-owner/other-repo/a.txt`                                          | 404，`{"error":"请求的文件不存在或不在本服务管理范围内。"}`（或纯文本同文案，记录实际）                  |
| TC-PRX-03 | 异常 | P0   | 路径穿越                | `GET /<owner>/<repo>/../secret.txt`、`GET /<owner>/<repo>/%2e%2e/secret.txt` | 404；不得返回仓库外内容                                                                                  |
| TC-PRX-04 | 异常 | P1   | GitHub 未配置时访问     | 清空 GitHub 三件套后 `GET /<owner>/<repo>/ips/test-a.txt`                    | 500，`{"error":"服务器尚未完成初始化配置。"}`                                                            |
| TC-PRX-05 | 异常 | P1   | 上游文件不存在          | 访问 `<owner>/<repo>/ips/not-exist.txt`                                      | 500 或 404，文案 `无法获取对应文件，请稍后重试。`（记录实际状态码）                                      |
| TC-PRX-06 | 边界 | P2   | 二次请求缓存            | 连续两次访问同一 URL                                                         | 第二次由边缘缓存命中（观察响应头变化，如 `cf-cache-status`）；内容一致                                   |
| TC-PRX-07 | 边界 | P2   | 路径编码                | `GET /<owner>/<repo>/ips/test-a%2Etxt`                                       | 解码后命中同一文件；返回 200 与一致内容                                                                  |

### 5.10 M10 公开首页（`TC-PUB`）

| 用例编号  | 类型 | 优先 | 步骤                      | 输入数据                                                                                 | 预期结果                                                      |
| --------- | ---- | ---- | ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| TC-PUB-01 | 正常 | P0   | 清库后访问 `GET /`        | 无                                                                                       | 200；渲染初始化页，页面含「系统初始化」与密码输入框           |
| TC-PUB-02 | 正常 | P0   | 初始化后访问 `GET /`      | 无                                                                                       | 200；含两个区块标题「优选域名」「优选API」；不含后台导航      |
| TC-PUB-03 | 正常 | P1   | 三网展示名映射            | 依次把 `THREE_NETWORK_SOURCE` 设为 `CloudFlareYes`、`api.uouin.com`、`wetest.vip`、`foo` | 前三个分别展示对应名称；`foo` 展示「未知」                    |
| TC-PUB-04 | 边界 | P0   | 只展示可展示目标          | 造 3 条域名：success、failed、is_enabled=0（查库直改）                                   | 页面只出现 success 那条；failed 与禁用均不出现                |
| TC-PUB-05 | 异常 | P1   | 未初始化访问 `GET /admin` | 无                                                                                       | 渲染初始化页（或 302 到 `/`，记录实际）；不得暴露后台结构     |
| TC-PUB-06 | 正常 | P0   | 已登录访问 `GET /admin`   | 携带 `Cookie: session=$SESSION`                                                          | 200；渲染后台，含三个 `.nav-link` 与 `#domain-list-container` |

### 5.11 M11 管理后台 UI（`TC-UI`）

前置：Chromium 内核浏览器，已登录 `/admin`。每条用例需截图存 `$JV_EVID/shot.png`。

| 用例编号 | 类型 | 优先 | 步骤                                                | 输入数据                                                                     | 预期结果                                                                                                                 |
| -------- | ---- | ---- | --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| TC-UI-01 | 正常 | P0   | 依次点击三个 `.nav-link`                            | `data-target` 分别为 `page-dns-clone`、`page-github-upload`、`page-settings` | 对应 `.page` 获得 `active` 类；同一时刻只有一个 `.page.active`；浏览器 console 无报错                                    |
| TC-UI-02 | 边界 | P0   | CF 未配置状态下查看域名页                           | 无                                                                           | `#addDomainBtn` 为 `disabled`；点击无响应                                                                                |
| TC-UI-03 | 边界 | P0   | GitHub 未配置状态下查看 IP 源页                     | 无                                                                           | `#addIpSourceBtn` 为 `disabled`                                                                                          |
| TC-UI-04 | 正常 | P0   | 点击 `#addDomainBtn` 打开弹窗，再关闭               | 无                                                                           | `#domainModal` 显示；`#modalTitle` 为新建文案；`#domainId` 为空；关闭后弹窗隐藏且字段清空                                |
| TC-UI-05 | 正常 | P0   | 弹窗内把 `#source_type` 切到 `url`，再切回 `domain` | 无                                                                           | 切到 url：`#source_url` 可见可用、`#source_domain` 隐藏、`#is_deep_resolve` 为 `disabled` 且未勾选；切回 domain 反向恢复 |
| TC-UI-06 | 异常 | P1   | 填 TTL=59 保存                                      | `#ttl=59`                                                                    | 保存失败并提示（前端校验或后端 400 文案展示），弹窗不关闭                                                                |
| TC-UI-07 | 正常 | P0   | `[E2]` 合法填写并保存                               | `#target_domain_prefix=t1`、`#source_domain=a.example.com`、`#ttl=600`       | 弹窗关闭；列表出现新卡片 `#domain-card-<id>`；提示成功                                                                   |
| TC-UI-08 | 正常 | P1   | 点击卡片删除按钮                                    | 无                                                                           | 出现 confirm，文案为「确定要删除这个目标吗？此操作不可逆转。」；点「取消」不删除                                         |
| TC-UI-09 | 正常 | P0   | `[E2]` 点击卡片「立即同步」                         | 无                                                                           | 所有按钮 `disabled` 且有 `aria-busy`；`#logOutput` 逐行追加 SSE 内容；结束后提示、按钮恢复、列表刷新                     |
| TC-UI-10 | 正常 | P1   | 观察卡片内记录占位符                                | `[E2]` 已同步目标                                                            | `.records-placeholder[data-domain-id]` 被 `/api/domains/records` 批量填充；无 CF 时显示「查询失败」                      |
| TC-UI-11 | 正常 | P0   | 打开 `#ipSourceModal`，点 `#probeBtn`               | 合法可探测 URL                                                               | `#probeProgress` 显示进度；`#probeResult` 出现「探测成功！策略: ...」；`#saveIpSourceBtn` 由 `disabled` 变为可点         |
| TC-UI-12 | 异常 | P1   | 探测失败路径                                        | 不可达 URL                                                                   | `#probeResult` 显示「探测失败: 」+ 原因；`#saveIpSourceBtn` 保持 `disabled`                                              |
| TC-UI-13 | 正常 | P1   | 设置页 Secret 占位文案                              | 先配置 GitHub Token，再打开设置页                                            | `#githubToken` 的 placeholder 为「已配置，留空保持不变」；未配置时无该提示                                               |
| TC-UI-14 | 正常 | P1   | 勾选 `#githubClear` 后保存，再刷新页面              | 无                                                                           | 请求体含 `GITHUB_TOKEN:null`；刷新后 placeholder 回到未配置状态，`GITHUB_CONFIGURED` 为 false                            |
| TC-UI-15 | 边界 | P1   | `#maxIpsPerType` 留空保存                           | 清空输入框                                                                   | 提交为空串/缺省；刷新后显示归一默认 `20`                                                                                 |
| TC-UI-16 | 正常 | P2   | 空列表文案                                          | 删除全部自建目标与 IP 源                                                     | 域名页显示「暂无域名克隆目标，点右上角「添加克隆目标」新建一条。」；IP 源页显示对应空态文案                              |
| TC-UI-17 | 异常 | P1   | 会话失效后操作                                      | 手动删除 session 行后点同步                                                  | 出现统一未授权提示并跳转登录页，不出现空白页或死循环                                                                     |
| TC-UI-18 | 边界 | P2   | 窄屏渲染（375px 宽）                                | 无                                                                           | 页面无横向滚动条；导航可用；弹窗可关闭                                                                                   |

### 5.12 M12 定时任务与迁移（`TC-SCH`）

查询用 §4.4 命令；本地触发定时任务用 `pnpm exec wrangler dev --test-scheduled`，再执行 `curl "http://127.0.0.1:8787/__scheduled?cron=0+*+*+*+*"`。

| 用例编号  | 类型 | 优先 | 步骤               | 输入数据                                                                 | 预期结果                                                                                                                                            |
| --------- | ---- | ---- | ------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-SCH-01 | 正常 | P0   | 迁移幂等           | 连续两次启动 `pnpm dev`                                                  | 两次均正常启动；第二次不报重复建表错误；`settings.migration_version` 为 `2026-11-10-ip-fetch-unification`                                           |
| TC-SCH-02 | 正常 | P0   | 24h 门控           | 查 `settings.last_migrated_at` 后重启                                    | 时间戳未变（版本相同且 24h 内跳过）                                                                                                                 |
| TC-SCH-03 | 正常 | P0   | 表与索引齐备       | `SELECT name,type FROM sqlite_master WHERE type IN ("table","index")`    | 含 5 表 `settings`/`domains`/`sessions`/`login_attempts`/`ip_sources`，及 `idx_login_attempts_ip_time`、`idx_domains_batch`、`idx_ip_sources_batch` |
| TC-SCH-04 | 正常 | P1   | 超期失败记录清理   | 手工插入一条 `created_at` 为 2 小时前的 `login_attempts` 后触发迁移/定时 | 该行被删除；1 小时内的记录保留                                                                                                                      |
| TC-SCH-05 | 正常 | P1   | 定时任务轮转       | 连触发两次 `__scheduled`                                                 | 第一次跑 `domains` 批、第二次跑 `ip_sources` 批；`settings.next_sync_task` 每次都被翻转                                                             |
| TC-SCH-06 | 异常 | P1   | 单类任务失败仍轮转 | 让 `ip_sources` 批全部失败（Token 无效），再触发两次                     | `next_sync_task` 依然切换，不卡在同一类任务上                                                                                                       |
| TC-SCH-07 | 边界 | P2   | 未初始化时定时任务 | 清库后触发 `__scheduled`                                                 | 不抛未捕获异常；记录实际行为（跳过或自动建表后空跑）                                                                                                |

### 5.13 M13 错误响应与兜底（`TC-ERR`）

| 用例编号  | 类型 | 优先 | 步骤                           | 输入数据                                               | 预期结果                                                                                                                     |
| --------- | ---- | ---- | ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| TC-ERR-01 | 异常 | P0   | 访问未知 API                   | `call GET /api/not-exist`                              | 404，`{"error":"API 端点未找到"}`                                                                                            |
| TC-ERR-02 | 异常 | P1   | 未支持的方法                   | `curl -X PATCH /api/domains`（带 Cookie）              | 返回明确的 4xx/5xx JSON（记录实际状态码与文案），不得返回 HTML 或空体                                                        |
| TC-ERR-03 | 正常 | P1   | 响应编码                       | 任取 3 个 API 响应                                     | `Content-Type` 含 `charset=utf-8`；中文文案无乱码                                                                            |
| TC-ERR-04 | 正常 | P0   | 错误响应结构一致性             | 汇总本组所有 4xx/5xx                                   | 全部为 `{"error":"<中文文案>"}` 形状；不出现堆栈、SQL、路径等内部细节                                                        |
| TC-ERR-05 | 边界 | P2   | 数据库绑定错误（可选，破坏性） | 在**副本目录**把 `wrangler.toml` 的 binding 改名后启动 | 返回 500，正文为「严重错误：数据库初始化失败，请检查Worker的D1数据库绑定是否正确配置为「WUYA」。」；禁止在仓库主工作树做此项 |
| TC-ERR-06 | 边界 | P2   | 非 API 路径兜底                | 访问 `GET /a/b/c/d`（不在白名单的多段路径）            | 走代理分支并返回代理 404 文案，而非站点 500 页                                                                               |

## 6. 建议执行顺序

阶段之间有硬门：**上一阶段未达退出标准，不进入下一阶段**。标 `[E2]` 的用例若阻塞，跳过后继续同阶段其余用例，最后统一统计。

| 阶段 | 内容             | 用例范围                                   | 退出标准                                                | 预计耗时          |
| ---- | ---------------- | ------------------------------------------ | ------------------------------------------------------- | ----------------- |
| P0   | 环境与基线       | §2.2 前置检查 + `pnpm check` + `pnpm test` | 全部 exit=0，基线用例数已记录                           | 10–20 分钟        |
| P1   | 初始化与鉴权     | `TC-AUTH-01`…`15`（限流用例放本阶段末尾）  | 初始化、登录、401/403/429 全部判定完成                  | 15 分钟           |
| P2   | 系统设置         | `TC-SET-01`…`16`                           | 白名单、Secret 语义、配对校验全覆盖；CF/GitHub 配置就绪 | 20 分钟           |
| P3   | 域名目标 CRUD    | `TC-DOM-01`…`24`                           | 校验矩阵（12 条错误文案）全部命中                       | 30 分钟           |
| P4   | 记录查询         | `TC-REC-01`…`06`                           | 正常/404/无配置三类判定完成                             | 10 分钟           |
| P5   | 域名同步         | `TC-SYN-01`…`18`                           | 四种模式各至少 1 条成功；互斥与失败隔离已验证           | 40 分钟（含等待） |
| P6   | IP 源 CRUD       | `TC-IPS-01`…`26`                           | 路径/正则/JSON 路径校验全覆盖                           | 25 分钟           |
| P7   | IP 源探测        | `TC-PRB-01`…`08`                           | 成功与全失败路径各 1 条                                 | 15 分钟           |
| P8   | IP 源同步与推送  | `TC-IPU-01`…`12`                           | 主文件、伴生文件、空删除三条已验                        | 25 分钟           |
| P9   | 订阅代理与公开页 | `TC-PRX-01`…`07`、`TC-PUB-01`…`06`         | 白名单与展示过滤已验证                                  | 15 分钟           |
| P10  | 管理后台 UI      | `TC-UI-01`…`18`                            | 每页关键交互有截图                                      | 35 分钟           |
| P11  | 定时任务与迁移   | `TC-SCH-01`…`07`                           | 轮转与门控已验证                                        | 20 分钟           |
| P12  | 错误与兜底       | `TC-ERR-01`…`06`                           | 结构与编码一致性已验                                    | 10 分钟           |
| P13  | 回归与报告       | §8 回归集 + §9 报告                        | 回归全绿，报告回填完成                                  | 30 分钟           |

执行顺序的三条理由（供复核时判断是否可调整）：

1. 先鉴权后业务：所有业务接口都要求会话，鉴权不通过时后续全 401，无法区分「功能坏」与「没登录」。
2. 先设置后写入：域名写入依赖 CF 区域名派生 `target_domain`，CF 未配置时 `TC-DOM` 全部命中「Cloudflare API 未配置」，等于白跑。
3. 先 API 后 UI：UI 用例依赖已存在的域名/IP 源数据，先跑 API 组可顺带造好数据。

## 7. 缺陷记录方式

### 7.1 编号与文件

- 缺陷编号：`BUG-<两位序号>`，本轮内自增，如 `BUG-01`。
- 落盘：`$RUN_DIR/defects.jsonl`，一行一个 JSON 对象（UTF-8，不加 BOM）。
- 用例判定落盘：`$RUN_DIR/results.jsonl`，一行一个 JSON 对象。

### 7.2 `results.jsonl` 字段

```json
{
    "tc": "TC-DOM-10",
    "module": "M3",
    "priority": "P0",
    "result": "FAIL",
    "http": 400,
    "evidence": "evidence/TC-DOM-10/",
    "note": "TTL=59 返回 200 而非 400",
    "ts": "2026-11-14T15:20:31+08:00"
}
```

| 字段       | 必填 | 说明                                                  |
| ---------- | ---- | ----------------------------------------------------- |
| `tc`       | 是   | 用例编号，与本文档一致                                |
| `module`   | 是   | 模块编号 M1–M13                                       |
| `priority` | 是   | P0/P1/P2                                              |
| `result`   | 是   | `PASS`/`FAIL`/`BLOCKED`/`SKIP`                        |
| `http`     | 否   | 实际状态码，无 HTTP 交互时留空                        |
| `evidence` | 是   | 相对 `$RUN_DIR` 的证据目录                            |
| `note`     | 否   | FAIL 必须写清「预期 vs 实际」；BLOCKED 必须写阻塞原因 |
| `ts`       | 是   | 本地时间带时区                                        |

### 7.3 `defects.jsonl` 字段

```json
{
    "id": "BUG-01",
    "tc": "TC-DOM-10",
    "title": "TTL=59 未被拒绝，目标被创建",
    "severity": "P1",
    "env": "E1",
    "preconditions": "已初始化并登录；CF 已配置",
    "steps": ["POST /api/domains，ttl=59"],
    "expected": "400 TTL 必须为 1（自动）或 60 到 86400 之间的整数。",
    "actual": "200 目标添加成功，库中 ttl=59",
    "evidence": ["evidence/TC-DOM-10/resp.txt", "evidence/TC-DOM-10/code.txt"],
    "repro": "always",
    "scope": "src/routes/api.ts handleDomainMutation 的 TTL 校验",
    "status": "open",
    "ts": "2026-11-14T15:20:31+08:00"
}
```

| 字段                  | 必填 | 说明                                                               |
| --------------------- | ---- | ------------------------------------------------------------------ |
| `id`                  | 是   | `BUG-NN`                                                           |
| `tc`                  | 是   | 触发用例编号，可多个用逗号分隔                                     |
| `title`               | 是   | 一句话现象，含输入与结果                                           |
| `severity`            | 是   | `P0`–`P3`，定义见 7.4                                              |
| `env`                 | 是   | `E1` 或 `E2`                                                       |
| `preconditions`       | 是   | 数据与环境状态，保证可复现                                         |
| `steps`               | 是   | 数组，每步一条命令或操作                                           |
| `expected` / `actual` | 是   | 逐字记录文案，不概括                                               |
| `evidence`            | 是   | 相对路径数组                                                       |
| `repro`               | 是   | `always` / `intermittent` / `once`                                 |
| `scope`               | 否   | 疑似代码位置（文件 + 函数/行号），不确定写「未定位」               |
| `status`              | 是   | `open` / `fixing` / `fixed` / `verified` / `wontfix` / `duplicate` |
| `ts`                  | 是   | 记录时间                                                           |

### 7.4 严重度定义

| 级别 | 定义                                      | 示例                                             |
| ---- | ----------------------------------------- | ------------------------------------------------ |
| P0   | 功能不可用或数据被破坏，无绕过手段        | 初始化后所有接口 500；同步把云端正确记录全部删光 |
| P1   | 主流程可用但校验/状态错误，会产出错误数据 | 非法 TTL 被接受；同步失败仍记为 success          |
| P2   | 次要路径错误或文案与规范不符              | 404 文案不符；空态文案错字；UI 按钮未及时恢复    |
| P3   | 体验或一致性问题                          | 排序不稳定；日志多一行空行                       |

### 7.5 缺陷单模板（需要人读的场合复制此块）

```markdown
### BUG-01 TTL=59 未被拒绝，目标被创建

- 严重度：P1　　环境：E1　　用例：TC-DOM-10
- 复现率：always
- 前置条件：已初始化并登录；CF 已配置
- 疑似位置：src/routes/api.ts handleDomainMutation（TTL 校验分支）

**复现步骤**

1. `POST /api/domains` 体：`{"source_type":"domain","source_domain":"a.example.com","ttl":59}`

**预期**：400，`TTL 必须为 1（自动）或 60 到 86400 之间的整数。`

**实际**：200，`目标添加成功。`；库里 `ttl=59`。

**证据**：`evidence/TC-DOM-10/resp.txt`、`evidence/TC-DOM-10/code.txt`
```

## 8. 回归测试要求

### 8.1 何时必须回归

满足任一条即触发回归，且回归必须在**同一环境画像**（E1/E2）下完成：

1. 本轮出现任何 `P0` 或 `P1` 缺陷且已被修复；
2. 修复触及写入校验（`/api/settings`、`domains`、`ip_sources` 任一写路径）；
3. 修复触及同步逻辑（`src/sync/**`）或鉴权（`src/util/auth.ts`）；
4. 合并分支、部署前（发版门禁）。

### 8.2 回归集

| 集合      | 内容                                                                                                       | 何时跑                        |
| --------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `R-SMOKE` | `TC-AUTH-01`、`TC-AUTH-03`、`TC-AUTH-08`、`TC-AUTH-10`、`TC-SET-01`、`TC-DOM-13`、`TC-REC-03`、`TC-ERR-01` | 每次修复后（10 分钟内可跑完） |
| `R-CORE`  | `R-SMOKE` + 全部 `P0` 用例                                                                                 | 任一 `P1` 缺陷修复后          |
| `R-WRITE` | 全部写入校验用例：`TC-SET-03`…`12`、`TC-DOM-01`…`18`、`TC-IPS-01`…`25`                                     | 触及校验代码时                |
| `R-SYNC`  | `TC-SYN-01`…`09`、`TC-SYN-12`…`14`、`TC-IPU-01`…`07`                                                       | 触及 `src/sync/**` 时         |
| `R-FULL`  | 本文档全部用例                                                                                             | 发版前                        |

### 8.3 回归执行要求

1. 回归用例**重新执行**，不得复用上一轮结论；证据目录追加 `-r<n>` 后缀（如 `evidence/TC-DOM-10-r1/`）。
2. 每个回归失败的用例，缺陷 `status` 回退为 `open` 并补一条 `note` 说明「回归复现」。
3. 静态门禁必须一起跑：`pnpm verify`（`pnpm check` + `pnpm test`），exit=0 才算回归通过。
4. 覆盖率门槛不得下降：`pnpm test:coverage` 的 lines ≥ 84、functions ≥ 85、statements ≥ 82、branches ≥ 74。

### 8.4 回归完成的证据

- `results.jsonl` 中回归用例全部 `PASS`；
- `pnpm verify` 输出附在报告 §6；
- 缺陷 `status=verified`，并记录验证人与时间。

## 9. 测试报告模板

执行完成后，把下面模板复制为 `$RUN_DIR/report.md`（或 `docs/` 下的正式报告），逐项回填，不留 `TBD`。

```markdown
# dns-clone 功能测试报告

- 报告编号：FT-<RUN_ID>
- 执行时间段：<开始> — <结束>
- 执行者：<agent 名 / 人>
- 被测版本：commit <hash>（branch <name>）
- 环境：E1 <是否启用>；E2 <是否启用，入口 URL>
- 依据文档：《dns-clone 功能测试方案（AI agent 可执行版）》v1

## 1. 结论

- 总体判定：<通过 / 有条件通过 / 不通过>
- 一句话结论：<例：13 个模块中 12 个通过；域名同步在不可解析源下未正确落库 failed，已在 BUG-02 记录>
- 是否可发布：<是 / 否，附条件>

## 2. 统计

| 模块            | 用例数 | PASS | FAIL | BLOCKED | SKIP | 通过率 |
| --------------- | ------ | ---- | ---- | ------- | ---- | ------ |
| M1 初始化与鉴权 |        |      |      |         |      |        |
| M2 系统设置     |        |      |      |         |      |        |
| M3 域名 CRUD    |        |      |      |         |      |        |
| M4 记录查询     |        |      |      |         |      |        |
| M5 域名同步     |        |      |      |         |      |        |
| M6 IP 源 CRUD   |        |      |      |         |      |        |
| M7 IP 源探测    |        |      |      |         |      |        |
| M8 IP 源同步    |        |      |      |         |      |        |
| M9 订阅代理     |        |      |      |         |      |        |
| M10 公开首页    |        |      |      |         |      |        |
| M11 后台 UI     |        |      |      |         |      |        |
| M12 定时与迁移  |        |      |      |         |      |        |
| M13 错误兜底    |        |      |      |         |      |        |
| **合计**        |        |      |      |         |      |        |

## 3. 缺陷清单

| 编号   | 严重度 | 用例 | 标题 | 状态 | 证据 |
| ------ | ------ | ---- | ---- | ---- | ---- |
| BUG-01 |        |      |      |      |      |

## 4. 阻塞与跳过

| 用例 | 判定 | 原因 | 需要的支持 |
| ---- | ---- | ---- | ---------- |
|      |      |      |            |

## 5. 关键观察（非缺陷）

- <例：`/api/setup` 密码 1024 字符边界可正常接受，响应耗时约 120ms>
- <例：三网源同步受外部服务可用性影响，本次 3 次中 1 次失败，判 BLOCKED>

## 6. 门禁记录

| 命令                 | 结果 | 耗时 | 备注                       |
| -------------------- | ---- | ---- | -------------------------- |
| `pnpm check`         |      |      |                            |
| `pnpm test`          |      |      | 用例数 <n>                 |
| `pnpm test:coverage` |      |      | lines <x>% / branches <y>% |

## 7. 回归记录（有缺陷修复时填）

| 回归集  | 用例数 | PASS | FAIL | 执行时间 |
| ------- | ------ | ---- | ---- | -------- |
| R-SMOKE |        |      |      |          |
| R-CORE  |        |      |      |          |

## 8. 遗留风险与建议

1. <例：E2 用例仅覆盖单区域单仓库，多区域并发未验证>
2. <例：外部抓取源无 SLA，建议在同步失败时增加重试退避>

## 9. 附录

- 证据目录：`<RUN_DIR>/evidence/`
- 逐用例判定：`<RUN_DIR>/results.jsonl`
- 缺陷明细：`<RUN_DIR>/defects.jsonl`
```

## 10. 附录

### A. 执行时需回填的文案（实现未在本方案中固化）

下列用例的预期文案在方案中只给了「前缀」或「记录原文」，首次执行时把实际文案抄回本表，后续回归按固化文案严格比对：

| 用例                      | 待固化内容                                     | 首轮实测                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TC-IPS-05`               | `github_path` 非法时的完整文案                 | 以 `/` 开头 → `GitHub 文件路径不能以 "/" 开头。`；其余分支：`GitHub 文件路径不能包含反斜杠。`、`…不能包含控制字符。`、`…不能包含空路径段。`、`GitHub 文件路径不能包含 ".." 段。`、`GitHub 文件路径单段长度不能超过 255 个字符。`（src/sync/github.ts:47-60） |
| `TC-IPS-09`               | 伴生路径非法的 `<reason>` 取值                 | `派生出的 IPv6 伴生文件路径非法：GitHub 文件路径单段长度不能超过 255 个字符。`（主路径 254 字符 → 伴生 257 字符触发）                                                                                                                                        |
| `TC-IPS-18`               | 解析模式非法的完整文案                         | `解析模式非法：仅支持 auto、lines、json_path、custom_regex。`（src/sync/ip-parse.ts:25）                                                                                                                                                                     |
| `TC-SYN-06` / `TC-SYN-17` | 同步失败与空结果的实际分支与日志               | 未固化（本轮 [E2] 无 CF 凭据 → BLOCKED；E1 侧仅观测到无配置分支日志「Cloudflare 配置缺失，跳过本轮域名同步。」）                                                                                                                                             |
| `TC-SYN-16`               | `sync_system` 的实际输出形态                   | 未固化（本轮 [E2] → BLOCKED；无 CF 配置时与 `/api/sync` 同为 SSE，帧格式见 `TC-SYN-18`）                                                                                                                                                                     |
| `TC-PRX-02` / `TC-PRX-05` | 代理 404 的实际状态码与响应体形态              | 404，`Content-Type: text/plain;charset=UTF-8`，响应体纯文本 `请求的文件不存在或不在本服务管理范围内。`（**非 JSON**，src/routes/github-proxy.ts:39/44）；PRX-05 未执行（[E2]）                                                                               |
| `TC-REC-04`               | 批量记录接口的实际响应结构                     | `{"<domainId>":{"records":[...]}}`，单目标失败为 `{"<domainId>":{"error":"<中文文案>"}}`；接口忽略 `ids` 查询参数，始终按全表 SELECT 返回（src/routes/api.ts:646-662）                                                                                       |
| `TC-SYN-18`               | SSE 帧格式（`data:` 前缀、事件分隔、结束标志） | 每帧 `data: [YYYY/MM/DD HH:mm:ss] <message>\n\n`；无 `event:`/`id:` 字段，无结束标志，流关闭即结束；异常时最后一帧为 `[FATAL_ERROR] <message>`（src/util/sse.ts）                                                                                            |

### B. 关键常量速查

| 项                 | 值                                | 出处                           |
| ------------------ | --------------------------------- | ------------------------------ |
| 会话有效期         | 24 小时（`Max-Age=86400`）        | `src/routes/api.ts`            |
| 登录失败窗口       | 5 分钟内 ≥5 次 → 429              | 同上                           |
| 密码长度           | 8–1024                            | 同上                           |
| `BATCH_SIZE`       | 1–100，默认 10                    | `src/util/batch-size.ts`       |
| `MAX_IPS_PER_TYPE` | 1–200，默认 20                    | `src/util/max-ips-per-type.ts` |
| TTL                | 1 或 60–86400，默认 60            | `src/routes/api.ts`            |
| URL 上限           | 2048 字符                         | 同上                           |
| GitHub 路径上限    | 512 字符（owner 39 / repo 100）   | `src/sync/github.ts`           |
| 提交信息上限       | 1–200（trim 后）                  | 同上                           |
| JSON 点路径上限    | 512 字符                          | `src/sync/ip-parse.ts`         |
| 正则上限           | 200 字符                          | 同上                           |
| 正文截断           | 512KB                             | 同上                           |
| CNAME 深度上限     | 10 层                             | `src/sync/domains.ts`          |
| 探测总预算         | 25 秒                             | `src/sync/ip-sources.ts`       |
| 代理缓存           | `max-age=60`、`s-maxage=300`      | `src/routes/github-proxy.ts`   |
| Cron               | `0,30 * * * *`                    | `wrangler.toml`                |
| 迁移版本           | `2026-11-10-ip-fetch-unification` | `src/db/migrations.ts`         |

### C. 需要执行者/用户补充的信息

| 编号 | 信息                                          | 用途                     | 缺失时的处理                     |
| ---- | --------------------------------------------- | ------------------------ | -------------------------------- |
| I1   | `CF_API_TOKEN`（编辑区域 DNS 模板）           | E2 全部写入/同步用例     | 相关用例判 `BLOCKED`             |
| I2   | `CF_ZONE_ID` 与 `ZONE_NAME`                   | 派生 `target_domain`     | 同上                             |
| I3   | `GITHUB_TOKEN`、`GITHUB_OWNER`、`GITHUB_REPO` | IP 源推送与订阅代理      | 同上                             |
| I4   | 可访问的公网 IP 列表 URL（用于探测/抓取）     | `TC-PRB-05`、`TC-IPU-01` | 用公开源顶替，或判 `BLOCKED`     |
| I5   | 是否允许在测试仓库产生真实提交                | 决定 `TC-IPU` 是否执行   | 不允许则整组 `SKIP` 并在报告说明 |
| I6   | 是否允许改动真实 DNS 记录                     | 决定 `TC-SYN` 是否执行   | 不允许则只跑 E1 可覆盖部分       |

### D. 执行前 Checklist

- [ ] 已读 §0 执行者契约，`RUN_DIR` 已创建
- [ ] `pnpm check` 与 `pnpm test` 基线通过并记录用例数
- [ ] E1 已清库（未初始化状态）或确认沿用现有状态
- [ ] E2 凭据（I1–I3）已就位或已确认本轮不执行 E2
- [ ] `$RUN_DIR/api.sh` 已写入并 `source` 成功（`call GET /api/status` 有输出）
- [ ] 已知平台坑（§2.5）已确认规避，特别是 Secure Cookie 用 `-H` 显式传递
- [ ] 截图工具/截图方式可用（UI 组需要）
- [ ] 已确认本轮不做 `git commit` / `push` / 部署
