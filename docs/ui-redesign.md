# 界面审美重构方案

> 状态：待评审（尚未改任何代码）
> 基线日期：2026-10-20
> 适用代码：`src/ui/templates.js`（792 行，唯一 UI 模板文件）
> 基线截图：`.scratch/shots/`（20 张，不入库）

---

## 1. 结论

1. **当前不是"不好看"，而是三套视觉语言并存**：公开首页是手写的玻璃拟态（Glassmorphism）+ iOS 蓝 `#007aff`；后台是 Pico CSS v2 默认主题（`#0172ad`）加一把 2021 年的 Bootstrap 语义色（`#198754` / `#dc3545`）。
2. **暗色模式实质不可用**：主题切换只加了 `.dark` 类，而 Pico v2 认的是 `[data-theme="dark"]`，于是背景刷深、组件留白，页标题实测对比度 **1.69:1**。
3. **层级靠颜色硬撑**：后台行内小标签与正文同为 16px，层级只能靠灰度；禁用按钮被 Pico 的 `opacity: .5` 压到约 **2.1:1**。
4. **移动端只有一档断点**（768px），390px 下单列卡片每张约 250px 高，两页都要滚 2000px+ 才能看完全量。
5. 修复路径是**收敛不是重做**：先把设计令牌（Design Token）收成一套，再改列表结构与断点，最后打磨交互态。全部改动集中在 `src/ui/templates.js` 一个文件，不引新依赖、不碰业务逻辑。

---

## 2. 现状基线

### 2.1 技术事实

| 项    | 事实                                           | 位置                                                     |
| ---- | -------------------------------------------- | ------------------------------------------------------ |
| 模板载体 | 单文件 JS 模板字符串，无构建、无独立 CSS                     | `src/ui/templates.js`                                  |
| 共享样式 | 唯一 `<style>` 块，被首页与后台共用                      | `src/ui/templates.js:23-242`                           |
| 样式依赖 | Pico CSS v2（CDN）+ Font Awesome 6.5.1（CDN）    | `src/ui/templates.js:23`                               |
| 令牌覆盖 | 只覆盖 9 个 `--pico-*`，**未覆盖主业色**                | `src/ui/templates.js:26-34`                            |
| 自建变量 | `--c-*` 亮色 12 个 / 暗色 11 个，仅首页 `.public-*` 消费 | `src/ui/templates.js:35-47` / `:49-61`                 |
| 主题切换 | 只切 `document.documentElement.classList`      | `src/ui/templates.js:369-379`                          |
| 列表渲染 | 服务端出壳 + 客户端 `innerHTML` 拼行                   | `src/ui/templates.js:524-533`、`:544-553`、`:534`、`:554` |
| 后台布局 | `main.container` 改为 flex 行，侧栏 250px 固定       | `src/ui/templates.js:112`、`:122`                       |
| 断点   | 只有一个 `max-width: 768px`                      | `src/ui/templates.js:206-241`                          |

关键约束：`tsconfig.json` 排除 `src/ui/templates.js`，改它**不会被 `pnpm typecheck` 覆盖**，必须靠浏览器复验；`README.md` 是用户可见文案的真相之源，改文案前需同步。

### 2.2 实测令牌（`getComputedStyle` + 像素级截图）

| 项       | 实测值                                                                                        | 来源                                 |
| ------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| 页面背景    | `rgb(240,242,245)`                                                                         | `--c-bg`                           |
| 后台主色    | `rgb(1,114,173)` = `#0172ad`                                                               | Pico 默认，未覆盖                        |
| 首页主色    | `#007aff`（暗色 `#0a84ff`）                                                                    | `src/ui/templates.js:35` / `:50`   |
| 后台卡片    | `#ffffff`，边框 `rgb(231,234,240)`，圆角 12px，内边距 24px                                           | `.domain-card`                     |
| 后台行内标签  | `16px` / `#6c757d`（**与正文同字号**）                                                             | `src/ui/templates.js:140`          |
| 后台域名单元格 | `16px` / `#212529` 硬编码                                                                     | `src/ui/templates.js:141`          |
| 语义色     | 成功 `#198754`、失败 `#dc3545`、无变化 `#6c757d`                                                    | `src/ui/templates.js:146`          |
| 首页卡片    | `rgba(255,255,255,.6)` + `backdrop-filter: blur(5px)`                                      | `src/ui/templates.js:183-185`      |
| 首页导航    | `rgba(248,249,250,.7)` + `backdrop-filter: blur(10px)`，`max-width: 1200px`，内边距 `12px 16px` | `src/ui/templates.js:148-164`      |
| 首页内容容器  | `max-width: 1200px`，内边距 `24px`                                                             | `src/ui/templates.js:178`          |
| 装饰层     | 2 团 `.blur-orb`（`filter: blur(100px)`，`#007aff` / `#ff3b30`，`opacity: .2`）+ 噪声 SVG         | `src/ui/templates.js:76-111`、`:47` |
| 首页卡内字号  | 标题 `17.6px/600`、日期 `12.8px`、内容 `16px` 等宽、来源 `13.6px`                                       | `:198-201`                         |

### 2.3 对比度核查（WCAG 2.1 相对亮度公式，脚本核算）

