// 仪表盘请求封装（M-1）：把 apiFetch 从模板串里提成可注入依赖的工厂函数。
//
// 约束：createApiFetch 的函数体会被 toString() 注入浏览器脚本，
// 因此它必须完全自包含——不 import、不引用模块作用域变量，fetch / 提示 / 跳转全部注入。
export function createApiFetch({ fetchImpl, notify, redirect, schedule }) {
    return async function apiFetch(url, options = {}) {
        const res = await fetchImpl(url, {
            headers: { "Content-Type": "application/json", ...options.headers },
            ...options,
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({ error: `HTTP 错误: ${res.status}` }));
            if (res.status === 401) {
                notify("会话已过期，请重新登录。", "error");
                schedule(() => redirect("/login"), 2000);
            }
            throw new Error(errData.error);
        }
        try {
            return await res.json();
        } catch {
            return {};
        }
    };
}
