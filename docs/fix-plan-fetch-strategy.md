# 修复方案：抓取策略门控评审遗留项（fix plan）

- **输入报告**：[code-review-fetch-strategy.md](./code-review-fetch-strategy.md)（2026-11-13，评审范围 `git diff 83d2a44...d59455e`，结论：通过可推送）。
- **方案日期**：2026-11-14。基线：`b9772e0`（本地 dev）。
- **范围**：报告中两条气味基线（判断题）+ 一条措辞级偏差。零成文标准硬违规、零 Spec 实质缺口、零可疑实现，**没有阻塞项**；本方案全部为后续小票粒度的改善，不回改已评审的 #67/#68/#69 实现语义。

## 0. 优先级总览

| 编号 | 问题                                    | 报告出处                                        | 优先级                 | 类型               | 改动面                                                                     | 行为变化                    |
| ---- | --------------------------------------- | ----------------------------------------------- | ---------------------- | ------------------ | -------------------------------------------------------------------------- | --------------------------- |
| P1   | hostmonit fetch stub 逐字重复           | Standards 气味基线 1                            | **P1（先做）**         | 测试去重           | `test/api.test.ts`、`test/ip-sources-fetch.test.ts` + 新建 1 个共享 helper | 无                          |
| P2   | fetch_strategy 缓存裁决逻辑滞留路由层   | Standards 气味基线 2（依恋别人）                | **P2**                 | 架构归位（纯重构） | `src/routes/api.ts`、`src/sync/ip-sources.ts`                              | 无（语义等价核对表见 §2.4） |
| P3   | #67「循环必跑」注释措辞与验收字面不一致 | Spec 缺失项 1（评审判定：语义等价，仅记录不改） | **P3（可选，需拍板）** | 注释               | `src/sync/ip-sources.ts`                                                   | 无                          |

执行顺序建议：P1 与 P2 互不依赖，可各开一张小票并行；P3 是措辞对齐，若维护者认可评审「仅记录不改」的结论则直接关闭不做。三项各自独立 commit（`fix(test)` / `refactor(ip)` / `docs`），提交前跑 `pnpm check`（仓库红线：先提交再复审的顺序不受影响，因为三项均不触碰已评审实现的判定语义）。

---

## 1. P1：测试 stub 去重（hostmonit fetch stub）

### 1.1 现状与证据

报告口径是「api.test.ts 两处、ip-sources-fetch.test.ts 两处成对逐字重复」；实测精确分布如下（同一 `api.hostmonit.com/get_optimization_ip` 判定 + `code:200` IP 列表响应 + fallback 403 的结构逐字或近似重复）：

- `test/api.test.ts:1202-1211`（probe 候选不含不适配策略，issue #68 用例）
- `test/api.test.ts:1233-1242`（probe 在 hostmonit URL 上仍会尝试 hostmonit_api，回归用例）
- `test/ip-sources-fetch.test.ts:163-177`（hostmonit 源命中专用 API 策略，返回 **两个** IP）
- `test/ip-sources-fetch.test.ts:218-229`（已缓存策略遇非 hostmonit URL 不入链，issue #68 用例）
- `test/ip-sources-fetch.test.ts:239-250`（已缓存策略在 hostmonit URL 上优先命中，回归用例）
- `test/ip-sources-fetch.test.ts:305-318`：已存在 helper `stubHostmonitFetch`（记录请求体的 bodies 变体，服务 issue #25 的 key 用例），但与上述五处 **互不复用**。

两处文件还原模式不同，这是去重设计必须兼容的点：

- api.test.ts：手动 `globalThis.fetch = ... as typeof fetch` + `try/finally` 里 `globalThis.fetch = origFetch` 还原；
- ip-sources-fetch.test.ts：`vi.stubGlobal("fetch", vi.fn(...))`，无显式还原，靠用例间互相覆盖。

### 1.2 改法

