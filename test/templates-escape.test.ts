// templates-escape.test.ts — P0-2：公开首页存储型 XSS 修复回归测试
// 验证 getPublicHomepage 对用户控制字段（notes/target_domain/github_path/url）做 HTML 实体转义
import { describe, it, expect } from "vitest";
import { getHtmlLayout, getPublicHomepage, getDashboardPage } from "../src/ui/templates.js";

const requestUrl = "https://example.com/";

describe("getPublicHomepage HTML 转义 (P0-2)", () => {
    it("转义 notes 中的 <img onerror> payload", () => {
        const domains = [{
            target_domain: "safe.example.com",
            source_domain: "src.example.com",
            notes: '<img src=x onerror=alert(1)>',
            last_synced_time: "2026-01-01T00:00:00Z",
            is_enabled: 1,
            last_sync_status: "success",
        }];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 未转义的 <img 标签不应出现
        expect(html).not.toMatch(/<img src=x onerror=alert\(1\)>/);
        // 转义后的实体应当出现
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("转义 target_domain 中的属性逃逸 payload", () => {
        const domains = [{
            target_domain: '" onmouseover="alert(1)',
            source_domain: "src.example.com",
            notes: "正常备注",
            last_synced_time: "2026-01-01T00:00:00Z",
            is_enabled: 1,
            last_sync_status: "success",
        }];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 未转义的 onmouseover 属性不应出现
        expect(html).not.toMatch(/onmouseover="alert\(1\)"/);
        // 双引号应被转义为 &quot;
        expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    });

    it("转义 ipSource 的 github_path 中的 HTML payload", () => {
        const ipSources = [{
            url: "https://raw.githubusercontent.com/u/r/main/file.txt",
            github_path: '<script>alert(1)</script>/path.txt',
            last_synced_time: "2026-01-01T00:00:00Z",
        }];
        const html = getPublicHomepage(requestUrl, [], ipSources, "三网聚合", false);
        expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("转义 github_path 中的双引号属性逃逸", () => {
        const ipSources = [{
            url: "https://example.com/raw/file.txt",
            github_path: '" onmouseover="alert(1)/x.txt',
            last_synced_time: "2026-01-01T00:00:00Z",
        }];
        const html = getPublicHomepage(requestUrl, [], ipSources, "三网聚合", false);
        // 未转义的双引号应被替换为 &quot;，属性逃逸不成立
        expect(html).not.toMatch(/onmouseover="alert\(1\)"/);
        expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    });

    it("对 null/undefined 值安全降级为空串", () => {
        const domains = [{
            target_domain: "safe.example.com",
            source_domain: "src.example.com",
            notes: null,
            last_synced_time: null,
            is_enabled: 1,
            last_sync_status: "success",
        }];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 不应抛错，且应包含兜底文案
        expect(html).toContain("未知线路");
        expect(html).toContain("N/A");
    });
    it("ipSource.url 非法时安全降级不抛错 (Suggestion ⑧)", () => {
        const ipSources = [{
            url: "not a valid url",
            github_path: "ok.txt",
            last_synced_time: "2026-01-01T00:00:00Z",
        }];
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
        const payload = '</script><img src=x onerror=alert(1)>';
        const html = getDashboardPage([{ ...baseDomain, notes: payload }], [], baseSettings);
        // 原始 payload 不得原样出现在 HTML 中（否则 <script> 提前闭合）
        expect(html).not.toContain('</script><img src=x');
        // 所有 < 均以 \u003c 形式进入脚本上下文（解析后仍是原字符，仅阻断标签逃逸）
        expect(html).toContain("\\u003c/script>\\u003cimg");
    });

    it("脚本上下文：ipSources/settings 同样安全化 (I2)", () => {
        const ipSources = [{
            id: 1,
            url: '</script><img src=x onerror=alert(1)>',
            github_path: "IP/a.txt",
            commit_message: "m",
            fetch_strategy: "direct_regex",
            last_synced_time: "2026-01-01T00:00:00Z",
            last_sync_status: "success",
            last_sync_error: null as string | null,
            is_enabled: 1,
        }];
        const html = getDashboardPage([], ipSources, { ...baseSettings, GITHUB_OWNER: '</script>x' });
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

    it("首页容器与导航不再限宽", () => {
        const html = layoutSource();
        const container = html.match(/\.public-container \{([\s\S]*?)\}/);
        expect(container).not.toBeNull();
        expect(container![1]).not.toMatch(/max-width/);
        const nav = html.match(/\.public-nav \{([\s\S]*?)\}/);
        expect(nav).not.toBeNull();
        expect(nav![1]).not.toMatch(/max-width/);
    });
});
