# 修复方案：仪表盘三项缺陷（fix plan）

- **输入**：2026-11-15 与维护者三轮对齐。已拍板决策：Q1=A（右上角固定 toast）、Q2=B（按快照恢复按钮状态）、Q3=A（保留解析能力、收进高级折叠项）、Q5=A（只补样式，不加行高亮/滚动）、Q6=A（不改后端文案）、Q7=A+B（浏览器手测为主，补最弱防回归断言）。
- **方案日期**：2026-11-15。基线：`f9c1aff`（工作区干净）。
- **范围**：`src/ui/templates.js` 一处文件为主，外加 `test/templates-escape.test.ts` 三条防回归断言；不触碰 API 契约、数据库、同步与解析语义。
- **本轮只出方案，不动代码。**

## 0. 优先级总览

| 编号 | 问题                                                    | 影响面                                          | 优先级         | 类型     | 改动面                                       | 行为变化                     |
| ---- | ------------------------------------------------------- | ----------------------------------------------- | -------------- | -------- | -------------------------------------------- | ---------------------------- |
| P0   | 任一同步结束后，弹窗内“保存/取消”按钮永久 disabled      | 域名、IP 源两个模态框全部无法保存，属阻断性缺陷 | **P0（最先）** | 缺陷修复 | `src/ui/templates.js`（1 个函数）            | 恢复按钮可用性；无其它语义   |
| P1   | 通知浮层缺样式，消息以纯文本堆在页面最底部且永不移除    | 所有成功/失败反馈都不可见或误以为丢失           | **P1**         | 缺陷修复 | `src/ui/templates.js`（CSS + 移除兜底）      | 提示改为右上角浮层并自动消失 |
| P2   | 解析模式/解析参数常显，和“探测方案”并列，易被误读为必填 | 新增/编辑域名（URL 类型）与 IP 源的表单理解成本 | **P2**         | 交互收敛 | `src/ui/templates.js`（两个弹窗 + 探测回显） | 默认收起，默认路径零操作     |

执行顺序：P0 → P1 → P2，三项各自独立 commit（提交信息见 §5）。三项之间无代码依赖，但 P0 是用户当前无法保存配置的直接原因，必须先发。

---

## 1. 背景事实：解析模式与探测方案不是同一层

这一节记录 P2 的设计依据，避免后续实现时把两者混为一谈。

| 维度         | 探测方案（`fetch_strategy`）                     | 解析模式 / 解析参数（`parse_mode` / `parse_param`）                                                                     |
| ------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 解决的问题   | 怎么把正文抓回来：候选策略逐条回退并缓存命中项   | 从正文里怎么抽 IP：全文/按行/JSON 路径/自定义正则                                                                       |
| 探测时行为   | 依次尝试适用策略，任一策略解析出 IP 即返回并缓存 | **使用表单当前选中的模式解析候选正文**，不参与策略选择                                                                  |
| 是否必须填写 | 不需要，点按钮即可                               | 不需要；`auto` 为默认，NULL / 空串 / 未知值一律按 `auto`                                                                |
| 存在的原因   | 不同站点需要不同抓取通道                         | `auto` 会全文捞取所有合法 IP，遇到含示例 IP、站点自身 IP 的 JSON 或 IP 与端口拼在一起的内容会**抓错**，需要精确定位去噪 |

证据：

- 探测接口用表单解析配置解析候选正文：`src/routes/api.ts:929-951`；前端探测体携带 `parse_mode` / `parse_param`：`src/ui/templates.js:1036-1043`。
- 模式白名单与默认值：`src/sync/ip-parse.ts:13-37`；保存/探测共用校验：`src/sync/ip-parse.ts:49-77`。
- 四种模式的实现差异：`src/sync/ip-parse.ts:395-409`。
- 表结构可空、旧数据保持 NULL：`src/db/migrations.ts:77`。

结论：两者正交、不冲突；不填参数即旧版行为。真正的缺陷是 UI 没有传达“默认自动、可不填”，且 `auto` 误抓时探测仍报成功。

---

## 2. P0：同步后弹窗按钮永久禁用

### 2.1 现状与证据

