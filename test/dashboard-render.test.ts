// dashboard-render.test.ts — 仪表盘渲染助手的行为断言（M-1）
// 这些函数会被 toString() 注入浏览器脚本，因此必须在模块里可独立调用、不依赖页面作用域。

import { describe, it, expect } from "vitest";
import { createDashboardRenderers } from "../src/ui/dashboard-render.js";
import { escapeHtmlClient, canAddDomains, planSyncCompletionActions } from "../src/ui/dashboard-helpers.js";
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
        // 静态契约（issue #42）：判定逻辑本身已由上方 canAddDomains 行为用例覆盖，
        // 这里只锁「注入点存在 + DOM 接线 + 提示文案」，脱离 DOM 无法转成行为测试。
        expect(html).toContain("const canAddDomains = function canAddDomains");
        expect(html).toContain("document.getElementById('addDomainBtn').disabled = !canAddDomains(currentSettings);");
        // 区域名称缺失时提示会在保存时自动获取，而不是让人先去保存设置
        expect(html).toContain("（保存时自动获取）");
    });
});

// issue #22（P3）：单条同步结束后列表必须自动刷新（无需 F5），且刷新必须排在流结束提示之后。
// issue #42 把这条契约从「源码字符串断言」升级为纯函数行为测试：
// planSyncCompletionActions 与页面注入的是同一份实现（templates.js 用 toString() 注入），
// 用例直接调用它并断言返回的动作序列；删掉函数实现会让下面的用例全部失败（变异自证）。
describe("单条同步结束后自动刷新列表 (issue #22 / #42)", () => {
    it("域名日志先提示流结束，再刷新域名列表", () => {
        expect(planSyncCompletionActions("logOutput")).toEqual([
            { type: "hint", text: "同步完成，正在更新列表。" },
            { type: "refresh", target: "domains" },
        ]);
    });

    it("IP 源日志先提示流结束，再刷新 IP 源列表", () => {
        expect(planSyncCompletionActions("ipLogOutput")).toEqual([
            { type: "hint", text: "同步完成，正在更新列表。" },
            { type: "refresh", target: "ipSources" },
        ]);
    });

    it("其他日志面板只提示流结束，不刷新任何列表", () => {
        expect(planSyncCompletionActions("otherOutput")).toEqual([{ type: "hint", text: "同步完成，正在更新列表。" }]);
    });

    it("页面注入该判定函数并按序列执行（冒烟）", () => {
        const html = getDashboardPage([], [], {
            CF_CONFIGURED: true,
            GITHUB_CONFIGURED: true,
            zoneName: ZONE,
        });
        // 静态契约（issue #42）：只锁「注入点存在 + 同步段按动作序列执行」两处接线，
        // 刷新顺序行为已由上方 planSyncCompletionActions 用例覆盖；脱离 DOM 无法转成行为测试。
        expect(html).toContain("const planSyncCompletionActions = function planSyncCompletionActions");
        expect(html).toContain("for (const action of planSyncCompletionActions(");
    });
});

// issue #49：设置页必须能改单类型记录上限，并在保存后回填服务端归一的返回值。
describe("单类型记录上限设置项 (issue #49)", () => {
    it("缺失或损坏时渲染默认 20，有值时渲染该值", () => {
        expect(getDashboardPage([], [], {})).toMatch(/id="maxIpsPerType"[^>]*value="20"/);
        expect(getDashboardPage([], [], { MAX_IPS_PER_TYPE: "oops" })).toMatch(/id="maxIpsPerType"[^>]*value="20"/);
        expect(getDashboardPage([], [], { MAX_IPS_PER_TYPE: 200 })).toMatch(/id="maxIpsPerType"[^>]*value="200"/);
        expect(getDashboardPage([], [], { MAX_IPS_PER_TYPE: 30 })).toMatch(/id="maxIpsPerType"[^>]*value="30"/);
    });

    it("输入框受 1-200 约束，避免提交必然被拒的值", () => {
        const html = getDashboardPage([], [], {});
        expect(html).toMatch(/id="maxIpsPerType"[^>]*min="1"[^>]*max="200"/);
    });

    it("表单保存该字段，并在保存后按服务端返回值回填", () => {
        const html = getDashboardPage([], [], {});
        // 静态契约（issue #49）：只锁「读输入并入保存体 / 保存后回填」两处 DOM 接线，
        // 脱离 DOM（getElementById）无法转成行为测试，与 issue #42 的豁免条件一致。
        expect(html).toContain(
            "settingsToSave.MAX_IPS_PER_TYPE = document.getElementById('maxIpsPerType').value.trim();"
        );
        expect(html).toContain("document.getElementById('maxIpsPerType').value = currentSettings.MAX_IPS_PER_TYPE;");
    });
});
