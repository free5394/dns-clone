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
