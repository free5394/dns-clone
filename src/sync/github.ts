// github.ts — GitHub API 封装（仓库检查 / 内容读取 / 文件更新）
// 从 index.legacy.js 提取（原 1237-1310 行）

import { fetchWithRetry } from '../util/fetch.ts';
import { HttpError } from '../util/http-error.ts';

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
        content: btoa(String.fromCharCode(...new TextEncoder().encode(content))),
        sha
    });

    await githubApiRequest(apiUrl, token, { method: 'PUT', body });
}
