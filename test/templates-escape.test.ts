// templates-escape.test.ts — P0-2：公开首页存储型 XSS 修复回归测试
// 验证 getPublicHomepage 对用户控制字段（notes/target_domain/github_path/url）做 HTML 实体转义
import { describe, it, expect } from "vitest";
import { consumeSseEvents, getHtmlLayout, getPublicHomepage, getDashboardPage } from "../src/ui/templates.js";

const requestUrl = "https://example.com/";

describe("getPublicHomepage HTML 转义 (P0-2)", () => {
    it("转义 notes 中的 <img onerror> payload", () => {
        const domains = [
            {
                target_domain: "safe.example.com",
                source_domain: "src.example.com",
                notes: "<img src=x onerror=alert(1)>",
                last_synced_time: "2026-01-01T00:00:00Z",
                is_enabled: 1,
                last_sync_status: "success",
            },
        ];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 未转义的 <img 标签不应出现
        expect(html).not.toMatch(/<img src=x onerror=alert\(1\)>/);
        // 转义后的实体应当出现
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("转义 target_domain 中的属性逃逸 payload", () => {
        const domains = [
            {
                target_domain: '" onmouseover="alert(1)',
                source_domain: "src.example.com",
                notes: "正常备注",
                last_synced_time: "2026-01-01T00:00:00Z",
                is_enabled: 1,
                last_sync_status: "success",
            },
        ];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 未转义的 onmouseover 属性不应出现
        expect(html).not.toMatch(/onmouseover="alert\(1\)"/);
        // 双引号应被转义为 &quot;
        expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    });

    it("转义 ipSource 的 github_path 中的 HTML payload", () => {
        const ipSources = [
            {
                url: "https://raw.githubusercontent.com/u/r/main/file.txt",
                github_path: "<script>alert(1)</script>/path.txt",
                last_synced_time: "2026-01-01T00:00:00Z",
            },
        ];
        const html = getPublicHomepage(requestUrl, [], ipSources, "三网聚合", false);
        expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("转义 github_path 中的双引号属性逃逸", () => {
        const ipSources = [
            {
                url: "https://example.com/raw/file.txt",
                github_path: '" onmouseover="alert(1)/x.txt',
                last_synced_time: "2026-01-01T00:00:00Z",
            },
        ];
        const html = getPublicHomepage(requestUrl, [], ipSources, "三网聚合", false);
        // 未转义的双引号应被替换为 &quot;，属性逃逸不成立
        expect(html).not.toMatch(/onmouseover="alert\(1\)"/);
        expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    });

    it("对 null/undefined 值安全降级为空串", () => {
        const domains = [
            {
                target_domain: "safe.example.com",
                source_domain: "src.example.com",
                notes: null,
                last_synced_time: null,
                is_enabled: 1,
                last_sync_status: "success",
            },
        ];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 不应抛错，且应包含兜底文案
        expect(html).toContain("未知线路");
        expect(html).toContain("N/A");
    });
    it("ipSource.url 非法时安全降级不抛错 (Suggestion ⑧)", () => {
        const ipSources = [
            {
                url: "not a valid url",
                github_path: "ok.txt",
                last_synced_time: "2026-01-01T00:00:00Z",
            },
        ];
        // 旧实现 new URL(s.url).hostname 直接抛 TypeError → 整个公开首页 500
        const html = getPublicHomepage(requestUrl, [], ipSources, "三网聚合", false);
        expect(html).toContain("ok.txt");
    });
});

describe("getDashboardPage 仪表盘转义 (I2)", () => {
    const baseDomain = {
        id: 1,
        source_domain: "src.example.com",
        target_domain: "safe.example.com",
        zone_id: "zone123",
        is_deep_resolve: 0,
        ttl: 60,
        notes: null as string | null,
        last_synced_time: "2026-01-01T00:00:00Z",
        last_sync_status: "success",
        last_sync_error: null as string | null,
        is_enabled: 1,
        is_system: 0,
    };
    const baseSettings = {
        CF_API_TOKEN: "tok",
        CF_ZONE_ID: "zone123",
        GITHUB_TOKEN: "gtok",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        THREE_NETWORK_SOURCE: "wetest.vip",
        zoneName: "example.com",
    };

    it("脚本上下文：notes 含 </script> 不能逃逸 <script> 标签 (I2)", () => {
        const payload = "</script><img src=x onerror=alert(1)>";
        const html = getDashboardPage([{ ...baseDomain, notes: payload }], [], baseSettings);
        // 原始 payload 不得原样出现在 HTML 中（否则 <script> 提前闭合）
        expect(html).not.toContain("</script><img src=x");
        // 所有 < 均以 \u003c 形式进入脚本上下文（解析后仍是原字符，仅阻断标签逃逸）
        expect(html).toContain("\\u003c/script>\\u003cimg");
    });

    it("脚本上下文：ipSources/settings 同样安全化 (I2)", () => {
        const ipSources = [
            {
                id: 1,
                url: "</script><img src=x onerror=alert(1)>",
                github_path: "IP/a.txt",
                commit_message: "m",
                fetch_strategy: "direct_regex",
                last_synced_time: "2026-01-01T00:00:00Z",
                last_sync_status: "success",
                last_sync_error: null as string | null,
                is_enabled: 1,
            },
        ];
        const html = getDashboardPage([], ipSources, { ...baseSettings, GITHUB_OWNER: "</script>x" });
        expect(html).not.toMatch(/<\/script><img src=x/);
    });

    it("设置表单 value 属性转义（属性逃逸不成立）(I2)", () => {
        const quote = '" onfocus="alert(1) autofocus="';
        const html = getDashboardPage([], [], { ...baseSettings, CF_API_TOKEN: quote, GITHUB_OWNER: quote });
        expect(html).not.toContain('" onfocus="alert(1)');
        expect(html).toContain("&quot; onfocus=&quot;alert(1)");
    });

    it("客户端渲染器源码对 DB 字段一律经过 esc()，通知改用 textContent (I2)", () => {
        const html = getDashboardPage([{ ...baseDomain }], [], baseSettings);
        // 客户端 esc 助手存在
        expect(html).toMatch(/function esc\(s\)/);
        // renderStatus 的 title 属性
        expect(html).toMatch(/title="\$\{esc\(item\.last_sync_error/);
        // renderDomainCard：notes / target_domain / source_domain（notes 用 .domain-notes 区别行内标签）
        expect(html).toMatch(/<strong class="domain-notes">\$\{esc\(domain\.notes\)\}<\/strong>/);
        expect(html).toMatch(/title="\$\{esc\(domain\.target_domain\)\}"/);
        expect(html).toMatch(/\$\{esc\(sourceDisplay\)\}/);
        // renderIpSourceCard：url / github_path
        expect(html).toMatch(/\$\{esc\(source\.url\)\}/);
        expect(html).toMatch(/>\$\{esc\(source\.github_path\)\}<\/a>/);
        // renderLiveRecords：record type/content
        expect(html).toMatch(/\$\{esc\(first\.content\)\}/);
        // showNotification 不再走 innerHTML
        expect(html).not.toMatch(/toast\.innerHTML/);
        expect(html).toMatch(/toast\.appendChild\(msg\)/);
    });
});

describe("设置页与流式日志脚本契约 (issue #13)", () => {
    const contractSettings = {
        CF_ZONE_ID: "zone123",
        GITHUB_OWNER: "owner",
        THREE_NETWORK_SOURCE: "wetest.vip",
        zoneName: "example.com",
        CF_CONFIGURED: true,
        GITHUB_CONFIGURED: true,
    };
    const dashboardHtml = () => getDashboardPage([], [], contractSettings);

    it("空 Token 不提交，按钮状态使用非敏感 configured 标志", () => {
        const html = dashboardHtml();
        // Token 输入不回填 Secret；只有用户输入新值才写入 payload。
        expect(html).toContain("if (cfToken) settingsToSave.CF_API_TOKEN = cfToken;");
        expect(html).toContain("if (githubToken) settingsToSave.GITHUB_TOKEN = githubToken;");
        expect(html).not.toContain("settingsToSave.CF_API_TOKEN = currentSettings.CF_API_TOKEN");
        expect(html).not.toContain("settingsToSave.GITHUB_TOKEN = currentSettings.GITHUB_TOKEN");
        // 完整性不能依赖被安全响应剔除的 Token。
        expect(html).toContain('"CF_CONFIGURED":true,"GITHUB_CONFIGURED":true');
        expect(html).not.toContain('id="addDomainBtn" disabled');
        expect(html).not.toContain('id="addIpSourceBtn" disabled');
        expect(html).toContain("currentSettings.GITHUB_CONFIGURED === true");
        expect(html).toContain("currentSettings = newSettings;");
        expect(html).toContain("document.getElementById('cfZoneId').value = currentSettings.CF_ZONE_ID || '';");
        expect(html).toContain("document.getElementById('githubOwner').value = currentSettings.GITHUB_OWNER || '';");
        expect(html).toContain("document.getElementById('githubRepo').value = currentSettings.GITHUB_REPO || '';");
    });

    it("SSE 事件解析使用跨 chunk buffer", () => {
        const html = dashboardHtml();
        expect(html).toContain("const parsed = consumeSseEvents(sseBuffer, decoder.decode(value, { stream: true }));");
        expect(html).toContain("decoder.decode();");
        expect(html).not.toContain("sseBuffer += decoder.decode();");
        expect(html).not.toContain(".split('\\n\\n')");
    });

    it("SSE 跨分块事件不丢失且保留残余字节", () => {
        const first = consumeSseEvents("", "data: 第一");
        expect(first.events).toEqual([]);
        expect(first.buffer).toBe("data: 第一");

        const second = consumeSseEvents(first.buffer, "行\n\ndata: 第二");
        expect(second.events).toEqual(["第一行"]);
        expect(second.buffer).toBe("data: 第二");

        const third = consumeSseEvents(second.buffer, "行\n\n");
        expect(third.events).toEqual(["第二行"]);
        expect(third.buffer).toBe("");
    });

    it("通知调用保持纯文本，不携带 HTML 片段", () => {
        const html = dashboardHtml();
        expect(html).toMatch(/function showNotification\(message, type = 'info', duration = 5000\)/);
        expect(html).not.toMatch(/showNotification\([^\n]*(?:<br\s*\/?>|<code\b|\$\{esc\()/);
    });
});

describe("首页导航按钮中线对齐 (FIX-23)", () => {
    it("共享规则对 a 与 button 一起归零 margin，避免 Pico 的 button 底部外边距把主题按钮顶高", () => {
        // 首页模板只返回主体，CSS 在 getHtmlLayout 里，按 ui.ts 的方式拼装
        const body = getPublicHomepage("https://example.com/", [], [], "三网聚合", true);
        const html = getHtmlLayout("测试", body);
        // 两个同级元素：进入后台是 <a>，主题切换是 <button>，Pico 只给 button 加 margin-bottom
        expect(body).toMatch(/<a href="\/admin"/);
        expect(body).toMatch(/<button id="theme-toggle"/);
        const rule = html.match(/\.public-nav-actions a, \.public-nav-actions button \{([\s\S]*?)\}/);
        expect(rule).not.toBeNull();
        expect(rule![1]).toMatch(/margin:\s*0;/);
    });
});

describe("主题：默认跟随系统，后台也能切换 (FIX-24)", () => {
    const homeBody = () => getPublicHomepage("https://example.com/", [], [], "三网聚合", true);
    // baseSettings 定义在另一个 describe 内，这里自备一份最小设置
    const dashboardSettings = { CF_ZONE_ID: "zone", GITHUB_TOKEN: "t", GITHUB_OWNER: "o", GITHUB_REPO: "r" };

    it("首帧主题脚本在无保存值时才回退到系统偏好，不再硬编码 light", () => {
        const html = getHtmlLayout("测试", "");
        expect(html).toMatch(/prefers-color-scheme: dark/);
        expect(html).toMatch(/localStorage\.getItem\('theme'\)/);
        // 旧实现是 getItem('theme')||'light'，会让"跟随系统"名存实亡
        expect(html).not.toMatch(/getItem\('theme'\)\s*\|\|\s*'light'/);
    });

    it("系统偏好变化时，未显式选择过的用户跟着变", () => {
        const html = getHtmlLayout("测试", "");
        expect(html).toMatch(/addEventListener\('change'/);
    });

    it("主题逻辑只在布局里定义一次，首页模板里不再重复", () => {
        const html = getHtmlLayout("测试", homeBody());
        expect((html.match(/function applyTheme/g) || []).length).toBe(1);
        expect(homeBody()).not.toMatch(/function applyTheme/);
    });

    it("后台页有主题切换按钮，且全站每个页面只有一枚", () => {
        const dashboard = getDashboardPage([], [], dashboardSettings);
        expect(dashboard).toMatch(/id="theme-toggle"/);
        expect((dashboard.match(/id="theme-toggle"/g) || []).length).toBe(1);
        expect((homeBody().match(/id="theme-toggle"/g) || []).length).toBe(1);
    });

    it("侧栏主题按钮归零外边距，避免被 Pico 的 button 底部外边距顶高", () => {
        const html = getHtmlLayout("测试", getDashboardPage([], [], dashboardSettings));
        const rule = html.match(/#theme-toggle \{([\s\S]*?)\}/);
        expect(rule).not.toBeNull();
        expect(rule![1]).toMatch(/margin:\s*0;/);
        expect(html).toMatch(/\.sidebar-header \{[^}]*display: flex;/);
    });
});

describe("布局铺满视口 (FIX-25)", () => {
    // 本用例只校验 CSS 规则形状，不依赖任何配置值，故用空对象即可
    const layoutSource = () => getHtmlLayout("测试", getDashboardPage([], [], {}));

    it("后台内容区不再限宽居中", () => {
        const rule = layoutSource().match(/\.main-content \{([\s\S]*?)\}/);
        expect(rule).not.toBeNull();
        expect(rule![1]).not.toMatch(/max-width/);
        expect(rule![1]).not.toMatch(/margin-inline:\s*auto/);
        expect(rule![1]).toMatch(/flex-grow:\s*1;/);
    });

    it("前台容器与导航保持原有 1200px 限宽并居中，不被后台铺满改动波及", () => {
        const html = layoutSource();
        const container = html.match(/\.public-container \{([\s\S]*?)\}/);
        expect(container).not.toBeNull();
        expect(container![1]).toMatch(/max-width:\s*1200px;/);
        // 居中靠 margin: auto，只锁 max-width 会漏掉"限宽但左对齐"的回归
        expect(container![1]).toMatch(/margin:\s*0 auto;/);
        const nav = html.match(/\.public-nav \{([\s\S]*?)\}/);
        expect(nav).not.toBeNull();
        expect(nav![1]).toMatch(/max-width:\s*1200px;/);
        expect(nav![1]).toMatch(/margin:\s*0 auto 2rem auto;/);
    });
});

describe("设置页铺满 (FIX-26)", () => {
    // 用户决定：设置页与列表页一致铺满，表单保持单列竖排，提交按钮在表单底部居中
    const layoutHtml = () => getHtmlLayout("测试", getDashboardPage([], [], {}));

    it("设置页不再限宽", () => {
        expect(layoutHtml()).not.toMatch(/#page-settings \{[^}]*max-width/);
    });

    it("提交按钮在表单底部居中且不是通栏", () => {
        expect(layoutHtml()).toContain(
            '#settingsForm > button[type="submit"] { display: block; width: fit-content; min-width: 12rem; margin: var(--space-5) auto 0 auto; }'
        );
    });
});

describe("手动同步进度：日志框即唯一进度面 (retro #1)", () => {
    // 用户三轮反馈都落在这两个 <pre> 上：重复进度、贴按钮、圆角压字。
    // 断言只锁契约（走间距刻度、内边距大于圆角），不核对具体像素值。
    const layoutHtml = () => getHtmlLayout("测试", getDashboardPage([], [], {}));
    const syncLogRule = (html: string) => {
        const rule = html.match(/\.sync-log \{([\s\S]*?)\}/);
        expect(rule).not.toBeNull();
        return rule![1];
    };

    it("两页的日志框都挂 .sync-log，并留出上外边距", () => {
        const html = layoutHtml();
        // 域名克隆页与 GitHub 上传页各一处，缺一页就是漏改
        expect(html).toMatch(/<pre id="logOutput" class="sync-log"/);
        expect(html).toMatch(/<pre id="ipLogOutput" class="sync-log"/);
        expect(syncLogRule(html)).toMatch(/margin-top:\s*var\(--space-\d+\)/);
    });

    it("日志框内边距不小于圆角，首行文字不被圆角压住", () => {
        const html = layoutHtml();
        const padding = syncLogRule(html).match(/padding:\s*var\(--(space-\d+)\)/);
        // 裸 px 值会绕过间距刻度，这里要求走令牌
        expect(padding).not.toBeNull();
        // 圆角的真相之源是 --radius-md，别把 10px 抄进断言
        const radius = /--radius-md:\s*(\d+)px/.exec(html);
        expect(radius).not.toBeNull();
        const declared = new RegExp(`--${padding![1]}:\\s*(\\d+)px`).exec(html);
        expect(declared).not.toBeNull();
        // 内边距小于圆角时，首行文字会被圆角切掉
        expect(Number(declared![1])).toBeGreaterThanOrEqual(Number(radius![1]));
    });

    it("按钮不承载进度文案，进度只由日志框呈现", () => {
        const html = layoutHtml();
        // 先确认这段脚本真的在断言范围内，避免负向断言空过
        expect(html).toContain("handleStreamingRequest");
        // 第一轮的 bug 就是按钮写「同步中」+ 日志框再刷一遍进度，出现两个进度面
        expect(html).not.toContain("同步中");
    });
});

describe("CSS 变量无孤儿 (retro #2)", () => {
    const layoutHtml = () => getHtmlLayout("测试", getDashboardPage([], [], {}));

    // --pico-* 是写给 Pico 自己的组件消费的覆盖令牌，我们自己的 var() 不引用它们
    // 属于正常情况，不能当成孤儿。只有自定义命名空间才需要逐个被 var() 消费。
    const isPicoOverride = (name: string) => name.startsWith("--pico-");

    it("所有自定义 CSS 变量都至少被 var() 引用一次", () => {
        const html = layoutHtml();
        const declared = [...html.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
        const orphans = [...new Set(declared)].filter((name) => {
            if (isPicoOverride(name)) return false;
            const re = new RegExp(String.raw`var\(\s*${name}\s*[,)]`);
            return !re.test(html);
        });
        expect(orphans).toEqual([]);
    });
});
