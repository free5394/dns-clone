# 架构深化候选清单

> 来源：2026-10-20 的 `/improve-codebase-architecture` 架构评审（88 tests green 时的快照）。
>
> 评审报告本体（当时写在系统临时目录的单文件 HTML）**没有入库，已经不存在**。本文件保留那次评审留下的提名：编号 / 一句话问题 / 一句话方案 / 强度 / 状态。除 C4 外，其余候选的完整「问题定位 / 方案 / 收益」正文**未留档**。

## 候选

| 编号 | 一句话问题 | 一句话方案 | 强度 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | settings 词汇表没有归属模块：键名、白名单、脱敏表、配对不变量被 9 个调用点各自重述 | 未留档——需重跑评审重建 | Strong | 仅提名，未认领 |
| C2 | 批同步编排写了 5 遍：每张表重复一次「取值 → 失败优先取批 → 逐条吞错 → 翻转游标」 | 未留档——需重跑评审重建 | Strong | 仅提名，未认领 |
| C3 | domain / ip_source 行的读取被 7 个 module 重写，列清单逐字重复 4 次且改名零反馈 | 未留档——需重跑评审重建 | Strong | 仅提名，未认领 |
| C4 | GitHub 访问有两套实现：代理路径手写裸 fetch，绕开了全仓的超时与指数退避 | 订阅器读与边缘缓存归入 `src/sync/github.ts`（新增 `readFileForSubscriber`），`src/routes/github-proxy.ts` 塌缩 26 行 | Strong | **done** — issue [#1](https://github.com/free5394/dns-clone/issues/1) / 提交 `dfc04df` |
| C5 | 为可测试性抽出的纯函数层层转发：同一个日志出口 seam 被实现了两次 | 未留档——需重跑评审重建 | Worth exploring | 仅提名，未认领 |
| C6 | 841 行、免 tsc、免覆盖率的 templates.js 内嵌了第二套仪表盘数据逻辑 | 未留档——需重跑评审重建 | Speculative | 仅提名，未认领 |

C1 / C2 / C3 / C5 / C6 这五条**仅提名，内容需重跑评审重建**。C4 有完整 spec：已关闭的 issue [#1](https://github.com/free5394/dns-clone/issues/1) 正文（149 passed / 14 files）。

## 只有提名、没有内容的五条：怎么重建

1. 重跑 `/improve-codebase-architecture`，拿到当次报告；
2. 用它把该条的问题 / 方案 / 收益补进本文件（或直接开票）；
3. **别把上表那行当 spec**——它只够让你知道该去看哪儿，不够让你动手改。

## 评审当时给出的顺序

**先做 C1**。不是因为它最大，而是因为它是 C3 / C5 / C6 的公共上游，且收益不需要任何新设计就能被现有测试证明（`test/api.test.ts` 22 例 + `test/ui.test.ts` 8 例 + `test/migrations.test.ts` 3 例已在间接覆盖这些规则）。真实事故背书：`src/db/migrations.ts:17-18` 的 settings 门控自举死锁、`src/routes/api.ts:122` 的原子占位 SQL、`test/api.test.ts:60-88` 为竞态手写的带栅栏 D1 代理，都发生在同一个 seam 上。

## 用途

下次 `/wayfinder` chart 可以直接拿这份清单做地图种子——不必从零访谈，也不必重跑整场评审才知道还剩什么。
