// templates.js — UI 模板函数（阶段 E 从 index.legacy.js 拆出）
import {
    escapeHtmlClient,
    canAddDomains,
    planSyncCompletionActions,
    buildDomainSavePayload,
    buildIpSourceSavePayload,
    buildIpSourceProbePayload,
} from "./dashboard-helpers.js";
import { createDashboardRenderers } from "./dashboard-render.js";
import { createApiFetch } from "./dashboard-api.js";
// 单类型记录上限的唯一归一实现（issue #49）：模板层不重复定义默认值
import {
    DEFAULT_MAX_IPS_PER_TYPE,
    MAX_MAX_IPS_PER_TYPE,
    MIN_MAX_IPS_PER_TYPE,
    normalizeMaxIpsPerType,
} from "../util/max-ips-per-type.ts";
// 纯 JS 文件（tsc 不参与）：内含大量浏览器端 JS 模板字符串

// HTML 实体转义：所有插值到模板字符串的用户控制字段必须经过 escapeHtml
// 防止存储型 XSS（攻击者写入恶意 notes/target_domain 等字段即可在所有访客浏览器执行）
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(
        /[&<>"']/g,
        (c) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[c]
    );
}

// 脚本上下文 JSON 安全化（I2）：JSON.stringify 不转义 <，
// 值里含 </script> 会提前闭合 <script> 标签造成注入；把 < 序列化为 \u003c，
// 解析后仍是原字符，仅阻断标签逃逸
function safeJsonForScript(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * 渲染公共 HTML 骨架（DOCTYPE + PicoCSS + FontAwesome + 全局 CSS 变量）
 * 所有动态值在调用方传入前已经过 escapeHtml；本函数只做字符串拼接。
 */
export function getHtmlLayout(title, content) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"><style>
/* Pico v2 的浅色令牌定义在 :root:not([data-theme=dark])（特异性 0,2,0），
   单纯 :root（0,1,0）会被压过；故浅色块也用 0,2,0 的 [data-theme="light"]，
   暗色块同样用 0,2,0 并排在后面，靠先后顺序胜出。两面都用属性选择器，避免 :not() 互相冲突。 */
:root, :root[data-theme="light"] {
    --sidebar-width: 250px;
    /* 字体：补中文字族，避免 Windows 下落到宋体 */
    --pico-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif;
    --pico-font-size: 100%;
    --pico-line-height: 1.6;
    /* 间距刻度（4px 基准） */
    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 20px;
    --space-6: 24px;
    --space-8: 32px;
    --space-10: 40px;
    /* 圆角 */
    --radius-sm: 6px;
    --radius-md: 10px;
    --pico-border-radius: var(--radius-md);
    --pico-form-element-spacing-vertical: 1rem;
    --pico-form-element-spacing-horizontal: 1.25rem;
    /* 只留一档阴影，且只给真正"浮在页面上方"的层（弹窗、toast）用；卡片与导航一律不用 */
    --shadow-overlay: 0 10px 30px rgba(0, 0, 0, 0.12);
    /* 单一主色：替换 Pico 默认 #0172ad，白底 5.48:1 */
    --pico-primary: #0b64d8;
    --pico-primary-background: #0b64d8;
    --pico-primary-border: #0b64d8;
    --pico-primary-underline: rgba(11, 100, 216, .5);
    --pico-primary-hover: #0a58bd;
    --pico-primary-hover-background: #0a58bd;
    --pico-primary-hover-border: #0a58bd;
    --pico-primary-focus: rgba(11, 100, 216, .25);
    --pico-primary-inverse: #ffffff;
    /* Pico 组件色统一映射到语义令牌：组件层不再出现第二套色值，暗色自动跟随 */
    --pico-background-color: var(--surface-2);
    --pico-color: var(--text-body);
    --pico-muted-color: var(--text-muted);
    --pico-muted-border-color: var(--border-subtle);
    --pico-h1-color: var(--text-strong);
    --pico-h2-color: var(--text-strong);
    --pico-h3-color: var(--text-strong);
    --pico-h4-color: var(--text-strong);
    --pico-h5-color: var(--text-strong);
    --pico-h6-color: var(--text-strong);
    --pico-card-background-color: var(--surface-1);
    --pico-card-border-color: var(--border-subtle);
    --pico-card-sectioning-background-color: var(--surface-2);
    --pico-form-element-background-color: var(--surface-1);
    --pico-form-element-border-color: var(--border-subtle);
    --pico-form-element-color: var(--text-strong);
    --pico-form-element-placeholder-color: var(--text-muted);
    --pico-secondary: var(--text-body);
    --pico-secondary-border: var(--border-subtle);
    /* 表面 / 边框 / 文字 */
    --surface-1: #ffffff;
    --surface-2: #f0f2f5;
    --border-subtle: #e4e8ef;
    --text-strong: #1a1f27;
    --text-body: #3d4551;
    --text-muted: #5b6472;
    /* 语义色（白底均 ≥4.5:1） */
    --ok: #15803d;
    --danger: #b91c1c;
    /* 首页自定义变量：全部指向令牌，不再手写色值 */
    --c-primary: var(--pico-primary);
    --c-bg: var(--surface-2);
    --c-card-bg: var(--surface-1);
    --c-card-border: var(--border-subtle);
    --c-text: var(--text-strong);
    --c-text-muted: var(--text-muted);
    --c-icon-bg: #e9ecef;
    --c-button-bg: var(--c-primary);
    --c-button-text: var(--pico-primary-inverse);
}
/* 暗色令牌：与浅色块同特异性（0,2,0）且排在其后，保证胜出 */
:root[data-theme="dark"], :root.dark {
    /* 暗色下阴影要更重才看得见层次 */
    --shadow-overlay: 0 10px 30px rgba(0, 0, 0, 0.6);
    --c-primary: #4d9bff;
    --c-bg: #121212;
    --c-card-bg: #1c1c1e;
    --c-card-border: #2c2c2e;
    --c-text: #e5e5e7;
    --c-text-muted: #a1a1a6;
    --c-icon-bg: #2c2c2e;
    --c-button-bg: #0b64d8;
    --c-button-text: var(--pico-primary-inverse);
    /* 后台硬编码色统一改引用这些语义色后即可自动跟随暗色 */
    --surface-1: #1c1c1e;
    --surface-2: #121212;
    --border-subtle: #2c2c2e;
    --text-strong: #e5e5e7;
    --text-body: #d4d4d8;
    --text-muted: #a1a1a6;
    --ok: #4ade80;
    --danger: #f87171;
    /* Pico 主色在暗色下必须一起换，否则链接/按钮/标题仍是浅色主题的深蓝，压深底不可读 */
    --pico-primary: #4d9bff;
    --pico-primary-background: #0b64d8;
    --pico-primary-border: #0b64d8;
    --pico-primary-hover: #74b1ff;
    --pico-primary-hover-background: #0a58bd;
    --pico-primary-hover-border: #0a58bd;
    --pico-primary-focus: rgba(77, 155, 255, .25);
    --pico-primary-underline: rgba(77, 155, 255, .5);
    /* Pico 暗色主题会把 inverse 改回深色，这里锁死白字保证主按钮对比度 */
    --pico-primary-inverse: #ffffff;
}
body {
    font-family: var(--pico-font-family);
    margin: 0;
    background-color: var(--c-bg);
    color: var(--c-text);
    transition: background-color 0.3s ease, color 0.3s ease;
    overflow-x: hidden;
}
.public-body-wrapper {
    position: relative;
    z-index: 1;
    width: 100%;
    min-height: 100vh;
}
/* 装饰层已移除：双色光斑（filter:blur(100px) + 20s 无限动画）与 SVG 噪点叠加
   既拖累低端设备合成，也把页面主题色搅成"生成页"观感；层次改由留白与边框承担。 */
main.container { max-width: none; padding: 0; display: flex; }
.auth-container {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 100vh;
    padding: 2rem;
}
.auth-container > article { width: 100%; max-width: 480px; }
.sidebar { width: var(--sidebar-width); flex-shrink: 0; background: var(--pico-card-background-color); height: 100vh; position: sticky; top: 0; border-right: 1px solid var(--pico-card-border-color); display: flex; flex-direction: column; }
.sidebar-header { padding: 1.5rem; text-align: left; border-bottom: 1px solid var(--pico-card-border-color); display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.sidebar-header h3 { margin: 0; font-size: 1.75rem; font-weight: 700; color: var(--pico-primary); }
.sidebar-nav { padding: 1rem 0; flex-grow: 1; }
.sidebar-nav a { display: flex; align-items: center; gap: .85rem; padding: .85rem 1.5rem; color: var(--text-body); text-decoration: none; margin: 0 .75rem; border-radius: 6px; transition: background-color .2s ease, color .2s ease; font-weight: 500; }
.sidebar-nav a:hover { background: var(--surface-2); color: var(--text-strong); }
.sidebar-nav a.active { color: var(--c-button-text); background-color: var(--c-button-bg); font-weight: 600; }
/* FIX-25: 不再限宽居中。原先 max-width:1180px + margin-inline:auto，在 1920 下两侧各留 237.5px 空白，
   用户反馈「只占中间、两边一大块空白」。内容区铺满侧栏以外的全部宽度，靠 padding 留呼吸；
   需要窄一些的局部单独限宽；设置页曾属于这一类，FIX-26 后已按用户决定一并铺满（见下方 #settingsForm 规则）。 */
.main-content { flex-grow: 1; min-width: 0; width: 100%; padding: var(--space-10) var(--space-8); }
.page-header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-6); }
.page-header h2 { margin: 0; font-size: 1.75rem; font-weight: 700; letter-spacing: -0.01em; }
.page { display: none; }
.page.active { display: block; animation: fadeIn .3s ease-out forwards; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
article, fieldset { border-radius: var(--pico-border-radius); border: 1px solid var(--pico-card-border-color); background: var(--pico-card-background-color); padding: 2rem; }
dialog article { box-shadow: var(--shadow-overlay); }
/* 手动同步日志框：与上方按钮拉开距离；内边距需大于圆角，避免文字被圆角压住 */
.sync-log { margin-top: var(--space-8); padding: var(--space-4); }
/* 禁用态：Pico 用 opacity:.5 淡化，白字压在淡蓝底上≈1.9:1 不可读；改为中性底 + 静音字（4.6:1 以上） */
button[disabled], button[disabled]:hover { opacity: 1; background-color: var(--surface-2); border-color: var(--border-subtle); color: var(--text-muted); cursor: not-allowed; }
legend { font-size: 1.25rem; font-weight: 600; padding: 0 .5rem; }
/* 行网格：表头与数据行共用同一列定义，避免两处漂移 */
.row-grid { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.6fr) minmax(0, 1.2fr) auto; gap: var(--space-5); align-items: center; }
.domain-card { background-color: var(--pico-card-background-color); border: 1px solid var(--pico-card-border-color); border-radius: var(--pico-border-radius); padding: var(--space-4) var(--space-5); margin-bottom: var(--space-3); transition: border-color .15s ease; }
.domain-card:hover { border-color: var(--pico-primary); }
/* 系统内置行（hostmonit 三网等）不可编辑/删除：主色浅染 + 淡色描边区分，不新增文案 */
.domain-card.system-domain { background-color: color-mix(in srgb, var(--pico-primary) 4%, var(--pico-card-background-color)); border-color: color-mix(in srgb, var(--pico-primary) 32%, var(--pico-card-border-color)); }
.card-col { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
/* 行内小标签：窄屏可见，≥768 由列表表头代替（保留给读屏） */
.col-label { font-size: 0.8125rem; color: var(--text-muted); font-weight: 500; }
.domain-notes { font-size: 1rem; font-weight: 500; color: var(--text-strong); }
.domain-list-head { display: none; }
@media (min-width: 1024px) {
    .col-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .domain-list-head { display: grid; padding: 0 var(--space-5) var(--space-2); font-size: 0.8125rem; color: var(--text-muted); font-weight: 500; }
}
.card-col .domain-cell { font-size: 1rem; font-weight: 500; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.card-col small.domain-cell { color: var(--text-muted); font-weight: 400; }
.card-actions { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: nowrap; }
.card-actions button { font-size: 0.875rem; padding: .5rem .875rem; white-space: nowrap; margin: 0; }
/* 删除：破坏性动作用红色幽灵按钮。不写死颜色——Pico 的 .contrast 在暗色主题下取到近黑色，
   与深色卡片同色导致按钮"消失"（实测 rgb(24,28,37) 文字压在 #1c1c1e 卡片上） */
.card-actions button.contrast { color: var(--danger); border-color: var(--danger); background: transparent; }
.card-actions button.contrast:hover:not([disabled]) { background: var(--danger); border-color: var(--danger); color: #fff; }
/* 系统内置行的「删除」是禁用态：别再留着红色描边，否则看起来像可点的破坏性操作 */
.card-actions button.contrast[disabled] { color: var(--text-muted); border-color: var(--border-subtle); }
.record-details summary { display: inline-flex; align-items: center; cursor: pointer; user-select: none; list-style: none; font-weight: 500; }
.record-details ul { margin: 8px 0 0; padding-left: 20px; font-size: 0.9em; }
/* 同步状态改徽标：底色由语义色混合，亮暗主题都跟着走，不再靠纯文字颜色 */
.status-success, .status-failed, .status-no_change, .status-pending { display: inline-flex; align-items: center; font-size: 0.8125rem; font-weight: 500; padding: 1px var(--space-2); border-radius: var(--radius-sm); }
.status-success { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.status-failed { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.status-no_change { color: var(--text-muted); background: color-mix(in srgb, var(--text-muted) 12%, transparent); }
.status-pending { color: var(--text-muted); background: color-mix(in srgb, var(--text-muted) 8%, transparent); }
.notifications, .home-toast { z-index: 1050; }
.public-nav {
    position: sticky;
    top: 1rem;
    /* 前台限宽保持原样：用户要求前台页面不做修改（FIX-25 仅作用于后台） */
    max-width: 1200px;
    margin: 0 auto 2rem auto;
    padding: 0.75rem var(--space-6);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--c-card-bg);
    border: 1px solid var(--c-card-border);
    border-radius: var(--pico-border-radius);
    z-index: 100;
}
.public-nav-title { font-size: 1.25rem; font-weight: 600; color: var(--c-text); }
.public-nav-actions { display: flex; align-items: center; gap: 1rem; }
.public-nav-actions a, .public-nav-actions button {
    text-decoration: none;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    font-weight: 500;
    transition: all 0.2s ease;
    border: none;
    /* FIX-23: Pico 给 button 加了 margin-bottom，a 没有；align-items:center 会连外边距一起居中，
       导致按钮比旁边的链接高出半个外边距。两者一起归零才对得齐中线。 */
    margin: 0;
}
.public-nav-actions a { background-color: var(--c-button-bg); color: var(--c-button-text); }
.public-nav-actions a:hover { filter: brightness(1.1); }
/* FIX-24: margin 归零，否则 Pico 给 button 的底部外边距会让按钮相对标题顶高半个外边距；
   flex:0 0 auto 保证侧栏变窄时按钮不被挤压（曾实测被压到 33px）；44px 满足触控区要求 */
#theme-toggle { background: var(--c-icon-bg); color: var(--c-text); font-size: 1.2rem; width: 44px; height: 44px; margin: 0; padding: 0; flex: 0 0 auto; display:flex; align-items:center; justify-content:center; }
/* 前台限宽保持原样：用户要求前台页面不做修改（FIX-25 仅作用于后台） */
.public-container { max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
.public-section h2 { font-size: 1.5rem; margin-bottom: var(--space-5); color: var(--c-text); border: none; padding: 0; }
.public-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem; }
.public-card {
    background: var(--c-card-bg);
    border: 1px solid var(--c-card-border);
    border-radius: var(--pico-border-radius);
    padding: var(--space-5);
    cursor: pointer;
    transition: border-color .15s ease;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
}
.public-card:hover { border-color: var(--c-primary); }
.public-card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
.public-card-title { font-size: 1.1rem; font-weight: 600; color: var(--c-text); margin: 0; }
.public-card-meta { font-size: 0.8rem; color: var(--c-text-muted); white-space: nowrap; }
.public-card-content { font-family: inherit; font-size: 0.95rem; line-height: 1.5; color: var(--c-text); overflow-wrap: anywhere; word-break: normal; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.public-card-footer { font-size: 0.85rem; color: var(--c-text-muted); display: flex; align-items: center; gap: 0.5rem; }
.home-toast { position: fixed; top: 80px; right: 20px; background-color: var(--c-button-bg); color: var(--c-button-text); padding: 12px 20px; border-radius: 6px; z-index: 1000; font-weight: 500; box-shadow: var(--shadow-overlay); transition: transform 0.4s ease-in-out, opacity 0.4s ease-in-out; transform: translateY(-100px); opacity: 0; }
.home-toast.show { transform: translateY(0); opacity: 1; }
.home-toast.hide { transform: translateY(50px); opacity: 0; }

/* 统一焦点环：键盘 Tab 才出现，鼠标点击不残留 */
:focus-visible { outline: 2px solid var(--pico-primary); outline-offset: 2px; }
/* 尊重系统"减少动态效果"：关掉入场与悬浮过渡，保留加载中的旋转指示 */
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }
    .fa-spin { animation-duration: 1.5s !important; animation-iteration-count: infinite !important; }
}
/* 字段说明改浮层：原实现没有定位，长文案会内联铺开把标签行撑断 */
.tooltip { position: relative; display: inline-flex; cursor: help; }
.tooltip-text { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); width: max-content; max-width: 260px; padding: var(--space-2) var(--space-3); background: var(--text-strong); color: var(--surface-1); font-size: 0.8125rem; font-weight: 400; line-height: 1.5; border-radius: var(--radius-sm); opacity: 0; visibility: hidden; transition: opacity .15s ease; z-index: 10; }
.tooltip:hover .tooltip-text, .tooltip:focus-within .tooltip-text { opacity: 1; visibility: visible; }
/* 弹窗底部：主次按钮同宽，修正"取消"贴边 60px、"保存"满宽的失衡 */
dialog article footer { display: flex; gap: var(--space-3); }
dialog article footer button { flex: 1 1 0; margin: 0; }
/* 取消：次按钮用幽灵底，避免实心深灰块和主按钮抢注意力 */
dialog article footer button.secondary { background: transparent; border: 1px solid var(--pico-card-border-color); color: var(--text-body); }
dialog article footer button.secondary:hover { background: var(--surface-2); border-color: var(--text-muted); color: var(--text-strong); }
/* FIX-26: 设置页不再限宽（原先 max-width:820px，1920 下右侧空出 835px）。
   单列表单沿用 Pico 的「标签在上、输入框在下」，靠 .main-content 的 padding 留白；
   提交按钮居中，避免铺满后孤零零贴在左下角。 */
#settingsForm > button[type="submit"] { display: block; width: fit-content; min-width: 12rem; margin: var(--space-5) auto 0 auto; }
/* ≤1024：侧栏与内容留白收紧 */
@media (max-width: 1024px) {
    :root { --sidebar-width: 200px; }
    .main-content { padding: var(--space-8) var(--space-6); }
    .domain-card { gap: var(--space-4); }
    .public-container { padding: var(--space-6) var(--space-5); }
    /* FIX-24: 侧栏缩到 200px 后，1.5rem 内边距 + 1.75rem 站名会把主题按钮挤到 33px 并让站名折行 */
    .sidebar-header { padding: var(--space-4) var(--space-5); }
    .sidebar-header h3 { font-size: 1.25rem; }
}
/* ≤1023：列表退回单列卡片，行内标签重新可见（表格布局需要 ≥1024 的宽度才不挤） */
@media (max-width: 1023px) {
    .row-grid { grid-template-columns: 1fr; gap: var(--space-3); align-items: start; }
    .domain-list-head { display: none; }
}
/* 768–1023：卡片内部已是单列堆叠，容器再并两列换回一半首屏密度（每列约 380px，动作按钮仍能一行放下） */
@media (min-width: 768px) and (max-width: 1023px) {
    #domain-list-container, #ip-source-list-container { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); align-items: start; }
    #domain-list-container .domain-card, #ip-source-list-container .domain-card { margin-bottom: 0; }
    #domain-list-container .empty-state, #ip-source-list-container .empty-state { grid-column: 1 / -1; }
}
/* ≤767：后台侧栏折叠为顶栏 */
@media (max-width: 767px) {
    .public-nav { top: 0; left: 0; right: 0; border-radius: 0; width: 100%; }
    .public-container { padding: var(--space-4); }
    .public-grid { grid-template-columns: 1fr; }
    main.container { display: block; }
    .sidebar { width: 100%; height: auto; position: static; border-right: none; border-bottom: 1px solid var(--pico-card-border-color); }
    .sidebar-header { padding: var(--space-4) var(--space-5); }
    .sidebar-nav { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-1); padding: var(--space-2) var(--space-3); }
    .sidebar-nav a { justify-content: center; margin: 0; padding: var(--space-3) var(--space-1); font-size: 0.875rem; gap: var(--space-2); white-space: nowrap; }
    .main-content { padding: var(--space-5) var(--space-4); }
    .page-header { flex-direction: column; align-items: flex-start; gap: var(--space-3); }
    .domain-card { padding: var(--space-4); }
    .card-actions { justify-content: flex-start; flex-wrap: wrap; }
    .card-actions button { flex: 1 1 0; }
}
/* ≤520：窄屏进一步压缩 */
@media (max-width: 520px) {
    .main-content { padding: var(--space-4) var(--space-3); }
    .page-header h2 { font-size: 1.375rem; }
    .public-nav { padding: var(--space-2) var(--space-3); }
    .public-card { padding: var(--space-4); }
    .card-actions { flex-direction: column; }
    .card-actions button { width: 100%; }
}
</style><script>/* 首帧即应用已保存主题：避免暗色闪白，也让没有切换按钮的后台页跟随主题 *//* FIX-24 主题：首帧按"已保存值 → 系统偏好"决定，避免暗色闪白；用户没显式选过就一直跟着系统变。
   切换按钮由各页自行放置（首页导航、后台侧栏），逻辑只在这里定义一次，避免两处实现漂移。 */
(function(){var mq=window.matchMedia('(prefers-color-scheme: dark)');function stored(){try{return localStorage.getItem('theme')}catch(e){return null}}function applyTheme(t){var dark=t==='dark';document.documentElement.classList.toggle('dark',dark);document.documentElement.dataset.theme=dark?'dark':'light';var btn=document.getElementById('theme-toggle');if(!btn)return;btn.innerHTML=dark?'<i class="fa-solid fa-sun" aria-hidden="true"></i>':'<i class="fa-solid fa-moon" aria-hidden="true"></i>';btn.setAttribute('aria-label',dark?'切换到浅色主题':'切换到深色主题')}function preferred(){return stored()||(mq.matches?'dark':'light')}applyTheme(preferred());document.addEventListener('DOMContentLoaded',function(){var btn=document.getElementById('theme-toggle');if(!btn)return;btn.addEventListener('click',function(){var next=document.documentElement.classList.contains('dark')?'light':'dark';try{localStorage.setItem('theme',next)}catch(e){}applyTheme(next)})});mq.addEventListener('change',function(e){if(!stored())applyTheme(e.matches?'dark':'light')})})()</script></head><body><main class="container">${content}</main><div id="notifications" class="notifications" role="status" aria-live="polite"></div></body></html>`;
}

export function getSetupPage() {
    return `<div class="auth-container"><article id="setupForm"><h1>系统初始化</h1><p>请设置一个安全的管理员密码以保护您的应用。</p><form><label for="password">管理员密码 (最少8位)</label><input type="password" id="password" required minlength="8"><button type="submit">设置密码</button></form><p id="error-msg" style="color:red"></p></article></div><script>document.querySelector('#setupForm form').addEventListener('submit',async function(e){e.preventDefault();const password=document.getElementById('password').value;document.getElementById('error-msg').textContent='';try{const res=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});if(!res.ok){const err=await res.json();throw new Error(err.error||'设置失败')}alert('设置成功，页面即将刷新...');setTimeout(()=>window.location.reload(),1000)}catch(e){document.getElementById('error-msg').textContent=e.message}});</script>`;
}

/**
 * 渲染公开首页（无需鉴权）：仅展示启用且同步成功的域名/IP 源卡片
 * 入参全部来自 D1，所有用户控制字段在模板内统一通过 escapeHtml 包裹
 */
export function getPublicHomepage(requestUrl, domains, ipSources, threeNetworkSourceName, loggedIn) {
    const origin = new URL(requestUrl).origin;
    const formatTime = (isoStr) => {
        if (!isoStr) return "N/A";
        const date = new Date(isoStr);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    };

    const domainCards = domains
        .map((d) => {
            let sourceHost;
            if (d.is_system) {
                sourceHost = threeNetworkSourceName;
            } else {
                try {
                    let urlCompatibleSource = d.source_domain;
                    if (!urlCompatibleSource.startsWith("http://") && !urlCompatibleSource.startsWith("https://")) {
                        urlCompatibleSource = "https://" + urlCompatibleSource;
                    }
                    sourceHost = new URL(urlCompatibleSource).hostname;
                } catch {
                    sourceHost = d.source_domain || "解析错误";
                }
            }
            return `
        <div class="public-card" data-copy-content="${escapeHtml(d.target_domain)}">
            <div class="public-card-header">
                <h3 class="public-card-title">${escapeHtml(d.notes || "未知线路")}</h3>
                <span class="public-card-meta">${escapeHtml(formatTime(d.last_synced_time))}</span>
            </div>
            <div class="public-card-content">${escapeHtml(d.target_domain)}</div>
            <div class="public-card-footer">
                <span>来源: ${escapeHtml(sourceHost)}</span>
            </div>
        </div>`;
        })
        .join("");

    const ipSourceCards = ipSources
        .map((s) => {
            const fullUrl = `${origin}/${s.github_path}`;
            // Suggestion ⑧: 坏 url 行不得让整页抛错（域名卡片已有同样兜底）
            let sourceHost;
            try {
                sourceHost = new URL(s.url).hostname;
            } catch {
                sourceHost = s.url || "解析错误";
            }
            return `
        <div class="public-card" data-copy-content="${escapeHtml(fullUrl)}">
            <div class="public-card-header">
                <h3 class="public-card-title">${escapeHtml(s.github_path)}</h3>
                <span class="public-card-meta">${escapeHtml(formatTime(s.last_synced_time))}</span>
            </div>
            <div class="public-card-content">${escapeHtml(fullUrl)}</div>
            <div class="public-card-footer">
                <span>来源: ${escapeHtml(sourceHost)}</span>
            </div>
        </div>`;
        })
        .join("");

    const authButton = loggedIn
        ? `<a href="/admin" role="button">进入后台</a>`
        : `<button class="outline" onclick="document.getElementById('login-modal').showModal()">登录</button>`;

    return `
    <div class="public-body-wrapper">
        <nav class="public-nav">
            <div class="public-nav-title">CF-DNS-Clon</div>
            <div class="public-nav-actions">
                ${authButton}
                <button id="theme-toggle" type="button" aria-label="切换深浅色主题">
                    <i class="fa-solid fa-moon" aria-hidden="true"></i>
                </button>
            </div>
        </nav>
        <div class="public-container">
            <section class="public-section">
                <h2>优选域名</h2>
                <div class="public-grid">${domainCards || "<p>暂无可用数据</p>"}</div>
            </section>
            <section class="public-section">
                <h2>优选API</h2>
                <div class="public-grid">${ipSourceCards || "<p>暂无可用数据</p>"}</div>
            </section>
        </div>
    </div>
    <div id="copy-toast" class="home-toast" role="status" aria-live="polite"></div>

    <dialog id="login-modal">
      <article>
        <header>
          <a href="#close" aria-label="Close" class="close" onclick="document.getElementById('login-modal').close()"></a>
          <h3>管理员登录</h3>
        </header>
        <p>请输入密码以继续。</p>
        <form id="modal-login-form">
          <label for="modal-password">密码</label>
          <input type="password" id="modal-password" name="password" required>
          <p id="modal-error-msg" style="color: var(--pico-color-red-500); height: 1em;"></p>
          <button type="submit">登录</button>
        </form>
      </article>
    </dialog>

    <script>
        const toast = document.getElementById('copy-toast');

        function showToast(message) {
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
                toast.classList.add('hide');
                 setTimeout(() => toast.classList.remove('hide'), 400);
            }, 2000);
        }

        document.querySelector('.public-container').addEventListener('click', (event) => {
            const card = event.target.closest('.public-card');
            if (card && card.dataset.copyContent) {
                const content = card.dataset.copyContent;
                navigator.clipboard.writeText(content).then(() => {
                    showToast('已复制: ' + content);
                }, () => {
                    showToast('复制失败！');
                });
            }
        });

        document.getElementById('modal-login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('modal-password').value;
            const errorMsg = document.getElementById('modal-error-msg');
            const submitBtn = e.target.querySelector('button');
            errorMsg.textContent = '';
            submitBtn.setAttribute('aria-busy', 'true');
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || '登录失败');
                }
                window.location.href = '/admin';
            } catch (e) {
                errorMsg.textContent = e.message;
            } finally {
                submitBtn.removeAttribute('aria-busy');
            }
        });

    </script>
    `;
}
/**
 * 渲染已登录管理员的仪表盘页面骨架（含域名/IP 源表格 + 设置面板）
 * settings 必须是已过滤敏感字段的安全版本（getSafeSettings）
 */
export function getDashboardPage(domains, ipSources, settings) {
    const githubSettingsComplete = settings.GITHUB_CONFIGURED === true;
    const cfSettingsComplete = canAddDomains(settings);
    return `<aside class="sidebar"><div class="sidebar-header"><h3>DNS Clone</h3><button id="theme-toggle" type="button" aria-label="切换到深色主题"><i class="fa-solid fa-moon" aria-hidden="true"></i></button></div><nav class="sidebar-nav"><a href="#page-dns-clone" class="nav-link active" data-target="page-dns-clone"><i class="fa-solid fa-clone fa-fw"></i> 域名克隆</a><a href="#page-github-upload" class="nav-link" data-target="page-github-upload"><i class="fa-brands fa-github fa-fw"></i> GitHub 上传</a><a href="#page-settings" class="nav-link" data-target="page-settings"><i class="fa-solid fa-gear fa-fw"></i> 系统设置</a></nav></aside>
    <div class="main-content">
        <div id="page-dns-clone" class="page active">
            <div class="page-header"><h2>域名克隆列表</h2><button id="addDomainBtn" ${cfSettingsComplete ? "" : "disabled"}>＋ 添加克隆目标</button></div>
            <div id="domain-list-container"></div>
            <article><h3>手动操作</h3><p>点击下方按钮，可以立即为所有已启用的目标执行一次同步任务。</p><button id="manualSyncBtn">手动同步所有目标</button><pre id="logOutput" class="sync-log" style="display:none;"></pre></article>
        </div>
        <div id="page-github-upload" class="page">
            <div class="page-header"><h2>GitHub IP源列表</h2><button id="addIpSourceBtn" ${githubSettingsComplete ? "" : "disabled"}>＋ 添加IP源</button></div>
             <div id="ip-source-list-container"></div>
            <article><h3>手动操作</h3><p>点击下方按钮，可以立即为所有已启用的IP源执行一次同步并上传到GitHub。</p><button id="manualSyncIpSourcesBtn">同步所有IP源</button><pre id="ipLogOutput" class="sync-log" style="display:none;"></pre></article>
        </div>
        <div id="page-settings" class="page">
            <div class="page-header"><h2>系统设置</h2></div>
            <form id="settingsForm">
                <fieldset><legend><i class="fa-brands fa-cloudflare"></i> Cloudflare API 设置</legend><label for="cfToken">API 令牌 (Token)</label><input type="password" id="cfToken" value="" placeholder="${settings.CF_CONFIGURED ? "已配置，留空保持不变" : "输入 Cloudflare API 令牌"}"><label><input type="checkbox" id="cfClear"> 清除已保存的 Cloudflare 配置</label><label for="cfZoneId">区域 (Zone) ID</label><input type="text" id="cfZoneId" value="${escapeHtml(settings.CF_ZONE_ID || "")}">
                    <details class="tutorial-details"><summary>如何获取 API 令牌和区域 ID？</summary><div class="tutorial-content"><ol><li><strong>获取 API 令牌 (Token):</strong><ol type="a"><li>登录 <a href="https://dash.cloudflare.com/" target="_blank">Cloudflare</a>，进入 <strong>“我的个人资料”</strong> &rarr; <strong>“API 令牌”</strong>。</li><li>点击 <strong>“创建令牌”</strong>，然后选择 <strong>“编辑区域 DNS”</strong> 模板并点击“使用模板”。</li><li>在 <strong>“区域资源”</strong> 部分，选择您需要操作的具体域名区域。</li><li>点击“继续以显示摘要”和“创建令牌”，复制生成的令牌。<strong>注意：令牌仅显示一次，请妥善保管。</strong></li></ol></li><li><strong>获取区域 ID (Zone ID):</strong><ol type="a"><li>在 Cloudflare 仪表板主页，点击您需要操作的域名。</li><li>在域名的“概述”页面，您可以在右下角找到 <strong>“区域 ID”</strong>，点击即可复制。</li></ol></li></ol></div></details>
                </fieldset>
                 <fieldset><legend><i class="fa-solid fa-network-wired"></i> 三网优选IP源设置</legend><label for="threeNetworkSource">三网采集源</label><select id="threeNetworkSource"><option value="CloudFlareYes" ${settings.THREE_NETWORK_SOURCE === "CloudFlareYes" ? "selected" : ""}>CloudFlareYes</option><option value="api.uouin.com" ${settings.THREE_NETWORK_SOURCE === "api.uouin.com" ? "selected" : ""}>api.uouin.com</option><option value="wetest.vip" ${settings.THREE_NETWORK_SOURCE === "wetest.vip" ? "selected" : ""}>wetest.vip</option></select><small>为系统预设的电信/移动/联通域名选择IP来源。更改后保存设置将自动同步一次系统域名。</small>
                </fieldset>
                <fieldset><legend><i class="fa-solid fa-list-ol"></i> DNS 记录设置</legend><label for="maxIpsPerType">单类型记录上限 (MAX_IPS_PER_TYPE)</label><input type="number" id="maxIpsPerType" min="${MIN_MAX_IPS_PER_TYPE}" max="${MAX_MAX_IPS_PER_TYPE}" step="1" value="${normalizeMaxIpsPerType(settings.MAX_IPS_PER_TYPE)}"><small>每个 DNS 类型（A / AAAA）最多保留的记录条数，范围 ${MIN_MAX_IPS_PER_TYPE}–${MAX_MAX_IPS_PER_TYPE}。留空并保存表示恢复默认 ${DEFAULT_MAX_IPS_PER_TYPE}。</small>
                 </fieldset>
                 <fieldset><legend><i class="fa-solid fa-key"></i> IP 源抓取设置</legend><label for="hostmonitKey">hostmonit 接口 Key</label><input type="password" id="hostmonitKey" value="" placeholder="留空沿用内置默认 Key（已自定义时留空保持不变）"><label><input type="checkbox" id="hostmonitClear"> 清除自定义 Key（恢复内置默认）</label><small>hostmonit 三网优选 IP 接口的公开 key，对方轮换或限流后在此更新，保存后下一次同步即生效。</small>
                </fieldset>
                <fieldset><legend><i class="fa-brands fa-github"></i> GitHub API 设置</legend><label for="githubToken">GitHub Token</label><input type="password" id="githubToken" value="" placeholder="${settings.GITHUB_CONFIGURED ? "已配置，留空保持不变" : "具有 repo 权限的 Personal Access Token"}"><label><input type="checkbox" id="githubClear"> 清除已保存的 GitHub 配置</label><label for="githubOwner">GitHub 用户名/组织名</label><input type="text" id="githubOwner" value="${escapeHtml(settings.GITHUB_OWNER || "")}" placeholder="例如: my-username"><label for="githubRepo">仓库名称</label><input type="text" id="githubRepo" value="${escapeHtml(settings.GITHUB_REPO || "")}" placeholder="例如: my-dns-records">
                    <details class="tutorial-details"><summary>如何获取 GitHub API 信息？</summary><div class="tutorial-content"><ol><li><strong>获取 GitHub Token:</strong><ol type="a"><li>登录 <a href="https://github.com/" target="_blank">GitHub</a>，点击右上角头像，进入 <strong>“Settings”</strong>。</li><li>在左侧菜单中，选择 <strong>“Developer settings”</strong> &rarr; <strong>“Personal access tokens”</strong> &rarr; <strong>“Tokens (classic)”</strong>。</li><li>点击 <strong>“Generate new token”</strong>，并选择 <strong>“Generate new token (classic)”</strong>。</li><li>为令牌添加描述（Note），设置合适的过期时间（Expiration）。</li><li>在 <strong>“Select scopes”</strong> 部分，勾选 <code>repo</code> 权限。</li><li>点击页面底部的 <strong>“Generate token”</strong>，并复制生成的令牌。<strong>注意：令牌仅显示一次，请妥善保管。</strong></li></ol></li><li><strong>获取用户名/组织名 和 仓库名称:</strong><ol type="a"><li><strong>用户名/组织名</strong> 就是您的GitHub个人主页URL中，github.com后面的那部分，或者您组织的主页URL。</li><li><strong>仓库名称</strong> 是您在GitHub上创建的，用来存储IP文件的仓库的名字。如果仓库不存在，系统将在第一次同步时自动为您创建为私有仓库。</li></ol></li></ol></div></details>
                </fieldset>
                <button type="submit">保存设置</button>
            </form>
        </div>
    </div>
    <dialog id="domainModal"><article><header><a href="#close" aria-label="Close" class="close" onclick="window.closeModal('domainModal')"></a><h3 id="modalTitle"></h3></header><form id="domainForm"><input type="hidden" id="domainId"><label for="source_type">IP 输入类型</label><select id="source_type" onchange="window.onDomainSourceTypeChange()"><option value="domain">域名</option><option value="url">URL</option></select><div id="domainSourceDomainGroup"><label for="source_domain">克隆域名</label><input type="text" id="source_domain" placeholder="example-source.com"></div><div id="domainSourceUrlGroup" hidden><label for="source_url">URL</label><input type="text" id="source_url" placeholder="https://example.com/ip_list.json" maxlength="2048"><div class="grid"><div><label for="domain_parse_mode">解析模式</label><select id="domain_parse_mode"><option value="auto">自动（全文提取）</option><option value="lines">按行提取</option><option value="json_path">JSON 路径</option><option value="custom_regex">自定义正则</option></select></div><div><label for="domain_parse_param">解析参数</label><input type="text" id="domain_parse_param" maxlength="512" placeholder="json_path: data.list.ips；custom_regex: 正则"></div></div><small>自动 / 按行不需要参数；JSON 路径最长 512 字符，自定义正则最长 200 字符。URL 类型固定为深度关闭。</small></div><label for="target_domain_prefix">我的域名前缀</label><div class="grid"><input type="text" id="target_domain_prefix" placeholder="subdomain or @" required><span id="zoneNameSuffix" style="line-height:var(--pico-form-element-height);font-weight:700">.your-zone.com</span></div><div class="grid"><div><label for="is_deep_resolve">深度 <span class="tooltip">(?)<span class="tooltip-text">开启后，如果克隆域名是CNAME，系统将递归查找最终的IP地址进行解析。关闭则直接克隆CNAME记录本身。</span></span></label><input type="checkbox" id="is_deep_resolve" role="switch" checked></div><div><label for="ttl">TTL (秒)</label><input type="number" id="ttl" min="60" max="86400" value="60" required></div></div><label for="notes">备注 (可选)</label><textarea id="notes" rows="2" placeholder="例如：主力CDN"></textarea><footer><button type="button" class="secondary" onclick="window.closeModal('domainModal')">取消</button><button type="submit" id="saveBtn">保存</button></footer></form></article></dialog>
    <dialog id="ipSourceModal"><article><header><a href="#close" aria-label="Close" class="close" onclick="window.closeModal('ipSourceModal')"></a><h3 id="ipSourceModalTitle"></h3></header><form id="ipSourceForm"><input type="hidden" id="ipSourceId"><div class="grid"><label for="ip_source_url">IP源地址</label><button type="button" class="outline" id="probeBtn" style="width:auto;padding:0 1rem;">探测方案</button></div><input type="text" id="ip_source_url" placeholder="https://example.com/ip_list.txt" required><progress id="probeProgress" style="display:none;"></progress><p id="probeResult" style="font-size:0.9em;"></p><small>抓取策略是 URL 的抓取方式缓存：修改 IP 源地址后抓取策略会随 URL 变更重置，请重新探测后再保存。</small><div class="grid"><div><label for="parse_mode">解析模式</label><select id="parse_mode"><option value="auto">自动（全文提取）</option><option value="lines">按行提取</option><option value="json_path">JSON 路径</option><option value="custom_regex">自定义正则</option></select></div><div><label for="parse_param">解析参数</label><input type="text" id="parse_param" maxlength="512" placeholder="json_path: data.list.ips；custom_regex: 正则"></div></div><small>自动 / 按行不需要参数；JSON 路径最长 512 字符，自定义正则最长 200 字符。</small><label for="github_path">GitHub 文件路径</label><input type="text" id="github_path" placeholder="IP/Cloudflare.txt" required><label for="commit_message">Commit 信息</label><input type="text" id="commit_message" placeholder="Update Cloudflare IPs" required><footer><button type="button" class="secondary" onclick="window.closeModal('ipSourceModal')">取消</button><button type="submit" id="saveIpSourceBtn">保存</button></footer></form></article></dialog>
    <script>${getDashboardScript(domains, ipSources, settings)}</script>`;
}

/** 消费完整的 SSE 事件，并保留被网络分块切开的残余内容 */
export function consumeSseEvents(buffer, chunk) {
    buffer += chunk;
    const events = [];
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (event.startsWith("data: ")) events.push(event.substring(6));
        boundary = buffer.indexOf("\n\n");
    }
    return { buffer, events };
}

/**
 * 渲染仪表盘浏览器端脚本（API 调用 / 流式同步 / 主题切换等）
 * 模板字符串中的 settings 仅渲染为可读视图，敏感字段已被剔除
 */
function getDashboardScript(domains, ipSources, settings) {
    // 分四段拼装客户端脚本：数据准备 + 渲染 + 交互 + 同步/启动。
    // 每个分段函数只返回字符串片段，拼装结果与拆分前逐字一致。
    return (
        `
  // esbuild 的 keep_names 会给被 toString() 注入的函数体里插入 __name(fn, "fn") 语句；
  // 浏览器侧没有这个 helper，缺垫片会让整个脚本块在 ReferenceError 处中止，后台所有交互失效。
  const __name = (fn, name) => {
      try {
          Object.defineProperty(fn, "name", { value: name, configurable: true });
      } catch (e) {
          /* 老引擎不支持改 name，忽略即可 */
      }
      return fn;
  };
  const consumeSseEvents = ${consumeSseEvents.toString()};
  function showNotification(message, type = 'info', duration = 5000) {
      const container = document.getElementById('notifications');
      const toast = document.createElement('div');
      toast.className = \`toast toast-\${type}\`;
      // I2: 通知一律 textContent，避免 e.message / API 文案中的 HTML 被解析执行
      const msg = document.createElement('div');
      msg.textContent = message;
      toast.appendChild(msg);
      container.appendChild(toast);
      setTimeout(() => toast.classList.add('show'), 10);
      setTimeout(() => {
          toast.classList.add('hide');
          toast.addEventListener('transitionend', e => {
              if (e.target === toast) toast.remove();
          }, { once: true });
      }, duration);
  }
  // 统一请求封装：401 一律提示并跳登录，业务错误直接抛出后端文案。
  // 实现来自 ./dashboard-api.js，注入后可直接被行为测试覆盖。
  const createApiFetch = ${createApiFetch.toString()};
  const apiFetch = createApiFetch({
      fetchImpl: (input, init) => fetch(input, init),
      notify: showNotification,
      redirect: (target) => { window.location.href = target; },
      schedule: (fn, delay) => setTimeout(fn, delay),
  });
  let currentDomains = ${safeJsonForScript(domains)};
  let currentIpSources = ${safeJsonForScript(ipSources)};
  let currentSettings = ${safeJsonForScript(settings)};
  let zoneName = currentSettings.zoneName || '';
  let successfulProbeStrategy = null;

  // I2: 客户端渲染统一转义助手（与服务器端 escapeHtml 同语义）
  // 客户端转义助手来自 ./dashboard-helpers.js，注入后可直接被行为测试覆盖。
  const esc = ${escapeHtmlClient.toString()};
  // 按钮可用性判定与服务器端渲染共用同一份实现（issue #21）
  const canAddDomains = ${canAddDomains.toString()};
  // 保存体组装来自 ./dashboard-helpers.js（issue #52）：URL/域名两种来源的字段互斥规则只有一处实现
  const buildDomainSavePayload = ${buildDomainSavePayload.toString()};
  // IP 源提交体同样来自 ./dashboard-helpers.js（issue #57）：保存与探测的解析参数归一只有一处实现
  const buildIpSourceSavePayload = ${buildIpSourceSavePayload.toString()};
  const buildIpSourceProbePayload = ${buildIpSourceProbePayload.toString()};

  const formatBeijingTime = (isoStr) => { if (!isoStr) return '从未'; const d = new Date(isoStr); return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d).replace(/\\//g, '-'); };
` +
        getDashboardRenderScript() +
        getDashboardInteractionScript() +
        getDashboardSyncScript() +
        getDashboardBootstrapScript()
    );
}