1. 流式同步开始时把**文档内所有** button 置为 disabled：`src/ui/templates.js:862`。
2. `finally` 里只恢复“不在 `<dialog>` 内”的按钮：`src/ui/templates.js:903-906`。
3. 域名字段弹窗的“保存/取消”在 dialog 内，且 `openModal` 打开时不会重置 `#saveBtn`：`src/ui/templates.js:710-768`。
4. 因此只要跑过任意一次流式请求，这两个按钮就永久禁用，`type="submit"` 不再触发，表现为“编辑后点保存没反应”。

触发入口（全部会被污染）：

- 域名页「手动同步所有目标」→ `POST /api/sync`：`src/ui/templates.js:1014`。
- 域名单条同步 `individualSync`：`src/ui/templates.js:909-912`。
- IP 源页「同步全部」→ `/api/ip_sources/sync_all`：`src/ui/templates.js:1018`。
- IP 源单条同步 `syncSingleIpSource`：`src/ui/templates.js:913-916`。
- 设置页改「三网优选源」后自动触发的 `sync_system`：`src/ui/templates.js:959`。

该逻辑自初始提交即存在，不是新回归。

### 2.2 改法（Q2=B：快照恢复）

在 `handleStreamingRequest` 内改为“禁用前快照、结束时按快照还原”：

```js
// 同步期间禁用全部按钮防止重复触发；结束时按快照还原，
// 不能按「是否在 dialog 内」一刀切，否则弹窗按钮会被永久禁用。
const buttonStates = Array.from(document.querySelectorAll("button"), (b) => [b, b.disabled]);
for (const [b] of buttonStates) b.disabled = true;
```

`finally` 内替换为：

```js
finally {
    // 还原到请求开始前的状态：原本就禁用的（如待探测的 IP 源保存键）保持禁用
    for (const [b, wasDisabled] of buttonStates) b.disabled = wasDisabled;
    if (btn) btn.removeAttribute('aria-busy');
}
```

约束：

- 快照必须在第一处禁用**之前**采集；`btn` 允许为 `null`（`sync_system` 传 null）。
- 不再保留 `closest('dialog')` 判断，也不新增“打开弹窗时重置保存键”的补丁——单点修复，避免两处状态互相覆盖。
- 日志面板、`aria-busy`、SSE 消费与刷新顺序保持不变。

### 2.3 验收标准

1. 手动同步所有目标 → 完成后打开任一域名编辑 → “保存”“取消”均可点击，保存成功并出现提示。
2. 单条域名同步、单条 IP 源同步、IP 源同步全部后，两个弹窗同样可保存。
3. 设置页修改三网优选源触发自动同步后，弹窗同样可保存。
4. 新建 IP 源时保存键仍保持“探测成功后才可点”的原有约束（快照还原不能把它提前放开）。
5. `pnpm test`、`pnpm check` 全绿。
6. 防回归断言：生成的仪表盘脚本中不再出现 `closest('dialog')` 这一恢复判据。

### 2.4 回滚

单函数改动；直接 revert 该 commit 即可，无数据与配置影响。

---

## 3. P1：通知浮层缺失样式

### 3.1 现状与证据

1. 通知容器挂在 `<main>` 之后的 `body` 末尾：`src/ui/templates.js:371`。
2. 全局样式只给该容器写了 `z-index`：`src/ui/templates.js:243`；`.toast` / `.toast-success` / `.toast.show` / `.toast.hide` 在仓库内**没有任何规则**（与首页 `.home-toast` 的完整样式形成对比：`src/ui/templates.js:298-300`）。
3. `showNotification` 到点后只加 `.hide`，依赖 `transitionend` 移除节点：`src/ui/templates.js:621-637`。没有 transition 就不会触发该事件，节点永不移除。

结果：消息以普通文本块追加在页面最底部，且随操作次数累积。这正是“更新成功后在最底部出现‘目标更新成功。’”的根因。

### 3.2 规格

- S1：通知以固定浮层出现在视口右上角，不参与文档流；多条同时存在时纵向堆叠，互不重叠。
- S2：按 `type` 区分语义色边条（`success` / `error` / `info` / `warning`），文字仍走 `textContent`。
- S3：到达 `duration` 后淡出并**移除 DOM 节点**；移除不得只依赖 `transitionend`。
- S4：窄屏（375px）不溢出、不遮挡主要内容；深浅主题下均可读。
- S5：调用点、文案、`duration` 取值全部不变（Q6=A）。

### 3.3 改法