新建共享 helper `test/hostmonit-stub.ts`（沿用 `test/ip-source-row.ts`、`test/domain-row.ts` 已确立的「非 `.test.ts` 后缀共享文件」先例；vitest 只收集 `*.test.ts`，不会被当成用例文件）：

```ts
// test/hostmonit-stub.ts
// hostmonit 专用接口的共享 fetch stub（评审报告「测试 stub 逐字重复」的收口处）。
// 先例：test/ip-source-row.ts / test/domain-row.ts 的非 .test.ts 共享 helper。

const HOSTMONIT_ENDPOINT = "api.hostmonit.com/get_optimization_ip";

export interface HostmonitStub {
    /** 被拦截的全部请求 URL（hostmonit 与 fallback 都记） */
    calls: string[];
    /** 仅 hostmonit 请求的请求体原文（key 写入语义用例使用） */
    bodies: string[];
    /** 还原 globalThis.fetch 到装本 stub 之前的值；api.test.ts 的 try/finally 依赖它 */
    restore: () => void;
}

/**
 * 只放行 hostmonit 专用接口：命中回 code:200 的 IP 列表响应，
 * 其余 URL 一律回 fallbackStatus（默认 403，与被收口各用例的原行为一致）。
 */
export function stubHostmonitOnlyFetch(options: { ips?: string[]; fallbackStatus?: number } = {}): HostmonitStub {
    const ips = options.ips ?? ["172.67.172.3"];
    const fallbackStatus = options.fallbackStatus ?? 403;
    const calls: string[] = [];
    const bodies: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes(HOSTMONIT_ENDPOINT)) {
            bodies.push(String(init?.body ?? ""));
            return new Response(JSON.stringify({ code: 200, info: ips.map((ip) => ({ ip })) }), { status: 200 });
        }
        return new Response("forbidden", { status: fallbackStatus });
    }) as typeof fetch;
    return {
        calls,
        bodies,
        restore: () => {
            globalThis.fetch = origFetch;
        },
    };
}
```

设计取舍（为什么不直接用 `vi.stubGlobal`）：

1. api.test.ts 现行模式是 globalThis 直赋 + try/finally 还原，workerd 环境下该模式已被 590 用例验证可靠；helper 返回 `restore` 句柄能同时服务两种文件，不依赖 `unstubGlobals` 配置差异。
2. **执行前先确认 `vitest.config.ts` 是否开了 `unstubGlobals: true`**：若开了，ip-sources-fetch.test.ts 侧可保持「用例开头装、不显式还原」的节奏不变；若没开，说明现状靠的是用例间互相覆盖，替换时给该文件统一补一个文件级 `afterEach` 调用最近一次 stub 的 `restore()`（比现状更干净且行为确定）。
3. **捕获链注意**：`origFetch` 捕获的是「装本 stub 之前」的值。若上一个用例的 stub 未还原，restore 回去的仍是旧 stub。api.test.ts 侧每用例都 try/finally，无此问题；ip-sources-fetch.test.ts 侧替换时保持「每用例自行装 stub」节奏即可，与现状 `vi.stubGlobal` 互相覆盖的语义等价。

### 1.3 各处替换

api.test.ts 两处替换模式（以 :1198 用例为例，:1229 用例同构）：

```diff
     it("probe 候选集合不含与 URL 不适配的策略（issue #68）", async () => {
         const cookie = await loginAndGetCookie();
-        const calls: string[] = [];
-        const origFetch = globalThis.fetch;
-        globalThis.fetch = ((input: RequestInfo | URL) => {
-            const url = String(input);
-            calls.push(url);
-            if (url.includes("api.hostmonit.com/get_optimization_ip")) {
-                return Promise.resolve(
-                    new Response(JSON.stringify({ code: 200, info: [{ ip: "172.67.172.3" }] }), { status: 200 })
-                );
-            }
-            return Promise.resolve(new Response("forbidden", { status: 403 }));
-        }) as typeof fetch;
+        const stub = stubHostmonitOnlyFetch();

         try {
             // ... 用例主体不动，原 calls.some(...) 改为 stub.calls.some(...)
-            expect(calls.some((u) => u.includes("api.hostmonit.com"))).toBe(false);
+            expect(stub.calls.some((u) => u.includes("api.hostmonit.com"))).toBe(false);
         } finally {
-            globalThis.fetch = origFetch;
+            stub.restore();
         }
     });
```

