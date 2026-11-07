// api.test.ts — API 路由分发 + 登录 + 域名 CRUD + 设置白名单 + 权限守卫 + 敏感字段过滤
// 覆盖 plan v2 用例表 + fix-plan 14 项 findings 回归
import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { handleApiRequest } from "../src/routes/api.ts";
import { verifyPassword } from "../src/util/auth.ts";

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
        env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind("test-token"),
        env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind("test-zone-id"),
        env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('CF_ZONE_NAME', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind("example.com"),
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

    it("登录成功时批量清理过期会话", async () => {
        await env.WUYA.batch([
            env.WUYA.prepare("INSERT OR REPLACE INTO sessions (token, expires_at) VALUES ('expired-token', ?)").bind(
                new Date(Date.now() - 60_000).toISOString()
            ),
            env.WUYA.prepare("INSERT OR REPLACE INTO sessions (token, expires_at) VALUES ('active-token', ?)").bind(
                new Date(Date.now() + 3_600_000).toISOString()
            ),
        ]);

        const res = await SELF.fetch("https://example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: PASSWORD }),
        });
        expect(res.status).toBe(200);

        const expired = await env.WUYA.prepare("SELECT token FROM sessions WHERE token = 'expired-token'").first();
        const active = await env.WUYA.prepare("SELECT token FROM sessions WHERE token = 'active-token'").first();
        expect(expired).toBeNull();
        expect(active).not.toBeNull();
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
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
            ({
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
            }) as unknown as D1PreparedStatement;
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
        const originalHash = (await env.WUYA.prepare(
            "SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'"
        ).first()) as { value: string };
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

            const rows = (await env.WUYA.prepare(
                "SELECT COUNT(*) as n FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'"
            ).first()) as { n: number };
            expect(rows.n).toBe(1);

            const credential = (await env.WUYA.prepare(
                "SELECT (SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH') as hash, (SELECT value FROM settings WHERE key = 'PASSWORD_SALT') as salt"
            ).first()) as { hash: string; salt: string };
            expect(credential.hash).not.toBe("pbkdf2$100000$pending$pending");
            const verified = await Promise.all([
                verifyPassword("attacker-pass-123", credential.hash, credential.salt),
                verifyPassword("owner-pass-456", credential.hash, credential.salt),
            ]);
            expect(verified.filter((item) => item.matched)).toHaveLength(1);
        } finally {
            await env.WUYA.batch([
                env.WUYA.prepare(
                    "INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                ).bind(originalHash.value),
                env.WUYA.prepare(
                    "INSERT INTO settings (key, value) VALUES ('PASSWORD_SALT', 'test-salt') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                ),
            ]);
        }
    });
});

describe("请求体容错 (Suggestion ①)", () => {
    it("POST /api/login with malformed JSON body returns 400 not 500", async () => {
        const res = await SELF.fetch("https://example.com/api/login", {
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
        )
            .bind("src.example.com", weird)
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?").bind(weird).first()) as {
            id: number;
        };

        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                calls.push(String(url));
                return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
            })
        );
        try {
            const res = await SELF.fetch(`https://example.com/api/domains/${row.id}/records`, {
                headers: { Cookie: cookie },
            });
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
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/过于频繁/);

        // 验证 login_attempts 表中只有 5 条失败记录（限流预检阻止第 6 次写入）
        const cnt = (await env.WUYA.prepare("SELECT COUNT(*) as n FROM login_attempts WHERE success = 0").first()) as {
            n: number;
        };
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
        const cnt = (await env.WUYA.prepare("SELECT COUNT(*) as n FROM login_attempts WHERE success = 0").first()) as {
            n: number;
        };
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
        const body = (await res.json()) as unknown[];
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
                return new Response(JSON.stringify({ success: true, result: { name: "example.com" } }), {
                    status: 200,
                });
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
            const row = (await env.WUYA.prepare(
                "SELECT target_domain, source_domain FROM domains WHERE target_domain = ?"
            )
                .bind("clone.example.com")
                .first()) as { target_domain: string; source_domain: string };
            expect(row).not.toBeNull();
            expect(row.source_domain).toBe("origin.example.com");
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("空目标前缀按根域名处理", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await SELF.fetch("https://example.com/api/domains", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ source_domain: "origin.example.com" }),
        });
        expect(res.status).toBe(200);
    });
});

