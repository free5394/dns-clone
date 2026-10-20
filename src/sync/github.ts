// github.ts — GitHub API 封装（仓库检查 / 内容读取 / 文件更新 / 订阅器读）
// 从 index.legacy.js 提取（原 1237-1310 行）
// C4：全仓对 GitHub 的访问只走 githubApiRequest 一个出口（认证、User-Agent、Accept、超时、重试）

import { fetchWithRetry } from '../util/fetch.ts';
import { HttpError } from '../util/http-error.ts';

/** 订阅器读的边缘缓存命名空间：合成键，不暴露真实请求 URL，也不与上游 URL 互相污染 */
const SUBSCRIBER_CACHE_NAMESPACE = 'https://github-proxy.cache';

/** 订阅器读的缓存响应头（TTL 归属本模块：5 分钟边缘缓存） */
const SUBSCRIBER_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';

/** 上游非 2xx 时给订阅器的固定文案：不透传上游 JSON 错误体 */
const SUBSCRIBER_FETCH_ERROR = '无法获取对应文件，请稍后重试。';

/** 延迟写回调（路由传入 ExecutionContext.waitUntil）；缺省不等待、但吞掉写失败 */
type WaitUntil = (promise: Promise<unknown>) => void;

/** GitHub API 请求统一封装（非 2xx 由 fetchWithRetry 抛出 HttpError） */
async function githubApiRequest(url: string, token: string, options: RequestInit = {}): Promise<Response> {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'DNS-Clone-Worker',
        'Accept': 'application/vnd.github.v3+json',
        ...(options.headers as Record<string, string> | undefined),
    };
    return await fetchWithRetry(url, { ...options, headers }, 1, 15000);
}

/** 确保仓库存在，不存在则创建私有仓库 */
export async function ensureRepoExists(token: string, owner: string, repo: string, log: (msg: string) => void): Promise<void> {
    const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
    try {
        await githubApiRequest(repoUrl, token);
        log(`仓库 '${owner}/${repo}' 已存在。`);
    } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
            log(`仓库 '${owner}/${repo}' 不存在，正在尝试创建...`);
            const createUrl = `https://api.github.com/user/repos`;
            const body = JSON.stringify({
                name: repo,
                private: true,
                description: 'Auto-generated repository for IP source files by DNS Clone Worker.'
            });
            await githubApiRequest(createUrl, token, { method: 'POST', body });
            log(`✔ 成功创建私有仓库 '${owner}/${repo}'。`);
        } else {
            throw e;
        }
    }
}

/** 获取 GitHub 文件当前内容；404 返回 null（表示需创建） */
export async function getCurrentGitHubContent({ token, owner, repo, path, log }: {
    token: string;
    owner: string;
    repo: string;
    path: string;
    log: (msg: string) => void;
}): Promise<string | null> {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    try {
        const response = await githubApiRequest(apiUrl, token, {
            headers: { 'Accept': 'application/vnd.github.v3.raw' }
        });
        return await response.text();
    } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
            log(`GitHub文件 '${path}' 不存在，将创建新文件。`);
            return null;
        }
        throw e;
    }
}

/**
 * 大内容分块 base64 编码（UTF-8 安全）。
 * 一次性 String.fromCharCode(...bytes) 的实参数有栈上限（约 65k），
 * IP 聚合文件达数万字节时会抛 RangeError，必须分块拼接。
 */
function encodeBase64Utf8(content: string): string {
    const bytes = new TextEncoder().encode(content);
    let binary = '';
    const CHUNK_SIZE = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
}

/** 更新/创建 GitHub 文件（内容 base64 编码，UTF-8 安全） */
export async function updateFileOnGitHub({ token, owner, repo, path, content, message, log }: {
    token: string;
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    log: (msg: string) => void;
}): Promise<void> {
    await ensureRepoExists(token, owner, repo, log);

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    let sha: string | undefined;
    try {
        const getFileResponse = await githubApiRequest(apiUrl, token);
        const fileData = await getFileResponse.json() as { sha: string };
        sha = fileData.sha;
    } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
    }

    const body = JSON.stringify({
        message,
        content: encodeBase64Utf8(content),
        sha
    });

    await githubApiRequest(apiUrl, token, { method: 'PUT', body });
}

/** 订阅器读的合成边缘缓存键（键格式归本模块，路由不再知道缓存怎么拼） */
function subscriberCacheKey(path: string): Request {
    return new Request(new URL(path, SUBSCRIBER_CACHE_NAMESPACE).toString());
}

/**
 * 订阅器读：读穿边缘缓存 → 未命中走上游（与同步路径同一套超时/退避）→ 仅成功响应写缓存。
 * 返回已装配响应头与错误映射的 Response，路由只负责白名单与设置校验。
 * 注意：同步写路径的「远端当前内容读」不走这里，否则变更检测会把缓存旧值当远端当前值。
 */
export async function readFileForSubscriber(
    { token, owner, repo }: { token: string; owner: string; repo: string },
    path: string,
    waitUntil?: WaitUntil,
): Promise<Response> {
    // Cloudflare Workers 运行时的 caches.default（标准 DOM 的 CacheStorage 接口不含此字段）。
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = subscriberCacheKey(path);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    let upstream: Response;
    try {
        upstream = await githubApiRequest(apiUrl, token, {
            headers: { 'Accept': 'application/vnd.github.v3.raw' }
        });
    } catch (e) {
        // 上游非 2xx 被统一 fetch 归一成 HttpError：状态码原样透传（含 404 / 403），正文换成固定文案；
        // 网络层错误继续冒泡，由 Worker 入口全局兜底转 500。
        if (e instanceof HttpError) {
            return new Response(SUBSCRIBER_FETCH_ERROR, { status: e.status });
        }
        throw e;
    }

    const response = new Response(upstream.body, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': SUBSCRIBER_CACHE_CONTROL
        }
    });

    // 写缓存不阻塞订阅器响应；缺省也不等待，写失败不影响本次响应
    const write = cache.put(cacheKey, response.clone()).catch(() => {});
    if (waitUntil) waitUntil(write);
    return response;
}