| 前景 / 背景                       | 比值         | 结论               |
| ----------------------------- | ---------- | ---------------- |
| `#007aff` / `#ffffff`（首页域名链接） | **4.02:1** | 正文不达 AA（需 4.5:1） |
| `#6c757d` / `#ffffff`（次要文字）   | 4.69:1     | 勉强通过             |
| `#0172ad` 白字（后台主按钮）           | 5.28:1     | 通过               |
| 禁用按钮（Pico `opacity: .5` 后）    | **≈2.1:1** | 不通过              |
| 暗色页标题 `#373c44` / `#121212`   | **1.69:1** | 严重不通过            |
| 暗色白卡 `#ffffff` / `#121212` 背景 | 18.7:1     | 反向刺眼             |

### 2.4 截图基线

| 界面             | 视口 / 状态                | 文件                                                                                |
| -------------- | ---------------------- | --------------------------------------------------------------------------------- |
| 公开首页           | 1440 亮                 | `home-1440.png` / `home-1440-full.png`                                            |
| 公开首页           | 1440 暗                 | `home-1440-dark.png` / `home-1440-dark-full.png`                                  |
| 公开首页           | 768 / 390              | `home-768.png` / `home-390.png`                                                   |
| 登录弹窗           | 1440 亮                 | `login-modal-1440.png`                                                            |
| 后台 · 域名克隆      | 1440 亮                 | `admin-domains-1440.png` / `admin-domains-1440-full.png`                          |
| 后台 · 域名克隆      | 1440 暗 / 768 / 390     | `admin-domains-1440-dark.png` / `admin-domains-768.png` / `admin-domains-390.png` |
| 后台 · GitHub 上传 | 1440 亮                 | `admin-github-1440.png`                                                           |
| 后台 · 系统设置      | 1440 亮 / 暗 / 768 / 390 | `admin-settings-1440.png`、`-full.png`、`-dark.png`、`-768.png`、`-390.png`           |
| 新增克隆目标弹窗       | 1440 亮                 | `admin-add-modal-1440.png`                                                        |
| 设置 · 教程折叠展开    | 1440 亮                 | `admin-settings-tutorial-1440.png`                                                |

> 截图中出现的紫色圆角浮标与粉色「T」圆钮来自浏览器扩展注入，不属于本仓库，评估时已排除。

---

## 3. 诊断

### D1 主色分裂（P1）

- 现象：首页链接蓝 `#007aff`，后台按钮/侧栏激活色 `#0172ad`，同屏两种蓝。
- 根因：`src/ui/templates.js:35` 自定义 `--c-primary: #007aff`；`:26-34` 的令牌覆盖里没有 `--pico-primary`，于是后台沿用 Pico 默认。
- 影响：品牌感缺失；`#007aff` 在白底 4.02:1，作为正文链接不合规。

### D2 暗色模式被切掉一半（P1，最严重）

- 现象：暗色下背景 `#121212`、侧栏与卡片仍是白、页标题 `#373c44` 落在深底上。
- 根因：`:369-379` 只 `classList.toggle('dark')`；`.dark` 只在 `:49-61` 重定义 `--c-*`，Pico v2 组件认 `[data-theme="dark"]`。另外 `:140-146` 的 `#6c757d` / `#212529` / `#198754` / `#dc3545` 全是硬编码十六进制，即使变量切换也不会跟着变。
- 影响：暗色模式实质不可用（1.69:1）。

### D3 字号没有刻度（P1）

- 现象：后台一行里"我的域名 → 克隆源"标签与域名同为 16px。
- 根因：`:140` 设了 `font-size: .75rem` 但被 `:135` 的 `article`/`.domain-card` 继承链与 Pico `--pico-font-size: 16px` 覆盖（实测 16px），说明令牌覆盖没有形成体系。
- 影响：层级只能靠灰度，扫读时标签在抢数据的位置。

### D4 间距无级差（P1）

- 现象：卡片 `24px`、表单 `16/20px`、导航 `13.6/24px`、页头 `40px`，各不相同。
- 根因：`:30-31` 的 `--pico-form-element-spacing-*` 与各处 `rem` 手写值混用。
- 影响：纵向节奏碎，长期维护只能靠"看感觉调"。

### D5 两套组件语言（P1）

- 现象：首页卡片 60% 白 + `blur(5px)` 玻璃态、按钮圆角 8px；后台卡片纯白实心、按钮圆角 12px。
- 根因：`:182-195`（首页）与 `:135-143`（后台）各自成型，未共用令牌。
- 影响：从首页点进后台像换了产品。

### D6 装饰过剩（P3）

- 现象：两团 100px 模糊光球（蓝 + 红）+ 噪点底 + 逐卡 `backdrop-filter`。
- 根因：`:76-111`；`:184-185` 每张卡片一次 `blur(5px)`。
- 影响：视觉噪声；17 张卡片各一次 backdrop-filter，移动端明显掉帧。

### D7 断词损坏（P2）

- 现象：`ip/cf-speed-dns-top10.txt` 在窄列被切成 `top10.tx` / `t`。
- 根因：`:200` 的 `word-break: break-all` + 16px 等宽字体。
- 影响：URL 可读性、可复制性、屏幕阅读器朗读都被破坏。

### D8 断点只有一档（P2）

