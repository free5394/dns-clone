// dashboard-helpers.js — 仪表盘脚本里的客户端助手（M-1 / L-8）
// 这些函数会被 toString() 序列化后注入浏览器脚本，因此必须自包含：
// 不 import、不引用模块作用域变量，只用参数和字面量。
// 放在独立模块而不是模板字符串里的原因：模板字符串里的代码只能靠字符串断言保护，
// 提出来之后可以直接 import 进来跑行为测试。

/**
 * 「添加克隆目标」按钮是否可用。
 * 只看 Cloudflare 凭证是否配置完整；区域名称（zoneName）只在保存设置时回填，
 * 不能作为按钮可用性的前置条件，否则凭证已配好的全新环境永远点不动。
 * 区域名称缺失由提交路径按需获取并缓存（见 src/routes/api.ts）。
 */
export function canAddDomains(settings) {
    return Boolean(settings && settings.CF_CONFIGURED === true);
}

/**
 * 单条同步的 SSE 流结束后，按日志面板 id 决定要执行的动作序列（issue #22 / #42）。
 * 返回有序数组：先「流结束提示」，再对应列表的刷新动作；未知面板只提示不刷新。
 * 刷新必须排在提示之后：早于落库完成会读到旧数据（issue #22 的原始契约）。
 * 页面侧（templates.js handleStreamingRequest）按序列逐项执行；
 * 抽成纯函数是为了让这条顺序契约由行为测试直接驱动，而不是源码字符串断言。
 */
export function planSyncCompletionActions(logId) {
    const actions = [{ type: "hint", text: "同步完成，正在更新列表。" }];
    if (logId === "logOutput") actions.push({ type: "refresh", target: "domains" });
    if (logId === "ipLogOutput") actions.push({ type: "refresh", target: "ipSources" });
    return actions;
}

/**
 * 客户端 HTML 转义，与服务器端 escapeHtml 同语义。
 * 所有来自数据库、又要在仪表盘里拼 HTML 的字段都必须先过这里。
 */
export function escapeHtmlClient(value) {
    return String(value == null ? "" : value).replace(
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
/**
 * 组装「添加/编辑克隆目标」的提交体（issue #52）。
 * 弹窗同时承载域名与 URL 两种来源，两者的有效字段互斥：
 * - URL 类型：深度解析强制关闭（0），URL / 解析配置按输入归一，解析参数空串归一为 null；
 * - 域名类型：URL 与解析配置一律为 null，深度开关按用户勾选。
 * 抽成纯函数是因为这段组装逻辑会被表单直接调用——按源码字符串断言组不出来「URL 时深度开关
 * 被强制写成 0」这类行为契约（CODING_STANDARDS.md §前端行为测试）。
 */
export function buildDomainSavePayload(input) {
    const isUrl = input.sourceType === "url";
    const parseParam = String(input.parseParam ?? "").trim();
    return {
        source_type: isUrl ? "url" : "domain",
        source_domain: String(input.sourceDomain ?? ""),
        source_url: isUrl ? String(input.sourceUrl ?? "").trim() : null,
        parse_mode: isUrl ? input.parseMode : null,
        parse_param: isUrl && parseParam !== "" ? parseParam : null,
        target_domain_prefix: String(input.targetDomainPrefix ?? "").trim(),
        is_deep_resolve: isUrl ? 0 : input.isDeepResolve ? 1 : 0,
        ttl: parseInt(input.ttl, 10),
        notes: input.notes ?? "",
    };
}

/**
 * 组装「添加/编辑 IP 源」的提交体（issue #57）。
 * 与域名侧 buildDomainSavePayload 同形态：表单输入在这里归一成服务端契约字段。
 * 解析参数空串/纯空白归一为 null，有值去首尾空白；url / github_path / commit_message
 * 等字段原样透传。归一规则只允许存在这一处，保存与探测共用（CODING_STANDARDS.md §前端行为测试）。
 * fetch_strategy 不在提交体内（issue #69）：该列是 URL 的抓取方式缓存，唯一写入方是同步链实测结果，
 * 客户端只读不写，与域名侧契约一致。
 */
export function buildIpSourceSavePayload(input) {
    const parseParam = String(input.parseParam ?? "").trim();
    return {
        url: input.url,
        github_path: input.githubPath,
        commit_message: input.commitMessage,
        parse_mode: input.parseMode,
        parse_param: parseParam === "" ? null : parseParam,
    };
}

/**
 * 探测请求体（issue #57）：从保存体投影出探测端点接受的字段。
 * 投影而不是重写，保证「探测用的解析配置 = 保存下去的解析配置」。
 */
export function buildIpSourceProbePayload(input) {
    const payload = buildIpSourceSavePayload(input);
    return { url: payload.url, parse_mode: payload.parse_mode, parse_param: payload.parse_param };
}
