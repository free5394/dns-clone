// github.ts — GitHub API 封装（仓库检查 / 内容读取 / 文件更新 / 订阅器读）
// 从 index.legacy.js 提取（原 1237-1310 行）
// C4：全仓对 GitHub 的访问只走 githubApiRequest 一个出口（认证、User-Agent、Accept、超时、重试）

import { fetchWithRetry } from "../util/fetch.ts";
import { HttpError } from "../util/http-error.ts";
import type { WaitUntil } from "../util/http.ts";

/** 订阅器读的边缘缓存命名空间：合成键，不暴露真实请求 URL，也不与上游 URL 互相污染 */
const SUBSCRIBER_CACHE_NAMESPACE = "https://github-proxy.cache";

/** 订阅器读的缓存响应头（TTL 归属本模块：5 分钟边缘缓存） */
const SUBSCRIBER_CACHE_CONTROL = "public, max-age=60, s-maxage=300";

/** 上游非 2xx 时给订阅器的固定文案：不透传上游 JSON 错误体 */
const SUBSCRIBER_FETCH_ERROR = "无法获取对应文件，请稍后重试。";

/** GitHub owner / repo 路径段白名单：字母、数字、下划线、点、连字符 */
const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** GitHub 用户名（含组织名）长度上限 */
const GITHUB_OWNER_MAX_LENGTH = 39;

/** GitHub 仓库名长度上限 */
const GITHUB_REPO_MAX_LENGTH = 100;

/** Contents API 路径单段长度上限 */
const GITHUB_PATH_SEGMENT_MAX_LENGTH = 255;

/**
 * 校验 owner / repo 路径段并原样返回。
 * 严格白名单 + 长度上限，避免外部输入改写 API 路径结构（如 `/`、`?`、`#`、`..`）。
 */
function assertSafeGitHubSegment(value: string, field: "owner" | "repo"): string {
    const maxLength = field === "owner" ? GITHUB_OWNER_MAX_LENGTH : GITHUB_REPO_MAX_LENGTH;
    if (!value || value.length > maxLength || !GITHUB_SEGMENT_PATTERN.test(value) || value === "." || value === "..") {
        throw new Error(
            `GitHub ${field} 参数非法：仅允许字母、数字、下划线、点和连字符，长度不超过 ${maxLength} 个字符，且不能是 "." 或 ".."。`
        );
    }
    return value;
}

/**
 * 内容路径形态校验（解码后执行）：拒绝绝对路径、空段、`..` 段、反斜杠、控制字符与超长段。
 */
function assertValidContentPath(path: string): void {
    if (!path) throw new Error("GitHub 文件路径不能为空。");
    if (path.startsWith("/")) throw new Error('GitHub 文件路径不能以 "/" 开头。');
    if (path.includes("\\")) throw new Error("GitHub 文件路径不能包含反斜杠。");
    if ([...path].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
        throw new Error("GitHub 文件路径不能包含控制字符。");
    }
    const segments = path.split("/");
    if (segments.some((segment) => segment.length === 0)) throw new Error("GitHub 文件路径不能包含空路径段。");
    if (segments.some((segment) => segment === "..")) throw new Error('GitHub 文件路径不能包含 ".." 段。');
    if (segments.some((segment) => segment.length > GITHUB_PATH_SEGMENT_MAX_LENGTH)) {
        throw new Error(`GitHub 文件路径单段长度不能超过 ${GITHUB_PATH_SEGMENT_MAX_LENGTH} 个字符。`);
    }
}

/**
 * 归一化 GitHub 内容路径：含 `%` 时先按一次 `decodeURIComponent` 解码，再用同一套规则校验，
 * 最后试编码拦截孤立代理项（它只在 `encodeURIComponent` 时才暴露，不能留到同步阶段抛 URIError）。
 * 契约：`a%20b.txt` 与 `a b.txt` 是同一个文件；URL 编码统一交给调用方在归一化之后完成。
 * 解码一次后仍含 `%` 的一律拒绝：`a%25b` 解码是 `a%b`，再解码就变义，属语义不确定输入。
 */
export function normalizeGithubPath(path: string): string {
    let decoded = path;
    if (path.includes("%")) {
        try {
            decoded = decodeURIComponent(path);
        } catch {
            throw new Error("GitHub 文件路径包含非法百分号转义。");
        }
    }
    assertValidContentPath(decoded);
    if (decoded.includes("%")) {
        // 只解码一次：剩余 `%` 意味着再解码会改变含义（如 `a%25b` → `a%b`），拒绝而不是猜
        throw new Error("GitHub 文件路径解码后仍包含百分号，请直接填写真实路径。");
    }
    try {
        // 试编码整条路径只为触发孤立代理项的 URIError；正式编码仍按段进行
        encodeURIComponent(decoded);
    } catch {
        throw new Error("GitHub 文件路径包含非法字符。");
    }
    return decoded;
}

/**
 * 编码 Contents API 的内容路径：先归一化（一次解码 + 形态校验），再保留 `/` 作为分段逐段编码。
 */