// 仪表盘脚本 · 渲染段（M-1）：纯展示助手，输入行数据输出 HTML
function getDashboardRenderScript() {
    return `
  // 渲染助手来自 ./dashboard-render.js：依赖全部通过参数注入，
  // 函数体自包含（不引用页面作用域），因此可以被 toString() 注入并单独做行为测试。
  const createDashboardRenderers = ${createDashboardRenderers.toString()};
  const { renderLiveRecords, renderStatus, renderDomainCard, renderIpSourceCard } = createDashboardRenderers({
      escapeHtml: esc,
      getZoneName: () => zoneName,
      formatBeijingTime: formatBeijingTime,
      origin: window.location.origin,
  });
  function renderDomainList() {
      const container = document.getElementById('domain-list-container');
      if (currentDomains.length > 0) {
        // 表头只在 ≥1024 显示（与行共用 row-grid 列宽）；窄屏由行内 .col-label 承担
        container.innerHTML = '<div class="domain-list-head row-grid"><span>克隆目标</span><span>当前解析</span><span>上次同步</span><span></span></div>' + currentDomains.map(renderDomainCard).join('');
      } else {
        container.innerHTML = '<div class="empty-state"><p>暂无域名克隆目标，点右上角「添加克隆目标」新建一条。</p></div>';
      }
  }

  function renderIpSourceList() {
      const container = document.getElementById('ip-source-list-container');
      if (currentIpSources.length > 0) {
        container.innerHTML = '<div class="domain-list-head row-grid"><span>GitHub 文件路径</span><span>抓取策略</span><span>上次同步</span><span></span></div>' + currentIpSources.map(renderIpSourceCard).join('');
      } else {
        container.innerHTML = '<div class="empty-state"><p>暂无 IP 源，点右上角「添加IP源」新建一条（需先在「系统设置」填好 GitHub Token / 用户名 / 仓库）。</p></div>';
      }
  }
`;
}

