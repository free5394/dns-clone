// api.test.ts — API 路由分发 + 登录 + 域名 CRUD + 设置白名单 + 权限守卫 + 敏感字段过滤
// 覆盖 plan v2 用例表 + fix-plan 14 项 findings 回归
import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { handleApiRequest } from "../src/routes/api.ts";
import { verifyPassword } from "../src/util/auth.ts";
import { DEFAULT_HOSTMONIT_API_KEY, resolveHostmonitKey } from "../src/sync/ip-sources.ts";

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

    it("接受 1-200 内的 MAX_IPS_PER_TYPE 并在刷新后回传同一值 (issue #49)", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ MAX_IPS_PER_TYPE: 30 }),
        });
        expect(res.status).toBe(200);
        const row = (await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").first()) as {
            value: string;
        } | null;
        expect(row?.value).toBe("30");

        // 刷新（GET）必须回传同一个值，设置页据此回填
        const get = await SELF.fetch("https://example.com/api/settings", { headers: { Cookie: cookie } });
        expect(get.status).toBe(200);
        expect(((await get.json()) as { MAX_IPS_PER_TYPE: number }).MAX_IPS_PER_TYPE).toBe(30);
    });

    it("拒绝非法 MAX_IPS_PER_TYPE 且不覆盖已存值 (issue #49)", async () => {
        const cookie = await loginAndGetCookie();
        // 同文件用例共享 D1 状态：先放一个合法值，验证被拒的请求既不 200 也不覆盖它
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('MAX_IPS_PER_TYPE', '25') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        for (const bad of [0, 201, 1.5, -1, "abc"]) {
            const res = await SELF.fetch("https://example.com/api/settings", {
                method: "POST",
                headers: { Cookie: cookie, "Content-Type": "application/json" },
                body: JSON.stringify({ MAX_IPS_PER_TYPE: bad }),
            });
            expect(res.status, `MAX_IPS_PER_TYPE=${JSON.stringify(bad)} 应被拒绝`).toBe(400);
        }
        const row = (await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").first()) as {
            value: string;
        } | null;
        expect(row?.value).toBe("25");
    });

    it("缺失、损坏或清除后 MAX_IPS_PER_TYPE 一律回退 20 (issue #49)", async () => {
        const cookie = await loginAndGetCookie();
        const readMax = async (): Promise<number> => {
            const res = await SELF.fetch("https://example.com/api/settings", { headers: { Cookie: cookie } });
            return ((await res.json()) as { MAX_IPS_PER_TYPE: number }).MAX_IPS_PER_TYPE;
        };

        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").run();
        expect(await readMax()).toBe(20);

        // 损坏的存量值（手工改库或旧版本遗留）同样回退，而不是把脏值透给前端
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('MAX_IPS_PER_TYPE', 'oops') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        expect(await readMax()).toBe(20);

        // 显式清除：null 落为删除指令，读取回到默认 20
        const cleared = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ MAX_IPS_PER_TYPE: null }),
        });
        expect(cleared.status).toBe(200);
        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").first();
        expect(row).toBeNull();
        expect(await readMax()).toBe(20);
    });

    it("非字符串却折叠成空的非法值整批 400，且不落库 (issue #49 复核)", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").run();

        // String([]) === ""，若按折叠结果判「显式清除」会被误判成合法清除并返回 200（方案 §9.5 要求 400）
        const res = await SELF.fetch("https://example.com/api/settings", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({ MAX_IPS_PER_TYPE: [] }),
        });
        expect(res.status).toBe(400);
        expect(await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").first()).toBeNull();
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

    it("陈旧锁被接管后，排空 SSE 即任务结束且锁已释放", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        // 清空域名：让后台任务在空集合上立刻结束，不依赖上游响应时序
        await env.WUYA.prepare("DELETE FROM domains").run();
        await writeLock(Date.now() - 60000);

        // createLogStreamResponse 在返回 Response 时就已经启动后台任务，
        // 「不读响应体就不会跑」是错误假设（复审 中-9）。这里改为排空流并断言任务真的走完。
        const fetchCalls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                fetchCalls.push(String(url));
                return new Response(JSON.stringify({ success: true, result: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            })
        );

        // 高-1：后台任务必须注册给运行时（waitUntil），否则客户端 abort 关流后可能被连带终止
        const registered: Promise<unknown>[] = [];

        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/sync", { method: "POST", headers: { Cookie: cookie } }),
                env,
                (p) => registered.push(p)
            );
            // 低-1：SSE 成功即 200；not.toBe(409) 会放过 401/500，失败点离根因太远
            expect(res.status).toBe(200);
            expect(registered, "SSE 后台任务必须交给 waitUntil").toHaveLength(1);

            // res.text() 只在流关闭后 resolve，而流在后台任务的 finally 里关闭 —— 排空即任务结束
            const text = await res.text();
            expect(text).toContain("开始批量同步任务");
            expect(text).toContain("没有需要同步的已启用目标");
            // 空域名集不应发起任何上游请求：证明任务确已结束，而不是仍在后台跑
            expect(fetchCalls).toHaveLength(0);

            // 关键断言（中-9 缺失项）：任务结束后锁行必须已被删除，否则会永久阻塞后续同步
            const lock = await env.WUYA.prepare("SELECT value FROM settings WHERE key = ?").bind(LOCK_KEY).first();
            expect(lock).toBeNull();

            // 延寿 Promise 完成时锁必须已释放：这是 abort 场景下唯一还能保证锁释放的路径
            await registered[0];
            const lockAfterWaitUntil = await env.WUYA.prepare("SELECT value FROM settings WHERE key = ?")
                .bind(LOCK_KEY)
                .first();
            expect(lockAfterWaitUntil).toBeNull();
        } finally {
            vi.unstubAllGlobals();
            await clearLock();
        }
    });

    it("IP 源批量同步的 SSE 路径同样把后台任务注册给 waitUntil", async () => {
        const cookie = await loginAndGetCookie();
        // 与上一条同理：清空 IP 源让后台任务在空集合上立刻结束，不依赖上游时序
        await env.WUYA.prepare("DELETE FROM ip_sources").run();
        await clearLock();

        const registered: Promise<unknown>[] = [];
        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/ip_sources/sync_all", {
                    method: "POST",
                    headers: { Cookie: cookie },
                }),
                env,
                (p) => registered.push(p)
            );
            expect(res.status).toBe(200);
            // 第二个 SSE 生产点：这里漏传 waitUntil 不会编译报错，只能靠断言拦住
            expect(registered, "IP 源 SSE 也必须交给 waitUntil").toHaveLength(1);

            const text = await res.text();
            expect(text).toContain("开始批量同步IP源");
            expect(text).toContain("没有已启用的IP源需要同步。");

            await registered[0];
            const lock = await env.WUYA.prepare("SELECT value FROM settings WHERE key = ?").bind(LOCK_KEY).first();
            expect(lock).toBeNull();
        } finally {
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
            const body = (await res.json()) as {
                success?: boolean;
                strategy?: string;
                ipv4Count?: number;
                ipv6Count?: number;
            };
            expect(body.success).toBe(true);
            expect(body.strategy).toBe("direct_regex");
            expect(body.ipv4Count).toBe(2);
            expect(body.ipv6Count).toBe(0);
            // ipCount 兼容字段已移除，响应只保留 ipv4Count / ipv6Count 一份真相
            expect(body).not.toHaveProperty("ipCount");
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

// issue #50：IP 源的解析模式端到端（保存 / 校验 / 回填 / 探测）
describe("IP 源解析模式 (issue #50)", () => {
    const basePayload = (overrides: Record<string, unknown> = {}) => ({
        url: "https://example.com/m50/source.txt",
        github_path: "m50/source.txt",
        commit_message: "解析模式",
        fetch_strategy: "direct_regex",
        parse_mode: "auto",
        parse_param: null,
        ...overrides,
    });

    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm50/%'").run();
    });

    it("保存 json_path 解析配置并原样回读", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(basePayload({ parse_mode: "json_path", parse_param: "data.list.ipv4" })),
        });
        expect(res.status).toBe(200);

        const row = await env.WUYA.prepare("SELECT parse_mode, parse_param FROM ip_sources WHERE github_path = ?")
            .bind("m50/source.txt")
            .first<{ parse_mode: string; parse_param: string }>();
        expect(row?.parse_mode).toBe("json_path");
        expect(row?.parse_param).toBe("data.list.ipv4");
    });

    it("拒绝白名单外的 parse_mode，且不落库", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(
                basePayload({
                    url: "https://example.com/m50/bad-mode.txt",
                    github_path: "m50/bad-mode.txt",
                    parse_mode: "regex",
                })
            ),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("解析模式");

        const row = await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("m50/bad-mode.txt")
            .first();
        expect(row).toBeNull();
    });

    it("json_path 缺少点路径时返回 400", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(
                basePayload({
                    url: "https://example.com/m50/missing-param.txt",
                    github_path: "m50/missing-param.txt",
                    parse_mode: "json_path",
                    parse_param: "",
                })
            ),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("JSON");
    });

    it("PUT 切回 auto 时把残留参数归一为 NULL", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy, parse_mode, parse_param) VALUES (?, ?, ?, ?, ?, ?)"
        )
            .bind(
                "https://example.com/m50/switch.txt",
                "m50/switch.txt",
                "切换前",
                "direct_regex",
                "json_path",
                "data.ips"
            )
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("m50/switch.txt")
            .first()) as { id: number };

        const res = await SELF.fetch(`https://example.com/api/ip_sources/${row.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(
                basePayload({
                    url: "https://example.com/m50/switch.txt",
                    github_path: "m50/switch.txt",
                    parse_mode: "auto",
                    parse_param: "data.ips",
                })
            ),
        });
        expect(res.status).toBe(200);

        const after = await env.WUYA.prepare("SELECT parse_mode, parse_param FROM ip_sources WHERE id = ?")
            .bind(row.id)
            .first<{ parse_mode: string; parse_param: string | null }>();
        expect(after?.parse_mode).toBe("auto");
        expect(after?.parse_param).toBeNull();
    });

    it("probe 返回 IPv4/IPv6 数量与两类样例", async () => {
        const cookie = await loginAndGetCookie();
        const origFetch = globalThis.fetch;
        globalThis.fetch = (() =>
            Promise.resolve(
                new Response("8.8.8.8\n1.1.1.1\n2606:4700:4700::1111", {
                    status: 200,
                    headers: { "Content-Type": "text/plain" },
                })
            )) as typeof fetch;

        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/ip_sources/probe", {
                    method: "POST",
                    headers: { Cookie: cookie, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        url: "https://example.com/m50/probe.txt",
                        parse_mode: "auto",
                        parse_param: null,
                    }),
                }),
                env
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                success?: boolean;
                strategy?: string;
                ipv4Count?: number;
                ipv6Count?: number;
                sampleIps?: string[];
                sampleIpv6?: string[];
            };
            expect(body.success).toBe(true);
            expect(body.strategy).toBe("direct_regex");
            expect(body.ipv4Count).toBe(2);
            expect(body.ipv6Count).toBe(1);
            expect(body).not.toHaveProperty("ipCount");
            expect(body.sampleIps).toEqual(["1.1.1.1", "8.8.8.8"]);
            expect(body.sampleIpv6).toEqual(["2606:4700:4700::1111"]);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("probe 解析配置非法时直接 400，且不发起抓取", async () => {
        const cookie = await loginAndGetCookie();
        const origFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (() => {
            fetchCalls++;
            return Promise.resolve(new Response("1.1.1.1", { status: 200 }));
        }) as typeof fetch;

        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/ip_sources/probe", {
                    method: "POST",
                    headers: { Cookie: cookie, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        url: "https://example.com/m50/bad-probe.txt",
                        parse_mode: "json_path",
                        parse_param: "",
                    }),
                }),
                env
            );
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error?: string }).error).toContain("JSON");
            expect(fetchCalls).toBe(0);
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});

// issue #56：custom_regex 与 json_path 对齐 trim 判空，保存与探测共用同一套规则
describe("custom_regex 空白归一 (issue #56)", () => {
    const regexPayload = (overrides: Record<string, unknown> = {}) => ({
        url: "https://example.com/m56/source.txt",
        github_path: "m56/source.txt",
        commit_message: "空白归一",
        fetch_strategy: "direct_regex",
        parse_mode: "custom_regex",
        parse_param: "[0-9]+",
        ...overrides,
    });

    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm56/%'").run();
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain LIKE 'm56-%'").run();
    });

    it("保存入口拒绝全空白 custom_regex，且不落库", async () => {
        const cookie = await loginAndGetCookie();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(regexPayload({ parse_param: "   " })),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toBe("custom_regex 模式必须填写正则表达式。");
        const row = await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("m56/source.txt")
            .first();
        expect(row).toBeNull();
    });

    it("探测入口拒绝全空白 custom_regex，且不发起抓取", async () => {
        const cookie = await loginAndGetCookie();
        const origFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (() => {
            fetchCalls++;
            return Promise.resolve(new Response("[0-9]", { status: 200 }));
        }) as typeof fetch;
        try {
            const res = await handleApiRequest(
                new Request("https://example.com/api/ip_sources/probe", {
                    method: "POST",
                    headers: { Cookie: cookie, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        url: "https://example.com/m56/probe.txt",
                        parse_mode: "custom_regex",
                        parse_param: "\t  ",
                    }),
                }),
                env
            );
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error?: string }).error).toBe("custom_regex 模式必须填写正则表达式。");
            expect(fetchCalls).toBe(0);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it("保存带首尾空白的合法正则：落库为 trim 后的值", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(
                regexPayload({
                    url: "https://example.com/m56/trim.txt",
                    github_path: "m56/trim.txt",
                    parse_param: "  [0-9]+  ",
                })
            ),
        });
        expect(res.status).toBe(200);
        const row = await env.WUYA.prepare("SELECT parse_mode, parse_param FROM ip_sources WHERE github_path = ?")
            .bind("m56/trim.txt")
            .first<{ parse_mode: string; parse_param: string }>();
        expect(row?.parse_mode).toBe("custom_regex");
        expect(row?.parse_param).toBe("[0-9]+");
    });

    it("域名 URL 保存入口同样拒绝全空白 custom_regex", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await SELF.fetch("https://example.com/api/domains", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                source_type: "url",
                source_url: "https://ips.example.com/m56/list.txt",
                parse_mode: "custom_regex",
                parse_param: " \n ",
                target_domain_prefix: "m56-base",
                ttl: 60,
            }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toBe("custom_regex 模式必须填写正则表达式。");
        const row = await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?")
            .bind("m56-base.example.com")
            .first();
        expect(row).toBeNull();
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

// issue #51：伴生路径长度与主文件/伴生文件的双向路径冲突在保存时就要拒绝
describe("IP 源伴生路径校验 (issue #51)", () => {
    const ABSENT_ID = 987654321;

    afterAll(async () => {
        await env.WUYA.prepare("DELETE FROM ip_sources WHERE github_path LIKE 'm51/%'").run();
    });

    function postIpSource(cookie: string, payload: Record<string, unknown>) {
        return SELF.fetch("https://example.com/api/ip_sources", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    }

    it("主文件路径合法但派生伴生路径超过 512 时返回 400", async () => {
        const cookie = await loginAndGetCookie();
        // 单段 ≤255：拼成 510 字符的主文件路径，派生后 513 字符（超过 512 上限）
        const mainPath = `m51/${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(100)}.txt`;
        expect(mainPath.length).toBe(510);
        expect(mainPath.slice(0, -4).length + "-v6.txt".length).toBe(513);

        const res = await postIpSource(cookie, {
            url: "https://example.com/m51/too-long.txt",
            github_path: mainPath,
            commit_message: "长路径",
            fetch_strategy: "direct_regex",
        });

        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("512");
        const count = (await env.WUYA.prepare("SELECT COUNT(*) AS n FROM ip_sources WHERE github_path = ?")
            .bind(mainPath)
            .first()) as { n: number };
        expect(count.n).toBe(0);
    });

    it("派生伴生路径的单段超过 255 时返回 400，不留到同步期才炸", async () => {
        const cookie = await loginAndGetCookie();
        // 主路径总长只有 257，但末段 253 字符：派生出的 "-v6.txt" 把它撑到 256，
        // 保存阶段就该拒绝——否则每轮同步都在 normalizeGithubPath 里抛错、永不收敛
        const mainPath = `m51/${"d".repeat(249)}.txt`;
        const companionPath = `m51/${"d".repeat(249)}-v6.txt`;
        expect(mainPath.length).toBeLessThan(512);
        expect(companionPath.length).toBeLessThan(512);
        expect(companionPath.split("/").at(-1)!.length).toBe(256);

        const res = await postIpSource(cookie, {
            url: "https://example.com/m51/segment.txt",
            github_path: mainPath,
            commit_message: "单段超限",
            fetch_strategy: "direct_regex",
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toContain("伴生");
        expect(body.error).toContain("255");
        const count = (await env.WUYA.prepare("SELECT COUNT(*) AS n FROM ip_sources WHERE github_path = ?")
            .bind(mainPath)
            .first()) as { n: number };
        expect(count.n).toBe(0);
    });

    it("新增源的伴生路径撞上已有源主文件时返回 409", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/m51/own.txt", "m51/own.txt", "已有", "direct_regex")
            .run();

        const res = await postIpSource(cookie, {
            url: "https://example.com/m51/claim-v6.txt",
            // m51/own.txt 的伴生文件就是它，主文件不能抢占
            github_path: "m51/own-v6.txt",
            commit_message: "抢占伴生",
            fetch_strategy: "direct_regex",
        });

        expect(res.status).toBe(409);
        expect(((await res.json()) as { error?: string }).error).toContain("伴生");
        const count = (await env.WUYA.prepare("SELECT COUNT(*) AS n FROM ip_sources WHERE github_path = ?")
            .bind("m51/own-v6.txt")
            .first()) as { n: number };
        expect(count.n).toBe(0);
    });

    it("新增源的伴生路径撞上已有源伴生文件时返回 409（反向）", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/m51/pair.txt", "m51/pair.txt", "已有", "direct_regex")
            .run();

        const res = await postIpSource(cookie, {
            url: "https://example.com/m51/pair-v6.txt",
            // 它的伴生路径是 m51/pair-v6-v6.txt，但主文件本身占用了别人的伴生路径
            github_path: "m51/pair-v6.txt",
            commit_message: "撞伴生",
            fetch_strategy: "direct_regex",
        });

        expect(res.status).toBe(409);
    });

    it("更新自身路径不与自身冲突，正常返回 200", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/m51/self.txt", "m51/self.txt", "自更新", "direct_regex")
            .run();
        const row = (await env.WUYA.prepare(
            "SELECT id FROM ip_sources WHERE github_path = 'm51/self.txt'"
        ).first()) as {
            id: number;
        };

        const res = await SELF.fetch(`https://example.com/api/ip_sources/${row.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/m51/self.txt",
                github_path: "m51/self.txt",
                commit_message: "换个提交信息",
                fetch_strategy: "direct_regex",
            }),
        });

        expect(res.status).toBe(200);
    });

    it("更新成别的源的伴生路径时返回 409", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.batch([
            env.WUYA.prepare(
                "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
            ).bind("https://example.com/m51/keep.txt", "m51/keep.txt", "保留", "direct_regex"),
            env.WUYA.prepare(
                "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
            ).bind("https://example.com/m51/move.txt", "m51/move.txt", "改路径", "direct_regex"),
        ]);
        const target = (await env.WUYA.prepare(
            "SELECT id FROM ip_sources WHERE github_path = 'm51/move.txt'"
        ).first()) as {
            id: number;
        };

        const res = await SELF.fetch(`https://example.com/api/ip_sources/${target.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/m51/move.txt",
                github_path: "m51/keep-v6.txt",
                commit_message: "撞伴生",
                fetch_strategy: "direct_regex",
            }),
        });

        expect(res.status).toBe(409);
        const after = (await env.WUYA.prepare("SELECT github_path FROM ip_sources WHERE id = ?")
            .bind(target.id)
            .first()) as { github_path: string };
        expect(after.github_path).toBe("m51/move.txt");
    });

    it("更新一个已不存在的 id 且路径撞别人时，报 404 而不是 409", async () => {
        const cookie = await loginAndGetCookie();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/m51/gone.txt", "m51/gone.txt", "占位", "direct_regex")
            .run();

        const res = await SELF.fetch(`https://example.com/api/ip_sources/${ABSENT_ID}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                url: "https://example.com/m51/gone.txt",
                // 这条路径本身会撞上 m51/gone.txt 的伴生文件，但目标行不存在，404 优先
                github_path: "m51/gone-v6.txt",
                commit_message: "目标不存在",
                fetch_strategy: "direct_regex",
            }),
        });

        expect(res.status).toBe(404);
        expect(((await res.json()) as { error?: string }).error).toBe("目标不存在。");
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

    function postIpSourceWithPath(cookie: string, githubPath: string) {
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
        const res = await postIpSourceWithPath(cookie, "m13/a%20b.txt");
        expect(res.status).toBe(200);

        const row = await env.WUYA.prepare("SELECT github_path FROM ip_sources WHERE github_path = ?")
            .bind("m13/a b.txt")
            .first<{ github_path: string }>();
        expect(row?.github_path).toBe("m13/a b.txt");
    });

    it("非法百分号转义返回 400 且不落库", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postIpSourceWithPath(cookie, "m13/%zz.txt");
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toContain("GitHub 文件路径");

        const row = await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind("m13/%zz.txt")
            .first();
        expect(row).toBeNull();
    });

    it("孤立代理项返回 400 而不是保存成功", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postIpSourceWithPath(cookie, "\uD800m13.txt");
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

// HOSTMONIT_API_KEY 三态语义的 API 级用例（issue #31）
// 说明：/api/settings 的路由级用例统一放在本文件，复用上面的 PASSWORD/loginAndGetCookie，
// 避免 test/settings.test.ts 再复制一份登录逻辑（issue #31 评审 low）。
async function readSafeSettings(cookie: string): Promise<Record<string, unknown>> {
    const res = await SELF.fetch("https://example.com/api/settings", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

async function postSettings(cookie: string, payload: Record<string, unknown>): Promise<Response> {
    return SELF.fetch("https://example.com/api/settings", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

/** 直接读 D1 行，用于断言「库值有没有被改写」，而不只是看接口布尔 */
async function readHostmonitKeyRow(): Promise<string | null> {
    const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'HOSTMONIT_API_KEY'").first<{
        value: string;
    }>();
    return row?.value ?? null;
}

async function seedHostmonitKey(value: string): Promise<void> {
    await env.WUYA.prepare(
        "INSERT INTO settings (key, value) VALUES ('HOSTMONIT_API_KEY', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
        .bind(value)
        .run();
}

async function clearHostmonitKey(): Promise<void> {
    await env.WUYA.prepare("DELETE FROM settings WHERE key = 'HOSTMONIT_API_KEY'").run();
}

describe("HOSTMONIT_API_KEY 三态 API 级语义 (issue #31)", () => {
    it("保存非空 key：trim 后落库、报「已配置」，响应不回传明文", async () => {
        await clearHostmonitKey();
        const cookie = await loginAndGetCookie();
        const plaintext = "api-level-hostmonit-key";

        const res = await postSettings(cookie, { HOSTMONIT_API_KEY: `  ${plaintext}  ` });
        expect(res.status).toBe(200);
        expect(await res.text()).not.toContain(plaintext);

        const settings = await readSafeSettings(cookie);
        expect(settings.HOSTMONIT_CONFIGURED).toBe(true);
        expect(JSON.stringify(settings)).not.toContain(plaintext);
        expect(await readHostmonitKeyRow()).toBe(plaintext);
    });

    it("先自定义再提交纯空白：库值保持不变，不误清", async () => {
        await seedHostmonitKey("keep-me-key");
        const cookie = await loginAndGetCookie();

        const res = await postSettings(cookie, { HOSTMONIT_API_KEY: "   " });
        expect(res.status).toBe(200);

        // 评审 low：不只看布尔，直接断言 D1 行没有被空串改写
        expect(await readHostmonitKeyRow()).toBe("keep-me-key");
        expect((await readSafeSettings(cookie)).HOSTMONIT_CONFIGURED).toBe(true);
    });

    it("库里本来没有 key 时提交纯空白：不新增库行，也不报「已配置」", async () => {
        // issue #37 R1：起点是「没有这一行」，与「已有 key 再提交空白」是不同分支
        await clearHostmonitKey();
        const cookie = await loginAndGetCookie();
        expect(await readHostmonitKeyRow()).toBeNull();

        const res = await postSettings(cookie, { HOSTMONIT_API_KEY: "   " });
        expect(res.status).toBe(200);

        // 「没有行」而不是「行值是空串」：直接数行数
        const rowCount = await env.WUYA.prepare(
            "SELECT COUNT(*) AS n FROM settings WHERE key = 'HOSTMONIT_API_KEY'"
        ).first<{ n: number }>();
        expect(rowCount?.n).toBe(0);
        expect(await readHostmonitKeyRow()).toBeNull();
        expect((await readSafeSettings(cookie)).HOSTMONIT_CONFIGURED).toBe(false);
        expect(await resolveHostmonitKey(env.WUYA)).toBe(DEFAULT_HOSTMONIT_API_KEY);
    });

    it("保存 null：库行删除、不再报「已配置」，抓取回落内置默认", async () => {
        await seedHostmonitKey("clear-me-key");
        const cookie = await loginAndGetCookie();

        const res = await postSettings(cookie, { HOSTMONIT_API_KEY: null });
        expect(res.status).toBe(200);

        expect(await readHostmonitKeyRow()).toBeNull();
        expect((await readSafeSettings(cookie)).HOSTMONIT_CONFIGURED).toBe(false);
        expect(await resolveHostmonitKey(env.WUYA)).toBe(DEFAULT_HOSTMONIT_API_KEY);
    });

    it("库里只有空白 key（历史脏数据）时不报「已配置」", async () => {
        // issue #32 回归：判据与 resolveHostmonitKey 共用 normalizeHostmonitKey
        await seedHostmonitKey("   ");
        expect((await readSafeSettings(await loginAndGetCookie())).HOSTMONIT_CONFIGURED).toBe(false);
        expect(await resolveHostmonitKey(env.WUYA)).toBe(DEFAULT_HOSTMONIT_API_KEY);
    });
});

// issue #49：列表投影必须包含新列，旧行读出 null 而不是报错（方案 §15.1.7 归 test/api.test.ts）
describe("列表投影包含新列 (issue #49)", () => {
    // 清单是契约锁（issue #49）：列定义真相源在 src/db/client.ts 的 DOMAIN_COLUMNS / IP_SOURCE_COLUMNS，
    // 这里复刻一份用于断言「投影真的带出这些列」，将来加列时需同步两处。
    const NEW_DOMAIN_COLUMNS = ["source_type", "source_url", "parse_mode", "parse_param", "fetch_strategy"] as const;
    const NEW_IP_SOURCE_COLUMNS = ["parse_mode", "parse_param"] as const;

    it("GET /api/domains 返回新字段，旧数据读出 null", async () => {
        const cookie = await loginAndGetCookie();
        const row = await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, is_enabled) VALUES (?, ?, 'test-zone-id', 1, 60, 1)"
        )
            .bind("legacy-projection.example.com", "projection.example.com")
            .run();
        try {
            const res = await SELF.fetch("https://example.com/api/domains", { headers: { Cookie: cookie } });
            expect(res.status).toBe(200);
            const rows = (await res.json()) as Array<Record<string, unknown>>;
            const target = rows.find((item) => item.target_domain === "projection.example.com");
            expect(target, "新插入的域名应出现在列表里").toBeDefined();
            for (const column of NEW_DOMAIN_COLUMNS) {
                expect(Object.keys(target as object), `投影缺列 ${column}`).toContain(column);
                expect((target as Record<string, unknown>)[column], `${column} 旧数据应为 null`).toBeNull();
            }
        } finally {
            await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(row.meta.last_row_id).run();
        }
    });

    it("GET /api/ip_sources 返回新字段，旧数据读出 null", async () => {
        const cookie = await loginAndGetCookie();
        const row = await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://example.com/projection/legacy.txt", "projection/legacy.txt", "投影测试", "direct_regex")
            .run();
        try {
            const res = await SELF.fetch("https://example.com/api/ip_sources", { headers: { Cookie: cookie } });
            expect(res.status).toBe(200);
            const rows = (await res.json()) as Array<Record<string, unknown>>;
            const target = rows.find((item) => item.github_path === "projection/legacy.txt");
            expect(target, "新插入的 IP 源应出现在列表里").toBeDefined();
            for (const column of NEW_IP_SOURCE_COLUMNS) {
                expect(Object.keys(target as object), `投影缺列 ${column}`).toContain(column);
                expect((target as Record<string, unknown>)[column], `${column} 旧数据应为 null`).toBeNull();
            }
        } finally {
            await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(row.meta.last_row_id).run();
        }
    });
});

describe("域名 URL 输入类型 (issue #52)", () => {
    /** POST /api/domains 的薄封装，自动带 Cookie 与 JSON 头 */
    async function postDomain(cookie: string, payload: Record<string, unknown>) {
        return await SELF.fetch("https://example.com/api/domains", {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    }

    it("URL 类型保存成功：派生 hostname、强制关闭深度解析、写入解析配置", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: "https://ips.example.com/list.json?v=1",
            parse_mode: "json_path",
            parse_param: "data.list",
            target_domain_prefix: "url-save",
            is_deep_resolve: 1,
            ttl: 60,
            notes: "URL 目标",
        });
        expect(res.status).toBe(200);
        const row = (await env.WUYA.prepare(
            "SELECT source_domain, source_type, source_url, parse_mode, parse_param, is_deep_resolve FROM domains WHERE target_domain = ?"
        )
            .bind("url-save.example.com")
            .first()) as {
            source_domain: string;
            source_type: string;
            source_url: string;
            parse_mode: string;
            parse_param: string;
            is_deep_resolve: number;
        };
        expect(row.source_domain).toBe("ips.example.com");
        expect(row.source_type).toBe("url");
        expect(row.source_url).toBe("https://ips.example.com/list.json?v=1");
        expect(row.parse_mode).toBe("json_path");
        expect(row.parse_param).toBe("data.list");
        // URL 类型强制关闭深度解析，即使请求里传了 1
        expect(row.is_deep_resolve).toBe(0);
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind("url-save.example.com").run();
    });

    it("域名类型忽略 URL 相关字段，写库为 domain 且解析配置清空", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await postDomain(cookie, {
            source_type: "domain",
            source_domain: "plain.example.com",
            source_url: "https://should-be-ignored.example.com/list.txt",
            parse_mode: "custom_regex",
            parse_param: "\\d+",
            target_domain_prefix: "plain",
            ttl: 60,
        });
        expect(res.status).toBe(200);
        const row = (await env.WUYA.prepare(
            "SELECT source_domain, source_type, source_url, parse_mode, parse_param FROM domains WHERE target_domain = ?"
        )
            .bind("plain.example.com")
            .first()) as {
            source_domain: string;
            source_type: string;
            source_url: string | null;
            parse_mode: string | null;
            parse_param: string | null;
        };
        expect(row.source_domain).toBe("plain.example.com");
        expect(row.source_type).toBe("domain");
        expect(row.source_url).toBeNull();
        expect(row.parse_mode).toBeNull();
        expect(row.parse_param).toBeNull();
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind("plain.example.com").run();
    });

    it("缺少 source_url 时返回 400", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postDomain(cookie, { source_type: "url", target_domain_prefix: "no-url" });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("source_url");
    });

    it("source_url 超过 2048 字符时返回 400", async () => {
        const cookie = await loginAndGetCookie();
        const longUrl = "https://example.com/" + "a".repeat(2100);
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: longUrl,
            target_domain_prefix: "long-url",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("2048");
    });

    it("非 http/https 协议返回 400", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: "ftp://example.com/ips.txt",
            target_domain_prefix: "bad-scheme",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("http/https");
    });

    it("内网地址被 SSRF 校验拦截", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: "http://169.254.169.254/latest/meta-data/",
            target_domain_prefix: "ssrf",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("内网");
    });

    it("解析模式非法时返回 400", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: "https://example.com/ips.txt",
            parse_mode: "bad_mode",
            target_domain_prefix: "bad-mode",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("解析模式");
    });

    it.each([[""], [null]])("解析模式缺省（%s）按 auto 落库", async (mode) => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const prefix = mode === "" ? "default-mode-empty" : "default-mode-null";
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: "https://example.com/ips.txt",
            parse_mode: mode,
            target_domain_prefix: prefix,
        });
        expect(res.status).toBe(200);
        const row = (await env.WUYA.prepare("SELECT parse_mode, parse_param FROM domains WHERE target_domain = ?")
            .bind(`${prefix}.example.com`)
            .first()) as { parse_mode: string; parse_param: string | null };
        expect(row.parse_mode).toBe("auto");
        expect(row.parse_param).toBeNull();
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind(`${prefix}.example.com`).run();
    });

    it("json_path 缺少解析参数时返回 400", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: "https://example.com/ips.json",
            parse_mode: "json_path",
            target_domain_prefix: "no-param",
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("json_path");
    });

    it("source_type 非法时返回 400", async () => {
        const cookie = await loginAndGetCookie();
        const res = await postDomain(cookie, { source_type: "ftp", target_domain_prefix: "bad-type" });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("source_type");
    });

    it("系统预设域名不允许切换输入类型（403）", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, 1, 60, ?, 1)"
        )
            .bind("internal:hostmonit:lt", "lt.example.com", "test-zone-id", "系统")
            .run();
        const sysRow = (await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?")
            .bind("lt.example.com")
            .first()) as { id: number };
        const res = await SELF.fetch(`https://example.com/api/domains/${sysRow.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                source_type: "url",
                source_url: "https://example.com/ips.txt",
                source_domain: "internal:hostmonit:lt",
                target_domain_prefix: "lt",
                ttl: 60,
            }),
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("不允许切换输入类型");
        const after = (await env.WUYA.prepare("SELECT source_domain, source_type FROM domains WHERE id = ?")
            .bind(sysRow.id)
            .first()) as { source_domain: string; source_type: string | null };
        expect(after.source_domain).toBe("internal:hostmonit:lt");
        expect(after.source_type).toBeNull();
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind("lt.example.com").run();
    });

    it("PUT 未显式传 source_type 时沿用该行已有类型（URL 保持 URL）", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, source_type, source_url, parse_mode, parse_param, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 60, NULL, 0)"
        )
            .bind(
                "ips.example.com",
                "url",
                "https://ips.example.com/list.txt",
                "auto",
                null,
                "url-keep.example.com",
                "test-zone-id"
            )
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?")
            .bind("url-keep.example.com")
            .first()) as { id: number };
        const res = await SELF.fetch(`https://example.com/api/domains/${row.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                source_url: "https://ips.example.com/list-v2.txt",
                target_domain_prefix: "url-keep",
                ttl: 60,
            }),
        });
        expect(res.status).toBe(200);
        const after = (await env.WUYA.prepare(
            "SELECT source_type, source_url, source_domain, is_deep_resolve FROM domains WHERE id = ?"
        )
            .bind(row.id)
            .first()) as {
            source_type: string;
            source_url: string;
            source_domain: string;
            is_deep_resolve: number;
        };
        expect(after.source_type).toBe("url");
        expect(after.source_url).toBe("https://ips.example.com/list-v2.txt");
        expect(after.source_domain).toBe("ips.example.com");
        expect(after.is_deep_resolve).toBe(0);
        await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(row.id).run();
    });

    it("从 URL 切回域名时清空 URL 相关列与历史策略", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, source_type, source_url, parse_mode, parse_param, fetch_strategy, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 60, NULL, 0)"
        )
            .bind(
                "ips.example.com",
                "url",
                "https://ips.example.com/list.txt",
                "auto",
                null,
                "jina_reader",
                "url-to-domain.example.com",
                "test-zone-id"
            )
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?")
            .bind("url-to-domain.example.com")
            .first()) as { id: number };
        const res = await SELF.fetch(`https://example.com/api/domains/${row.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                source_type: "domain",
                source_domain: "target.example.com",
                target_domain_prefix: "url-to-domain",
                ttl: 60,
            }),
        });
        expect(res.status).toBe(200);
        const after = (await env.WUYA.prepare(
            "SELECT source_type, source_url, parse_mode, parse_param, fetch_strategy, source_domain FROM domains WHERE id = ?"
        )
            .bind(row.id)
            .first()) as {
            source_type: string;
            source_url: string | null;
            parse_mode: string | null;
            parse_param: string | null;
            fetch_strategy: string | null;
            source_domain: string;
        };
        expect(after.source_type).toBe("domain");
        expect(after.source_domain).toBe("target.example.com");
        expect(after.source_url).toBeNull();
        expect(after.parse_mode).toBeNull();
        expect(after.parse_param).toBeNull();
        expect(after.fetch_strategy).toBeNull();
        await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(row.id).run();
    });

    it("GET /api/domains 投影包含 URL 类型字段", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: "https://projection.example.com/list.txt",
            parse_mode: "lines",
            target_domain_prefix: "url-proj",
            ttl: 60,
        });
        expect(res.status).toBe(200);
        const listRes = await SELF.fetch("https://example.com/api/domains", { headers: { Cookie: cookie } });
        const list = (await listRes.json()) as Record<string, unknown>[];
        const target = list.find((d) => d.target_domain === "url-proj.example.com");
        expect(target).toBeDefined();
        expect(target?.source_type).toBe("url");
        expect(target?.source_url).toBe("https://projection.example.com/list.txt");
        expect(target?.parse_mode).toBe("lines");
        expect(target?.parse_param).toBeNull();
        expect(target).toHaveProperty("fetch_strategy");
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind("url-proj.example.com").run();
    });

    it("IPv6 字面量 URL 的派生主机名不合规时拒绝保存（§9.5）", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        const res = await postDomain(cookie, {
            source_type: "url",
            source_url: "http://[2606:4700::1111]/list.txt",
            target_domain_prefix: "url-ipv6",
            ttl: 60,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("主机名格式无效");
        const rows = await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?")
            .bind("url-ipv6.example.com")
            .all();
        expect(rows.results.length).toBe(0);
    });

    it("URL 改动后不沿用为旧 URL 缓存的历史策略", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, source_type, source_url, parse_mode, parse_param, fetch_strategy, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 60, NULL, 0)"
        )
            .bind(
                "ips.example.com",
                "url",
                "https://ips.example.com/list.txt",
                "auto",
                null,
                "jina_reader",
                "url-strategy.example.com",
                "test-zone-id"
            )
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?")
            .bind("url-strategy.example.com")
            .first()) as { id: number };
        const res = await SELF.fetch(`https://example.com/api/domains/${row.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                source_url: "https://other.example.com/list.txt",
                target_domain_prefix: "url-strategy",
                ttl: 60,
            }),
        });
        expect(res.status).toBe(200);
        const after = (await env.WUYA.prepare("SELECT source_url, fetch_strategy FROM domains WHERE id = ?")
            .bind(row.id)
            .first()) as { source_url: string; fetch_strategy: string | null };
        expect(after.source_url).toBe("https://other.example.com/list.txt");
        expect(after.fetch_strategy).toBeNull();
        await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(row.id).run();
    });

    it("PUT 保留原 URL 时不丢弃已探测到的策略", async () => {
        const cookie = await loginAndGetCookie();
        await seedCfSettings();
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, source_type, source_url, parse_mode, parse_param, fetch_strategy, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 60, NULL, 0)"
        )
            .bind(
                "ips.example.com",
                "url",
                "https://ips.example.com/list.txt",
                "auto",
                null,
                "jina_reader",
                "url-keep-strategy.example.com",
                "test-zone-id"
            )
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM domains WHERE target_domain = ?")
            .bind("url-keep-strategy.example.com")
            .first()) as { id: number };
        const res = await SELF.fetch(`https://example.com/api/domains/${row.id}`, {
            method: "PUT",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                source_url: "https://ips.example.com/list.txt",
                target_domain_prefix: "url-keep-strategy",
                ttl: 300,
            }),
        });
        expect(res.status).toBe(200);
        const after = (await env.WUYA.prepare("SELECT fetch_strategy, ttl FROM domains WHERE id = ?")
            .bind(row.id)
            .first()) as { fetch_strategy: string | null; ttl: number };
        expect(after.fetch_strategy).toBe("jina_reader");
        expect(after.ttl).toBe(300);
        await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(row.id).run();
    });
});
