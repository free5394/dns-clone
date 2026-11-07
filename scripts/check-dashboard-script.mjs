// 仪表盘客户端脚本的语法闸门：Node 侧解析一次注入后的 <script>，确认浏览器拿到的是合法 JS。
//
// 为什么不在 CI / vitest 里跑：workerd 禁止 eval 与 new Function，vitest-pool-workers 里无法求值；
// 而这段脚本是由 src/ui/templates.js 用模板字符串拼出来的，只有真正渲染一次页面才能拿到成品。
// 因此定位是"改模板后手动跑一次"的检查，不接入 pnpm check（避免 CI 里出现一个 Node 与 workerd
// 行为不一致的门禁）。
//
// 用法：node scripts/check-dashboard-script.mjs
import { getDashboardPage } from "../src/ui/templates.js";

const domains = [
    {
        id: 1,
        source_domain: "a.example.com",
        target_domain: "a.example.com",
        zone_id: "zone",
        is_deep_resolve: 0,
        ttl: 1,
        notes: "备注",
        last_synced_records: 2,
        last_synced_time: null,
        last_sync_status: "success",
        last_sync_error: null,
        is_enabled: 1,
        is_system: 0,
    },
];

const ipSources = [
    {
        id: 1,
        url: "https://example.com/ip.txt",
        github_path: "ip/list.txt",
        commit_message: "同步",
        fetch_strategy: "direct_regex",
        last_synced_time: null,
        last_sync_status: "",
        last_sync_error: null,
        is_enabled: 1,
    },
];

const settings = {
    BATCH_SIZE: "50",
    CF_ZONE_NAME: "example.com",
    THREE_NETWORK_SOURCE: "https://example.com/three.txt",
};

const html = getDashboardPage(domains, ipSources, settings);
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
if (scripts.length === 0) {
    console.error("未找到内联脚本：模板结构可能已变，请更新本脚本的提取规则。");
    process.exit(1);
}

let total = 0;
scripts.forEach((code, index) => {
    total += code.length;
    try {
        // 只解析不执行：new Function 在这里仅用于语法校验
        const probe = new Function(code);
        void probe;
    } catch (e) {
        console.error(`第 ${index + 1} 段内联脚本语法错误：${e instanceof Error ? e.message : e}`);
        process.exit(1);
    }
});

console.log(`内联脚本 ${scripts.length} 段，共 ${total} 字符，语法解析通过。`);
console.log(`页面长度 ${html.length} 字符；包含批量记录端点：${html.includes("/api/domains/records")}`);