在 `getHtmlLayout` 的 `<style>` 内（`src/ui/templates.js:48-49`，样式尚未拆出，CSS 仍在模板里）补齐规则，放在 `.home-toast` 附近：

```css
/* 后台通知浮层：固定在右上角，按类型着左边条；首页 .home-toast 保持独立 */
.notifications {
    position: fixed;
    top: 80px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: min(360px, calc(100vw - 40px));
    z-index: 1050;
    pointer-events: none;
}
.toast {
    pointer-events: auto;
    padding: 12px 16px;
    border: 1px solid var(--c-card-border);
    border-left: 4px solid var(--text-muted);
    border-radius: var(--radius-sm);
    background: var(--c-card-bg);
    color: var(--c-text);
    font-weight: 500;
    box-shadow: var(--shadow-overlay);
    opacity: 0;
    transform: translateY(-8px);
    transition:
        opacity 0.25s ease,
        transform 0.25s ease;
}
.toast.show {
    opacity: 1;
    transform: translateY(0);
}
.toast.hide {
    opacity: 0;
    transform: translateY(-8px);
}
.toast-success {
    border-left-color: var(--ok);
}
.toast-error {
    border-left-color: var(--danger);
}
.toast-warning {
    border-left-color: var(--warning, var(--danger));
}
.toast-info {
    border-left-color: var(--c-button-bg);
}
```

移除兜底：保留 `transitionend`，同时增加 `duration + 400ms` 的超时移除，二者都调用幂等的 `remove()`：

```js
const removeToast = () => toast.remove();
toast.addEventListener(
    "transitionend",
    (e) => {
        if (e.target === toast) removeToast();
    },
    { once: true }
);
setTimeout(removeToast, duration + 400);
```

约束：

- 遵守 house rules：禁渐变、禁玻璃拟态、禁装饰性图标；阴影只允许浮层使用现有 `--shadow-overlay` 一档。
- 若 `--warning` 未定义，回退到 `--danger`，不新增主题令牌（新增令牌必须落在正确的 `:root` 块，见 `docs/ui-templates-refactor.md` §10 第 1 条）。
- 不改 `#notifications` 的 DOM 位置（`aria-live` 依赖它），只加样式。

### 3.4 验收标准

1. 保存域名 / IP 源 / 设置后，消息出现在右上角，约 5 秒后淡出且 DOM 中不再残留。
2. 连续触发 3 条以上消息时纵向堆叠，不覆盖侧栏、不溢出视口。
3. 错误消息（如“保存失败: …”）与成功消息颜色可区分。
4. 深色 / 浅色主题下文字与背景对比可读。
5. 首页复制提示 `.home-toast` 行为不变。
6. 既有断言仍通过：`test/templates-escape.test.ts:235-239` 的通知纯文本断言；新增断言：全局 CSS 中存在 `.notifications` 的 `position: fixed` 与 `.toast-success` 规则。样式断言需自行拼装 `getHtmlLayout(...)`（`test/templates-escape.test.ts:250-253`）。

### 3.5 回滚

纯 CSS 与 3 行兜底逻辑；revert 后回到“底部文本”现状，无功能退化风险。

---

## 4. P2：解析模式/参数收进高级折叠项

### 4.1 现状与证据

- 域名弹窗（URL 类型）内嵌“解析模式 + 解析参数 + 说明”：`src/ui/templates.js:582`。
- IP 源弹窗同样常显这两项，且位于“探测方案”按钮下方：`src/ui/templates.js:583`。
- 编辑时按存量值回填，NULL 按 `auto`：`src/ui/templates.js:735-737`、`src/ui/templates.js:755-757`。
- 探测请求体与保存体同源归一：`src/ui/dashboard-helpers.js:51-75`。

### 4.2 规格

- S1：两个弹窗的解析模式/参数/说明收进折叠区，默认收起；新建时保持收起。
- S2：编辑已有数据且 `parse_mode !== 'auto'` 时自动展开，避免隐藏已配置的解析规则。
- S3：探测结果文案追加“解析方式：<当前选中项文字>”，纯前端读取 select 文案，不改 API 返回结构。
- S4：字段名、提交体、后端校验、`auto`/`lines` 参数归一为 `null` 的语义全部不变（`src/sync/ip-parse.ts:47`）。
- S5：不做“参数输入框按模式禁用/隐藏”的联动——后端已归一，额外事件处理无功能收益。

### 4.3 改法

