# CODING_STANDARDS.md

评审期规则（review-judgement rules）的单一真相之源。

`/code-review` 的 Standards 轴、以及任何要替人做「这行代码合规吗」判断的 agent，规则都从这里取——不要在别处重述，也不要从 `AGENTS.md` 手工摘抄。实现期导航与部署红线仍在 `AGENTS.md`。

这里判的是**判断类**问题（该用哪种语言、日志与错误该怎么写），不是机械可脚本化的闸；仓库不为它们建自动检查。

## 语言三档

- **中文**：`console.*` / `throw new Error(msg)` / UI 模板字符串 / 用户可见的 API 错误消息
- **中文**：测试标题——`it()` / `describe()` 的首参
- **英文**：函数名 / 变量名 / 类型名 / import 路径
- **英文**：代码注释中解释「为什么这样做」的元说明可保留英文（一句话内）

**只约束新增与改动的代码与测试标题**：存量英文测试标题不转（约 77 个 `it`，全量转是纯 churn）。

> 历史注记：本条曾把「测试断言文本」划进英文档，与仓库实际（154 个测试里 77 个 `it` 标题是中文、8 个文件以中文为主）长期矛盾，并让评审 agent 每轮误报硬违规。2026-10-21 改到中文档。

## 注释惯例

注释用「中文说明意图 + 英文引用阶段代号」（如 `// FIX-12`、`// P1-8`），保持溯源。

## 模板转义（HTML 模板）

所有用户可控字段（`notes`、`target_domain` 等）必须经 `escapeHtml` 转义。

## 错误日志格式

`console.*` 一律输出中文 user-facing 消息 + `e instanceof Error ? e.stack : e`；**不要**用 `String(e)`。

## API 错误响应

- API 路径：`jsonResponse(errorObj, status)`。
- 非 API 路径：`new Response("固定文案", { status: 500 })`，**绝不**暴露 stack。

## 文档代码围栏

`README.md` 与 `docs/**/*.md` 的围栏内容同样过 Prettier（CI 的 `format:check` 与本地 `pnpm check` 都会扫到）：标了 `js` / `css` / `json` 的片段会被重排（`'`→`"`、`.5`→`0.5`、media query 展开），语义不变。

- 示例代码写成能被格式化器接受的合法片段，不要指望它原样保留。
- 确实需要原样的片段（伪代码、旧版对照），在围栏上一行紧贴 `<!-- prettier-ignore -->`，或干脆不标语言。
