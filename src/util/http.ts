// http.ts — HTTP 响应与请求体工具
// 从 index.legacy.js 提取（原 1847 行）

/** 统一 JSON 响应（格式化 2 空格缩进） */
export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...headers }
    });
}

/** 从 Cookie 头中按 key 提取 value（找不到返回 null；值按首个 = 之后整体保留，Suggestion ⑦） */
export function getCookie(request: Request, name: string): string | null {
    const header = request.headers.get('Cookie');
    if (!header) return null;
    for (const raw of header.split(';')) {
        const eq = raw.indexOf('=');
        if (eq < 0) continue;
        if (raw.slice(0, eq).trim() === name) return raw.slice(eq + 1).trim() || null;
    }
    return null;
}