- 现象：390px 下单列卡片约 250px 高，一屏放不下两张。
- 根因：`:206-241` 只有一个 `max-width: 768px`；`:231-235` 直接退回单列。
- 影响：移动端可用性低；后台顶部侧栏不折叠，吃掉 168px 首屏。

### D9 列表把表格做成了卡片（P2）

- 现象：每行重复三遍列标签（10 行 = 30 个重复标签）。
- 根因：`:524-533` 的行模板把标签写在行内（`:525`）。
- 影响：信息密度低、扫读成本高，且移动端重复更刺眼。

### D10 交互态缺失（P3）

- 现象：`同步`/`编辑`/`删除` 三个 ghost 按钮同款同权重；成功与失败只差颜色；关闭 × 目标约 14px；弹窗「取消」60px 小方块 vs「保存」拉满整行；`.tooltip-text` 没有定位样式直接内联铺开。
- 根因：`:143`、`:146`、`:464`；Pico 默认按钮体量未覆盖。
- 影响：危险操作与主操作视觉权重相同，误触概率上升；对比度不合规。

---

## 4. 目标设计系统

### 4.1 令牌（替换 `src/ui/templates.js:26-34`）

```css
:root {
    /* 字体：补中文字族，避免 Windows 下落到宋体 */
    --pico-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif;
    --pico-font-size: 100%;
    --pico-line-height: 1.6;

    /* 间距：4px 基准刻度 */
    --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
    --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;

    /* 圆角 */
    --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px;
    --pico-border-radius: var(--radius-md);

    /* 单一主色（替换 Pico 默认 #0172ad，白底 5.48:1） */
    --pico-primary: #0b64d8;
    --pico-primary-background: #0b64d8;
    --pico-primary-border: #0b64d8;
    --pico-primary-underline: rgba(11, 100, 216, .5);
    --pico-primary-hover: #0a58bd;
    --pico-primary-hover-background: #0a58bd;
    --pico-primary-hover-border: #0a58bd;
    --pico-primary-focus: rgba(11, 100, 216, .25);
    --pico-primary-inverse: #ffffff;

    /* 表面 / 边框 / 文字 */
    --surface-1: #ffffff;
    --surface-2: #f0f2f5;
    --border-subtle: #e4e8ef;
    --text-strong: #1a1f27;
    --text-body: #3d4551;
    --text-muted: #5b6472;   /* 白底 6.9:1 */

    /* 语义色（白底均 ≥4.5:1） */
    --ok: #15803d;      /* 5.0:1 */
    --warn: #b45309;
    --danger: #b91c1c;  /* 6.5:1 */
    --info: #0b64d8;
}
```

> Pico v2 的变量名以 CDN 里 `pico.min.css` 为准（上述为该版本官方变量组）；版本锁在 `@2`，升级前需重新核对。

### 4.2 暗色（替换 `src/ui/templates.js:49-61`）

```css
/* 双写选择器：Pico 认 [data-theme]，首页自定义变量认 .dark，兼容旧 localStorage */
[data-theme="dark"], html.dark {
    --c-primary: #4d9bff;            /* 深底 6.7:1 */
    --c-primary-hover: #74b1ff;
    --c-bg: #121212;
    --c-bg-blur: rgba(28, 28, 30, .72);
    --c-card-bg: #1c1c1e;
    --c-card-border: #2c2c2e;
    --c-text: #e5e5e7;
    --c-text-muted: #a1a1a6;         /* 深底 6.7:1 */
    --c-icon-bg: #2c2c2e;
    --c-button-bg: #0b64d8;
    --c-button-text: #ffffff;

    /* 后台硬编码处改为引用这些语义色后即可自动跟随 */
    --surface-1: #1c1c1e;
    --surface-2: #121212;
    --border-subtle: #2c2c2e;
    --text-strong: #e5e5e7;
    --text-body: #d4d4d8;
    --text-muted: #a1a1a6;
    --ok: #4ade80;
    --warn: #fbbf24;
    --danger: #f87171;
}
```

### 4.3 主题切换（替换 `src/ui/templates.js:369-379`）

```js
function applyTheme(theme) {
    const dark = theme === 'dark';
    document.documentElement.classList.toggle('dark', dark);
    // Pico v2 只认 data-theme；不同步设置的话后台组件会留在浅色
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeToggle.innerHTML = dark
        ? '<i class="fa-solid fa-sun"></i>'
        : '<i class="fa-solid fa-moon"></i>';
    localStorage.setItem('theme', theme);
}

applyTheme(localStorage.getItem('theme') || 'light');
themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
});
```

### 4.4 排版刻度

| 用途             | 字号 / 字重 / 行高                                     |
| -------------- | ------------------------------------------------ |
| 页面标题 `h2`      | 28px / 700 / 1.25（移动端 24px）                      |
| 区块标题           | 20px / 600                                       |
| 正文             | 15px / 400 / 1.6                                 |
| 数据强调（域名）       | 15px / 500                                       |
| 行内标签           | 12px / 600 / 0.04em 字距                           |
| 辅助信息（时间、来源）    | 12.5px / 400                                     |
| 等宽（IP、URL、策略名） | 13px，`"SF Mono", "Consolas", "Menlo", monospace` |

### 4.5 组件规范

