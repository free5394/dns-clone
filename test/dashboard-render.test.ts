// dashboard-render.test.ts — 仪表盘渲染助手的行为断言（M-1）
// 这些函数会被 toString() 注入浏览器脚本，因此必须在模块里可独立调用、不依赖页面作用域。

import { describe, it, expect } from "vitest";
import { createDashboardRenderers } from "../src/ui/dashboard-render.js";
import { escapeHtmlClient, canAddDomains } from "../src/ui/dashboard-helpers.js";
import { getDashboardPage } from "../src/ui/templates.js";

const ZONE = "example.com";
const ORIGIN = "https://dash.test";

function makeRenderers(zoneName: string = ZONE) {
    return createDashboardRenderers({
        escapeHtml: escapeHtmlClient,
        getZoneName: () => zoneName,
        formatBeijingTime: (iso?: string | null) => (iso ? `时间:${iso}` : "从未"),
        origin: ORIGIN,
    });
}

function domain(overrides: Record<string, unknown> = {}) {
    return {
        id: 7,
        source_domain: "src.test",
        target_domain: "a.example.com",
        notes: "",
        is_system: 0,
        last_sync_status: "success",
        last_sync_error: null,
        last_synced_time: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

function ipSource(overrides: Record<string, unknown> = {}) {
    return {
        id: 3,
        github_path: "ip/list.txt",
        url: "https://source.test/raw.txt",
        fetch_strategy: "direct_regex",
        last_sync_status: "no_change",
        last_sync_error: null,
        last_synced_time: null,
        ...overrides,
    };
}

describe("仪表盘渲染助手 (M-1)", () => {
    it("renderStatus 覆盖四种状态，失败原因作为 title 逃逸", () => {
        const { renderStatus } = makeRenderers();

        expect(renderStatus({ last_sync_status: "success" })).toContain("同步成功");
        expect(renderStatus({ last_sync_status: "no_change" })).toContain("内容一致");
        expect(renderStatus({ last_sync_status: "pending" })).toContain("待定");

        const failed = renderStatus({ last_sync_status: "failed", last_sync_error: '<img src=x onerror="alert(1)">' });
        expect(failed).toContain("同步失败");
        expect(failed).not.toContain("<img");
        expect(failed).toContain("&lt;img");
    });

    it("renderDomainCard 按 zone 裁剪显示前缀，zone 自身显示为 @", () => {
        const { renderDomainCard } = makeRenderers();

        expect(renderDomainCard(domain())).toContain(">a<");
        expect(renderDomainCard(domain({ target_domain: "example.com" }))).toContain(">@<");
        // 不在 zone 下的域名保留全名
        expect(renderDomainCard(domain({ target_domain: "other.test" }))).toContain(">other.test<");
    });

    it("renderDomainCard 保留卡片 id、记录占位与操作按钮绑定", () => {
        const { renderDomainCard } = makeRenderers();
        const html = renderDomainCard(domain());

        expect(html).toContain('id="domain-card-7"');
        expect(html).toContain('class="records-placeholder" data-domain-id="7"');
        expect(html).toContain("window.individualSync(7)");
        expect(html).toContain("window.openModal('domainModal', 7)");
        expect(html).toContain("时间:2026-01-01T00:00:00Z");
        expect(html).toContain("src.test");
    });

    it("renderDomainCard 对备注与域名做 HTML 逃逸，备注优先于域名展示", () => {
        const { renderDomainCard } = makeRenderers();
        const html = renderDomainCard(domain({ notes: '<b>"note"</b>', target_domain: 'a"><script>x</script>' }));

        expect(html).toContain('<strong class="domain-notes">&lt;b&gt;&quot;note&quot;&lt;/b&gt;</strong>');
        expect(html).not.toContain("<script>");
        // 即使展示被备注替换，title 里的原始域名也必须逃逸
        expect(html).toContain('title="a&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    });

    it("系统内置域名带 system-domain 样式且编辑删除被禁用", () => {
        const { renderDomainCard } = makeRenderers();
        const html = renderDomainCard(domain({ is_system: 1 }));

        expect(html).toContain("system-domain");
        expect(html).toContain("系统内置");
        expect(html.match(/disabled/g)?.length).toBe(2);
    });

    it("renderIpSourceCard 的链接用编码路径，文本用逃逸值", () => {
        const { renderIpSourceCard } = makeRenderers();
        const html = renderIpSourceCard(ipSource({ github_path: 'a"><img src=x>.txt' }));

        expect(html).toContain(`href="${ORIGIN}/${encodeURIComponent('a"><img src=x>.txt')}"`);
        expect(html).toContain("&quot;&gt;&lt;img");
        expect(html).not.toContain("<img");
        expect(html).toContain('id="ip-source-card-3"');
    });

    it("IP 源缺少抓取策略时显示占位文案", () => {
        const { renderIpSourceCard } = makeRenderers();

        expect(renderIpSourceCard(ipSource({ fetch_strategy: "" }))).toContain("尚未探测");
        expect(renderIpSourceCard(ipSource({ last_synced_time: null }))).toContain("从未");
    });

    it("renderLiveRecords 空、单条、多条三种形态", () => {
        const { renderLiveRecords } = makeRenderers();

        expect(renderLiveRecords([])).toBe("无记录");
        expect(renderLiveRecords([{ type: "A", content: "1.1.1.1" }])).toContain("<b>A:</b> 1.1.1.1");

        const many = renderLiveRecords([
            { type: "A", content: "1.1.1.1" },
            { type: "A", content: "2.2.2.2" },
        ]);
        expect(many).toContain("共 2 条");
        expect(many).toContain("<li><b>A:</b> 2.2.2.2</li>");
        expect(renderLiveRecords([{ type: "<x>", content: "<y>" }])).not.toContain("<x>");
    });
});

describe("添加克隆目标按钮可用性 (issue #21)", () => {
    it("CF 凭证已配置、区域名称为空时仍允许添加", () => {
        // zoneName 只在保存设置时回填；按钮是否可点不能再依赖它。
        expect(canAddDomains({ CF_CONFIGURED: true, zoneName: "" })).toBe(true);
        expect(canAddDomains({ CF_CONFIGURED: true })).toBe(true);
    });

    it("CF 未配置时禁用", () => {
        expect(canAddDomains({ CF_CONFIGURED: false, zoneName: "example.com" })).toBe(false);
        expect(canAddDomains({})).toBe(false);
        expect(canAddDomains(null)).toBe(false);
    });

    it("服务端渲染与保存设置后的客户端刷新共用同一判定", () => {
        const html = getDashboardPage([], [], { CF_CONFIGURED: true, zoneName: "" });

        expect(html).not.toContain('id="addDomainBtn" disabled');
        // 判定函数随脚本注入，保存设置后刷新按钮状态时调用同一份实现
        expect(html).toContain("const canAddDomains = function canAddDomains");
        expect(html).toContain("document.getElementById('addDomainBtn').disabled = !canAddDomains(currentSettings);");
        // 区域名称缺失时提示会在保存时自动获取，而不是让人先去保存设置
        expect(html).toContain("（保存时自动获取）");
    });
});

// issue #22（P3）：单条同步结束后列表必须自动刷新（无需 F5）。
// 本地与浏览器实测均未复现"不刷新"，但这段顺序是行为契约，锁住防回归。
// 断言必须切进流式函数体内：saveSettings 里也有 await refreshDomains()，
// 全文 indexOf 会命中那一处，删掉流结束后的刷新照样绿（评审变异实验已证）。
describe("单条同步结束后自动刷新列表 (issue #22)", () => {
    it("SSE 流结束后先提示再刷新域名与 IP 源列表", () => {
        const html = getDashboardPage([], [], {
            CF_CONFIGURED: true,
            GITHUB_CONFIGURED: true,
            zoneName: ZONE,
        });

        // 结束锚点用带赋值的写法：裸 "window.individualSync" 在页面更早处也出现过，
        // 用它做 end 会得到空切片，断言等于没写
        const body = html.slice(
            html.indexOf("async function handleStreamingRequest"),
            html.indexOf("window.individualSync = (id)")
        );
        expect(body.length).toBeGreaterThan(0);

        const hint = body.indexOf("同步完成，正在更新列表。");
        expect(hint).toBeGreaterThan(-1);

        // 两处刷新都必须排在"流结束"提示之后：早于落库刷新会读到旧数据
        const domainRefresh = body.indexOf("await refreshDomains();", hint);
        const ipRefresh = body.indexOf("await refreshIpSources();", hint);
        expect(domainRefresh).toBeGreaterThan(hint);
        expect(ipRefresh).toBeGreaterThan(hint);
    });
});
