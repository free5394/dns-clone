// dashboard-render.test.ts — 仪表盘渲染助手的行为断言（M-1）
// 这些函数会被 toString() 注入浏览器脚本，因此必须在模块里可独立调用、不依赖页面作用域。

import { describe, it, expect } from "vitest";
import { createDashboardRenderers } from "../src/ui/dashboard-render.js";
import {
    escapeHtmlClient,
    canAddDomains,
    planSyncCompletionActions,
    buildDomainSavePayload,
    buildIpSourceSavePayload,
    buildIpSourceProbePayload,
} from "../src/ui/dashboard-helpers.js";
import { getDashboardPage } from "../src/ui/templates.js";
import { DEFAULT_MAX_IPS_PER_TYPE, MAX_MAX_IPS_PER_TYPE, MIN_MAX_IPS_PER_TYPE } from "../src/util/max-ips-per-type.ts";

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

    // issue #50：卡片展示解析模式；未知值（含存量 NULL）按自动处理，原始值不进 HTML
    it("IP 源卡片展示解析模式中文标签", () => {
        const { renderIpSourceCard } = makeRenderers();

        expect(renderIpSourceCard(ipSource())).toContain("解析: 自动");
        expect(renderIpSourceCard(ipSource({ parse_mode: "json_path" }))).toContain("解析: JSON 路径");
        expect(renderIpSourceCard(ipSource({ parse_mode: "custom_regex" }))).toContain("解析: 自定义正则");
        expect(renderIpSourceCard(ipSource({ parse_mode: null }))).toContain("解析: 自动");
    });

    it("IP 源卡片的未知解析模式回落自动且不注入 HTML", () => {
        const { renderIpSourceCard } = makeRenderers();
        const html = renderIpSourceCard(ipSource({ parse_mode: '"><img src=x onerror="alert(1)">' }));

        expect(html).toContain("解析: 自动");
        expect(html).not.toContain("<img");
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
    // 期望值取自同一处常量（src/util/max-ips-per-type.ts），避免测试与实现各存一份真相
    const inputTagWith = (value: number) =>
        new RegExp(
            `id="maxIpsPerType"[^>]*min="${MIN_MAX_IPS_PER_TYPE}"[^>]*max="${MAX_MAX_IPS_PER_TYPE}"[^>]*value="${value}"`
        );

    it("缺失或损坏时渲染默认上限，有值时渲染该值", () => {
        expect(getDashboardPage([], [], {})).toMatch(inputTagWith(DEFAULT_MAX_IPS_PER_TYPE));
        expect(getDashboardPage([], [], { MAX_IPS_PER_TYPE: "oops" })).toMatch(inputTagWith(DEFAULT_MAX_IPS_PER_TYPE));
        expect(getDashboardPage([], [], { MAX_IPS_PER_TYPE: MAX_MAX_IPS_PER_TYPE })).toMatch(
            inputTagWith(MAX_MAX_IPS_PER_TYPE)
        );
        expect(getDashboardPage([], [], { MAX_IPS_PER_TYPE: 30 })).toMatch(inputTagWith(30));
    });

    it("输入框受范围约束，避免提交必然被拒的值", () => {
        const html = getDashboardPage([], [], {});
        expect(html).toMatch(
            new RegExp(`id="maxIpsPerType"[^>]*min="${MIN_MAX_IPS_PER_TYPE}"[^>]*max="${MAX_MAX_IPS_PER_TYPE}"`)
        );
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

// issue #50：IP 源弹窗必须能配置解析模式与参数，编辑回填与保存/探测共用同一份字段。
describe("IP 源解析配置弹窗 (issue #50)", () => {
    it("弹窗包含解析模式与参数控件", () => {
        const html = getDashboardPage([], [], {});

        expect(html).toContain('id="parse_mode"');
        expect(html).toContain('id="parse_param"');
        for (const mode of ["auto", "lines", "json_path", "custom_regex"]) {
            expect(html).toContain(`<option value="${mode}">`);
        }
        expect(html).toContain('id="parse_param" maxlength="512"');
    });

    it("编辑回填、保存与探测都带上解析配置", () => {
        const html = getDashboardPage([], [], {});
        // 静态契约（issue #50 / #57）：DOM 接线只能在页面脚本里锁；保存与探测的归一行为
        // 已下沉到 buildIpSourceSavePayload / buildIpSourceProbePayload，由下方行为用例直接驱动。
        expect(html).toContain("document.getElementById('parse_mode').value = source.parse_mode || 'auto';");
        expect(html).toContain("const buildIpSourceSavePayload = function buildIpSourceSavePayload(input) {");
        expect(html).toContain("const buildIpSourceProbePayload = function buildIpSourceProbePayload(input) {");
        expect(html).toContain("const payload = buildIpSourceSavePayload({");
        expect(html).toContain("const probePayload = buildIpSourceProbePayload({");
    });

    // issue #68：策略是 URL 的抓取方式缓存，URL 变更后会被清空；不弹窗，只给一行静态说明。
    // 静态契约（issue #42）：可见文案脱离 DOM 无法驱动，只能锁注入点存在。
    it("编辑弹窗说明抓取策略会随 URL 变更重置", () => {
        const html = getDashboardPage([], [], {});

        expect(html).toContain("抓取策略是 URL 的抓取方式缓存");
        expect(html).toContain("会随 URL 变更重置");
        // 不弹窗、不打断保存：说明是静态文本，不引入 confirm/alert 接线
        expect(html).not.toContain("confirm('修改 URL 会重置");
    });
});

// issue #52：URL 类型域名的卡片展示与弹窗接线。
describe("URL 类型域名 (issue #52)", () => {
    it("URL 来源展示完整 URL 与解析模式标签，而不是 hostname", () => {
        const { renderDomainCard } = makeRenderers();
        const html = renderDomainCard(
            domain({
                source_domain: "ips.example.com",
                source_type: "url",
                source_url: "https://ips.example.com/list.json?v=1",
                parse_mode: "json_path",
            })
        );

        expect(html).toContain("https://ips.example.com/list.json?v=1");
        expect(html).toContain("解析: JSON 路径");
    });

    it("URL 与解析配置做 HTML 逃逸，不注入标签", () => {
        const { renderDomainCard } = makeRenderers();
        const html = renderDomainCard(
            domain({
                source_type: "url",
                source_url: 'https://evil.test/"><script>alert(1)</script>',
                parse_mode: "lines",
            })
        );

        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });

    it("未知解析模式与存量 NULL 一律显示「自动」", () => {
        const { renderDomainCard } = makeRenderers();

        expect(
            renderDomainCard(domain({ source_type: "url", source_url: "https://a.test/x", parse_mode: null }))
        ).toContain("解析: 自动");
        expect(
            renderDomainCard(domain({ source_type: "url", source_url: "https://a.test/x", parse_mode: "unknown_mode" }))
        ).toContain("解析: 自动");
    });

    it("域名类型不渲染解析模式提示，系统内置优先于 URL 字段", () => {
        const { renderDomainCard } = makeRenderers();

        expect(renderDomainCard(domain({ source_type: "domain", source_domain: "src.test" }))).not.toContain("解析:");
        const systemHtml = renderDomainCard(
            domain({ is_system: 1, source_type: "url", source_url: "https://should-not-show.test/x" })
        );
        expect(systemHtml).toContain("系统内置");
        expect(systemHtml).not.toContain("should-not-show.test");
    });

    it("弹窗包含 IP 输入类型切换与 URL 解析配置控件", () => {
        const html = getDashboardPage([], [], {});

        expect(html).toContain('id="source_type"');
        expect(html).toContain('<option value="domain">域名</option>');
        expect(html).toContain('<option value="url">URL</option>');
        expect(html).toContain('id="source_url"');
        expect(html).toContain('maxlength="2048"');
        expect(html).toContain('id="domain_parse_mode"');
        expect(html).toContain('id="domain_parse_param" maxlength="512"');
    });

    it("来源切换会互斥显示域名/URL 输入并锁定深度开关", () => {
        const html = getDashboardPage([], [], {});
        // 静态契约（issue #52）：DOM 接线只能在页面脚本里锁——选择器存在性与元素显隐联动
        // 脱离 DOM 无法驱动，符合 CODING_STANDARDS.md §豁免条件；深度开关的取值契约由下方
        // buildDomainSavePayload 行为用例覆盖。
        expect(html).toContain("window.setDomainSourceType = (type) =>");
        expect(html).toContain("document.getElementById('domainSourceDomainGroup').hidden = isUrl;");
        expect(html).toContain("document.getElementById('domainSourceUrlGroup').hidden = !isUrl;");
        expect(html).toContain("deepSwitch.disabled = isUrl;");
    });

    it("编辑回填 URL 字段，保存体由行为用例覆盖", () => {
        const html = getDashboardPage([], [], {});
        // 静态契约（issue #52）：回填是纯 DOM 读值/写值，脱离 DOM 无法驱动；
        // 保存体组装已抽成 buildDomainSavePayload，由下方行为用例直接驱动。
        expect(html).toContain("window.setDomainSourceType(domain.source_type === 'url' ? 'url' : 'domain');");
        expect(html).toContain("document.getElementById('source_url').value = domain.source_url || '';");
        expect(html).toContain("document.getElementById('domain_parse_mode').value = domain.parse_mode || 'auto';");
        expect(html).toContain("document.getElementById('domain_parse_param').value = domain.parse_param || '';");
        // 保存体组装已抽成 buildDomainSavePayload 并注入页面脚本，这里只锁注入接线存在
        expect(html).toContain("const buildDomainSavePayload = function buildDomainSavePayload(input) {");
    });
});

// issue #52：保存体组装抽成纯函数后直接驱动行为，而不是断言页面脚本里的字符串。
describe("域名保存体组装 (issue #52)", () => {
    const base = {
        sourceDomain: "src.test",
        sourceUrl: "  https://ips.example.com/list.txt  ",
        parseMode: "json_path",
        parseParam: " data.list ",
        targetDomainPrefix: " sub ",
        isDeepResolve: true,
        ttl: "300",
        notes: "备注",
    };

    it("URL 类型：深度解析强制为 0，URL 与解析配置按输入归一", () => {
        const payload = buildDomainSavePayload({ ...base, sourceType: "url" });

        expect(payload).toEqual({
            source_type: "url",
            source_domain: "src.test",
            source_url: "https://ips.example.com/list.txt",
            parse_mode: "json_path",
            parse_param: "data.list",
            target_domain_prefix: "sub",
            is_deep_resolve: 0,
            ttl: 300,
            notes: "备注",
        });
    });

    it("URL 类型空解析参数归一为 null，不落空串", () => {
        const payload = buildDomainSavePayload({ ...base, sourceType: "url", parseParam: "   " });

        expect(payload.parse_param).toBeNull();
    });

    it("域名类型：URL 与解析配置一律为 null，深度开关按勾选提交", () => {
        const on = buildDomainSavePayload({ ...base, sourceType: "domain" });
        const off = buildDomainSavePayload({ ...base, sourceType: "domain", isDeepResolve: false });

        expect(on.source_url).toBeNull();
        expect(on.parse_mode).toBeNull();
        expect(on.parse_param).toBeNull();
        expect(on.is_deep_resolve).toBe(1);
        expect(off.is_deep_resolve).toBe(0);
    });

    it("从 URL 切回域名时不会沿用被锁死的深度关闭", () => {
        // 弹窗在 URL 模式下把深度开关置灰关闭，切回域名后开关恢复可用且默认开启；
        // 这里锁定「未勾选」才提交 0，避免切换后被静默保存成深度关闭的目标。
        const payload = buildDomainSavePayload({ ...base, sourceType: "domain", isDeepResolve: false });

        expect(payload.source_type).toBe("domain");
        expect(payload.is_deep_resolve).toBe(0);
        expect(buildDomainSavePayload({ ...base, sourceType: "domain", isDeepResolve: true }).is_deep_resolve).toBe(1);
    });
});

// issue #57：IP 源保存与探测的提交体必须由同一份纯函数产出，
// 避免「探测用的配置 ≠ 保存下去的配置」漂移。
describe("IP 源提交体组装与探测同源 (issue #57)", () => {
    const base = {
        url: "https://ips.example.com/list.txt",
        githubPath: "IP/Cloudflare.txt",
        commitMessage: "Update Cloudflare IPs",
        parseMode: "json_path",
        parseParam: " data.list ",
    };

    it("保存体：解析参数 trim 后提交，其余字段原样透传", () => {
        const payload = buildIpSourceSavePayload(base);

        expect(payload).toEqual({
            url: "https://ips.example.com/list.txt",
            github_path: "IP/Cloudflare.txt",
            commit_message: "Update Cloudflare IPs",
            parse_mode: "json_path",
            parse_param: "data.list",
        });
    });

    it("空串与纯空白解析参数一律归一为 null，不落空串", () => {
        for (const raw of ["", "   "]) {
            expect(buildIpSourceSavePayload({ ...base, parseParam: raw }).parse_param).toBeNull();
        }
    });

    // issue #69：fetch_strategy 是 URL 的抓取方式缓存，唯一写入方是同步链实测结果，
    // 客户端只读不写 —— 保存体里带不带、带什么都不该出现在提交结果里。
    it("保存体不含 fetch_strategy，即便输入里带着探测结果", () => {
        const payload = buildIpSourceSavePayload({ ...base, fetchStrategy: "direct" });

        expect("fetch_strategy" in payload).toBe(false);
        expect(buildIpSourceSavePayload({ ...base, fetchStrategy: null })).not.toHaveProperty("fetch_strategy");
    });

    it("探测体从保存体投影，两条路径的解析参数同源一致", () => {
        for (const raw of ["", "   ", "  data.list  ", base.parseParam]) {
            const save = buildIpSourceSavePayload({ ...base, parseParam: raw });
            const probe = buildIpSourceProbePayload({ ...base, parseParam: raw });

            // 同源断言：探测只取自己需要的三个字段，值必须与保存体逐项相同，而不是各写一遍归一断言
            expect(probe).toEqual({
                url: save.url,
                parse_mode: save.parse_mode,
                parse_param: save.parse_param,
            });
        }
    });
});
