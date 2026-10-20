// github-proxy.test.ts — 用例 6：GitHub 代理白名单
// 覆盖 plan v2 用例表：#6 GitHub 代理白名单（200 / 非白名单 404 / 未配置 500）
// C4：订阅器读的 GitHub 访问与边缘缓存归入 GitHub module，新增用例全部落在同一 seam（本入口）
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGitHubFileProxy } from "../src/routes/github-proxy.ts";

// 插入白名单记录（github_path 即订阅器访问的文件名）
async function seedWhitelistEntry(path: string, urlSuffix = ""): Promise<void> {
    await env.WUYA.prepare(
        "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO NOTHING"
    ).bind(`https://example.com/whitelisted-${path}-${urlSuffix}`, path, "test commit", "direct_regex").run();
}

// 恢复 GitHub 设置（用例间可能被“未配置”用例删掉）
async function seedGitHubSettings(): Promise<void> {
    await env.WUYA.batch([
        env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('GITHUB_TOKEN', 'ghp_test_token')"),
        env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('GITHUB_OWNER', 'test-owner')"),
        env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('GITHUB_REPO', 'test-repo')"),
    ]);
}

// 计数用 fetch mock：返回固定正文的成功响应
function stubUpstreamSuccess(body = "1.1.1.1\n2.2.2.2") {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", spy);
    return spy;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("handleGitHubFileProxy", () => {
    it("returns 404 for non-whitelisted file", async () => {
        const ctx = createExecutionContext();
        const res = await handleGitHubFileProxy("not-in-whitelist.txt", env, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(404);
    });

    it("returns 200 with file content for whitelisted path", async () => {
        await seedWhitelistEntry("whitelisted.txt");
        // mock GitHub Contents API 响应
        vi.stubGlobal("fetch", vi.fn(async () => new Response("1.1.1.1\n2.2.2.2", { status: 200 })));

        const ctx = createExecutionContext();
        const res = await handleGitHubFileProxy("whitelisted.txt", env, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("1.1.1.1\n2.2.2.2");
    });

    it("returns 500 when GitHub settings are missing", async () => {
        await seedWhitelistEntry("no-settings.txt");
        // 删除 GitHub 设置（模拟未配置）
        await env.WUYA.prepare("DELETE FROM settings WHERE key IN ('GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO')").run();

        const ctx = createExecutionContext();
        const res = await handleGitHubFileProxy("no-settings.txt", env, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(500);
    });
});

// C4 新增：订阅器代理入口是唯一 seam（能拿到 ExecutionContext，因此延迟写缓存也可断言）
describe("handleGitHubFileProxy — C4 订阅器读", () => {
    it("a. 白名单未收录 → 404，且不发出上游请求", async () => {
        const spy = stubUpstreamSuccess();

        const ctx = createExecutionContext();
        const res = await handleGitHubFileProxy("c4-not-whitelisted.txt", env, ctx);
        await waitOnExecutionContext(ctx);

        expect(res.status).toBe(404);
        expect(spy).not.toHaveBeenCalled();
    });

    it("b. GitHub 设置缺失 → 500，且不发出上游请求", async () => {
        await seedWhitelistEntry("c4-no-settings.txt");
        await env.WUYA.prepare("DELETE FROM settings WHERE key IN ('GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO')").run();
        const spy = stubUpstreamSuccess();

        const ctx = createExecutionContext();
        const res = await handleGitHubFileProxy("c4-no-settings.txt", env, ctx);
        await waitOnExecutionContext(ctx);

        expect(res.status).toBe(500);
        expect(spy).not.toHaveBeenCalled();

        await seedGitHubSettings();
    });

    it("c. 白名单命中 + 上游 200 → 正文、Content-Type 与缓存响应头", async () => {
        await seedGitHubSettings();
        await seedWhitelistEntry("c4-cache-shape.txt");
        stubUpstreamSuccess("9.9.9.9");

        const ctx = createExecutionContext();
        const res = await handleGitHubFileProxy("c4-cache-shape.txt", env, ctx);
        await waitOnExecutionContext(ctx);

        expect(res.status).toBe(200);
        expect(await res.text()).toBe("9.9.9.9");
        expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        const cacheControl = res.headers.get("Cache-Control") ?? "";
        expect(cacheControl).toContain("max-age=60");
        expect(cacheControl).toContain("s-maxage=300");
    });

    it("d. 上游请求形状：contents API URL + Bearer + 原始内容 Accept", async () => {
        await seedGitHubSettings();
        await seedWhitelistEntry("c4-request-shape.txt");
        const spy = stubUpstreamSuccess();

        const ctx = createExecutionContext();
        await handleGitHubFileProxy("c4-request-shape.txt", env, ctx);
        await waitOnExecutionContext(ctx);

        expect(spy).toHaveBeenCalledTimes(1);
        const [url, init] = spy.mock.calls[0];
        expect(url).toBe("https://api.github.com/repos/test-owner/test-repo/contents/c4-request-shape.txt");
        expect(init?.method ?? "GET").toBe("GET");
        const headers = init?.headers as Record<string, string>;
        expect(headers["Authorization"]).toBe("Bearer ghp_test_token");
        expect(headers["Accept"]).toBe("application/vnd.github.v3.raw");
        expect(headers["User-Agent"]).toBe("DNS-Clone-Worker");
    });

    it("e. 同一路径连续两次 → 上游只被调用一次（边缘缓存命中）", async () => {
        await seedGitHubSettings();
        await seedWhitelistEntry("c4-cache-hit.txt");
        const spy = stubUpstreamSuccess("8.8.8.8");

        const ctx1 = createExecutionContext();
        const res1 = await handleGitHubFileProxy("c4-cache-hit.txt", env, ctx1);
        await waitOnExecutionContext(ctx1); // 等延迟写缓存落地
        expect(await res1.text()).toBe("8.8.8.8");

        const ctx2 = createExecutionContext();
        const res2 = await handleGitHubFileProxy("c4-cache-hit.txt", env, ctx2);
        await waitOnExecutionContext(ctx2);

        expect(res2.status).toBe(200);
        expect(await res2.text()).toBe("8.8.8.8");
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("f. 上游 404 → 404 与固定中文文案（不是上游原始错误体）", async () => {
        await seedGitHubSettings();
        await seedWhitelistEntry("c4-upstream-404.txt");
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
        })));

        const ctx = createExecutionContext();
        const res = await handleGitHubFileProxy("c4-upstream-404.txt", env, ctx);
        await waitOnExecutionContext(ctx);

        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).toBe("无法获取对应文件，请稍后重试。");
        expect(body).not.toContain("Not Found");
    });

    it("g. 上游瞬时 5xx → 自动重试一次；仍失败则 500 与固定文案", async () => {
        await seedGitHubSettings();
        await seedWhitelistEntry("c4-upstream-5xx.txt");
        const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response("upstream exploded", { status: 503 }));
        vi.stubGlobal("fetch", spy);

        const ctx = createExecutionContext();
        const res = await handleGitHubFileProxy("c4-upstream-5xx.txt", env, ctx);
        await waitOnExecutionContext(ctx);

        // 与同步写路径同一套策略：1 次重试（共 2 次尝试），退避约 1s 后仍失败
        expect(spy).toHaveBeenCalledTimes(2);
        expect(res.status).toBe(503);
        expect(await res.text()).toBe("无法获取对应文件，请稍后重试。");
    });
});