describe("PUT /api/domains/:id (Task 1.3 系统域名守卫)", () => {
    it("rejects modifying source_domain of system domain with 403", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        // 种子系统域名
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, 1, 60, '系统', 1)"
        )
            .bind("internal:hostmonit:yd", "yd.example.com", "test-zone-id")
            .run();
        const sysRow = (await env.WUYA.prepare("SELECT id FROM domains WHERE is_system = 1").first()) as { id: number };

        // mock zone name
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string) => {
            if (url.includes("api.cloudflare.com")) {
                return new Response(JSON.stringify({ success: true, result: { name: "example.com" } }), {
                    status: 200,
                });
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
            const after = (await env.WUYA.prepare("SELECT source_domain FROM domains WHERE id = ?")
                .bind(sysRow.id)
                .first()) as { source_domain: string };
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
        await env.WUYA.prepare(
            "DELETE FROM settings WHERE key IN ('GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO')"
        ).run();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ GITHUB_TOKEN: "ghp_xxx" }),
        });
        expect(res.status).toBe(400);
    });

    it("空 Token 字符串保持既有 Secret 不变", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.batch([
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', 'cf-saved-token') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ),
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', 'cf-saved-zone') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ),
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('GITHUB_TOKEN', 'gh-saved-token') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ),
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('GITHUB_OWNER', 'saved-owner') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ),
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('GITHUB_REPO', 'saved-repo') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ),
        ]);

        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                THREE_NETWORK_SOURCE: "wetest.vip",
                CF_API_TOKEN: "",
                GITHUB_TOKEN: "",
            }),
        });
        expect(res.status).toBe(200);

        const saved = (await env.WUYA.prepare(
            "SELECT (SELECT value FROM settings WHERE key = 'CF_API_TOKEN') as cf_token, (SELECT value FROM settings WHERE key = 'GITHUB_TOKEN') as github_token"
        ).first()) as { cf_token: string; github_token: string };
        expect(saved.cf_token).toBe("cf-saved-token");
        expect(saved.github_token).toBe("gh-saved-token");

        const safe = await SELF.fetch("https://example.com/api/settings", { headers: { Cookie: cookie } });
        const safeBody = (await safe.json()) as Record<string, unknown>;
        expect(safeBody.CF_CONFIGURED).toBe(true);
        expect(safeBody.GITHUB_CONFIGURED).toBe(true);
        expect(safeBody.CF_API_TOKEN).toBeUndefined();
        expect(safeBody.GITHUB_TOKEN).toBeUndefined();
    });

    it("保存 Cloudflare 配置时缓存区域名称并写入初始化 marker", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "DELETE FROM settings WHERE key IN ('CF_API_TOKEN', 'CF_ZONE_ID', 'CF_ZONE_NAME', 'INITIALIZED_ZONE_ID')"
        ).run();
        const fetchSpy = vi.fn(
            async () =>
                new Response(JSON.stringify({ success: true, result: { name: "cached.example.com" } }), { status: 200 })
        );
        vi.stubGlobal("fetch", fetchSpy);

        const saved = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ CF_API_TOKEN: "cache-token", CF_ZONE_ID: "cache-zone" }),
        });
        expect(saved.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const cached = (await env.WUYA.prepare(
            "SELECT (SELECT value FROM settings WHERE key = 'CF_ZONE_NAME') as zone_name, (SELECT value FROM settings WHERE key = 'INITIALIZED_ZONE_ID') as marker"
        ).first()) as { zone_name: string; marker: string };
        expect(cached.zone_name).toBe("cached.example.com");
        expect(cached.marker).toBe("cache-zone");

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("仪表盘不应请求 Cloudflare");
            })
        );
        const read = await SELF.fetch("https://example.com/api/settings", { headers: { Cookie: cookie } });
        expect(read.status).toBe(200);
        const body = (await read.json()) as Record<string, unknown>;
        expect(body.CF_CONFIGURED).toBe(true);
        expect(body.zoneName).toBe("cached.example.com");
        vi.unstubAllGlobals();
    });

    it("域名输入非法时返回 400 且不落库", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const invalidCases = [
            { source_domain: "bad domain.example.com", target_domain_prefix: "clone", ttl: 60 },
            { source_domain: "internal:hostmonit:bad", target_domain_prefix: "clone", ttl: 60 },
            { source_domain: "origin.example.com", target_domain_prefix: "two.labels", ttl: 60 },
            { source_domain: "origin.example.com", target_domain_prefix: "clone", ttl: 30 },
            { source_domain: "origin.example.com", target_domain_prefix: "clone", ttl: 1.5 },
            { source_domain: "origin.example.com", target_domain_prefix: "clone", ttl: true },
            { source_domain: "origin.example.com", target_domain_prefix: "clone", ttl: null },
        ];

        const before = (await env.WUYA.prepare("SELECT COUNT(*) as n FROM domains").first()) as { n: number };
        for (const payload of invalidCases) {
            const res = await SELF.fetch("https://example.com/api/domains", {
                method: "POST",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            expect(res.status, JSON.stringify(payload)).toBe(400);
            const body = (await res.json()) as { error?: string };
            expect(body.error).toBeTruthy();
        }
        const after = (await env.WUYA.prepare("SELECT COUNT(*) as n FROM domains").first()) as { n: number };
        expect(after.n).toBe(before.n);
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
        const legit = (await env.WUYA.prepare(
            "SELECT value FROM settings WHERE key = 'THREE_NETWORK_SOURCE'"
        ).first()) as { value: string };
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

    it("非 Secret 字段的空字符串仍按清除处理", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('THREE_NETWORK_SOURCE', 'wetest.vip') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();

        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ THREE_NETWORK_SOURCE: "" }),
        });
        expect(res.status).toBe(200);
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
        const row = (await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'BATCH_SIZE'").first()) as {
            value: string;
        } | null;
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
        const body = (await res.json()) as Record<string, string>;
        expect(body.ADMIN_PASSWORD_HASH).toBeUndefined();
        expect(body.PASSWORD_SALT).toBeUndefined();
        expect(body.CF_API_TOKEN).toBeUndefined();
        expect(body.GITHUB_TOKEN).toBeUndefined();
    });
});

