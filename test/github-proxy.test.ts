// github-proxy.test.ts — 用例 6：GitHub 代理白名单
// 覆盖 plan v2 用例表：#6 GitHub 代理白名单（200 / 非白名单 404 / 未配置 500）
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { handleGitHubFileProxy } from "../src/routes/github-proxy.ts";

// 插入白名单记录（github_path 即订阅器访问的文件名）
async function seedWhitelistEntry(path: string, urlSuffix = ""): Promise<void> {
    await env.WUYA.prepare(
        "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO NOTHING"
    ).bind(`https://example.com/whitelisted-${path}-${urlSuffix}`, path, "test commit", "direct_regex").run();
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