ip-sources-fetch.test.ts 五处（:163、:218、:239 内联 + :305 旧 helper + :320 起的 #25 用例群）：

- :163 用例传 `{ ips: ["172.67.172.3", "198.41.208.168"] }`（它是唯一要求两个 IP 的用例，其余走默认单 IP）；
- :218 / :239 用例走默认参数；
- :305 旧 `stubHostmonitFetch` 删除，#25 用例群改用共享 helper 的 `stub.bodies`（语义不变：只记录 hostmonit 请求的 body）；
- 文件顶部增加 `import { stubHostmonitOnlyFetch } from "./hostmonit-stub.js";`（按仓库现有 import 风格核对后缀写法）。

### 1.4 验收

1. `pnpm exec vitest run test/api.test.ts test/ip-sources-fetch.test.ts` 全绿（注意：`pnpm test -- <file>` 不会过滤，必须用 `pnpm exec vitest run`）；
2. `ops_grep` 复核 `api.hostmonit.com/get_optimization_ip` 字符串在 test/ 下只剩 `hostmonit-stub.ts` 一处；
3. `pnpm check` 七项全绿；
4. 注意：`test/` 不在 typecheck 范围（tsconfig include 只含 src，见 issue #60），helper 的类型错误 CI 拦不住，提交前在 IDE 里过一遍。

---

## 2. P2：fetch_strategy 缓存裁决下沉到 sync/ip-sources.ts

### 2.1 问题复述

报告气味基线 2：`src/routes/api.ts` 的 `checkCompanionConflict` 本职责是路径冲突检查（api.ts:769-806），现在顺带取回旧 `url`/`fetch_strategy` 快照；而 `writeIpSource`（api.ts:848-853）据快照做的「保留还是清空」裁决，本质是 #68/#69 的策略适用性语义，属于 `src/sync/ip-sources.ts` 的领域。路由层聚拢了判定逻辑（依恋别人 / Feature Envy）。

**报告同时认可的正确方向要保留**：`CompanionCheck.previous` 把 url 与 fetchStrategy 合成一份快照对象（消除数据泥团），以及「顺同一趟全表扫描取回快照、不加 D1 往返」的取数方式，都不动。

### 2.2 改法

`src/sync/ip-sources.ts` 在 `isStrategyApplicable`（现 :112-120）之后新增导出：

```ts
/**
 * 写库路径的 fetch_strategy 缓存裁决（issue #68 / #69）：
 * fetch_strategy 是 URL 的抓取方式缓存而非用户偏好，唯一合法写入方是同步链的实测结果。
 * URL 未变更且缓存策略对该 URL 仍适用时保留原值，其余（无缓存 / URL 变更 / 不适用）一律置 NULL。
 * 判据与同步尝试链、探测候选集合共用 isStrategyApplicable；previous 快照由调用方
 * 顺自己的 D1 扫描取回（ip_sources 写入路径复用伴生冲突检查那趟全表扫描，不加往返）。
 * 请求体里带什么（合法名 / 未登记名 / null / 缺省）不参与本裁决也不因此报 400——
 * 部署期新旧前端交错时不能因为多带一个字段把保存拦下来。
 */
export interface StrategyCacheSnapshot {
    /** 目标行被覆盖前的 URL；决定缓存是否随旧地址失效（issue #68） */
    url: string;
    /** 目标行被覆盖前的策略缓存；决定未变更时保留什么（issue #69） */
    fetchStrategy: string | null;
}

export function resolvePersistedFetchStrategy(previous: StrategyCacheSnapshot | null, nextUrl: string): string | null {
    // 先判 null 再判适用性：空串喂给 isStrategyApplicable 会走「未登记即适用」的回落返回 true，
    // 读起来像 null 通过了判定。
    if (previous === null) return null;
    const cached = previous.fetchStrategy;
    if (cached === null) return null;
    // URL 变更即失效；未变更才谈得上沿用，再补一道适用性判据
    if (previous.url !== nextUrl) return null;
    return isStrategyApplicable(cached, nextUrl) ? cached : null;
}
```