// 仪表盘脚本 · 交互段（M-1）：弹窗、表单保存、列表刷新
function getDashboardInteractionScript() {
    return `
  window.copyToClipboard = (text) => { navigator.clipboard.writeText(text).then(() => { showNotification(\`已复制: \${text}\`, 'success', 3000); }, () => { showNotification(\`复制失败，请检查浏览器权限。\`, 'error'); }); };

  window.openModal = (modalId, id = null) => {
      const modal = document.getElementById(modalId);
      if (modalId === 'domainModal') {
          const form = document.getElementById('domainForm'); form.reset();
          document.getElementById('modalTitle').textContent = id ? '编辑克隆目标' : '添加新克隆目标';
          document.getElementById('zoneNameSuffix').textContent = zoneName ? '.' + zoneName : '（保存时自动获取）';
          document.getElementById('is_deep_resolve').checked = true;
          // 新增默认按域名输入；存量行 source_type 可能为 NULL，按 domain 处理（issue #52）
          window.setDomainSourceType('domain');
          if (id) {
              const domain = currentDomains.find(d => d.id === id);
              document.getElementById('domainId').value = domain.id;
              let prefix = domain.target_domain;
              if (zoneName) {
                  const suffix = '.' + zoneName;
                  if (domain.target_domain === zoneName) {
                      prefix = '@';
                  } else if (domain.target_domain.endsWith(suffix)) {
                      prefix = domain.target_domain.substring(0, domain.target_domain.length - suffix.length);
                  }
              }
              document.getElementById('target_domain_prefix').value = prefix;
              window.setDomainSourceType(domain.source_type === 'url' ? 'url' : 'domain');
              document.getElementById('source_domain').value = domain.source_domain;
              document.getElementById('source_url').value = domain.source_url || '';
              // 存量数据 parse_mode 可能为 NULL：按 auto 回填，避免编辑时把解析配置清成空
              document.getElementById('domain_parse_mode').value = domain.parse_mode || 'auto';
              document.getElementById('domain_parse_param').value = domain.parse_param || '';
              document.getElementById('is_deep_resolve').checked = !!domain.is_deep_resolve;
              document.getElementById('ttl').value = domain.ttl;
              document.getElementById('notes').value = domain.notes;
          } else { document.getElementById('domainId').value = ''; }
      } else if (modalId === 'ipSourceModal') {
          const form = document.getElementById('ipSourceForm'); form.reset();
          successfulProbeStrategy = null;
          document.getElementById('probeProgress').style.display = 'none';
          document.getElementById('probeResult').textContent = '';
          document.getElementById('saveIpSourceBtn').disabled = true;
          document.getElementById('probeBtn').disabled = false;
          document.getElementById('ipSourceModalTitle').textContent = id ? '编辑IP源' : '添加新IP源';
          if (id) {
              const source = currentIpSources.find(s => s.id === id);
              document.getElementById('ipSourceId').value = source.id;
              document.getElementById('ip_source_url').value = source.url;
              document.getElementById('github_path').value = source.github_path;
              document.getElementById('commit_message').value = source.commit_message;
              // 存量数据 parse_mode 可能为 NULL：按 auto 回填，避免编辑时把解析配置清成空
              document.getElementById('parse_mode').value = source.parse_mode || 'auto';
              document.getElementById('parse_param').value = source.parse_param || '';
              if (source.fetch_strategy) {
                  successfulProbeStrategy = source.fetch_strategy;
                  document.getElementById('probeResult').textContent = \`已缓存策略: \${successfulProbeStrategy}\`;
                  document.getElementById('saveIpSourceBtn').disabled = false;
              }
          } else {
              document.getElementById('ipSourceId').value = '';
          }
      }
      modal.showModal();
  };
  window.closeModal = (modalId) => { document.getElementById(modalId).close(); };
  // IP 输入类型切换（issue #52）：域名走 DoH，URL 走抓取；URL 类型强制关闭深度解析
  window.setDomainSourceType = (type) => {
      const isUrl = type === 'url';
      document.getElementById('source_type').value = isUrl ? 'url' : 'domain';
      document.getElementById('domainSourceDomainGroup').hidden = isUrl;
      document.getElementById('domainSourceUrlGroup').hidden = !isUrl;
      document.getElementById('source_domain').required = !isUrl;
      document.getElementById('source_url').required = isUrl;
      const deepSwitch = document.getElementById('is_deep_resolve');
      deepSwitch.disabled = isUrl;
      // URL 固定深度关闭；从 URL 切回域名时恢复默认开启，否则会静默保存成深度关闭的目标
      deepSwitch.checked = !isUrl;
  };
  window.onDomainSourceTypeChange = () => {
      window.setDomainSourceType(document.getElementById('source_type').value);
  };

  async function saveDomain() {
      const id = document.getElementById('domainId').value;
      const sourceType = document.getElementById('source_type').value;
      const parseMode = document.getElementById('domain_parse_mode').value;
      const parseParam = document.getElementById('domain_parse_param').value.trim();
      const payload = buildDomainSavePayload({
          sourceType: sourceType,
          sourceDomain: document.getElementById('source_domain').value,
          sourceUrl: document.getElementById('source_url').value,
          parseMode: parseMode,
          parseParam: parseParam,
          targetDomainPrefix: document.getElementById('target_domain_prefix').value,
          isDeepResolve: document.getElementById('is_deep_resolve').checked,
          ttl: document.getElementById('ttl').value,
          notes: document.getElementById('notes').value,
      });
      const url = id ? '/api/domains/' + id : '/api/domains'; const method = id ? 'PUT' : 'POST';
      try { const result = await apiFetch(url, { method, body: JSON.stringify(payload) }); showNotification(result.message, 'success'); closeModal('domainModal'); await refreshDomains(); } catch (e) { showNotification(\`保存失败: \${e.message}\`, 'error'); }
  }
  window.deleteDomain = async (id) => { if (!confirm('确定要删除这个目标吗？此操作不可逆转。')) return; try { const result = await apiFetch('/api/domains/' + id, { method: 'DELETE' }); showNotification(result.message, 'success'); await refreshDomains(); } catch (e) { showNotification(\`错误: \${e.message}\`, 'error'); } }

  async function refreshDomains() {
    try {
        currentDomains = await apiFetch('/api/domains');
        renderDomainList();
        fetchLiveRecords();
    } catch (e) {
        showNotification(\`更新列表失败: \${e.message}\`, 'error');
    }
  }

  async function fetchLiveRecords() {
    const placeholders = document.querySelectorAll('.records-placeholder');
    if (!placeholders.length) return;
    // 一次请求取回全部域名的记录，避免每张卡片各发一次（N+1）
    let payload = {};
    try {
        payload = await apiFetch('/api/domains/records');
    } catch(e) {
        payload = {};
    }
    for (const el of placeholders) {
        const entry = payload[el.dataset.domainId];
        if (entry && entry.records) {
            el.innerHTML = renderLiveRecords(entry.records);
        } else {
            el.innerHTML = '<span class="status-failed">查询失败</span>';
        }
    }
  }

  async function saveIpSource() {
      const id = document.getElementById('ipSourceId').value;
      const payload = buildIpSourceSavePayload({
          url: document.getElementById('ip_source_url').value,
          githubPath: document.getElementById('github_path').value,
          commitMessage: document.getElementById('commit_message').value,
          parseMode: document.getElementById('parse_mode').value,
          parseParam: document.getElementById('parse_param').value,
      });
      const apiUrl = id ? \`/api/ip_sources/\${id}\` : '/api/ip_sources';
      const method = id ? 'PUT' : 'POST';
      try { const result = await apiFetch(apiUrl, { method, body: JSON.stringify(payload) }); showNotification(result.message, 'success'); closeModal('ipSourceModal'); await refreshIpSources(); } catch (e) { showNotification(\`保存失败: \${e.message}\`, 'error'); }
  }
    window.deleteIpSource = async (id) => { if (!confirm('确定要删除这个IP源吗？')) return; try { await apiFetch(\`/api/ip_sources/\${id}\`, { method: 'DELETE' }); showNotification('IP源已删除', 'success'); await refreshIpSources(); } catch(e) { showNotification(\`删除失败: \${e.message}\`, 'error'); } }
    async function refreshIpSources() { try { currentIpSources = await apiFetch('/api/ip_sources'); renderIpSourceList(); } catch (e) { showNotification(\`更新IP源列表失败: \${e.message}\`, 'error'); } }
`;
}