| 组件      | 规范                                                                                         |
| ------- | ------------------------------------------------------------------------------------------ |
| 主按钮     | 实心 `--pico-primary`，白字，圆角 `--radius-md`，高 40px，内边距 `10px 20px`                             |
| 次按钮     | 透明底 + `1px solid --border-subtle`，文字 `--text-body`                                         |
| 危险按钮    | 透明底 + `--danger` 文字与边框，hover 时才填色                                                          |
| 禁用      | **不用 opacity**，改 `color: --text-muted` + `background: --surface-2` + `cursor: not-allowed` |
| 卡片      | `--surface-1` 实心 + `1px solid --border-subtle` + `--radius-lg` + `--space-6` 内边距（去掉玻璃态）    |
| 列表行     | 表头一次（sticky）+ 行内标签视觉隐藏（移动端恢复）+ 行高 ≥72px                                                    |
| 状态徽标    | 胶囊 `border-radius: 999px`，底色用 `color-mix(in srgb, var(--ok) 12%, transparent)`             |
| 表单控件    | 高 40px，圆角 `--radius-sm`，`1px solid --border-subtle`，focus 时主色描边 2px                        |
| 弹窗      | 宽 520px，footer 右对齐、按钮等宽 `min-width: 96px`                                                  |
| Tooltip | 绝对定位浮层，`max-width: 260px`，深底白字；触屏降级为可点开的 `<details>` 或长按                                   |
| 空状态     | 居中，图标 + 一句说明 + 主按钮                                                                         |
| Toast   | `role="status" aria-live="polite"`，右上角，3s 自动淡出                                             |

### 4.6 断点

| 档位  | 范围         | 布局                                             |
| --- | ---------- | ---------------------------------------------- |
| L   | ≥1024px    | 侧栏 250px + 内容区 `max-width: 1180px` 居中；列表 4 列   |
| M   | 768–1023px | 侧栏 220px；列表 4 列但压缩间距；首页网格 `minmax(280px, 1fr)` |
| S   | 521–767px  | 侧栏折叠为顶部三格 nav；列表单列 + 行内标签恢复                    |
| XS  | ≤520px     | 首页单列；卡片内边距降到 16px；页头纵向堆叠                       |

---

## 5. 逐页改造清单

### 5.1 公开首页

1. 卡片去玻璃态：`:183-185` 的 `background: var(--c-card-bg)` → `var(--surface-1)`，删掉两行 `backdrop-filter`；理由：17 张卡逐卡模糊是移动端掉帧主因，且与后台实心卡统一。
2. 导航与内容左边缘对齐：`:153` 内边距 `0.75rem 1rem` → `0.75rem var(--space-6)`（24px），正好等于 `.public-container` 的 `1.5rem`；当前差 8px 就是截图里导航比卡片宽出去的原因。
3. 断词：`:200` 改为 4.2 节给出的 `overflow-wrap: anywhere` + 两行截断。
4. 卡片等高：`.public-card-content { min-height: 2.6em }`，消除单行/三行卡片的参差。
5. 装饰：删除 `.blur-orb-2`（红色第二色相）与 `.background-blurs::before`（噪点），`.blur-orb-1` 改 `background-color: var(--c-primary); opacity: .12`；补 `@media (prefers-reduced-motion: reduce) { .blur-orb { animation: none } }`。
6. 字号：标题 `1rem/600`、日期 `.75rem`、内容 `.875rem`、来源 `.8125rem`，见 4.4。

### 5.2 登录弹窗

1. 关闭按钮点击区从 14px 提到 32×32（`padding` 补足），保留 `aria-label="Close"`。
2. 补「取消」次按钮，与「登录」右对齐等宽。
3. 弹窗宽度 480px，内边距 `--space-6`。
4. 错误提示 `#modal-error-msg` 由 `--pico-color-red-500` 改 `var(--danger)`（暗色下可读）。

### 5.3 后台壳

1. 内容区限宽：`:129` → `max-width: 1180px; margin-inline: auto; padding: var(--space-8)`；1440px 下当前行宽约 1150px 且无上限，长行难扫读。
2. 侧栏加主题切换（可选，建议做）：在 `.sidebar-header` 右侧放 `#theme-toggle-admin`，复用 4.3 的 `applyTheme`；后台目前完全没有暗色入口，等于暗色模式只有首页能触发。
3. 页头：`:130-131` 标题 28px/700、按钮高 40px，间距 `--space-6`。
4. 移动端：`:213-235` 侧栏改顶部三格 nav（见 4.6 S 档），页头纵向堆叠。

### 5.4 域名克隆列表

1. **去重复标签**：新增 `.domain-list-head` sticky 表头（4 列），行内 `.card-col strong` 在 ≥768px 时用"视觉隐藏"而非 `display:none`（保留无障碍朗读）：

```css
.domain-list-head {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1.5fr) minmax(0, 1.1fr) auto;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    font-size: 12px; font-weight: 600; letter-spacing: .04em;
    color: var(--text-muted);
    position: sticky; top: 0; z-index: 2;
    background: var(--surface-2);
}
@media (min-width: 768px) {
    .card-col strong {
        position: absolute; width: 1px; height: 1px;
        overflow: hidden; clip-path: inset(50%); white-space: nowrap;
    }
}
```

