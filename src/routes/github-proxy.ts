// github-proxy.ts — 订阅器直读代理（GitHub 文件白名单代理 + 缓存）
// 从 index.legacy.js 提取（原 handleGitHubFileProxy）

import { getGitHubSettings } from '../db/client.ts';

/** 订阅器友好代理：按 github_path 白名单从 GitHub 拉取文件并缓存 300s */
export async function handleGitHubFileProxy(fileName: string, env: { WUYA: D1Database }, ctx: ExecutionContext): Promise<Response> {
    const db = env.WUYA;
    const source = await db.prepare("SELECT * FROM ip_sources WHERE github_path = ?").bind(fileName).first();

    if (!source) {
        return new Response('请求的文件不存在或不在本服务管理范围内。', { status: 404 });
    }

    const githubSettings = await getGitHubSettings(db);
    if (!githubSettings.token || !githubSettings.owner || !githubSettings.repo) {
        return new Response('服务器尚未完成初始化配置。', { status: 500 });
    }

    // Cloudflare Workers 运行时的 caches.default（标准 DOM 的 CacheStorage 接口不含此字段）。
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(new URL(fileName, "https://github-proxy.cache").toString());
    let response = await cache.match(cacheKey);

    if (!response) {
        const apiUrl = `https://api.github.com/repos/${githubSettings.owner}/${githubSettings.repo}/contents/${fileName}`;
        const headers = {
            'Authorization': `Bearer ${githubSettings.token}`,
            'User-Agent': 'DNS-Clone-Worker-Proxy',
            'Accept': 'application/vnd.github.v3.raw'
        };

        const githubResponse = await fetch(apiUrl, { headers });

        if (!githubResponse.ok) {
            return new Response('无法获取对应文件，请稍后重试。', { status: githubResponse.status });
        }

        response = new Response(githubResponse.body, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'public, max-age=60, s-maxage=300'
            }
        });

        ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
}