`src/routes/api.ts` 侧：

1. import 行（现 :19）追加 `resolvePersistedFetchStrategy`（`isStrategyApplicable` 的 import 保留，probe 候选集合 :938 仍在用）；
2. `CompanionCheck`（:749-760）`previous` 字段类型改为 `StrategyCacheSnapshot | null`（结构化类型本就兼容，显式引用让漂移在 typecheck 就暴露）；
3. :848-853 的六行裁决压缩为一行：

```diff
-    const previous = check.previous;
-    const cached = previous?.fetchStrategy ?? null;
-    // URL 变更即失效；未变更才谈得上沿用，再补一道适用性判据
-    const keepCached =
-        cached !== null && previous !== null && previous.url === url && isStrategyApplicable(cached, url);
-    const nextFetchStrategy: string | null = keepCached ? cached : null;
+    const nextFetchStrategy = resolvePersistedFetchStrategy(check.previous, url);
```

4. :838-847 的裁决长注释随逻辑迁入 ip-sources.ts 函数头（上文已含），api.ts 该处留一行指针注释（「裁决规则见 sync/ip-sources.ts 的 resolvePersistedFetchStrategy」）即可。

`checkCompanionConflict` 函数本体一行不改：快照取回（:784-789）是「免得多打一次 D1 往返」的装配职责，留在路由层正当。

### 2.3 为什么不把取数也下沉

快照来自「伴生路径冲突检查的全表扫描」内部循环，把冲突检查整体搬去 ip-sources.ts 会把 D1 路由装配和策略语义搅成反向依赖（ip-sources.ts 引入 github_path 概念），比现状更糟。下沉边界画在「纯函数裁决」，数据获取留在调用方——这也是报告「可考虑下沉」的合理读法。

### 2.4 语义等价核对表（迁移红线）

| previous | cached            | previous.url vs url | isStrategyApplicable | 旧 keepCached 结果          | 新函数结果 |
| -------- | ----------------- | ------------------- | -------------------- | --------------------------- | ---------- |
| null     | —                 | —                   | —                    | `null`                      | `null` ✓   |
| 快照     | null              | 任意                | —                    | `null`                      | `null` ✓   |
| 快照     | `""`（空串）      | 相同                | `true`（未登记回落） | `""` 原样保留               | `""` ✓     |
| 快照     | `"hostmonit_api"` | 相同                | false（URL 换站点）  | `null`（mismatch 清空用例） | `null` ✓   |
| 快照     | `"hostmonit_api"` | 相同                | true                 | 保留原值                    | 保留原值 ✓ |
| 快照     | 合法名            | 变更                | —                    | `null`                      | `null` ✓   |

空串行是唯一争议点：D1 历史数据若存了空串，现状与新方案都原样保留（不归 NULL）。**本方案严格等价迁移、不顺手收紧**；若要把空串也归 NULL，属行为变化，单独开票并补一条「空串缓存被归一为 NULL」的用例，不混进本重构。

### 2.5 验收