2. 徽标化状态：`:146` 的 `.status-*` 改为胶囊徽标（`.status-badge--ok` / `--fail` / `--no-change`），并给失败态加一行"上次成功时间"。
3. 按钮组降噪：`同步` 用次按钮样式，`编辑` 用次按钮，`删除` 只在 hover/focus 时显示危险色（`:143`）。
4. 禁用态修正：覆盖 Pico 的 `opacity: .5`（见 4.5）。
5. 行结构改动需同步 `renderDomainCard`（`src/ui/templates.js:524-533`）与 `container.innerHTML`（`:534`）；**必须保留 `.card-actions` 与首个 button**，否则单条同步选择器 `#domain-card-${id} .card-actions button:first-child`（`:684`）会失效。

### 5.5 GitHub IP 源列表

同 5.4，另加：

1. `抓取策略` 用等宽字体 + 浅色 chip，与"文件路径"区分层次。
2. `源:` 前缀的 URL 加 `title` 属性 + 单行省略号（当前直接截断）。
3. 失败行左侧加 3px `--danger` 竖条，让失败可在列表中一眼定位。
4. 卡片间距与域名页统一为 `--space-2`（当前两页间距不同）。

### 5.6 系统设置

1. 分组标题（`:453` 附近的 `article` 头）用 20px/600 + 图标 16px，卡内上下留 `--space-6`。
2. 表单 label 12px/600 `--text-muted`，控件高 40px。
3. 「如何获取 API 令牌」`<details>` 的 summary 补 chevron 旋转与 hover 底色。
4. 「保存设置」按钮不再拉满整宽，改右对齐 160px 宽，避免被读成页面级 banner。
5. 三网优选 IP 源卡片只有一个 select，补一句说明文字补齐卡片高度观感。

### 5.7 新增/编辑弹窗（`#domainModal`）

1. Tooltip 修成浮层（`:464` 的 `.tooltip-text` 目前内联铺开，把「深度 (?)」标签挤断）：

```css
#domainModal .tooltip { position: relative; display: inline-flex; }
#domainModal .tooltip-text {
    position: absolute; left: 0; top: 1.75em; z-index: 10;
    width: max-content; max-width: 260px;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--text-strong); color: #fff;
    font-size: 13px; line-height: 1.45; font-weight: 400;
    opacity: 0; visibility: hidden; transform: translateY(-4px);
    transition: opacity .15s ease, transform .15s ease;
}
#domainModal .tooltip:hover .tooltip-text,
#domainModal .tooltip:focus-within .tooltip-text {
    opacity: 1; visibility: visible; transform: none;
}
@media (hover: none) { #domainModal .tooltip-text { display: none; } }
```

2. Footer 对齐：`#domainModal footer { display: flex; justify-content: flex-end; gap: var(--space-3); }` + `footer button { width: auto; min-width: 96px; }`。
3. 「我的域名前缀」那一行的后缀 `.seismic.ccwu.cc` 与输入框基线对齐（`:464` 的 `line-height: var(--pico-form-element-height)` 在 Pico v2 里已不存在，改用 `display:flex; align-items:center`）。

---

## 6. 实施批次

### P1 统一设计令牌（约半天）

改动点：

| 位置                            | 动作                                                                     |
| ----------------------------- | ---------------------------------------------------------------------- |
| `src/ui/templates.js:26-34`   | 替换为 4.1 的完整令牌块（含主色覆盖）                                                  |
| `src/ui/templates.js:35`      | `--c-primary: #007aff` → `var(--pico-primary)`                         |
| `src/ui/templates.js:49-61`   | 替换为 4.2 的双写暗色块                                                         |
| `src/ui/templates.js:140-142` | 硬编码 `#6c757d` / `#212529` → `var(--text-muted)` / `var(--text-strong)` |
| `src/ui/templates.js:146`     | `#198754` / `#dc3545` → `var(--ok)` / `var(--danger)`                  |
| `src/ui/templates.js:153`     | 导航内边距对齐 24px                                                           |
| `src/ui/templates.js:183-188` | 卡片去玻璃态改实心                                                              |
| `src/ui/templates.js:369-379` | 替换为 4.3 的 `applyTheme`                                                 |

验收：暗色下 `html[data-theme="dark"]` 生效、正文对比度 ≥4.5:1、后台主色与首页一致。

### P2 结构与断点（约一天）

| 位置                                       | 动作                        |
| ---------------------------------------- | ------------------------- |
| `src/ui/templates.js:129-131`            | 内容区限宽 + 页头令牌化             |
| `src/ui/templates.js:138-143`            | 列表行网格与按钮组令牌化              |
| `src/ui/templates.js:200`                | 首页内容断行与截断                 |
| `src/ui/templates.js:206-241`            | 断点重写为 1024 / 767 / 520 三档 |
| `src/ui/templates.js:524-533`、`:544-553` | 行模板去重复标签 + 新增表头           |
| `src/ui/templates.js:333`、`:337`         | 空状态文案补按钮                  |

验收：390 / 768 / 1440 三档无横向滚动、无断词、1440 首屏可见 ≥6 行。

### P3 交互打磨（约半天）

