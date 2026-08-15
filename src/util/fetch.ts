// fetch.ts — 带超时/重试/安全解析的 fetch 封装
// 隐含修正 B4 的载体：引入 AbortController 超时，杜绝外部抓取无界等待
// 阶段 C 新建；阶段 D 起 sync 层全面使用

import { HttpError } from './http-error.ts';

/**
 * 带超时的 fetch（默认 10s）
 * @param url 请求地址
 * @param init fetch init 选项
 * @param timeoutMs 超时毫秒数
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 带超时 + 指数退避重试的 fetch
 *
 * 非 2xx 抛 HttpError（携带 status），调用方可据此分支处理（如 404 走"资源不存在"路径）。
 * 4xx 属于客户端错误，重试无意义，立即抛出；仅 408/429 与 5xx/网络错误才重试。
 *
 * @param url 请求地址
 * @param init fetch init 选项
 * @param retries 最大重试次数（默认 2）
 * @param timeoutMs 每次尝试的超时毫秒数
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}, retries = 2, timeoutMs = 10000): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetchWithTimeout(url, init, timeoutMs);
            if (response.ok) return response;
            const httpError = new HttpError(response.status, `HTTP ${response.status}: ${url}`);
            // 4xx（除 408 超时 / 429 限流）重试不会改变结果，直接抛出
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                throw httpError;
            }
            lastError = httpError;
        } catch (e) {
            if (e instanceof HttpError) throw e;
            lastError = e instanceof Error ? e : new Error(String(e));
        }
        if (attempt < retries) {
            // 指数退避：1s → 2s
            await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        }
    }
    throw lastError;
}

/**
 * 安全解析 JSON 响应（非 2xx 抛错）
 * @param url 请求地址
 * @param init fetch init 选项
 */
export async function safeJson(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<unknown> {
    const response = await fetchWithTimeout(url, init, timeoutMs);
    if (!response.ok) {
        throw new Error(`请求失败: HTTP ${response.status} (${url})`);
    }
    return await response.json();
}