// M-7 回归：IP 源输入必须在信任边界做结构校验（策略白名单、路径形态、消息长度）
describe("POST/PUT /api/ip_sources 输入校验 (M-7)", () => {
    const valid = {
        url: "https://example.com/m7/valid.txt",
        github_path: "m7/valid.txt",
        commit_message: "同步 IP 列表",
        fetch_strategy: "direct_regex",
    };

    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm7/%'").run();
    });

    it("合法输入可保存（回归保护）", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(valid),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { success?: boolean }).success).toBe(true);
    });

    it("拒绝未登记的 fetch_strategy，且不落库", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                ...valid,
                url: "https://example.com/m7/bad-strategy.txt",
                github_path: "m7/bad-strategy.txt",
                fetch_strategy: "no_such_strategy",
            }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("策略");

        const row = await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("m7/bad-strategy.txt")
            .first();
        expect(row).toBeNull();
    });

    it("拒绝首尾带空白的 github_path", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                ...valid,
                url: "https://example.com/m7/space.txt",
                github_path: " m7/space.txt",
            }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("路径");
    });

    it("拒绝包含 .. 段的 github_path", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                ...valid,
                url: "https://example.com/m7/dotdot.txt",
                github_path: "m7/../escape.txt",
            }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("路径");
    });

    it("拒绝以 / 开头或含反斜杠的 github_path", async () => {
        const cookie = await loginAndGetCookie();
        for (const badPath of ["/m7/abs.txt", "m7\\win.txt"]) {
            const res = await SELF.fetch("https://example.com/api/ip_sources", {
                method: "POST",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...valid,
                    url: "https://example.com/m7/shape.txt",
                    github_path: badPath,
                }),
            });
            expect(res.status, `github_path=${JSON.stringify(badPath)} 应被拒绝`).toBe(400);
            expect(((await res.json()) as { error?: string }).error).toContain("路径");
        }
    });

    it("拒绝超过 200 字符的 commit_message", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                ...valid,
                url: "https://example.com/m7/long-msg.txt",
                github_path: "m7/long-msg.txt",
                commit_message: "同".repeat(201),
            }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("提交");
    });

    it("PUT 更新同样拒绝非法 fetch_strategy，且不改变原记录", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/m7/put.txt", "m7/put.txt", "更新前", "direct_regex")
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("m7/put.txt")
            .first()) as { id: number };

        const res = await SELF.fetch(`https://example.com/api/ip_sources/${row.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                ...valid,
                url: "https://example.com/m7/put.txt",
                github_path: "m7/put.txt",
                fetch_strategy: "no_such_strategy",
            }),
        });
        expect(res.status).toBe(400);

        const after = (await env.WUYA.prepare("SELECT fetch_strategy, commit_message FROM ip_sources WHERE id = ?")
            .bind(row.id)
            .first()) as { fetch_strategy: string; commit_message: string };
        expect(after.fetch_strategy).toBe("direct_regex");
        expect(after.commit_message).toBe("更新前");
    });
});

// M-9 回归：探测必须受总时长预算约束，不能按策略超时逐个串行累加（最坏约 50 秒）
describe("POST /api/ip_sources/probe 总时长预算 (M-9)", () => {
    it("所有策略都挂起时，探测在总预算内结束并返回 400", async () => {
        // 真实计时器下完成登录，避免假定时器卡住 D1 会话查询
        const cookie = await loginAndGetCookie();

        let fetchCalls = 0;
        const origFetch = globalThis.fetch;
        // 所有上游请求永久挂起，直到被 AbortSignal 中断（模拟三个策略都超时）
        globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls += 1;
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        }) as typeof fetch;

        try {
            vi.useFakeTimers();
            let settled: Response | null = null;
            handleApiRequest(
                new Request("https://example.com/api/ip_sources/probe", {
                    method: "POST",
                    headers: { Cookie: cookie, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: "https://example.com/m9/never-responds.txt" }),
                }),
                env
            )
                .then((response) => {
                    settled = response;
                })
                .catch(() => {});

            await vi.advanceTimersByTimeAsync(30000);

            expect(fetchCalls, "探测应已发起上游请求（否则是鉴权或 D1 未就绪）").toBeGreaterThan(0);
            expect(settled, "30 秒后探测必须已结束；当前实现按 15+20+15 秒串行累加，此时仍在等待").not.toBeNull();
            expect((settled as unknown as Response).status).toBe(400);
            const body = (await (settled as unknown as Response).json()) as { error?: string };
            expect(body.error).toContain("探测");
        } finally {
            vi.useRealTimers();
            globalThis.fetch = origFetch;
        }
    });
});

// M-8：手动全量同步的并发防护（第二个请求应被拒绝，陈旧锁不应永久阻塞）
describe("手动全量同步并发防护 (M-8)", () => {
    const LOCK_KEY = "MANUAL_SYNC_RUNNING";

    async function writeLock(value: number): Promise<void> {
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
            .bind(LOCK_KEY, String(value))
            .run();
    }

    async function clearLock(): Promise<void> {
        await env.WUYA.prepare("DELETE FROM settings WHERE key = ?").bind(LOCK_KEY).run();
    }

    it("已有任务运行时返回 409 并提示稍后再试", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        await writeLock(Date.now() + 60000);

        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/sync", { method: "POST", headers: { Cookie: cookie } }),
                env
            );
            expect(res.status).toBe(409);
            const body = (await res.json()) as { error?: string };
            expect(body.error).toContain("手动同步任务正在执行");
        } finally {
            await clearLock();
        }
    });

    it("陈旧锁不阻塞新的手动同步", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        await writeLock(Date.now() - 60000);

        // 不读取响应体，避免真正驱动 SSE 流去请求上游
        const origFetch = globalThis.fetch;
        globalThis.fetch = (() =>
            Promise.resolve(
                new Response(JSON.stringify({ success: true, result: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                })
            )) as typeof fetch;

        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/sync", { method: "POST", headers: { Cookie: cookie } }),
                env
            );
            expect(res.status).not.toBe(409);
        } finally {
            globalThis.fetch = origFetch;
            await clearLock();
        }
    });
});

// M-12：补齐缺少直接测试的端点（logout / ip_sources 列表与删除 / probe 成功与非法 URL）
describe("端点直测补齐 (M-12)", () => {
    it("logout 后原会话立即失效并清空 Cookie", async () => {
        const cookie = await loginAndGetCookie();

        const logoutRes = await handleApiRequest(
            new Request("https://example.com/api/logout", { method: "POST", headers: { Cookie: cookie } }),
            env
        );
        expect(logoutRes.status).toBe(200);
        expect(logoutRes.headers.get("Set-Cookie")).toContain("session=;");
        expect(logoutRes.headers.get("Set-Cookie")).toContain("Expires=Thu, 01 Jan 1970");

        const after = await handleApiRequest(
            new Request("https://example.com/api/domains", { method: "GET", headers: { Cookie: cookie } }),
            env
        );
        expect(after.status).toBe(401);
    });

    it("GET /api/ip_sources 按 github_path 排序返回已存条目", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/m12/b.txt", "m12/b.txt", "M12 测试", "direct_regex")
            .run();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/m12/a.txt", "m12/a.txt", "M12 测试", "direct_regex")
            .run();

        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/ip_sources", { method: "GET", headers: { Cookie: cookie } }),
                env
            );
            expect(res.status).toBe(200);
            const rows = (await res.json()) as Array<{ github_path: string }>;
            const paths = rows.map((row) => row.github_path);
            expect(paths).toContain("m12/a.txt");
            expect(paths).toContain("m12/b.txt");
            expect(paths.indexOf("m12/a.txt")).toBeLessThan(paths.indexOf("m12/b.txt"));
        } finally {
            await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm12/%'").run();
        }
    });

    it("DELETE /api/ip_sources/:id 删除后列表中不再出现", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/m12/del.txt", "m12/del.txt", "M12 删除", "direct_regex")
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = 'm12/del.txt'").first()) as {
            id: number;
        };

        const res = await handleApiRequest(
            new Request(`https://example.com/api/ip_sources/${row.id}`, {
                method: "DELETE",
                headers: { Cookie: cookie },
            }),
            env
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { success?: boolean };
        expect(body.success).toBe(true);

        const left = await env.WUYA.prepare("SELECT COUNT(*) AS n FROM ip_sources WHERE id = ?")
            .bind(row.id)
            .first<{ n: number }>();
        expect(left?.n).toBe(0);
    });

    it("probe 命中文本中的 IPv4 时返回成功与策略名", async () => {
        const cookie = await loginAndGetCookie();
        const origFetch = globalThis.fetch;
        globalThis.fetch = (() =>
            Promise.resolve(
                new Response("1.1.1.1\n8.8.8.8\n", { status: 200, headers: { "Content-Type": "text/plain" } })
            )) as typeof fetch;

        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/ip_sources/probe", {
                    method: "POST",
                    headers: { Cookie: cookie, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: "https://example.com/m12/ips.txt" }),
                }),
                env
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as { success?: boolean; strategy?: string; ipCount?: number };
            expect(body.success).toBe(true);
            expect(body.strategy).toBe("direct_regex");
            expect(body.ipCount).toBe(2);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("probe 拒绝非 HTTP(S) 协议", async () => {
        const cookie = await loginAndGetCookie();
        const res = await handleApiRequest(
            new Request("https://example.com/api/ip_sources/probe", {
                method: "POST",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify({ url: "file:///etc/passwd" }),
            }),
            env
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBeTruthy();
    });
});