| 位置                           | 动作                                         |
| ---------------------------- | ------------------------------------------ |
| `src/ui/templates.js:143`    | 按钮层级与危险按钮 hover 上色                         |
| `src/ui/templates.js:146`    | 状态改徽标                                      |
| `src/ui/templates.js:147`    | Toast 加 `role="status" aria-live="polite"` |
| `src/ui/templates.js:464`    | Tooltip 浮层 + footer 对齐                     |
| `src/ui/templates.js:76-111` | 装饰精简 + `prefers-reduced-motion`            |
| 全局                           | `:focus-visible` 统一 2px 主色描边               |

验收：禁用按钮 ≥4.5:1、所有可交互元素 ≥44×44、键盘 Tab 可见焦点。

---

## 7. 验收标准（可脚本化）

1. **对比度**：页面内每段文字与其背景的对比度 ≥4.5:1（大字 ≥3:1），用 `getComputedStyle` 遍历 + WCAG 公式核算。
2. **暗色一致性**：`document.documentElement.dataset.theme === 'dark'` 时 `body` 背景 `#121212`、卡片 `#1c1c1e`、正文 `#e5e5e7`，截图与亮色不再混排。
3. **无横向滚动**：390 / 768 / 1440 下 `document.documentElement.scrollWidth === clientWidth`。
4. **无破坏性断词**：`ip/cf-speed-dns-top10.txt` 在三档视口下都不出现 `top10.tx` / `t` 式切分。
5. **列表密度**：1440×900 首屏（不含滚动）可见 ≥6 行。
6. **点击目标**：所有按钮与关闭控件 ≥44×44 CSS px。
7. **回归**：`pnpm test`（136 个 it）与 `pnpm typecheck` 全绿；`git diff --stat` 只包含 `src/ui/templates.js`（外加一处测试断言同步）。

复验流程（沿用本次基线）：

```powershell
$env:BSK_AUTO_START='0'
$sid = (Get-Content .scratch\bsk-session.txt -Raw).Trim()
bsk navigate 'https://cfc.glacier.de5.net/' --session $sid
bsk screenshot --session $sid --out .scratch\shots\home-after.png
bsk emulate --session $sid --device iphone-14
bsk screenshot --session $sid --out .scratch\shots\home-after-390.png
bsk emulate --session $sid --off
```

---

## 8. 风险与回滚

| 风险                              | 缓解                                                       |
| ------------------------------- | -------------------------------------------------------- |
| Pico 变量名随版本变动导致覆盖失效             | CDN 锁 `@2`；升级前用 `getComputedStyle` 复测主色                  |
| `data-theme` 与 `.dark` 双写出现一处分叉 | 只保留 `applyTheme()` 单一入口，禁止其它地方直接 `classList.add('dark')` |
| 列表行结构改动打断单条同步                   | 保留 `.card-actions` 与首个 button 选择器，改完手动点一次「同步」            |
| 视觉回归无法自动断言                      | 每批改完用同一浏览器会话重截三档视口对照                                     |
| 改动误触业务逻辑                        | 全部改动限制在 `src/ui/templates.js`；不碰 API、路由、D1、`env.WUYA`    |

回滚：`git checkout -- src/ui/templates.js` 一步还原（单文件改动）。

---

## 9. 不做的事（Non-goals）

- 不换前端框架、不引入构建步骤、不新增 CSS 文件或依赖（Pico 与 Font Awesome 仍走 CDN）。
- 不改变信息架构（哪些字段展示、列表排序规则），只改呈现。
- 不重绘图标（继续用 Font Awesome）。
- 不改任何文案语义；如确需改，先同步 `README.md`。
- ~~不默认跟随系统主题（`prefers-color-scheme`）——列为 P3 可选项，因为会改变用户当前看到的外观。~~ 已在 FIX-24 改为默认跟随系统，见 §10.3。

---

## 10. 实施记录（2026-10-20）

三批均已落地，改动仍全部限制在 `src/ui/templates.js`（外加一处测试断言同步），`pnpm typecheck` 与 `pnpm test`（136 项）全绿。

| 批次 | 提交 | 关键改动 | 实测结果 |
| --- | --- | --- | --- |
| P1 令牌 | `6e78547` | 令牌收口、Pico 组件色映射、暗色双写出 0,2,0 权重、后台页首帧主题脚本、去硬编码色 | 静音字 4.18:1 → 5.33:1；暗色侧栏主色 3.11:1 → 6.03:1；主色 `#0b64d8` 白底 5.48:1 |
| P2 结构 | 同上批一并提交 | 内容区限宽 1180px、行网格与表头共用 `row-grid`、标签窄屏可见/宽屏隐藏、断点 1024/1023/767/520、首页断行改 `overflow-wrap:anywhere` + 3 行截断 | 390/768/1440 三档 `scrollWidth - clientWidth = 0`；1440 列表行高约 87px，首屏可见 4 行（原 3 行） |
| P3 打磨 | 同上批一并提交 | 移除双色光斑/噪点/玻璃态/静止阴影/hover 位移/标题色条/装饰图标；状态改徽标；删除改红色幽灵底；弹窗底部等宽 + 取消幽灵底 + tooltip 浮层；`:focus-visible`、`prefers-reduced-motion`、toast `role=status`、主题按钮中文 aria | 弹窗按钮 311/311 等宽；状态徽标底色 `color-mix(in srgb, 语义色 12%, transparent)` |

