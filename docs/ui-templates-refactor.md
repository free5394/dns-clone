# src/ui/templates.js 重构方案（方案 A）

- 状态：待实施。本文档只描述方案，不含任何代码改动。
- 修订：v2（2026-11-10）按评审结论调整：契约门禁前移到结构拆分之前、注入点订正为六处、合并碎片客户端片段、基线改为可复算、补上 AGENTS.md 失效引用修复与"暂缓拆分"条件。
- 决策：Q1 选定方案 A（源码层拆分、运输格式不变）。
- 范围：`src/ui/**` 的文件组织方式，不改行为、样式、接口与数据库。
- 前提：不引入新依赖、新构建工具、新运行期资源。

## 1. 目标与非目标

### 1.1 目标

1. 单文件从 988 行降到每文件不超过 200 行（这是上限，不是目标：不为凑行数继续切碎片）；HTML、CSS、浏览器脚本、共享工具各归其位。
2. 对外接口零变化：`getHtmlLayout`、`getSetupPage`、`getPublicHomepage`、`getDashboardPage`、`consumeSseEvents` 的导出名、参数、返回值保持原样。
3. 页面字节不变：同一组输入渲染出的 HTML 与重构前逐字节一致。
4. 把当前只能靠人眼守的隐式契约（class / id / `onclick` / `__name` 垫片 / 片段执行顺序）变成可自动检查的规则。
5. 门禁先于拆分：§7.2 的 R1–R3、R6 在结构改动之前就先对现有单文件生效，让每一步搬运都有可验证的守门人。

### 1.2 非目标

- 不引入模板引擎、CSS 预处理器、前端框架。
- 不把 CSS / JS 变成运行期独立资源，不新增静态资源路由，不改 `wrangler.toml`。
- 不改造类型体系：templates.js 及其后继模块仍不做 `tsc` 类型检查（`checkJs: false`），也不进入覆盖率统计；新模块会作为 JS 进入 program 参与解析，但这一定位不变。
- 不调整任何页面视觉、交互流程、后端接口或表结构。

## 2. 事实约束（方案的依据）