// 仪表盘脚本 · 同步段（M-1）：流式同步、单条同步、设置保存
function getDashboardSyncScript() {
    return `
  // 流结束后的刷新判定来自 ./dashboard-helpers.js，注入后可直接被行为测试覆盖（issue #42）。
  const planSyncCompletionActions = ${planSyncCompletionActions.toString()};
  async function handleStreamingRequest(url, btn, logOutputElem) {
      const allButtons = document.querySelectorAll('button'); allButtons.forEach(b => b.disabled = true); if (btn) btn.setAttribute('aria-busy', 'true'); // 进度只由日志面板呈现，按钮只禁用不改文案
      logOutputElem.style.display = 'block';
      logOutputElem.textContent = '开始同步任务...\\n';
      try {
          const response = await fetch(url, { method: 'POST' });
          if (!response.ok) {
              let errMessage = '服务器错误: ' + response.status;
              try {
                  const errData = await response.clone().json();
                  if (errData && errData.error) errMessage = errData.error;
              } catch (e) {
                  errMessage = '服务器错误: ' + response.status;
              }
              throw new Error(errMessage);
          }
          if (!response.body) throw new Error('服务器错误: ' + response.status);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let sseBuffer = '';
          while (true) {
              const { done, value } = await reader.read();
              if (done) {
                  decoder.decode();
                  break;
              }
              const parsed = consumeSseEvents(sseBuffer, decoder.decode(value, { stream: true }));
              sseBuffer = parsed.buffer;
              for (const payload of parsed.events) {
                  logOutputElem.textContent += payload + '\\n';
                  logOutputElem.scrollTop = logOutputElem.scrollHeight;
              }
          }
          // 动作序列由注入的纯函数判定（issue #42）：提示在前、刷新在后，顺序契约见 dashboard-helpers.js
          for (const action of planSyncCompletionActions(logOutputElem.id)) {
              if (action.type === 'hint') logOutputElem.textContent += '\\n' + action.text;
              else if (action.type === 'refresh' && action.target === 'domains') await refreshDomains();
              else if (action.type === 'refresh' && action.target === 'ipSources') await refreshIpSources();
          }
      } catch (e) {
          logOutputElem.textContent += '\\n发生严重错误：\\n' + e.message;
          showNotification('同步任务发生错误', 'error');
      } finally {
          allButtons.forEach(b => { if (!b.closest('dialog')) b.disabled = false; });
          if (btn) btn.removeAttribute('aria-busy');
      }
  }

  window.individualSync = (id) => {
      const btn = document.querySelector(\`#domain-card-\${id} .card-actions button:first-child\`);
      handleStreamingRequest(\`/api/domains/\${id}/sync\`, btn, document.getElementById('logOutput'));
  };
   window.syncSingleIpSource = (id) => {
      const btn = document.querySelector(\`#ip-source-card-\${id} .card-actions button:first-child\`);
      handleStreamingRequest(\`/api/ip_sources/\${id}/sync\`, btn, document.getElementById('ipLogOutput'));
  };

  async function saveSettings(event) {
      event.preventDefault();
      const btn = event.target.querySelector('button');
      btn.disabled = true; btn.setAttribute('aria-busy', 'true');

      const oldThreeNetworkSource = currentSettings.THREE_NETWORK_SOURCE;
      const newThreeNetworkSource = document.getElementById('threeNetworkSource').value;

      const settingsToSave = { THREE_NETWORK_SOURCE: newThreeNetworkSource };
      // issue #49：单类型记录上限；留空即清除，服务端读取时回退默认 20
      settingsToSave.MAX_IPS_PER_TYPE = document.getElementById('maxIpsPerType').value.trim();
      if (document.getElementById('cfClear').checked) {
          Object.assign(settingsToSave, { CF_API_TOKEN: null, CF_ZONE_ID: null });
      } else {
          const cfToken = document.getElementById('cfToken').value.trim();
          const cfZoneId = document.getElementById('cfZoneId').value.trim();
          if (cfToken) settingsToSave.CF_API_TOKEN = cfToken;
          if (cfZoneId) settingsToSave.CF_ZONE_ID = cfZoneId;
      }
      if (document.getElementById('hostmonitClear').checked) {
          settingsToSave.HOSTMONIT_API_KEY = null;
      } else {
          const hostmonitKey = document.getElementById('hostmonitKey').value.trim();
          if (hostmonitKey) settingsToSave.HOSTMONIT_API_KEY = hostmonitKey;
      }
      if (document.getElementById('githubClear').checked) {
          Object.assign(settingsToSave, { GITHUB_TOKEN: null, GITHUB_OWNER: null, GITHUB_REPO: null });
      } else {
          const githubToken = document.getElementById('githubToken').value.trim();
          const githubOwner = document.getElementById('githubOwner').value.trim();
          const githubRepo = document.getElementById('githubRepo').value.trim();
          if (githubToken) settingsToSave.GITHUB_TOKEN = githubToken;
          if (githubOwner) settingsToSave.GITHUB_OWNER = githubOwner;
          if (githubRepo) settingsToSave.GITHUB_REPO = githubRepo;
      }
      try {
          const result = await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(settingsToSave) });
          showNotification(result.message || '设置已保存！', 'success');

          if (oldThreeNetworkSource !== newThreeNetworkSource) {
              showNotification('三网优选源已更改，正在为您同步系统域名...', 'info');
              handleStreamingRequest('/api/domains/sync_system', null, document.getElementById('logOutput'));
          }

          const newSettings = await apiFetch('/api/settings');
          currentSettings = newSettings;
          zoneName = currentSettings.zoneName || '';
          const githubSettingsComplete = currentSettings.GITHUB_CONFIGURED === true;
          document.getElementById('addDomainBtn').disabled = !canAddDomains(currentSettings);
          document.getElementById('addIpSourceBtn').disabled = !githubSettingsComplete;
          document.getElementById('cfClear').checked = false;
          document.getElementById('githubClear').checked = false;
          document.getElementById('cfToken').value = '';
          document.getElementById('cfZoneId').value = currentSettings.CF_ZONE_ID || '';
          document.getElementById('maxIpsPerType').value = currentSettings.MAX_IPS_PER_TYPE;
          document.getElementById('githubToken').value = '';
          document.getElementById('githubOwner').value = currentSettings.GITHUB_OWNER || '';
          document.getElementById('githubRepo').value = currentSettings.GITHUB_REPO || '';
          document.getElementById('hostmonitKey').value = '';
          document.getElementById('hostmonitKey').placeholder = currentSettings.HOSTMONIT_CONFIGURED
              ? '已配置，留空保持不变'
              : '留空沿用内置默认 Key';
          document.getElementById('hostmonitClear').checked = false;
          await refreshDomains();
      } catch (e) {
          showNotification(\`保存失败: \${e.message}\`, 'error', 10000);
      } finally {
          btn.disabled = false; btn.removeAttribute('aria-busy');
      }
  }
`;
}