1. `pnpm exec vitest run test/api.test.ts` 重点看两条既有用例不动仍绿：mismatch 清空（api.test.ts:2122 起「历史脏数据」用例）与未登记名保留（:2140 起用例）；
2. `pnpm check` 七项全绿（typecheck 覆盖 src/）；
3. `git diff` 复核 api.ts 净减行数（预期 -6/+1 加注释迁移），无其它文件意外改动。

---

## 3. P3（可选）：#67 注释措辞对齐验收字面

报告 Spec 缺失项 1：#67 验收要求注释改写为「循环必跑」不变量说明，最终版（`src/sync/ip-sources.ts:422-423`）语义近似但措辞与验收字面不一致，评审判定「低严重度，语义等价，仅记录不改」。

本方案将其列为可选项，供维护者拍板：

- **选项 A（默认）**：接受评审结论，不改动。理由：语义等价，注释已把「为什么不能拿 attempts 反推」讲清，改动无收益。
- **选项 B（对齐字面）**：把 :422-423 改为明确写出「循环必跑」不变量：

```diff
-    // 名字未必都有实现：configuredStrategy 可能是空串或已下线的策略名，这类名字会被循环跳过且不记账，
-    // 所以「有没有可跑的策略」必须在进循环前按同一判据算出来，不能事后拿 attempts 反推（issue #67）。
+    // 名字未必都有实现：configuredStrategy 可能是空串或已下线的策略名，这类名字会被循环跳过且不记账。
+    // 不变量（issue #67）：会跑的策略集合在进循环前按同一判据一次算定，循环体内对有名项零剔除——
+    // 「循环必跑」，因此事后拿 attempts 反推「有没有可跑的策略」必然漏掉这些无名跳过项。
```

若选 B，随 P2 同一提交带上即可（同一文件），不必单独开票。

---

## 4. 明确不做项

1. **`CompanionCheck.previous` 聚合结构**：报告正向认可「消除数据泥团的正确方向」，保留，不拆回 url/fetchStrategy 两个平行字段。
2. **`checkCompanionConflict` 的快照取回**：免 D1 往返的装配职责，留在路由层，不随 P2 下沉（理由见 §2.3）。
3. **sync.test.ts helper 收口（a34e3d9）**：纯重构已验收，不回改。
4. **空串缓存归一化**：见 §2.4，行为变化单独评估。
5. **评审结论本身**：`83d2a44...d59455e` 可推送的结论不受本方案影响；三项遗留均为后续小票，不构成推送门控。

## 5. 验证与提交顺序（汇总）

| 步骤     | P1                                                                                                               | P2                                                                           | P3(B)    |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| 实现前   | 读 vitest.config.ts 确认 unstubGlobals                                                                           | —                                                                            | —        |
| 实现     | 新建 hostmonit-stub.ts + 替换 7 处                                                                               | ip-sources.ts 加导出 + api.ts 一行替换                                       | 注释替换 |
| 定向测试 | `pnpm exec vitest run test/api.test.ts test/ip-sources-fetch.test.ts`                                            | `pnpm exec vitest run test/api.test.ts`                                      | 随 P2    |
| 全量门禁 | `pnpm check`（七项：typecheck、typecheck:test、check:language、check:utf8、lint、format:check、check:dashboard） | 同左                                                                         | 同左     |
| 提交     | `fix(test): 收口 hostmonit fetch stub 重复（评审遗留 P1）`                                                       | `refactor(ip): fetch_strategy 缓存裁决下沉至 sync/ip-sources（评审遗留 P2）` | 随 P2    |

注意事项汇总：

- `pnpm test -- <file>` 不做过滤（会跑全量），定向验证一律 `pnpm exec vitest run <file>`。
- `test/` 不在 typecheck 范围（issue #60 追踪中），P1 的 helper 类型需 IDE 自查。
- 新增注释/用例标题保持简体中文（语言门禁 + CODING_STANDARDS 三档规则）。
- 本方案文档本身无可执行内容，无需评审即可提交；P1/P2 含可执行改动，按仓库「实现 → commit → 复审」红线走。
