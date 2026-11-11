// github-proxy.ts — 订阅器直读代理（白名单查询 + 设置校验 + 调 GitHub module）
// C4：GitHub 访问与边缘缓存统一归入 sync/github.ts，本文件不再自建请求头或缓存

import { getGitHubSettings } from "../db/client.ts";
import { companionSourceCandidate, deriveCompanionPath, readFileForSubscriber } from "../sync/github.ts";

/**
 * 白名单查询：先按请求路径精确匹配主文件，未命中再按派生规则反查伴生文件所属的源。
 * 反查只给候选，必须用 deriveCompanionPath 正推一次确认 —— 否则任何 `x-v6` 形态都能借白名单读出去。
 */
async function findWhitelistedSource(db: D1Database, path: string): Promise<{ github_path: string } | null> {
    const exact = await db.prepare("SELECT * FROM ip_sources WHERE github_path = ?").bind(path).first();
    if (exact) return exact as { github_path: string };

    const candidate = companionSourceCandidate(path);
    if (candidate === null) return null;
    const owner = (await db.prepare("SELECT * FROM ip_sources WHERE github_path = ?").bind(candidate).first()) as {
        github_path: string;
    } | null;
    if (!owner || deriveCompanionPath(owner.github_path) !== path) return null;
    return owner;
}

/** 订阅器友好代理：命中白名单（主文件或已登记源的伴生文件）后由 GitHub module 读穿边缘缓存 */
export async function handleGitHubFileProxy(
    fileName: string,
    env: { WUYA: D1Database },
    ctx: ExecutionContext
): Promise<Response> {
    let decodedFileName: string;
    try {
        decodedFileName = decodeURIComponent(fileName);
    } catch {
        return new Response("请求的文件不存在或不在本服务管理范围内。", { status: 404 });
    }
    const source = await findWhitelistedSource(env.WUYA, decodedFileName);

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
        decodedFileName,
        (promise) => ctx.waitUntil(promise)
    );
}