实施中发现的额外缺陷（原诊断未列出）：

- **Pico `.contrast` 按钮在暗色主题下取到近黑色**（实测文字 `rgb(24,28,37)` 压在 `#1c1c1e` 卡片上），导致「删除」按钮在暗色下"消失"。已改为红色幽灵底，颜色走 `--danger` 令牌。
- **`<strong>` 在行内双用**：既作字段小标签，又作 `notes` 的内容容器，导致备注被渲染成 12px 大写小标签。已拆成 `.col-label`（标签）与 `.domain-notes`（内容），并同步更新 `test/templates-escape.test.ts:154` 的源码形状断言（转义保护不变）。
- **表单页过宽**：设置页字段行满铺 1180px，扫视成本高。已给 `#page-settings` 限宽 820px。

验收复验：`pnpm dev` 起本地预览后，用同一浏览器会话按 1440 / 768 / 390 三档截图对照即可；单条同步选择器（`.card-actions button:first-child`）结构未变。

### 10.1 追加打磨（同日晚，四个提交）

上一节列出的三条「可选做」已全部落地，另按审查结论补了两处一致性修正。

| 项 | 提交 | 改动 | 实测 |
| --- | --- | --- | --- |
| 中档密度 | `57851e3` | 新增 `@media (min-width:768px) and (max-width:1023px)`：`#domain-list-container` / `#ip-source-list-container` 两列网格，卡片自身仍是单列堆叠 | 1023 每列 349px、900 288px、768 222px；三档无横向溢出，3 个 58px 按钮仍在一行（内容宽 190px）；行距 12px 与单列档一致 |
| 阴影收敛 | `8fd6850` | 三档 `--pico-shadow-*` 收敛为单档 `--shadow-overlay`（浅色 12% / 暗色 60%），只服务弹窗与 toast；toast 文字色改引用 `--c-button-text` | 弹窗阴影浅色 `rgba(0,0,0,0.12)`、暗色 `rgba(0,0,0,0.6)`；卡片与侧栏仍 `none` |
| 系统行区分 | `1249346` | `.domain-card.system-domain` 用主色 4% 浅染底 + 32% 描边；补 `.card-actions button.contrast[disabled]` 改静音字（原先被 `.contrast` 特异性压过，禁用态仍带红边） | 浅色底 `rgb(245,249,253)` / 边 `#9ebde7`；暗色底 `rgb(30,33,39)` / 边 `#364f71`；禁用「删除」文字 `rgb(91,100,114)` |
| 文案统一 | `c1892cc` | 列表表头「我的域名 → 克隆源」→「克隆目标」，与窄屏行内标签一致（该单元格主值就是克隆目标，副行是克隆源） | 表头读出 `克隆目标｜当前解析｜上次同步` |

中档两列同时把行内标签文案缩短为「克隆目标」——222px 的窄卡片里原长文案会折行。

仍可选做：

- 强调色在首页只用于「进入后台」与悬停边框，卡片正文已改回正文色；如需更强的视觉记忆点可另议。
- 列表第一列的副行（克隆源）在窄屏没有标签，如后续觉得歧义可加一句极简说明。

### 10.2 导航中线错位（FIX-23）

用户反馈首页「进入后台」与主题切换按钮上下不齐。实测两元素中心相差 `8px`，恰等于主题按钮 `margin-bottom:16px` 的一半：同级元素一个是 `<a>`（Pico 不给外边距），一个是 `<button>`（Pico 有 `margin-bottom:var(--pico-spacing)`），而容器 `align-items:center` 连外边距一起居中，带外边距的那一个视觉上被推高半个外边距。

修法是在 `.public-nav-actions a, .public-nav-actions button` 共享规则里统一 `margin: 0`（该规则本就负责归一化这两个元素的 padding/border），而非只给 `#theme-toggle` 打补丁。修复后三档视口 `spreadCenterY` 均为 0。另用同一判据全站扫描「同一 flex/grid 行里既有无外边距元素又有有外边距元素」的组合，首页与后台（含弹窗、设置页）均为 0 处。

### 10.3 主题默认跟随系统 + 后台可切换（FIX-24）

§9 曾把「默认跟随系统」列为不做的事，与 §4.2 的决定 Q5（默认跟随 `prefers-color-scheme`，手动选择可覆盖并记住）矛盾；实现也确实停在旧形态：`applyTheme(localStorage.getItem('theme') || 'light')`，`prefers-color-scheme` 一次都没读。FIX-24 按 Q5 落地，并把 Non-goals 一条划掉。

改动三处：

1. `getHtmlLayout` 的首帧脚本从"读 localStorage，缺省 light"改为 `已保存值 → 系统偏好`，并监听 `matchMedia('(prefers-color-scheme: dark)')` 的 `change`：**用户没显式选过就跟着系统变**，选过一次就以保存值为准。首帧同时写 `class="dark"` 与 `data-theme`，避免暗色用户看到白闪。
2. 主题逻辑上移到布局（每页都有，只定义一次），首页模板里那份 `applyTheme` 删除——此前后台页完全没有主题入口，本轮在侧栏标题旁加了 `#theme-toggle` 按钮，五类页面共用同一份 JS，不会漂移。
3. 按钮本身：`margin: 0`（同 FIX-23 的根因，Pico 给 `button` 加 `margin-bottom`，`align-items:center` 会连外边距一起居中，实测按钮比站名中线高 `8px`）；`flex: 0 0 auto` + `44×44`——侧栏在 ≤1024px 收窄到 200px 后，1.75rem 的站名曾把按钮挤到 `33.5px` 并让站名折成两行，故在 ≤1024 断点把标题降到 1.25rem、内边距收到 `var(--space-4) var(--space-5)`。

