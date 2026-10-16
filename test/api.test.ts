// api.test.ts — API 路由分发 + 登录 + 域名 CRUD + 设置白名单 + 权限守卫 + 敏感字段过滤
// 覆盖 plan v2 用例表 + fix-plan 14 项 findings 回归
import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { handleApiRequest } from "../src/routes/api.ts";

// 种子密码（见 apply-migrations.ts）
const PASSWORD = "test-password-123";

async function loginAndGetCookie(): Promise<string> {
    const res = await SELF.fetch("https://example.com/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") as string;
    return setCookie.split(";")[0];
}

/** 注入 CF 凭据，确保 handleDomainMutation 服务端拼装 target_domain 流程可走通 */
async function seedCfSettings(): Promise<void> {
    await env.WUYA.batch([
        env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-token"),
        env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-zone-id"),
    ]);
}

describe("/api/login", () => {
    it("rejects wrong password with 401", async () => {
        const res = await SELF.fetch("https://example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "wrong-password" }),
        });
        expect(res.status).toBe(401);
    });

    it("returns 200 with Set-Cookie for correct password", async () => {
        const res = await SELF.fetch("https://example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: PASSWORD }),
        });
        expect(res.status).toBe(200);
        const setCookie = res.headers.get("Set-Cookie");
        expect(setCookie).toContain("session=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("Max-Age=86400");
    });
});

describe("/api/setup 原子占用 (I4)", () => {
    /**
     * 带屏障的 D1 边界包装（技能准则：数据库边界允许 mock）。
     * 用途：workerd 把并发请求串行化，跨请求的 check→act 竞态无法自然复现；
     * 这里让 apiSetup 的凭据 SELECT 等待两个请求都到达后才放行，
     * 把竞态窗口确定性地打开——旧实现两者都通过检查 → 后者主键冲突 500。
     */
    function makeRacyDb(realDb: D1Database, expectedArrivals = 2) {
        let arrivals = 0;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement => ({
            bind: (...vals: unknown[]) => wrapStmt(stmt.bind(...(vals as Parameters<D1PreparedStatement["bind"]>))),
            first: async (...col: unknown[]) => {
                arrivals += 1;
                if (arrivals >= expectedArrivals) release();
                await gate;
                return await (stmt.first as (...a: unknown[]) => Promise<unknown>)(...col);
            },
            all: () => stmt.all(),
            raw: () => stmt.raw(),
            run: () => stmt.run(),
        } as unknown as D1PreparedStatement);
        return new Proxy(realDb, {
            get(target, prop) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        const s = target.prepare(sql);
                        // 只门控"读凭据"的 SELECT——即竞态读侧
                        return /SELECT value FROM settings WHERE key = \?/.test(sql) ? wrapStmt(s) : s;
                    };
                }
                return Reflect.get(target, prop);
            },
        }) as unknown as D1Database;
    }

    it("concurrent setup: exactly one 200, the other 403, never 500", async () => {
        const originalHash = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'").first() as { value: string };
        await env.WUYA.prepare("DELETE FROM settings WHERE key IN ('ADMIN_PASSWORD_HASH', 'PASSWORD_SALT')").run();

        const racyEnv = { WUYA: makeRacyDb(env.WUYA) };
        const setupReq = (password: string) =>
            new Request("https://example.com/api/setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
            });

        try {
            const [a, b] = await Promise.all([
                handleApiRequest(setupReq("attacker-pass-123"), racyEnv),
                handleApiRequest(setupReq("owner-pass-456"), racyEnv),
            ]);

            const statuses = [a.status, b.status].sort();
            // 契约：恰一成功 + 一明确拒绝；旧实现（check-then-act）下 loser 是 500（主键冲突冒泡）
            expect(statuses).toEqual([200, 403]);

            const rows = await env.WUYA.prepare("SELECT COUNT(*) as n FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'").first() as { n: number };
            expect(rows.n).toBe(1);
        } finally {
            await env.WUYA.batch([
                env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(originalHash.value),
                env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('PASSWORD_SALT', 'test-salt') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
            ]);
        }
    });
});


describe("请求体容错 (Suggestion ①)", () => {
    it("POST /api/login with malformed JSON body returns 400 not 500", async () => {        const res = await SELF.fetch("https://example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{not-json",
        });
        expect(res.status).toBe(400);
    });

    it("POST /api/settings with malformed JSON body returns 400 not 500", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: "garbage",
        });
        expect(res.status).toBe(400);
    });

    it("GET /api/domains/:id/records URL-encodes target_domain in query (Suggestion ⑨)", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const weird = `" onmouseover="alert(1)/x.example.com`;
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, is_enabled) VALUES (?, ?, 'test-zone-id', 0, 60, 1)"
        ).bind("src.example.com", weird).run();
        const row = await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?").bind(weird).first() as { id: number };

        const calls: string[] = [];
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            calls.push(String(url));
            return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
        }));
        try {
            const res = await SELF.fetch(`https://example.com/api/domains/${row.id}/records`, { headers: { Cookie: cookie } });
            expect(res.status).toBe(200);
            const cfCall = calls.find((u) => u.includes("api.cloudflare.com"));
            expect(cfCall).toBeDefined();
            // 关键语义：CF 收到的 name 解码后必须完整等于原 target_domain。
            // 未编码时裸 " 与空格会截断查询串、把 & 后的内容改写进参数
            const parsed = new URL(cfCall!);
            expect(parsed.searchParams.get("name")).toBe(weird);
            expect(parsed.searchParams.get("per_page")).toBe("100");
        } finally {
            vi.unstubAllGlobals();
            await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(row.id).run();
        }
    });
});