// M-3 回归：新增与更新共用同一条写库流水线后，唯一键冲突必须仍然走 409，且不能改动既有数据
describe("IP 源写库冲突 (M-3)", () => {
    const m3Payload = {
        url: "https://example.com/m3/dup.txt",
        github_path: "m3/dup.txt",
        commit_message: "新增",
        fetch_strategy: "direct_regex",
    };

    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm3/%'").run();
    });

    it("新增重复 URL 返回 409 且只保留一条记录", async () => {
        const cookie = await loginAndGetCookie();
        const first = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(m3Payload),
        });
        expect(first.status).toBe(200);

        const second = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ ...m3Payload, github_path: "m3/dup-other.txt" }),
        });
        expect(second.status).toBe(409);
        expect(((await second.json()) as { error?: string }).error).toContain("已存在");

        const count = (await env.WUYA.prepare(
            "SELECT COUNT(*) AS n FROM ip_sources WHERE url = 'https://example.com/m3/dup.txt'"
        ).first()) as { n: number };
        expect(count.n).toBe(1);
    });

    it("更新成已存在的 GitHub 路径返回 409 且原记录不变", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.batch([
            env.WUYA.prepare(
                "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
            ).bind("https://example.com/m3/a.txt", "m3/a.txt", "A", "direct_regex"),
            env.WUYA.prepare(
                "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
            ).bind("https://example.com/m3/b.txt", "m3/b.txt", "B", "direct_regex"),
        ]);
        const target = (await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = 'm3/b.txt'").first()) as {
            id: number;
        };

        const res = await SELF.fetch(`https://example.com/api/ip_sources/${target.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/m3/b.txt",
                github_path: "m3/a.txt",
                commit_message: "改成撞车",
                fetch_strategy: "direct_regex",
            }),
        });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error?: string }).error).toContain("已存在");

        const after = (await env.WUYA.prepare("SELECT github_path, commit_message FROM ip_sources WHERE id = ?")
            .bind(target.id)
            .first()) as { github_path: string; commit_message: string };
        expect(after.github_path).toBe("m3/b.txt");
        expect(after.commit_message).toBe("B");
    });
});

describe("仪表盘记录批量查询 (M-10)", () => {
    /** 插入两个域名并返回 id，测试结束按 id 清理 */
    async function seedDomains(names: string[]): Promise<number[]> {
        const ids: number[] = [];
        for (const name of names) {
            await env.WUYA.prepare(
                "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, is_enabled) VALUES (?, ?, 'test-zone-id', 0, 60, 1)"
            )
                .bind("src.example.com", name)
                .run();
            const row = (await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?")
                .bind(name)
                .first()) as {
                id: number;
            };
            ids.push(row.id);
        }
        return ids;
    }

    it("一次请求返回全部域名的记录，出站调用数等于域名数", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const ids = await seedDomains(["m10/one.example.com", "m10/two.example.com"]);
        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (String(url).includes("api.cloudflare.com")) calls.push(String(url));
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [{ id: "rec-1", name: "x", type: "A", content: "1.1.1.1" }],
                    }),
                    { status: 200 }
                );
            })
        );
        try {
            const res = await SELF.fetch("https://example.com/api/domains/records", { headers: { Cookie: cookie } });
            expect(res.status).toBe(200);
            const payload = (await res.json()) as Record<string, { records?: unknown[]; error?: string }>;
            for (const id of ids) {
                expect(payload[String(id)].records).toHaveLength(1);
            }
            // 关键语义：域名数 = 出站 Cloudflare 调用数，且整体只发一次前端请求
            const domainCount = ((await env.WUYA.prepare("SELECT COUNT(*) as n FROM domains").first()) as { n: number })
                .n;
            expect(calls).toHaveLength(domainCount);
        } finally {
            vi.unstubAllGlobals();
            for (const id of ids) await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(id).run();
        }
    });

    it("单个域名失败不影响其它域名", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const [okId, badId] = await seedDomains(["m10/ok.example.com", "m10/bad.example.com"]);
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (String(url).includes("m10%2Fbad.example.com")) {
                    return new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), {
                        status: 200,
                    });
                }
                return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
            })
        );
        try {
            const res = await SELF.fetch("https://example.com/api/domains/records", { headers: { Cookie: cookie } });
            expect(res.status).toBe(200);
            const payload = (await res.json()) as Record<string, { records?: unknown[]; error?: string }>;
            expect(payload[String(okId)].records).toEqual([]);
            expect(payload[String(badId)].error).toContain("Cloudflare API 返回错误");
        } finally {
            vi.unstubAllGlobals();
            for (const id of [okId, badId]) await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(id).run();
        }
    });

    it("未配置 Cloudflare 凭据时返回 400", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.batch([
            env.WUYA.prepare("UPDATE settings SET value = '' WHERE key = 'CF_API_TOKEN'"),
            env.WUYA.prepare("UPDATE settings SET value = '' WHERE key = 'CF_ZONE_ID'"),
        ]);
        try {
            const res = await SELF.fetch("https://example.com/api/domains/records", { headers: { Cookie: cookie } });
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error?: string }).error).toContain("未配置");
        } finally {
            await seedCfSettings();
        }
    });
});

describe("深解析开关类型校验 (L-4)", () => {
    it.each([["1"], ["true"], [2], [-1]])("is_deep_resolve = %s 时返回 400", async (value) => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/domains", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ source_domain: "pull.example.com", is_deep_resolve: value }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("is_deep_resolve");
    });
});

// 高-3：百分号编码路径的信任边界契约（先解码再校验，非法转义与孤立代理项直接拒绝）
describe("IP 源路径百分号语义 (高-3)", () => {
    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm13/%'").run();
    });

    function postIpSource(cookie: string, githubPath: string) {
        return SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/m13/source.txt",
                github_path: githubPath,
                commit_message: "同步 IP 列表",
                fetch_strategy: "direct_regex",
            }),
        });
    }

    it("百分号编码路径落库时归一为解码后的同一路径", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postIpSource(cookie, "m13/a%20b.txt");
        expect(res.status).toBe(200);

        const row = await env.WUYA.prepare("SELECT github_path FROM ip_sources WHERE github_path = ?")
            .bind("m13/a b.txt")
            .first<{ github_path: string }>();
        expect(row?.github_path).toBe("m13/a b.txt");
    });

    it("非法百分号转义返回 400 且不落库", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postIpSource(cookie, "m13/%zz.txt");
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("GitHub 文件路径");

        const row = await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("m13/%zz.txt")
            .first();
        expect(row).toBeNull();
    });

    it("孤立代理项返回 400 而不是保存成功", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postIpSource(cookie, "\uD800m13.txt");
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("GitHub 文件路径");
    });
});

// 中-7：M-3 合并写库路径后，新增与更新的成功分支缺少端点级直测
describe("IP 源写库成功路径 (中-7)", () => {
    type Row = {
        id: number;
        url: string;
        github_path: string;
        commit_message: string;
        fetch_strategy: string;
    };

    async function readRow(githubPath: string): Promise<Row | null> {
        return await env.WUYA.prepare(
            "SELECT id, url, github_path, commit_message, fetch_strategy FROM ip_sources WHERE github_path = ?"
        )
            .bind(githubPath)
            .first<Row>();
    }

    function payload(overrides: Record<string, unknown> = {}) {
        return {
            url: "https://example.com/m12p/source.txt",
            github_path: "m12p/source.txt",
            commit_message: "首次同步",
            fetch_strategy: "direct_regex",
            ...overrides,
        };
    }

    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm12p/%'").run();
    });

    it("POST 成功后按提交值落库并返回中文成功文案", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(payload()),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { success?: boolean; message?: string };
        expect(body.success).toBe(true);
        expect(body.message).toBe("IP源添加成功。");

        const row = await readRow("m12p/source.txt");
        expect(row).not.toBeNull();
        expect(row?.url).toBe("https://example.com/m12p/source.txt");
        expect(row?.commit_message).toBe("首次同步");
        expect(row?.fetch_strategy).toBe("direct_regex");
    });

    it("PUT 成功会真的改掉字段，且 id 不变", async () => {
        const cookie = await loginAndGetCookie();
        const created = await readRow("m12p/source.txt");
        expect(created).not.toBeNull();

        const res = await SELF.fetch("https://example.com/api/ip_sources/" + String(created?.id), {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(
                payload({
                    url: "https://example.com/m12p/updated.txt",
                    commit_message: "更新后的提交信息",
                    fetch_strategy: "phantomjs_cloud",
                })
            ),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { success?: boolean; message?: string };
        expect(body.success).toBe(true);
        expect(body.message).toBe("IP源更新成功。");

        const row = await readRow("m12p/source.txt");
        expect(row?.id).toBe(created?.id);
        expect(row?.url).toBe("https://example.com/m12p/updated.txt");
        expect(row?.commit_message).toBe("更新后的提交信息");
        expect(row?.fetch_strategy).toBe("phantomjs_cloud");
    });

    it("未登录时新增被拒，且不落库", async () => {
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
                payload({
                    url: "https://example.com/m12p/anonymous.txt",
                    github_path: "m12p/anonymous.txt",
                })
            ),
        });

        expect(res.status).toBe(401);
        expect(await readRow("m12p/anonymous.txt")).toBeNull();
    });
});

// 中-10：PUT 不存在的 id 曾返回 200「IP源更新成功。」，属假成功
describe("IP 源更新不存在 id (中-10)", () => {
    const MISSING_ID = 987654321;

    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm404/%'").run();
    });

    it("PUT 不存在的 id 返回 404 且不落库", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources/" + String(MISSING_ID), {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/m404/missing.txt",
                github_path: "m404/missing.txt",
                commit_message: "不该落库",
                fetch_strategy: "direct_regex",
            }),
        });

        expect(res.status).toBe(404);
        const body = (await res.json()) as { error?: string; success?: boolean };
        expect(body.error).toBe("目标不存在。");
        expect(body.success).toBeUndefined();

        const created = await env.WUYA.prepare(
            "SELECT COUNT(*) as total FROM ip_sources WHERE github_path LIKE 'm404/%'"
        ).first<{
            total: number;
        }>();
        expect(created?.total).toBe(0);
    });

    it("PUT 已存在 id 且提交值未变时仍返回 200，不被误判为不存在", async () => {
        const cookie = await loginAndGetCookie();
        const payload = {
            url: "https://example.com/m404/same.txt",
            github_path: "m404/same.txt",
            commit_message: "内容不变",
            fetch_strategy: "direct_regex",
        };

        const created = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        expect(created.status).toBe(200);
        const row = await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("m404/same.txt")
            .first<{ id: number }>();
        expect(row?.id).toBeGreaterThan(0);

        const res = await SELF.fetch("https://example.com/api/ip_sources/" + String(row?.id), {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        expect(res.status).toBe(200);
        expect(((await res.json()) as { message?: string }).message).toBe("IP源更新成功。");
    });
});

// 中-11：DELETE 不存在的 id 曾返回 200「IP源删除成功。」，与更新路径同类假成功
describe("IP 源删除不存在 id (中-11)", () => {
    const MISSING_ID = 987654322;

    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'mdel/%'").run();
    });

    it("DELETE 不存在的 id 返回 404 且不改动其他行", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources/" + String(MISSING_ID), {
            method: "DELETE",
            headers: { Cookie: cookie },
        });

        expect(res.status).toBe(404);
        const body = (await res.json()) as { error?: string; success?: boolean };
        expect(body.error).toBe("目标不存在。");
        expect(body.success).toBeUndefined();
    });

    it("重复删除同一 id 时第二次返回 404，第一次仍成功", async () => {
        const cookie = await loginAndGetCookie();
        const created = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/mdel/once.txt",
                github_path: "mdel/once.txt",
                commit_message: "待删除",
                fetch_strategy: "direct_regex",
            }),
        });
        expect(created.status).toBe(200);
        const row = await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("mdel/once.txt")
            .first<{ id: number }>();
        expect(row?.id).toBeGreaterThan(0);

        const first = await SELF.fetch("https://example.com/api/ip_sources/" + String(row?.id), {
            method: "DELETE",
            headers: { Cookie: cookie },
        });
        expect(first.status).toBe(200);

        const second = await SELF.fetch("https://example.com/api/ip_sources/" + String(row?.id), {
            method: "DELETE",
            headers: { Cookie: cookie },
        });
        expect(second.status).toBe(404);
    });
});

// Q1：解码一次后仍含 % 的路径语义不确定，必须在写库前拒绝，而不是落进数据库留到同步期炸
describe("IP 源路径解码残留百分号 (Q1)", () => {
    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'mq1/%'").run();
    });

    it("提交解码后仍含百分号的路径被拒绝且不落库", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/mq1/source.txt",
                github_path: "mq1/a%25b.txt",
                commit_message: "残留百分号",
                fetch_strategy: "direct_regex",
            }),
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toContain("GitHub 文件路径");

        const count = await env.WUYA.prepare(
            "SELECT COUNT(*) as n FROM ip_sources WHERE github_path LIKE 'mq1/%'"
        ).first<{ n: number }>();
        expect(count?.n).toBe(0);
    });

    it("普通编码路径仍按一次解码落库", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/mq1/encoded.txt",
                github_path: "mq1/a%20b.txt",
                commit_message: "普通编码",
                fetch_strategy: "direct_regex",
            }),
        });

        expect(res.status).toBe(200);
        const row = await env.WUYA.prepare("SELECT github_path FROM ip_sources WHERE github_path = ?")
            .bind("mq1/a b.txt")
            .first<{ github_path: string }>();
        expect(row?.github_path).toBe("mq1/a b.txt");
    });
});