| 事实                                                   | 证据                                                                                                                                                                           | 对方案的强制含义                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 运行时是 Cloudflare Worker，无文件系统、无静态资源绑定 | [wrangler.toml](file:///d:/dev/works/github/free5394/dns-clone/wrangler.toml) 无 `[assets]`                                                                                    | 页面只能在请求期拼成字符串随 `Response` 返回         |
| 有两条必须同时成立的部署路径                           | [package.json](file:///d:/dev/works/github/free5394/dns-clone/package.json) 的 `dev` / `deploy` / `build:single`                                                               | 任何拆分结果都必须能合回单个 Worker 文件             |
| 单文件产物要求可读、不压缩                             | [build-single-file.mjs](file:///d:/dev/works/github/free5394/dns-clone/scripts/build-single-file.mjs) `minify: false`、`sourcemap: false`                                      | 构建期加工越重，产物与源码越难对应                   |
| 客户端脚本靠 `toString()` 跨进程搬运                   | [templates.js](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L604-L796) 六处注入（L604 / L624 / L639 / L641 / L657 / L796）                               | 被注入的函数体必须自包含，不能引用模块作用域         |
| esbuild `keep_names` 会向函数体插入 `__name` 调用      | [templates.js](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L594-L603)                                                                                   | 浏览器侧必须有垫片，且必须在首段                     |
| templates.js 被刻意排除在 tsc 与覆盖率之外             | [tsconfig.json](file:///d:/dev/works/github/free5394/dns-clone/tsconfig.json#L19)、[vitest.config.ts](file:///d:/dev/works/github/free5394/dns-clone/vitest.config.ts#L32-L33) | 它是文本工厂，不是待类型化代码；拆分不改变这一定位   |
| 语言门禁只扫 `ts / js / mjs / cjs`                     | [check-changed-language.mjs](file:///d:/dev/works/github/free5394/dns-clone/scripts/check-changed-language.mjs#L6)                                                             | 新增 `.css` / `.html` 会掉出门禁覆盖，拆分只用 `.js` |
| 红线：不引入新依赖或构建工具                           | AGENTS.md「实现红线」                                                                                                                                                          | 排除一切需要改构建配置的方案                         |

由这些事实得到的结论：

1. **运输层只能是字符串。** 浏览器最终拿到的必然是内联 `<style>` 与内联 `<script>`，这一点在本项目里不可协商。
2. **拆分解决的是"编写层"，不是"运输层"。** 值得优化的是变更半径与反馈回路，不是运行时结构。
3. **任何改动都必须同时通过 `wrangler dev` 与单文件粘贴部署**，否则等于埋一个只在用户侧爆发的故障。

## 3. 现状分析

### 3.1 体量与职责分布

文件共 988 行、65,378 字节。

| 行范围  | 内容                                                                  | 行数 | 占比 |
| ------- | --------------------------------------------------------------------- | ---- | ---- |
| 1–28    | `escapeHtml`、`safeJsonForScript`（SSR 转义与脚本上下文 JSON 安全化） | 28   | 3%   |
| 34–358  | `getHtmlLayout`：`<head>`、CDN 外链、319 行内联 CSS、首帧主题脚本     | 325  | 33%  |
| 360–362 | `getSetupPage`                                                        | 3    | —    |
| 368–529 | `getPublicHomepage`：卡片渲染、导航、登录弹窗、内联脚本（478–527）    | 162  | 16%  |
| 534–569 | `getDashboardPage`：侧栏、三个面板、设置表单、两个弹窗                | 36   | 4%   |
| 572–583 | `consumeSseEvents`（服务端导出 + 浏览器注入，双用途）                 | 12   | 1%   |
| 589–650 | 仪表盘脚本装配头：垫片、通知、请求封装、数据注入、转义助手            | 62   | 6%   |
| 653–986 | 四段脚本：渲染、交互、同步、启动                                      | 334  | 34%  |
| 988     | 尾注释（说明函数已迁走）                                              | 1    | —    |

按语言归类：内联 CSS 约 34%，浏览器脚本约 38%，HTML / SSR 约 22%，共享工具与协议约 6%。

### 3.2 三类耦合

**A. 字符串层耦合：一段文本同时是两种语言**

CSS 与浏览器 JS 都写在模板字符串里，`\`` 与 `${}`成为跨语言转义符。例如
[templates.js:783](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L783) 的`\${id}`是为了让浏览器看到`${id}`；
[templates.js:373](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L373) 的 `${day}` 则是服务端插值。两者写法只差一个反斜杠，含义完全不同。
后果：改 CSS 时的语法错误会以 JS 报错的形式出现，定位成本高。

补充：样式片段抽出后不再包含任何插值（§4.2 规定 `styles/*` 无逻辑、无插值），CSS 侧的这类转义陷阱可以彻底消除；浏览器脚本侧因为仍要输出模板字符串，`\${` 仍需保留，收益只到"片段变小"为止。

**B. 契约层耦合：HTML 结构被脚本按名字消费**

- `id` 契约：`#domain-list-container`、`#ip-source-list-container`、`#logOutput`、`#ipLogOutput`、`#settingsForm`、`#addDomainBtn`、`#probeBtn` 等，被 [bootstrap 段](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L925-L985) 逐个 `getElementById`。
- `class` 契约：`.nav-link`、`.page`、`.domain-card`、`.row-grid`、`.card-actions`、`.public-card` 同时被 CSS 与 JS 选择器依赖。
- `onclick` 契约：HTML 里写 `window.copyToClipboard`、`window.openModal`、`window.deleteDomain`、`window.individualSync`、`window.syncSingleIpSource`、`window.deleteIpSource`、`window.closeModal`，对应实现在脚本段里以 `window.X = ...` 挂载（如 [dashboard-render.js](file:///d:/dev/works/github/free5394/dns-clone/src/ui/dashboard-render.js#L43-L58) 与 [templates.js:688](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L688)）。

三类契约都没有任何工具校验，改名即静默失效。

**C. 注入层耦合：`toString()` + `keep_names`**

[dashboard-helpers.js](file:///d:/dev/works/github/free5394/dns-clone/src/ui/dashboard-helpers.js)、[dashboard-render.js](file:///d:/dev/works/github/free5394/dns-clone/src/ui/dashboard-render.js)、[dashboard-api.js](file:///d:/dev/works/github/free5394/dns-clone/src/ui/dashboard-api.js) 的函数体经 `.toString()` 注入浏览器，因此必须完全自包含。注入点共 **六处**：`consumeSseEvents`（L604）、`createApiFetch`（L624）、`escapeHtmlClient`（L639）、`canAddDomains`（L641）、`createDashboardRenderers`（L657）、`planSyncCompletionActions`（L796）——三段模块实现、六个注入点（旧版本曾误记为四处）。esbuild 的 `keep_names` 会重写这些函数体内的嵌套函数并插入 `__name(...)`，浏览器没有该 helper，故 [templates.js:596](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L596) 手写垫片。
这条耦合最危险：服务端测试全绿，浏览器整段脚本在 `ReferenceError` 处中止，后台所有交互失效。

### 3.3 依赖与调用方

上游（消费方）：

| 调用方                                                                                                                                                                                                               | 使用内容                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [routes/ui.ts](file:///d:/dev/works/github/free5394/dns-clone/src/routes/ui.ts#L15)                                                                                                                                  | 四个页面函数                                              |
| [check-dashboard-script.mjs](file:///d:/dev/works/github/free5394/dns-clone/scripts/check-dashboard-script.mjs)                                                                                                      | `getDashboardPage`，解析内联脚本语法与 `__name` 声明      |
| [templates-escape.test.ts](file:///d:/dev/works/github/free5394/dns-clone/test/templates-escape.test.ts)                                                                                                             | 四个页面函数 + `consumeSseEvents`，断言渲染后的 HTML 子串 |
| [dashboard-helpers.test.ts](file:///d:/dev/works/github/free5394/dns-clone/test/dashboard-helpers.test.ts)、[dashboard-render.test.ts](file:///d:/dev/works/github/free5394/dns-clone/test/dashboard-render.test.ts) | 经 `getDashboardPage` 验证注入实现与模块实现一致          |
| [ui.test.ts](file:///d:/dev/works/github/free5394/dns-clone/test/ui.test.ts)、[smoke.test.ts](file:///d:/dev/works/github/free5394/dns-clone/test/smoke.test.ts)                                                     | 经路由间接消费，断言整页内容                              |

下游（被依赖）：

- 模块内：`dashboard-helpers.js`（`escapeHtmlClient`、`canAddDomains`、`planSyncCompletionActions`）、`dashboard-render.js`（`createDashboardRenderers`）、`dashboard-api.js`（`createApiFetch`）。
- 运行时外链：PicoCSS 2、FontAwesome 6.5.1（CDN），首帧主题脚本内置。

### 3.4 受影响的文件

| 文件                                 | 变化                                             |
| ------------------------------------ | ------------------------------------------------ |
| `src/ui/templates.js`                | 重写为兼容门面（仅 re-export）                   |
| `src/ui/layout/*`                    | 新增                                             |
| `src/ui/styles/*`                    | 新增                                             |
| `src/ui/pages/*`                     | 新增                                             |
| `src/ui/fragments/*`                 | 新增                                             |
| `src/ui/client/*`                    | 新增                                             |
| `scripts/ui-fixtures.mjs`            | 新增（两组检查脚本共用夹具）                     |
| `scripts/ui-baseline.mjs`            | 新增（基线生成与比对，固定 TZ 后可复算）         |
| `scripts/check-ui-contracts.mjs`     | 新增（契约门禁）                                 |
| `scripts/check-dashboard-script.mjs` | 修改（补顺序断言；订正"不接入 check"的过时注释） |
| `package.json`                       | 新增 `check:ui-contracts` 脚本，并接入 `check`   |
| `docs/ui-templates-refactor.md`      | 本文档                                           |
| `AGENTS.md`                          | 修正已删除的 `docs/ui-redesign.md` §11 引用      |
| `README.md`                          | 目录结构说明补一行（可选）                       |

不动：`routes/ui.ts`、三个 `dashboard-*.js`、`wrangler.toml`、`tsconfig.json`、`vitest.config.ts`、所有既有测试文件。

## 4. 目标结构

### 4.1 目录树

```text
src/ui/
├── templates.js                     # 兼容门面：对外唯一入口，仅 re-export
├── dashboard-api.js                 # 既有，不动
├── dashboard-helpers.js             # 既有，不动
├── dashboard-render.js              # 既有，不动
├── layout/
│   ├── meta.js                      # escapeHtml、safeJsonForScript
│   ├── document.js                  # getHtmlLayout：整页骨架与两个槽位
│   └── theme-boot.js                # getThemeBootScript：首帧主题
├── styles/
│   ├── tokens.js                    # 原 36–160：浅色与暗色设计令牌
│   ├── base.js                      # 原 161–232：全局布局、行网格、按钮、状态徽标
│   ├── public-page.js               # 原 233–287：公开首页与页头
│   ├── components.js                # 原 288–308：焦点环、减少动效、tooltip、弹窗底部
│   ├── responsive.js                # 原 309–354：四个断点
│   └── index.js                     # getStyles：按固定顺序拼接
├── pages/
│   ├── setup.js                     # getSetupPage
│   ├── homepage.js                  # getPublicHomepage
│   └── dashboard.js                 # getDashboardPage（骨架 + 脚本装配）
├── fragments/
│   ├── dashboard-sidebar.js         # 侧栏与导航
│   ├── dashboard-panels.js          # 域名克隆 / GitHub 上传两个面板
│   ├── dashboard-settings-panel.js  # 系统设置表单与教程 details
│   └── dashboard-modals.js          # domainModal、ipSourceModal
└── client/
    ├── sse.js                       # consumeSseEvents（服务端导出 + 浏览器注入）
    ├── runtime.js                   # 垫片、通知、请求封装装配
    ├── state.js                     # 数据注入 + 客户端转义/按钮判定/时间格式化
    ├── render.js                    # 列表渲染段
    ├── interactions.js              # 弹窗、复制、表单保存段
    ├── sync.js                      # 流式同步、单条同步、设置保存段
    ├── bootstrap.js                 # DOMContentLoaded 绑定段
    ├── homepage.js                  # 公开首页的内联脚本段
    └── dashboard-script.js          # 六个片段的装配器，顺序即字节顺序
```

### 4.2 文件职责

| 文件                         | 职责                                                        | 关键导出                                                |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `templates.js`               | 保持对外接口稳定，内部结构可自由调整                        | 5 个既有导出，全部 `export ... from`                    |
| `layout/meta.js`             | SSR 转义与 `</script>` 逃逸防护                             | `escapeHtml`、`safeJsonForScript`                       |
| `layout/document.js`         | 拼接 `<!DOCTYPE>`、`<head>`、外链、`<style>` 与 `<body>` 壳 | `getHtmlLayout(title, content)`                         |
| `layout/theme-boot.js`       | 首帧主题判定与切换按钮逻辑                                  | `getThemeBootScript()`                                  |
| `styles/index.js`            | 唯一的样式出口，固定拼接顺序                                | `getStyles()`                                           |
| `styles/*.js`                | 各自一段 CSS 文本，无逻辑、无插值                           | `getXxxStyles()`                                        |
| `pages/*.js`                 | 页面级 HTML 组合与服务端插值                                | `getSetupPage`、`getPublicHomepage`、`getDashboardPage` |
| `fragments/dashboard-*.js`   | 仪表盘可独立审阅的结构块，纯字符串函数                      | `getDashboardSidebar()` 等                              |
| `client/*.js`                | 浏览器侧脚本片段，返回字符串                                | `getXxxScript(...)`                                     |
| `client/dashboard-script.js` | 仪表盘脚本的唯一装配点，固化片段顺序                        | `getDashboardScript(domains, ipSources, settings)`      |
| `client/sse.js`              | 纯函数，同时供服务端导出与浏览器注入                        | `consumeSseEvents`                                      |

### 4.3 依赖方向

```text
templates.js ──> pages/*  ──> fragments/*  ──> layout/meta.js
     │              │
     │              ├──> client/*          （仅取字符串片段）
     │              └──> layout/meta.js
     └──> layout/document.js ──> styles/index.js ──> styles/*.js
                             └─> layout/theme-boot.js

styles/*、client/*：零 import（client 的函数体要能被 toString() 注入）
```

硬规则：

1. 依赖只允许自上而下，`styles/**` 与 `client/**` 不得 import 任何模块。
2. `fragments/**` 不得 import `pages/**`。
3. `templates.js` 只做 re-export，不承载逻辑。
4. 出现循环依赖即视为设计错误，不回退到"先这样"。

### 4.4 命名与导出规范

- 目录：`layout`、`styles`、`pages`、`client` 为单数不可数名词；`fragments` 用复数。
- 文件：kebab-case，与主导出语义对齐（`dashboard-settings-panel.js` 导出 `getDashboardSettingsPanel()`）。
- 函数：服务端渲染用 `getXxx`（返回完整页面/片段），样式用 `getXxxStyles`，浏览器脚本用 `getXxxScript`。
- 导出：全部具名导出，禁止 `default`；门面用 `export { x } from "./x.js"`。
- 每个模块首行写一行中文职责注释，满足语言门禁（AGENTS.md 的 `check:language` 要求 js 文件含中文注释）。
- 文件内不写跨模块的隐式全局；`window.*` 挂载只允许出现在 `client/interactions.js`、`client/sync.js`。
- 每个客户端片段内的顺序锚点声明保持稳定（R6 的 token 表取自这些声明），不要为了"更好读"调整它们的先后。

### 4.5 关键接口

```js
// styles/index.js —— 顺序即层叠顺序。用显式数组固化，避免"调整 import 顺序"静默改变层叠结果
import { getTokenStyles } from "./tokens.js";
import { getBaseStyles } from "./base.js";
import { getPublicPageStyles } from "./public-page.js";
import { getComponentStyles } from "./components.js";
import { getResponsiveStyles } from "./responsive.js";

const STYLE_SEGMENTS = [getTokenStyles, getBaseStyles, getPublicPageStyles, getComponentStyles, getResponsiveStyles];

export function getStyles() {
    return STYLE_SEGMENTS.map((getSegment) => getSegment()).join("");
}
```

```js
// layout/document.js —— 原有两处插值保持不变
import { getStyles } from "../styles/index.js";
import { getThemeBootScript } from "./theme-boot.js";

export function getHtmlLayout(title, content) {
    return `<!DOCTYPE html><html lang="zh-CN"><head>...<title>${title}</title>...<style>${getStyles()}</style><script>${getThemeBootScript()}</script></head><body><main class="container">${content}</main><div id="notifications" ...></div></body></html>`;
}
```

```js
// templates.js —— 兼容门面
export { getHtmlLayout } from "./layout/document.js";
export { getSetupPage } from "./pages/setup.js";
export { getPublicHomepage } from "./pages/homepage.js";
export { getDashboardPage } from "./pages/dashboard.js";
export { consumeSseEvents } from "./client/sse.js";
```

```js
// pages/dashboard.js —— 拼接顺序必须与现状一致
import { getDashboardScript } from "../client/dashboard-script.js"; // 装配器，内部按下述顺序拼接

export function getDashboardPage(domains, ipSources, settings) {
    // 顺序：侧栏 → main-content 开标签 → 面板 → 设置面板 → main-content 闭标签 → 弹窗 → script
    return (
        getDashboardSidebar() +
        '<div class="main-content">' +
        getDashboardPanels() +
        getDashboardSettingsPanel(settings) +
        "</div>" +
        getDashboardModals() +
        `<script>${getDashboardScript(domains, ipSources, settings)}</script>`
    );
}
```

```js
// client/dashboard-script.js —— 装配器，顺序就是字节顺序
import { getClientRuntimeScript } from "./runtime.js";
import { getClientStateScript } from "./state.js";
import { getDashboardRenderScript } from "./render.js";
import { getDashboardInteractionScript } from "./interactions.js";
import { getDashboardSyncScript } from "./sync.js";
import { getDashboardBootstrapScript } from "./bootstrap.js";

export function getDashboardScript(domains, ipSources, settings) {
    return (
        getClientRuntimeScript() + // 垫片必须在最前
        getClientStateScript(domains, ipSources, settings) + // 数据 + esc / canAddDomains / formatBeijingTime，必须先于渲染段
        getDashboardRenderScript() +
        getDashboardInteractionScript() +
        getDashboardSyncScript() +
        getDashboardBootstrapScript()
    );
}
```

顺序不是风格问题，是执行顺序：`__name` 垫片必须在首段才能被后续段调用；`esc`、`canAddDomains`、`formatBeijingTime` 必须在渲染段之前声明，否则渲染段立即执行时命中暂时性死区。

这段顺序由 R6 用固定 token 表校验，token 表写在门禁脚本里；**不往产物里加顺序标记注释**，否则会改变页面字节、破坏 I2。

## 5. 迁移步骤

每一步独立可验证、独立可回滚，一次提交只做一件事。切分一律"原样搬运"，不允许顺手改写、重排缩进或整理空行——字节相等是唯一硬判据，任何"顺手优化"都会让基线与实际失配。

### S0 建立基线（不改源码）

- 新增 `scripts/ui-fixtures.mjs`：导出 6 组固定夹具（见 7.1），供基线与门禁复用。
- 新增 `scripts/ui-baseline.mjs`，提供两个模式：
    - `--write`：调用四个导出，对每组夹具计算整页 HTML 的 sha256（`getHtmlLayout` 包裹后的结果）、仪表盘内联脚本体（`<script>` 内文本）的 sha256、各段长度，写入 `.scratch/ui-baseline.json`；
    - `--check`：重新计算并与基线比对，任一条不等即 exit 1。
- 基线文件仍留在被忽略的 `.scratch/`、不入库；**脚本入库**，任何机器都能复算，避免"基线只存在于作者本机"。
- 时区固定：`getPublicHomepage` 的 `formatTime` 用本地日期方法，哈希随 `TZ` 变化；脚本入口固定 `process.env.TZ = "Asia/Shanghai"`，保证跨机器可复现。
- 验证：`node scripts/ui-baseline.mjs --write` 输出 12 条哈希；换一个 `TZ` 再跑 `--check` 仍通过。
- 回滚：只新增脚本，无需回滚。

### S1 契约门禁 v1（对现有单文件生效，先于任何结构改动）

- 新增 `scripts/check-ui-contracts.mjs`，实现 §7.2 的 R1、R2、R3、R6（四条规则）。它们都只读字符串、不依赖目录结构，因此可以先对 988 行的现状生效。
- `package.json` 增加 `"check:ui-contracts": "node scripts/check-ui-contracts.mjs"`，并把 `pnpm check:ui-contracts` 追加到 `check` 链尾部。副作用：pre-commit 与 CI 各多一步纯字符串扫描。
- 订正 `scripts/check-dashboard-script.mjs` 的头注释：该脚本已经通过 `check:dashboard` 进入 `pnpm check` 与 CI，"不接入 `pnpm check`"的说法与 [package.json](file:///d:/dev/works/github/free5394/dns-clone/package.json#L20) 现状不符。
- 反向验证（必须做，否则门禁可能恒绿）：分别改名一个 `id`、删掉一个 `window.X =`、打乱一个顺序 token，三次都必须 exit 1；改回后恢复 exit 0。
- 回滚：`git revert` 单个提交。

### S2 抽出样式（对应原 36–354）

- 新增 `styles/{tokens,base,public-page,components,responsive,index}.js`，按 4.1 的边界整段搬运。
- `styles/index.js` 用显式数组固化拼接顺序（见 4.5），不依赖 import 语句的书写顺序；CSS 层叠顺序由此从"文件内自然顺序"变成可断言的常量。
- `layout/document.js` 建立，`getHtmlLayout` 的 CSS 区改为 `${getStyles()}`；主题脚本迁入 `layout/theme-boot.js`。
- 修改点：[templates.js:35](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L35) 的 `<style>` 内容与 [templates.js:355](file:///d:/dev/works/github/free5394/dns-clone/src/ui/templates.js#L355) 的 `<script>` 内容。
- 关键细节：切分点必须落在完整行边界，**片段包含原行的前导换行与尾随换行**，否则拼回来会少一个 `\n`，哈希立刻不等。
- 验证：`node scripts/ui-baseline.mjs --check` 12 条哈希全部相等；`pnpm test` 中 UI 相关用例通过；`pnpm check:ui-contracts` 通过；390/768/1440 三种宽度 + 明暗两套主题的截图与 `.scratch/shots/final/` 同分辨率比对。
- 回滚：`git revert` 单个提交。

### S3 抽出仪表盘客户端脚本（对应原 589–986）

- `client/sse.js`：`consumeSseEvents` 原样搬出，`templates.js` 改为 re-export。
- `client/runtime.js`：原 596–630（垫片、`consumeSseEvents` 注入、`showNotification`、`createApiFetch` 装配）。
- `client/state.js`：原 631–643（`currentDomains` / `currentIpSources` / `currentSettings` / `zoneName` / `successfulProbeStrategy`，以及 `esc` / `canAddDomains` / `formatBeijingTime`）。两段相邻且必须整体先于渲染段，合并为一个片段；旧方案把 5 行的数据段与 7 行的格式化段拆成两个文件，属于碎片化，已合并。
- `client/render.js`、`client/interactions.js`、`client/sync.js`、`client/bootstrap.js`：原 653–986 四段整段搬运，函数名不变。
- `client/dashboard-script.js`：新增装配器，顺序见 4.5。
- 验证：12 条哈希相等；`node scripts/check-dashboard-script.mjs` 通过（语法解析 + `__name` 声明检查 + 顺序断言）；`pnpm check:ui-contracts` 通过（R6 在拆分后仍须成立）；浏览器打开 `/admin` 确认控制台无报错、三个页签可切换。
- 回滚：`git revert` 单个提交。

### S4 抽出页面与片段（对应原 34–362、368–569）

- `layout/meta.js`：原 9–28。
- `pages/setup.js`：原 360–362 整段（内含一行内联脚本，不单独抽 `client/setup.js`——不足两行的片段抽出去只增加文件数；同一原则已用于 S3 的 `state.js` 合并）。
- `pages/homepage.js` + `client/homepage.js`：页面骨架与原 478–527 的内联脚本分离。
- `fragments/dashboard-*.js`：侧栏、两个列表面板、设置面板、两个弹窗按完整标签边界切分。
- `pages/dashboard.js`：只保留装配逻辑与两处条件属性计算（`githubSettingsComplete`、`cfSettingsComplete`）。
- 验证：12 条哈希相等；`pnpm test`；`check-dashboard-script.mjs`；`pnpm check:ui-contracts`。
- 回滚：`git revert` 单个提交。

### S5 门面收敛

- `templates.js` 重写为纯 re-export，保留原文件头注释并补充"内部结构见 docs/ui-templates-refactor.md"。
- 确认 `tsconfig.json` 的 `exclude` 仍指向 `src/ui/templates.js`：新目录在 `allowJs: true` + `checkJs: false` 下会被 `include` 收进去，但只做解析、不做类型检查，`pnpm typecheck` 应当仍通过。若出现意外报错，优先把 `exclude` 写成具体新目录（如 `src/ui/layout`、`src/ui/styles`）；**不要直接扩成 `src/ui/**`**——那会把既有三个 `dashboard-*.js` 一并移出 tsc 程序，等于顺手削弱现状。
- 验证：`pnpm check` 全绿；`pnpm test`；`node scripts/check-dashboard-script.mjs`；`pnpm build:single` 体积变化不超过 ±2%，且产物可通过 `wrangler deploy --dry-run`。
- 回滚：`git revert` 单个提交；因对外接口未变，`routes/ui.ts` 不需要联动回滚。

### S6 门禁补强与文档

- `check-ui-contracts.mjs` 追加 R4（`client/**` 与 `dashboard-*.js` 不得出现 import）与 R5（class 无定义只告警）。
- `check-dashboard-script.mjs` 改为从 `scripts/ui-fixtures.mjs` 取夹具，消除两份夹具漂移；顺序 token 表也只保留一份。
- `README.md` 的目录结构说明补 `src/ui/` 的新分层。
- 修正 `AGENTS.md` 第 12 行：`docs/ui-redesign.md` 已在 `f53dac0` 删除，改为指向本文件新增的 §10「界面模板编写约束」（内容从该文件 §11 的 git 历史迁移，行号改为语义定位，避免重构后失效）。同段引用的 `docs/architecture-review.md` 也已删除，若本次不动，至少在 issue 登记。
- 验证：故意在 `client/**` 里加一行 `import`，R4 必须失败；给一个未定义 class，R5 只告警不阻塞；`pnpm check` 全绿。
- 回滚：`git revert` 单个提交。

### 提交粒度

建议 8 个提交，顺序即提交顺序，信息遵循仓库规范：

```text
test(ui): 新增模板夹具与可复算基线脚本
test(ui): 新增模板契约门禁
refactor(ui): 抽出样式与布局模块
refactor(ui): 抽出仪表盘客户端脚本分段
refactor(ui): 抽出页面与片段模块
refactor(ui): templates.js 收敛为门面
test(ui): 补强契约门禁并统一夹具
docs(ui): 补充分层说明与界面模板约束
```

## 6. 兼容性与风险控制

### 6.1 必须保持的不变量

| 编号 | 不变量                                                     | 破坏后果                                   |
| ---- | ---------------------------------------------------------- | ------------------------------------------ |
| I1   | 五个导出的名字与签名不变                                   | `routes/ui.ts` 与 4 个测试文件同时报错     |
| I2   | 渲染结果逐字节不变                                         | 视觉/交互漂移，且难以定位                  |
| I3   | 拼接顺序不变（垫片最先，格式化助手先于渲染段），由 R6 守护 | 浏览器 `ReferenceError`，后台交互全挂      |
| I4   | 被注入的函数体自包含                                       | 同上，且服务端测试全绿，问题只在浏览器暴露 |
| I5   | `</script>` 逃逸防护（`safeJsonForScript`）不变            | 存储型 XSS 回归                            |

### 6.2 风险与缓解

| 风险                         | 触发条件                                         | 影响                             | 缓解                                                                          |
| ---------------------------- | ------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| 注入函数引用了模块作用域变量 | 搬运时"顺手"引用 `esc`、`zoneName`、`escapeHtml` | 后台整段脚本中止，测试发现不了   | I4 由 R4 静态拦截；S3 每步跑 `check-dashboard-script` 与 `check:ui-contracts` |
| 拼接顺序被调整               | 按"更合理"的顺序重排分段                         | 字节失配或 TDZ 报错              | 4.5 明确顺序；R6 断言 token 次序；哈希门禁抓字节失配                          |
| CSS 层叠顺序错位             | 五个样式文件乱序合并                             | 暗色主题或断点样式失效           | `styles/index.js` 用显式数组固化顺序（4.5）+ 390/768/1440 双主题截图比对      |
| `__name` 垫片被移出首段      | 把垫片并入某个后续段                             | 整段脚本失效                     | 垫片固定在 `runtime.js` 首行；R3 校验                                         |
| 新增模块缺中文注释           | 遗忘模块头注释                                   | pre-commit 语言门禁失败          | 每个文件首行写职责注释                                                        |
| 构建体积异常                 | 字符串常量被 esbuild 常量折叠                    | 单文件产物体积变化               | S5 比对 `pnpm build:single` 输出，阈值 ±2%                                    |
| 覆盖率下降                   | 新模块被计入覆盖                                 | `test:coverage` 阈值失守         | 已核实 `coverage.include` 为 `src/**/*.ts` 且 `exclude` 含 `src/ui/**`        |
| 门禁本身失效（恒绿）         | 检查脚本写错或夹具没覆盖到路径                   | 给出虚假安全感                   | S1 与 S6 都要求"故意改坏 → 必须变红"的反向验证                                |
| 基线不可复算                 | 换机器 / 换时区后哈希不同                        | 字节判据失效，或被误判为回归     | `ui-baseline.mjs` 固定 `TZ=Asia/Shanghai` 并入库，基线可随时重建              |
| 治理引用失效                 | 按 AGENTS.md 找不到 `docs/ui-redesign.md` §11    | 执行者卡在缺失文档或直接忽略约束 | §10 承接该内容，S6 更新 AGENTS.md 指向                                        |
| 过度切分增加间接层           | 为凑行数把 5–7 行的片段单独成文件                | 阅读需跨多文件跳转，反而更慢     | 合并 `state.js`；200 行是上限不是目标；按主题而非行数切分                     |
| 单文件产物路径未覆盖         | 只验证源码渲染，未验证 bundle                    | 与 `2b18142` 事故同源            | S5 对 `build:single` 产物跑 dry-run；7.3 第 9 项用 bundle 起服务验证          |

### 6.3 回滚与上线

- 每个阶段一个提交（S6 拆成"门禁补强"与"文档"两个），`git revert <hash>` 即可回到上一阶段，不涉及数据库、环境变量、构建配置。
- 因为对外接口不变，**不存在"需要同时回滚调用方"的情况**，回滚窗口很短。
- 建议一次性合并（8 个提交同 PR），不要分批上线：分批会让"字节相等"这条判据失去意义。
- 上线顺序：S1 门禁单独提交并确认"改坏变红、改回变绿" → 本地 `pnpm dev` 跑完 7.3 的手工清单 → `pnpm check && pnpm test` → `pnpm build:single` 核对体积并对产物再跑一遍手工清单 → `pnpm deploy` → 生产环境跑第三遍手工清单。
- 不涉 D1 迁移，不需要备份与门控。

## 7. 验证方案

### 7.1 基线夹具（6 组）

| 组  | 场景                                          | 覆盖点                                |
| --- | --------------------------------------------- | ------------------------------------- |
| F1  | 未初始化（仅 `getSetupPage`）                 | 初始化页与整页壳                      |
| F2  | 首页未登录 + 有数据                           | 卡片渲染、复制按钮、登录弹窗          |
| F3  | 首页已登录 + 有数据                           | `authButton` 分支                     |
| F4  | 首页空数据                                    | "暂无可用数据"分支                    |
| F5  | 仪表盘：CF / GitHub 均未配置、字段为空        | `disabled` 属性、`placeholder` 分支   |
| F6  | 仪表盘：均已配置、含 `is_system` 行与失败状态 | `selected` / `checked` / 状态徽标分支 |

每组记录两类哈希：整页 HTML、仪表盘内联脚本体。共 12 条。`getPublicHomepage` 的 `formatTime` 用本地日期方法，哈希随 `TZ` 变化；`scripts/ui-baseline.mjs` 固定 `TZ=Asia/Shanghai` 后再计算，保证任何机器可复算。

### 7.2 契约门禁规则（`scripts/check-ui-contracts.mjs`）

| 规则 | 内容                                                                                                                                  | 级别 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| R1   | HTML 内联事件属性（`onclick=` 等）里的每个 `window.X` 必须有实现；其中的 `getElementById('X')` / `querySelector('#X')` 必须有对应节点 | 失败 |
| R2   | 脚本里 `getElementById('X')` / `querySelector('#X')` 的每个 `X`，必须在本页 HTML 中存在                                               | 失败 |
| R3   | 每个 `__name(` 调用必须有同段声明（沿用现有规则）                                                                                     | 失败 |
| R4   | `client/**`、`dashboard-*.js` 内不得出现 `import` 语句                                                                                | 失败 |
| R5   | HTML 出现的 class 在 CSS 中无定义时输出告警（Pico 内置类、动态拼接类走白名单）                                                        | 告警 |
| R6   | 仪表盘内联脚本里，装配顺序 token 必须严格递增出现（垫片 → SSE → 状态/格式化 → 渲染 → 交互 → 同步 → 启动）                             | 失败 |

R1–R4、R6 是新增失效模式的止血带；R5 只告警，避免噪声阻塞提交。落地节奏：R1/R2/R3/R6 在 S1 就对现有单文件生效；R4/R5 需要目录拆分后才谈得上，放在 S6。R6 的 token 表写在门禁脚本里，取自各片段的首个声明（如 `const __name =`、`const consumeSseEvents =`、`let currentDomains =`、`const esc =`、`const createDashboardRenderers =`、`window.copyToClipboard =`、`document.addEventListener('DOMContentLoaded'`），**不往产物里加标记**，因此不影响页面字节。

### 7.3 手工回归清单

1. 首页：未登录点登录 → 输错密码 → 提示；输对 → 跳 `/admin`。
2. 首页：点卡片复制 → toast 出现，内容正确。
3. 主题：切换按钮 → 图标与配色变化；刷新后保持；系统偏好变化时跟随。
4. 后台：三个页签切换，URL 锚点与 `.active` 同步。
5. 域名：新增 → 编辑 → 删除；系统内置行按钮为禁用态。
6. 单条同步：SSE 日志逐行输出；结束后列表自动刷新且刷新在提示之后。
7. 批量同步与"同步所有 IP 源"：按钮全部禁用再恢复，日志面板滚动到底部。
8. IP 源：探测方案 → 显示策略与 IP 数 → 保存成功；未探测直接保存时策略为空。
9. 单文件产物：`pnpm build:single` 后以 `dist/worker.bundle.js` 再起一次服务（或部署预发），确认后台三个页签与单条同步可用——`2b18142` 的事故只在这条路径暴露。

### 7.4 验收标准

| 编号 | 标准                                                                              | 判定方式                                              |
| ---- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A1   | 五个导出名与签名不变                                                              | `git diff` 门面文件人工核对                           |
| A2   | 12 条基线哈希全部相等                                                             | `node scripts/ui-baseline.mjs --check`（脚本固定 TZ） |
| A3   | `pnpm check` 六项 + 新增 `check:ui-contracts`（共七步）全绿                       | 命令退出码                                            |
| A4   | `pnpm test` 全绿，既有 UI 测试**断言未改**                                        | 命令退出码 + `git diff test/` 为空                    |
| A5   | `node scripts/check-dashboard-script.mjs` 通过                                    | 命令退出码                                            |
| A6   | `pnpm build:single` 体积变化 ≤ ±2%，且该产物可被 `wrangler deploy --dry-run` 解析 | 体积对比 + dry-run                                    |
| A7   | 7.3 手工清单 9 项全部通过                                                         | 人工记录                                              |
| A8   | `package.json` 只新增一个 script，`dependencies` 无变化                           | `git diff package.json`                               |
| A9   | 单文件源码行数 ≤ 200（`templates.js` ≤ 30）                                       | `(Get-Content <file>).Count`（含空行；现状 988）      |
| A10  | 门禁确实会变红：改名 `id`、删除 `window.X =`、打乱顺序 token 三种改法都失败       | 人工三连测 + S1 记录                                  |
| A11  | 提交顺序正确：S1 门禁提交早于任何结构拆分提交                                     | `git log --oneline` 核对                              |

## 8. 备选方案对比

| 维度                | A 源码拆分（采用） | B 资源文件 + 构建期内联        | C 路由下发静态资源           |
| ------------------- | ------------------ | ------------------------------ | ---------------------------- |
| 变更半径            | 65KB → <10KB       | 65KB → <10KB                   | 65KB → <10KB                 |
| CSS / HTML 语法服务 | 无                 | 有                             | 有                           |
| 新增失效模式        | 1 类（注入自包含） | 3 类（双构建漂移、产物、调试） | 3 类（缓存一致性、首屏 RTT） |
| 新增依赖 / 配置     | 0                  | wrangler `rules` + loader      | 新路由 + 缓存策略            |
| 字节一致性可验证    | 强（哈希）         | 弱（构建加工）                 | 不可比                       |
| 门禁覆盖            | 不缩小             | 缩小（css/html 掉出）          | 缩小                         |
| 单文件部署兼容      | 完全兼容           | 需双路径同步                   | 兼容但多一次请求             |
| 回滚                | 单 revert          | 配置 + 代码联合回滚            | 路由 + 模板联合回滚          |

选择 A 的理由：

1. 本项目的第一约束是「一个 Worker、一次响应、一份可读产物」，运输层无法分离；B 与 C 都不改变运输层，只是把搬运工作挪走，换来的只有编辑体验。
2. 真正高频且工具抓不到的是**契约类**错误（class 改名、`window.X` 缺失、注入函数越界引用），而 B / C 对此毫无帮助，只有测试能解决。把预算花在门禁上比花在目录改造上回报更高。
3. B 需要新增一条必须与 `wrangler` 永久同步的第二构建路径，且客户端 `.js` 无法体面地当文本导入（esbuild 不支持 `?raw`，改后缀或加 codegen 都会引入产物），违背 AGENTS.md「不引入新依赖或构建工具」的红线。

翻转条件：若将来放弃单文件粘贴部署、或页面/组件数量翻倍、或需要 CSP 禁止内联脚本，B / C 才由亏转为赚；届时属架构变更，应单独立项，不塞进本次重构。

### 8.1 只做门禁、暂缓拆分（方案 D）

R1/R2/R3/R6 不依赖目录结构，可以先单独落地。出现以下任一情况时，建议只做 S0 + S1（外加 §10 的文档修正），把 S2–S6 留到真正需要时：

- UI 改动频率明显下降：拆分收益来自高频改动摊薄一次性成本。当前基线是 33 次提交 / 87 天（约 11 次 / 30 天）；若连续 30 天 `git log --format=%h -- src/ui/templates.js` 的提交数 ≤ 4，20 多个文件的间接层就是净成本。
- 当前没有并发修改 `src/ui` 的分支：拆分的主要收益之一是降低合并冲突。
- 团队更看重评审可读性而非编辑体验：门禁已覆盖事故同源风险，拆分只在"改动定位"上继续加分。

方案 D 的代价：CSS 转义陷阱与 65KB 变更半径保持不变；收益是不承担 25 个文件的搬运与评审成本。

## 9. 超出本次范围

- 把内联脚本改成外链（CSP 需求）。
- 把 `templates.js` 迁到 TypeScript。
- 用模板引擎替换字符串拼接。
- 双主题视觉系统的重新设计。
- 把字节基线固化为 CI 常驻门禁：本方案只在重构窗口内用 `--check`；是否长期跑需另行评估 Node/ICU 与 `TZ` 的一致性。
- 恢复整份 `docs/ui-redesign.md`：只把 §11 的硬约束迁移进 §10，其余设计过程记录不重建。

## 10. 界面模板编写约束（承接已删除的 docs/ui-redesign.md §11）

> 本节内容从 `docs/ui-redesign.md` §11（2026-10-21 由 AGENTS.md 的「界面专项」迁入）恢复；`AGENTS.md` 的强制阅读入口改为指向此处。原行号已失效，改用语义定位。

改模板前必须知道的四条（每条都实际踩过）：

1. **Pico v2 的浅色令牌写在 `:root:not([data-theme="dark"])`（特异性 0,2,0）**，裸 `:root`（0,1,0）压不过它，与源序无关。本项目浅色块用 `:root, :root[data-theme="light"]`，暗色块用 `:root[data-theme="dark"], :root.dark`（同为 0,2,0，暗色排后胜出）。**新增令牌必须放对块**，否则静默失效。
2. **全局 CSS 只存在于 `getHtmlLayout(title, content)` 的 `<style>` 内**（重构后位于 `styles/*`，由 `styles/index.js` 按固定顺序拼接）。`getPublicHomepage` / `getDashboardPage` / `getSetupPage` 只返回主体 HTML。写样式断言必须自己拼：`getHtmlLayout("x", getPublicHomepage(...))`。
3. **首帧主题脚本在 `getHtmlLayout` 的 `<head>` 内**（重构后位于 `layout/theme-boot.js`），同时写 `class="dark"` 与 `data-theme` 防闪白。主题逻辑只定义一次，各页只放按钮（`#theme-toggle`）；**不要在页面模板里再写一份 `applyTheme`**。
4. **选择器契约**：单条同步靠 `#domain-card-${id} .card-actions button:first-child` 与 `#ip-source-card-${id} ...` 命中，所以 `.card-actions` 里的**第一个按钮必须始终是「同步」**。改行结构时别动这个顺序。

其它约定：

- 主题语义：已保存的 `localStorage.theme` 优先；没有就跟随 `prefers-color-scheme` 并监听其 `change`（用户显式选过之后以保存值为准）。
- 这些可见文案被测试断言，改站名 / 关键文案会挂 `test/ui.test.ts` 或 `test/templates-escape.test.ts`：`系统初始化`、`DNS Clone Dashboard`、`CF-DNS-Clon`、`未知线路`、`N/A`。
- 不引 web font、不引图片资源（保住 `pnpm build:single` 单文件部署）。
- house rules：禁渐变、玻璃拟态、静止阴影、小号大写带字距标签、装饰性图标、hover 位移。