实测（`1440 / 1024 / 900 / 768 / 390` 五档，同一浏览器会话）：标题与按钮中线差 `0.00–0.01px`，按钮恒为 `44×44`，`scrollWidth-innerWidth = -15`（无横向滚动）；清空 `localStorage` 后首帧等于系统偏好（`theme: light`、`body #f0f2f5`），点击后 `theme: dark`、`stored: 'dark'`、`body #121212`，重载保持暗色。`pnpm test` 142 项、`pnpm typecheck` 均通过。

注：测试用的 Chrome 装了会强制写 `data-theme="light"` 的扩展（`html` 带 `tongyi-design-pc` 类），因此探针里 `data-theme` 属性可能被它改回 `light`；判定以 `classList.contains('dark')` 与实际背景色为准，真实无扩展环境下两处一致。

### 10.4 宽屏只占中间（FIX-25）

用户反馈：界面只占中间一条，两侧留一大块空白。实测确认是两个独立的限宽，不是同一个原因：

| 页面 | 元素 | 原规则 | 1920 下实测 |
| --- | --- | --- | --- |
| `/admin` | `.main-content` | `max-width: 1180px; margin-inline: auto` | 内容区 1180px，左侧空白 237.5px、右侧 237.5px（`250 → 487.5` 与 `1667.5 → 1905`） |
| `/` | `.public-container`、`.public-nav` | `max-width: 1200px; margin: 0 auto` | 内容区 1200px，两侧各 352.5px（**用户要求前台保持原样，不改**） |

后台那条是 P2 我自己加的（当时为了限制行宽、降低扫读成本），首页那条是改造前就有的。宽屏上"限宽居中"是合理的排版手段，但这个站的主界面是高密度表格式列表，用户希望一眼看全，所以改为铺满。

改动一处：`.main-content` 去掉 `max-width` 与 `margin-inline: auto`（保留 `flex-grow: 1; min-width: 0`）。需要窄一点的局部继续单独限宽（设置页表单 `#page-settings { max-width: 820px }` 保留）。

前台那两处（`.public-container`、`.public-nav`）第一版一并去掉了限宽，用户随后明确「后台页面可以修改，前台页面禁止修改，保持原样」，已回退为 `max-width: 1200px; margin: 0 auto`，并补了一条回归断言锁住这个值——前台宽度不再随后台改动漂移。

实测（同一浏览器会话，1920 / 1600 / 1440 / 1200 四档）：

- `/admin`：内容区宽度恒等于 `视口 − 250（侧栏）`，1920 下 1655px、1600 下 1335px、1440 下 1175px、1200 下 935px，左右各只剩 32px 内边距，无空白块。
- `/`：回退后容器仍为 1200px 居中（1920 下左右各 352.5px、1440 下各 112.5px），与改造前一致。
- 四档均 `scrollWidth − innerWidth = −15`（只有滚动条本身），无横向溢出。

### 10.5 设置页铺满（FIX-26）

`#page-settings` 上那条 `max-width: 820px` 是 P2 时加的，理由是"表单行不要长到难扫读"。但它和列表页共用 `.main-content`，列表铺满后设置页就成了左边一窄条、右边一大片空白（1920 下 1655px 只用到 820px）。

用户拍板的选择：**单列铺满**（不是多列网格），表单字段排布不变，只把提交按钮放到表单底部居中。

改动两处（`src/ui/templates.js`）：删掉 `#page-settings { max-width: 820px }`；新增 `#settingsForm > button[type="submit"] { display: block; width: fit-content; min-width: 12rem; margin: var(--space-5) auto 0 auto; }`。第一版只写了 `display: block` + `margin: auto`，实测按钮被拉成 1591px 通栏（块级盒子 `width: auto` 会填满容器），补 `width: fit-content` + `min-width: 12rem` 后实测 192×59.6px。

实测（1920 / 1440 / 1024 / 768 / 390 五档）：

| 视口 | 表单宽 | 输入框宽 | 提交按钮 | 按钮中线偏移 | 横向溢出 |
| --- | --- | --- | --- | --- | --- |
| 1920 | 1591 | 1525 | 192×59.6 | 0 | 0 |
| 1440 | 1111 | 1045 | 192×59.6 | 0 | 0 |
| 1024 | 711 | 645 | 192×59.6 | 0 | 0 |
| 768 | 455 | 389 | 192×59.6 | 0 | 0 |
| 390 | 351 | 285 | 192×59.6 | 0 | 0 |

表单宽度始终等于内容区宽度（`formFillRatio = 1`），五档均无横向溢出。已知代价：1920 下输入框宽 1525px、`<details>` 的 summary 与 chevron 相距较远——这是"单列铺满"的必然结果，记录下来，等用户看过真实大屏再决定是否给控件单独设上限。
