// ui.test.ts — src/routes/ui.ts 覆盖
// 覆盖四条分支：未初始化引导页 / 未登录访问 /admin 重定向 / 已登录仪表盘 / 公开首页
import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleUiRequest } from "../src/routes/ui.ts";

/** 创建一个带有效会话 Cookie 的登录态请求 */
async function loggedInRequest(url: string): Promise<Request> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    await env.WUYA.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expiresAt).run();
    return new Request(url, { headers: { Cookie: `session=${token}` } });
}

beforeEach(async () => {
    // 恢复"已初始化"状态（个别用例会删除该项）
    await env.WUYA.prepare(
        "INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind("pbkdf2$100000$test-salt$deadbeef").run();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("handleUiRequest 未初始化", () => {
    it("无 ADMIN_PASSWORD_HASH 时返回初始化引导页", async () => {
        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'").run();

        const res = await handleUiRequest(new Request("https://example.com/"), env);

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/html;charset=UTF-8");
        const html = await res.text();
        expect(html).toContain("系统初始化");
    });
});

describe("handleUiRequest /admin 鉴权", () => {
    it("未登录访问 /admin 时 302 重定向到首页", async () => {
        const res = await handleUiRequest(new Request("https://example.com/admin"), env);

        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/");
    });

    it("已登录访问 /admin 时返回仪表盘", async () => {
        // 清掉 CF 凭据，避免走 getZoneName 外部请求分支
        await env.WUYA.prepare("DELETE FROM settings WHERE key IN ('CF_API_TOKEN', 'CF_ZONE_ID')").run();

        const req = await loggedInRequest("https://example.com/admin");
        const res = await handleUiRequest(req, env);

        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("DNS Clone Dashboard");
    });

    it("CF 凭据存在但 getZoneName 失败时不影响仪表盘渲染", async () => {
        await env.WUYA.batch([
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-token"),
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-zone"),
        ]);
        // getZoneName 内部 fetch 抛错 → 应被 catch 吞掉并 console.warn
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

        const req = await loggedInRequest("https://example.com/admin");
        const res = await handleUiRequest(req, env);

        expect(res.status).toBe(200);
        expect(await res.text()).toContain("DNS Clone Dashboard");
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it("仪表盘 HTML 不应泄露 CF_API_TOKEN / GITHUB_TOKEN / PASSWORD_SALT / 密码哈希 (P0-3)", async () => {
        const tokenLeak = "CF_API_TOKEN_LITERAL_LEAK_123";
        const githubLeak = "GH_TOKEN_LITERAL_LEAK_456";
        const saltLeak = "SALT_LITERAL_LEAK_789";
        const hashLeak = "pbkdf2$999999$" + saltLeak + "$deadbeefcafebabe";
        await env.WUYA.batch([
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(tokenLeak),
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('GITHUB_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(githubLeak),
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('PASSWORD_SALT', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(saltLeak),
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(hashLeak),
            env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', 'zone') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
        ]);
        // getZoneName 会触发外部 fetch，stub 掉避免超时
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, result: { name: "example.com" } }), { status: 200 })));

        const req = await loggedInRequest("https://example.com/admin");
        const res = await handleUiRequest(req, env);

        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).not.toContain(tokenLeak);
        expect(html).not.toContain(githubLeak);
        expect(html).not.toContain(saltLeak);
        expect(html).not.toContain(hashLeak);
        expect(html).not.toContain("pbkdf2$");
    });
});

describe("handleUiRequest 公开首页", () => {
    it("根路径返回公开首页并只展示已启用且同步成功的记录", async () => {
        const visible = `visible-${crypto.randomUUID()}.example.com`;
        const hidden = `hidden-${crypto.randomUUID()}.example.com`;
        await env.WUYA.batch([
            // 已启用 + success → 应出现
            env.WUYA.prepare(
                "INSERT INTO domains (source_domain, target_domain, zone_id, notes, is_enabled, last_sync_status) VALUES (?, ?, 'z', 'note-visible', 1, 'success')"
            ).bind("src-a.example.com", visible),
            // 已禁用 → 不应出现
            env.WUYA.prepare(
                "INSERT INTO domains (source_domain, target_domain, zone_id, notes, is_enabled, last_sync_status) VALUES (?, ?, 'z', 'note-hidden', 0, 'success')"
            ).bind("src-b.example.com", hidden),
        ]);

        const res = await handleUiRequest(new Request("https://example.com/"), env);

        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(visible);
        expect(html).not.toContain(hidden);

        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain IN (?, ?)").bind(visible, hidden).run();
    });

    it("/login 路径同样落到公开首页分支", async () => {
        const res = await handleUiRequest(new Request("https://example.com/login"), env);

        expect(res.status).toBe(200);
        expect(await res.text()).toContain("CF-DNS-Clon");
    });

    it("三网源设置缺失时系统域名卡片显示'未知'来源名", async () => {
        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'THREE_NETWORK_SOURCE'").run();
        // 来源名仅在 is_system=1 的卡片上渲染（templates.js:231），需保证存在这样一条可见记录
        const sysDomain = `sys-${crypto.randomUUID()}.example.com`;
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, notes, is_enabled, is_system, last_sync_status) VALUES (?, ?, 'z', 'note-sys', 1, 1, 'success')"
        ).bind("internal:hostmonit:CM", sysDomain).run();

        const res = await handleUiRequest(new Request("https://example.com/"), env);

        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain(sysDomain);
        expect(html).toContain("未知");

        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind(sysDomain).run();
    });
});