describe("/api/login 限流 (FIX-05)", () => {
    // 每个测试前清空 login_attempts 与 sessions，避免累计状态污染
    beforeEach(async () => {
        await env.WUYA.batch([
            env.WUYA.prepare("DELETE FROM login_attempts"),
            env.WUYA.prepare("DELETE FROM sessions"),
        ]);
    });

    // 整组跑完清理一次（防止影响后续 loginAndGetCookie）
    afterAll(async () => {
        await env.WUYA.batch([
            env.WUYA.prepare("DELETE FROM login_attempts"),
            env.WUYA.prepare("DELETE FROM sessions"),
        ]);
    });

    it("6th wrong-password attempt within window returns 429", async () => {
        const wrongBody = JSON.stringify({ password: "definitely-wrong" });
        const opts = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: wrongBody,
        } as const;
        // 前 5 次：401
        for (let i = 0; i < 5; i++) {
            const res = await SELF.fetch("https://example.com/api/login", opts);
            expect(res.status).toBe(401);
        }
        // 第 6 次：被限流 → 429
        const res = await SELF.fetch("https://example.com/api/login", opts);
        expect(res.status).toBe(429);
        const body = await res.json() as { error: string };
        expect(body.error).toMatch(/过于频繁/);

        // 验证 login_attempts 表中只有 5 条失败记录（限流预检阻止第 6 次写入）
        const cnt = await env.WUYA.prepare(
            "SELECT COUNT(*) as n FROM login_attempts WHERE success = 0"
        ).first() as { n: number };
        expect(cnt.n).toBe(5);
    });

    it("successful login clears prior failures for that IP (new 5 wrong attempts re-trigger throttle)", async () => {
        const wrongBody = JSON.stringify({ password: "wrong" });
        const opts = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: wrongBody,
        } as const;
        // 4 次错误（离限流还差 1 次）
        for (let i = 0; i < 4; i++) {
            const res = await SELF.fetch("https://example.com/api/login", opts);
            expect(res.status).toBe(401);
        }
        // 1 次成功（清理失败）
        const okRes = await SELF.fetch("https://example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: PASSWORD }),
        });
        expect(okRes.status).toBe(200);

        // 验证失败记录已被清理
        const cnt = await env.WUYA.prepare(
            "SELECT COUNT(*) as n FROM login_attempts WHERE success = 0"
        ).first() as { n: number };
        expect(cnt.n).toBe(0);

        // 再次错误 5 次后应再次被限流
        for (let i = 0; i < 5; i++) {
            const res = await SELF.fetch("https://example.com/api/login", opts);
            expect(res.status).toBe(401);
        }
        const limitedRes = await SELF.fetch("https://example.com/api/login", opts);
        expect(limitedRes.status).toBe(429);
    });
});

describe("/api/domains routing", () => {
    it("returns 401 unauthenticated", async () => {
        const res = await SELF.fetch("https://example.com/api/domains");
        expect(res.status).toBe(401);
    });

    it("returns 200 with empty list after login", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/domains", {
            headers: { Cookie: cookie },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as unknown[];
        expect(Array.isArray(body)).toBe(true);
    });

    it("returns 404 for unknown API endpoint", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/nonexistent", {
            headers: { Cookie: cookie },
        });
        expect(res.status).toBe(404);
    });
});

describe("POST /api/domains (Task 1.1 API/UI 契约对齐)", () => {
    it("accepts target_domain_prefix and assembles target_domain server-side", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        // mock zone name lookup
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            if (url.includes("api.cloudflare.com")) {
                return new Response(JSON.stringify({ success: true, result: { name: "example.com" } }), { status: 200 });
            }
            return origFetch(url);
        }) as typeof fetch;
        try {
            const res = await SELF.fetch("https://example.com/api/domains", {
                method: "POST",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_domain: "origin.example.com",
                    target_domain_prefix: "clone",
                    is_deep_resolve: 1,
                    ttl: 60,
                    notes: "test domain",
                }),
            });
            expect(res.status).toBe(200);
            // 验证 target_domain 服务端拼装为 "clone.example.com"
            const row = await env.WUYA.prepare("SELECT target_domain, source_domain FROM domains WHERE target_domain = ?").bind("clone.example.com").first() as { target_domain: string; source_domain: string };
            expect(row).not.toBeNull();
            expect(row.source_domain).toBe("origin.example.com");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("returns 400 when target_domain_prefix is missing", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await SELF.fetch("https://example.com/api/domains", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ source_domain: "origin.example.com" }),
        });
        expect(res.status).toBe(400);
    });
});