// 仪表盘脚本 · 启动段（M-1）：DOMContentLoaded 绑定与首屏加载
function getDashboardBootstrapScript() {
    return `
  document.addEventListener('DOMContentLoaded', async () => {
      renderDomainList();
      renderIpSourceList();
      fetchLiveRecords();

      const navLinks = document.querySelectorAll('.nav-link');
      const pages = document.querySelectorAll('.page');
      navLinks.forEach(link => {
          link.addEventListener('click', (e) => {
              e.preventDefault();
              const targetId = link.dataset.target;
              pages.forEach(page => page.classList.remove('active'));
              document.getElementById(targetId).classList.add('active');
              navLinks.forEach(l => l.classList.remove('active'));
              link.classList.add('active');
          });
      });

      document.getElementById('settingsForm').addEventListener('submit', saveSettings);
      document.getElementById('addDomainBtn').addEventListener('click', () => openModal('domainModal'));
      document.getElementById('manualSyncBtn').addEventListener('click', (e) => handleStreamingRequest('/api/sync', e.target, document.getElementById('logOutput')));
      document.getElementById('domainForm').addEventListener('submit', (e) => { e.preventDefault(); saveDomain(); });

      document.getElementById('addIpSourceBtn').addEventListener('click', () => openModal('ipSourceModal'));
      document.getElementById('manualSyncIpSourcesBtn').addEventListener('click', (e) => handleStreamingRequest('/api/ip_sources/sync_all', e.target, document.getElementById('ipLogOutput')));
      document.getElementById('ipSourceForm').addEventListener('submit', (e) => { e.preventDefault(); saveIpSource(); });

      document.getElementById('probeBtn').addEventListener('click', async (e) => {
          const url = document.getElementById('ip_source_url').value;
          if (!url) { showNotification('请输入IP源地址', 'warning'); return; }

          const btn = e.target;
          const progress = document.getElementById('probeProgress');
          const resultElem = document.getElementById('probeResult');
          const saveBtn = document.getElementById('saveIpSourceBtn');

          btn.disabled = true;
          saveBtn.disabled = true;
          progress.style.display = 'block';
          progress.removeAttribute('value');
          resultElem.textContent = '正在探测...';
          successfulProbeStrategy = null;

          try {
              // 探测体与保存体同源（issue #57）：解析参数归一不再各写一遍
              const probePayload = buildIpSourceProbePayload({
                  url: url,
                  parseMode: document.getElementById('parse_mode').value,
                  parseParam: document.getElementById('parse_param').value,
              });
              const result = await apiFetch('/api/ip_sources/probe', { method: 'POST', body: JSON.stringify(probePayload) });
              progress.setAttribute('value', '100');
              const samples = [];
              if (result.sampleIps && result.sampleIps.length) samples.push(\`IPv4 样例: \${result.sampleIps.join(', ')}\`);
              if (result.sampleIpv6 && result.sampleIpv6.length) samples.push(\`IPv6 样例: \${result.sampleIpv6.join(', ')}\`);
              resultElem.textContent = \`探测成功！策略: \${result.strategy} | 发现 \${result.ipv4Count} 个IPv4、\${result.ipv6Count} 个IPv6\` + (samples.length ? \` | \${samples.join(' | ')}\` : '');
              successfulProbeStrategy = result.strategy;
              saveBtn.disabled = false;
          } catch (error) {
              progress.style.display = 'none';
              resultElem.textContent = \`探测失败: \${error.message}\`;
              showNotification(\`探测失败: \${error.message}\`, 'error');
          } finally {
              btn.disabled = false;
          }
      });
  });
`;
}

// fetchThreeNetworkIps 已移至 ./sync/ip-sources.ts
