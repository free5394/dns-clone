// dashboard-helpers.js — 仪表盘脚本里的客户端助手（M-1 / L-8）
// 这些函数会被 toString() 序列化后注入浏览器脚本，因此必须自包含：
// 不 import、不引用模块作用域变量，只用参数和字面量。
// 放在独立模块而不是模板字符串里的原因：模板字符串里的代码只能靠字符串断言保护，
// 提出来之后可以直接 import 进来跑行为测试。

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
