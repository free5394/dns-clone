// http.ts — HTTP 响应与请求体工具
// 从 index.legacy.js 提取（原 1847 行）

/** 统一 JSON 响应（格式化 2 空格缩进） */
export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...headers }
    });
}

/** 统一 JSON 错误响应 */
export function jsonError(message: string, status = 400, details?: unknown): Response {
    const body: Record<string, unknown> = { error: message };
    if (details !== undefined) body.details = details;
    return jsonResponse(body, status);
}

/** 从 Cookie 头中按 key 提取 value（找不到返回 null） */
export function getCookie(request: Request, name: string): string | null {
    const header = request.headers.get('Cookie');
    if (!header) return null;
    for (const raw of header.split(';')) {
        const [key, value] = raw.trim().split('=');
        if (key === name) return value ?? null;
    }
    return null;
}
