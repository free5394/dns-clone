// global-catch.test.ts — FIX-01：验证 src/index.ts 全局 catch 非 API 路径返回固定文案
// 触发方式：访问不匹配任何业务路由的非 API、非 UI、非 login/admin 的路径 → handleGitHubFileProxy
// handleGitHubFileProxy 对不在 ip_sources 白名单的路径返回 404，但若其内部抛错则由全局 catch 兜底
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("global catch — FIX-01 defensive regression", () => {
    it("non-API response should not contain V8 stack frame format", async () => {
        // 任意不存在白名单的路径，验证响应无 stack
        const res = await SELF.fetch("https://example.com/no-such-whitelist-file-abc.txt");
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).not.toMatch(/at .+\(.+:\d+:\d+\)/); // V8 stack frame
        expect(body).not.toMatch(/Error:/i);
    });

    it("GitHub proxy fetch failure should be caught and return fixed message", async () => {
        // 插入一个白名单条目，再让 fetch 抛错 → handleGitHubFileProxy 的 fetch 步骤抛错
        // → 全局 catch 拦截 → 返回固定文案 "服务器内部错误，请稍后重试。"
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO NOTHING"
        ).bind("https://example.com/catch-test", "catch-test.txt", "test commit", "direct_regex").run();
        // 设置 GitHub 设置（required by handleGitHubFileProxy）
        await env.WUYA.batch([
            env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('GITHUB_TOKEN', 'fake-token')"),
            env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('GITHUB_OWNER', 'fake-owner')"),
            env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('GITHUB_REPO', 'fake-repo')"),
        ]);

        // 让 fetch 抛网络错
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("simulated network failure with sensitive bearer token=ghp_xxx");
        }));

        const res = await SELF.fetch("https://example.com/catch-test.txt");
        expect(res.status).toBe(500);
        const body = await res.text();
        // 固定文案
        expect(body).toBe("服务器内部错误，请稍后重试。");
        // 不应泄露 stack / 凭据
        expect(body).not.toContain("simulated network failure");
        expect(body).not.toContain("ghp_xxx");
        expect(body).not.toMatch(/at .+\(.+:\d+:\d+\)/);

        // 清理
        await env.WUYA.batch([
            env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path = ?").bind("catch-test.txt"),
            env.WUYA.prepare("DELETE FROM settings WHERE key IN ('GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO')"),
        ]);
    });
});