1. 两个弹窗内，将解析相关的两个 `div.grid` 与 `<small>` 说明包进：

```html
<details class="advanced-parse">
    <summary>高级解析设置（默认自动，可不填）</summary>
    ...
</details>
```

2. `openModal` 内按模式决定展开状态（域名与 IP 源各一处，紧跟现有回填语句）：

```js
// 存量非 auto 配置必须自动展开，否则用户看不到已生效的解析规则
const mode = domain.parse_mode || "auto";
document.getElementById("domain_parse_mode").value = mode;
document.querySelector("#domainModal .advanced-parse").open = mode !== "auto";
```

IP 源同理使用 `#ipSourceModal .advanced-parse`；新建分支显式置 `open = false`。

3. 探测成功文案在现有拼接末尾追加解析方式（读取 `#parse_mode` 选中项文字）：

```js
const modeLabel = document.getElementById("parse_mode").selectedOptions[0].textContent;
resultElem.textContent = `探测成功！... | 解析方式: ${modeLabel}`;
```

约束：

- 不新增依赖、不改 `buildIpSourceProbePayload` / `buildDomainSavePayload`。
- 不改 `.card-actions` 中按钮顺序（选择器契约，见 `docs/ui-templates-refactor.md` §10 第 4 条）。
- `details` 使用原生元素，不写 JS 展开/收起逻辑。

### 4.4 验收标准

1. 新建 IP 源 / 新建域名（URL 类型）：解析设置默认收起，直接探测即可成功，保存后 `parse_mode` 为 `auto`、`parse_param` 为 `null`。
2. 编辑存量 `json_path` / `custom_regex` 源：折叠区自动展开，模式与参数正确回填，保存后值不变。
3. 探测成功文案包含“解析方式: 自动”。
4. 折叠区可用键盘展开，`summary` 文案明确“默认自动，可不填”。
5. 保存、探测接口行为与改动前逐字一致（可用现有 API 测试回归）。

### 4.5 回滚

仅模板结构与两处回填断言；revert 后恢复常显，无数据影响。

---

## 5. 执行与提交

| 顺序 | 内容          | 建议提交信息                                   | 预估改动                   |
| ---- | ------------- | ---------------------------------------------- | -------------------------- |
| 1    | P0 按钮恢复   | `fix(域名): 同步结束后恢复弹窗按钮可用状态`    | 1 个函数 + 1 条断言        |
| 2    | P1 通知浮层   | `fix(通知): 补齐通知浮层样式并兜底移除节点`    | CSS + 移除兜底 + 1 条断言  |
| 3    | P2 解析项收敛 | `refactor(界面): 解析模式与参数收进高级折叠项` | 两个弹窗 + 回填 + 探测回显 |

提交前统一跑 `pnpm check`（typecheck / 测试类型检查 / 语言门禁 / UTF-8 门禁 / lint / format check / 仪表盘脚本检查）；`pnpm test` 与本机 `pnpm dev` 同跑会偶发启动失败，需要确定性结果时先停 dev server。

## 6. 验证清单（每项改动后都要过）

- [ ] 手动链路：手动同步所有目标 → 编辑域名 → 改前缀/TTL → 保存成功 → 右上角提示 → 列表刷新。
- [ ] IP 源：新建 → 探测 → 保存 → 编辑 → 改 GitHub 路径 → 保存成功。
- [ ] 单条同步、IP 源同步全部、设置页三网源变更后的自动同步，三个入口各跑一次并复验保存。
- [ ] 通知连续触发 5 条不重叠、不残留 DOM。
- [ ] 375px 宽度下通知不溢出、弹窗不被遮挡。
- [ ] 深浅主题各看一遍。
- [ ] `pnpm check`、`pnpm test` 全绿。

## 7. 明确不做（边界）

- 不改后端返回文案（Q6=A），不动 `/api/*` 契约。
- 不加列表行高亮、不自动滚动到更新行（Q5=A）。
- 不让探测自动推荐/自动写入解析模式（需新增探测算法，超出本次范围）。
- 不调整解析模式白名单、校验规则、`fetch_strategy` 回退链与缓存语义。
- 不迁移、不回填存量数据（`parse_mode` 为 NULL 继续按 `auto` 读取）。
- 不引入新依赖、不拆分 `templates.js`、不重建样式目录。
- 不触碰 `wrangler.toml`、Secrets、`.claude/`。