describe("PUT /api/domains/:id (Task 1.3 系统域名守卫)", () => {
    it("rejects modifying source_domain of system domain with 403", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        // 种子系统域名
        await env.WUYA.prepare("INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, 1, 60, '系统', 1)")
            .bind("internal:hostmonit:yd", "yd.example.com", "test-zone-id").run();
        const sysRow = await env.WUYA.prepare("SELECT id FROM domains WHERE is_system = 1").first() as { id: number };

        // mock zone name
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            if (url.includes("api.cloudflare.com")) {
                return new Response(JSON.stringify({ success: true, result: { name: "example.com" } }), { status: 200 });
            }
            return origFetch(url);
        }) as typeof fetch;
        try {
            const res = await SELF.fetch(`https://example.com/api/domains/${sysRow.id}`, {
                method: "PUT",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_domain: "evil.example.com", // 试图篡改
                    target_domain_prefix: "yd",
                    ttl: 60,
                }),
            });
            expect(res.status).toBe(403);
            // 确认 source_domain 未被修改
            const after = await env.WUYA.prepare("SELECT source_domain FROM domains WHERE id = ?").bind(sysRow.id).first() as { source_domain: string };
            expect(after.source_domain).toBe("internal:hostmonit:yd");
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

describe("POST /api/settings (Task 2.6 白名单 + 配对验证)", () => {
    it("rejects when only CF_API_TOKEN provided (missing CF_ZONE_ID)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ CF_API_TOKEN: "abc" }),
        });
        expect(res.status).toBe(400);
    });

    it("rejects when only CF_ZONE_ID provided (missing CF_API_TOKEN)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ CF_ZONE_ID: "xyz" }),
        });
        expect(res.status).toBe(400);
    });

    it("rejects partial GitHub settings (only GITHUB_TOKEN)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ GITHUB_TOKEN: "ghp_xxx" }),
        });
        expect(res.status).toBe(400);
    });

    it("drops unknown keys (whitelist enforcement)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                THREE_NETWORK_SOURCE: "wetest.vip", // 合法 key
                SECRET_INJECTION: "should-not-persist", // 非法 key
            }),
        });
        expect(res.status).toBe(200);
        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'SECRET_INJECTION'").first();
        expect(row).toBeNull();
        const legit = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'THREE_NETWORK_SOURCE'").first() as { value: string };
        expect(legit.value).toBe("wetest.vip");
    });

    it("null value correctly clears the field (P1-4)", async () => {
        const cookie = await loginAndGetCookie();
        // 先写入一个值
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('THREE_NETWORK_SOURCE', 'wetest.vip') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        // 再用 null 覆盖
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ THREE_NETWORK_SOURCE: null }),
        });
        expect(res.status).toBe(200);
        // 字段应被删除，不应序列化为字符串 "null"
        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'THREE_NETWORK_SOURCE'").first();
        expect(row).toBeNull();
    });

    it("accepts BATCH_SIZE within 1-100 and persists it (I5)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ BATCH_SIZE: 25 }),
        });
        expect(res.status).toBe(200);
        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'BATCH_SIZE'").first() as { value: string } | null;
        expect(row?.value).toBe("25");
    });

    it("rejects invalid BATCH_SIZE values (I5)", async () => {
        const cookie = await loginAndGetCookie();
        // 同文件用例共享 D1 状态：清掉前序用例写入的值，保证"不得落库"断言干净
        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'BATCH_SIZE'").run();
        for (const bad of [0, -5, 101, "abc", 1.5]) {
            const res = await SELF.fetch("https://example.com/api/settings", {
                method: "POST",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify({ BATCH_SIZE: bad }),
            });
            expect(res.status, `BATCH_SIZE=${JSON.stringify(bad)} 应被拒绝`).toBe(400);
        }
        // 被拒值不得落库
        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'BATCH_SIZE'").first();
        expect(row).toBeNull();
    });
});

describe("GET /api/settings (Task 2.5 敏感字段过滤)", () => {
    it("does not leak ADMIN_PASSWORD_HASH or tokens to client", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            headers: { Cookie: cookie },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, string>;
        expect(body.ADMIN_PASSWORD_HASH).toBeUndefined();
        expect(body.PASSWORD_SALT).toBeUndefined();
        expect(body.CF_API_TOKEN).toBeUndefined();
        expect(body.GITHUB_TOKEN).toBeUndefined();
    });
});