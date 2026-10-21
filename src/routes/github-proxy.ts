// github-proxy.ts — 订阅器直读代理（白名单查询 + 设置校验 + 调 GitHub module）
// C4：GitHub 访问与边缘缓存统一归入 sync/github.ts，本文件不再自建请求头或缓存

import { getGitHubSettings } from "../db/client.ts";
import { readFileForSubscriber } from "../sync/github.ts";

/** 订阅器友好代理：命中 github_path 白名单后由 GitHub module 读穿边缘缓存 */
export async function handleGitHubFileProxy(
    fileName: string,
    env: { WUYA: D1Database },
    ctx: ExecutionContext
): Promise<Response> {
    const source = await env.WUYA.prepare("SELECT * FROM ip_sources WHERE github_path = ?").bind(fileName).first();

    if (!source) {
        return new Response("请求的文件不存在或不在本服务管理范围内。", { status: 404 });
    }

    const githubSettings = await getGitHubSettings(env.WUYA);
    if (!githubSettings.token || !githubSettings.owner || !githubSettings.repo) {
        return new Response("服务器尚未完成初始化配置。", { status: 500 });
    }

    // 缓存写入走延迟回调，不阻塞本次响应
    return await readFileForSubscriber(
        { token: githubSettings.token, owner: githubSettings.owner, repo: githubSettings.repo },
        fileName,
        (promise) => ctx.waitUntil(promise)
    );
}