function encodeContentPath(path: string): string {
    return normalizeGithubPath(path)
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

/** 仓库级 API URL（统一校验 owner / repo） */
function buildRepoApiUrl(owner: string, repo: string): string {
    return `https://api.github.com/repos/${assertSafeGitHubSegment(owner, "owner")}/${assertSafeGitHubSegment(repo, "repo")}`;
}

/** Contents API URL（统一校验 owner / repo 并逐段编码 path） */
function buildContentsApiUrl(owner: string, repo: string, path: string): string {
    return `${buildRepoApiUrl(owner, repo)}/contents/${encodeContentPath(path)}`;
}

/** GitHub API 请求统一封装（非 2xx 由 fetchWithRetry 抛出 HttpError） */
async function githubApiRequest(url: string, token: string, options: RequestInit = {}): Promise<Response> {
    const headers = {
        Authorization: `Bearer ${token}`,
        "User-Agent": "DNS-Clone-Worker",
        Accept: "application/vnd.github.v3+json",
        ...(options.headers as Record<string, string> | undefined),
    };
    return await fetchWithRetry(url, { ...options, headers }, 1, 15000);
}

/** 确保仓库存在，不存在则创建私有仓库 */
export async function ensureRepoExists(
    token: string,
    owner: string,
    repo: string,
    log: (msg: string) => void
): Promise<void> {
    const repoUrl = buildRepoApiUrl(owner, repo);
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
                description: "Auto-generated repository for IP source files by DNS Clone Worker.",
            });
            await githubApiRequest(createUrl, token, { method: "POST", body });
            log(`✔ 成功创建私有仓库 '${owner}/${repo}'。`);
        } else {
            throw e;
        }
    }
}

/** 获取 GitHub 文件当前内容；404 返回 null（表示需创建） */
export async function getCurrentGitHubContent({
    token,
    owner,
    repo,
    path,
    log,
}: {
    token: string;
    owner: string;
    repo: string;
    path: string;
    log: (msg: string) => void;
}): Promise<string | null> {
    const apiUrl = buildContentsApiUrl(owner, repo, path);
    try {
        const response = await githubApiRequest(apiUrl, token, {
            headers: { Accept: "application/vnd.github.v3.raw" },
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
    let binary = "";
    const CHUNK_SIZE = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
}

/** 更新/创建 GitHub 文件（内容 base64 编码，UTF-8 安全） */
export async function updateFileOnGitHub({
    token,
    owner,
    repo,
    path,
    content,
    message,
    log,
}: {
    token: string;
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    log: (msg: string) => void;
}): Promise<void> {
    await ensureRepoExists(token, owner, repo, log);

    const apiUrl = buildContentsApiUrl(owner, repo, path);
    let sha: string | undefined;
    try {
        const getFileResponse = await githubApiRequest(apiUrl, token);
        const fileData = (await getFileResponse.json()) as { sha: string };
        sha = fileData.sha;
    } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
    }

    const body = JSON.stringify({
        message,
        content: encodeBase64Utf8(content),
        sha,
    });

    await githubApiRequest(apiUrl, token, { method: "PUT", body });
}

/**
 * 订阅器读的合成边缘缓存键（键格式归本模块，路由不再知道缓存怎么拼）。
 * 复用 Contents API 的编码结果，保证缓存键与上游文件一一对应：
 * `a%20b/c.txt` 与 `a b/c.txt` 归一后同键，不同文件不会串缓存。
 */
function subscriberCacheKey(path: string): Request {
    return new Request(new URL(encodeContentPath(path), SUBSCRIBER_CACHE_NAMESPACE).toString());
}

/**
 * 订阅器读：读穿边缘缓存 → 未命中走上游（与同步路径同一套超时/退避）→ 仅成功响应写缓存。
 * 返回已装配响应头与错误映射的 Response，路由只负责白名单与设置校验。
 * 注意：同步写路径的「远端当前内容读」不走这里，否则变更检测会把缓存旧值当远端当前值。
 */
export async function readFileForSubscriber(
    { token, owner, repo }: { token: string; owner: string; repo: string },
    path: string,
    waitUntil?: WaitUntil
): Promise<Response> {
    // 先校验并构造上游 URL：非法 path 不得命中或写入缓存
    const apiUrl = buildContentsApiUrl(owner, repo, path);

    // Cloudflare Workers 运行时的 caches.default（标准 DOM 的 CacheStorage 接口不含此字段）。
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = subscriberCacheKey(path);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let upstream: Response;
    try {
        upstream = await githubApiRequest(apiUrl, token, {
            headers: { Accept: "application/vnd.github.v3.raw" },
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
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": SUBSCRIBER_CACHE_CONTROL,
        },
    });

    // 写缓存不阻塞订阅器响应；缺省也不等待，写失败不影响本次响应
    const write = cache.put(cacheKey, response.clone()).catch(() => {});
    if (waitUntil) waitUntil(write);
    return response;
}
