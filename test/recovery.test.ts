// recovery.test.ts — POST /api/recover 恢复入口（令牌门控、限流、原子替换）
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApiRequest } from "../src/routes/api.ts";
import { hashPassword, verifyPassword } from "../src/util/auth.ts";

const TOKEN = "test-recovery-token";
const NEW_PASSWORD = "recovered-pass-2026";
/** 种子密码，见 test/apply-migrations.ts */
const SEED_PASSWORD = "test-password-123";
const SEED_SALT = "test-salt";
const CLIENT_IP = "203.0.113.9";

const upsertSetting = (key: string, value: string) =>
    env.WUYA.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(key, value);

/** 每个用例都从种子密码开始：恢复成功会改掉哈希，串味会让后续断言失去意义 */
async function restoreSeedPassword(): Promise<void> {
    const hash = await hashPassword(SEED_PASSWORD, SEED_SALT);
    await env.WUYA.batch([
        upsertSetting("ADMIN_PASSWORD_HASH", hash),
        upsertSetting("PASSWORD_SALT", SEED_SALT),
        env.WUYA.prepare("DELETE FROM sessions"),
        env.WUYA.prepare("DELETE FROM login_attempts"),
    ]);
}

async function postRecover(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return SELF.fetch("https://example.com/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": CLIENT_IP, ...headers },
        body: JSON.stringify(body),
    });
}

async function login(password: string): Promise<Response> {
    return SELF.fetch("https://example.com/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": CLIENT_IP },
        body: JSON.stringify({ password }),
    });
}

async function countRows(sql: string): Promise<number> {
    const row = (await env.WUYA.prepare(sql).first()) as { n: number };
    return row.n;
}

// 显式省略 RECOVERY_TOKEN 调用分发器，模拟「部署方没配令牌」的实例
const noTokenEnv = { WUYA: env.WUYA };

function recoverRequest(headers: Record<string, string> = {}): Request {
    return new Request("https://example.com/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ token: TOKEN, password: NEW_PASSWORD }),
    });
}

describe("/api/recover 未配置令牌时与未知路径不可区分", () => {
    beforeEach(restoreSeedPassword);

    it("未登录时与未知路径同为 401 且响应体相同，失败记录不增加", async () => {
        const res = await handleApiRequest(recoverRequest(), noTokenEnv);
        const unknown = await handleApiRequest(new Request("https://example.com/api/does-not-exist"), noTokenEnv);

        expect(res.status).toBe(401);
        expect(unknown.status).toBe(401);
        expect(await res.json()).toEqual(await unknown.json());
        expect(await countRows("SELECT COUNT(*) AS n FROM login_attempts")).toBe(0);
    });

    it("已登录时与未知路径同为 404 且响应体相同，密码与会话不变", async () => {
        const setCookie = (await login(SEED_PASSWORD)).headers.get("Set-Cookie") as string;
        const cookie = setCookie.split(";")[0];
        const res = await handleApiRequest(recoverRequest({ Cookie: cookie }), noTokenEnv);
        const unknown = await handleApiRequest(
            new Request("https://example.com/api/does-not-exist", { headers: { Cookie: cookie } }),
            noTokenEnv
        );

        expect(res.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(await res.json()).toEqual(await unknown.json());

        // 会话仍在、新密码登不进去，说明这条请求没改动任何认证状态
        expect(await countRows("SELECT COUNT(*) AS n FROM sessions")).toBe(1);
        expect((await login(NEW_PASSWORD)).status).toBe(401);
    });
});

describe("/api/recover 令牌校验", () => {
    beforeEach(restoreSeedPassword);

    it("令牌错误返回 401 并记一次失败", async () => {
        const res = await postRecover({ token: "wrong-token", password: NEW_PASSWORD });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/恢复令牌无效/);
        expect(await countRows("SELECT COUNT(*) AS n FROM login_attempts WHERE success = 0")).toBe(1);
    });

    it("缺令牌字段按令牌错误处理", async () => {
        const res = await postRecover({ password: NEW_PASSWORD });
        expect(res.status).toBe(401);
    });

    it("非法 JSON 返回 400", async () => {
        const res = await SELF.fetch("https://example.com/api/recover", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": CLIENT_IP },
            body: "{not-json",
        });
        expect(res.status).toBe(400);
    });

    it("令牌正确但密码过短返回 400，且不改动密码与会话", async () => {
        await env.WUYA.prepare("INSERT INTO sessions (token, expires_at) VALUES ('keep-me', ?)")
            .bind(new Date(Date.now() + 60_000).toISOString())
            .run();
        const res = await postRecover({ token: TOKEN, password: "short7c" });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/8 到 1024/);
        expect(await countRows("SELECT COUNT(*) AS n FROM sessions")).toBe(1);
        expect((await login(SEED_PASSWORD)).status).toBe(200);
    });

    it("连续 5 次错误令牌后第 6 次被限流 429", async () => {
        for (let i = 0; i < 5; i++) {
            expect((await postRecover({ token: "wrong-token", password: NEW_PASSWORD })).status).toBe(401);
        }
        expect(await countRows("SELECT COUNT(*) AS n FROM login_attempts WHERE success = 0")).toBe(5);
        const limited = await postRecover({ token: "wrong-token", password: NEW_PASSWORD });
        expect(limited.status).toBe(429);
        const body = (await limited.json()) as { error: string };
        expect(body.error).toMatch(/过于频繁/);
    });
});

describe("/api/recover 恢复成功", () => {
    beforeEach(restoreSeedPassword);

    it("替换密码、清空会话与失败记录，新密码可登录、旧密码失效、旧 Cookie 被踢下线", async () => {
        const staleToken = "stale-session-token";
        await env.WUYA.batch([
            env.WUYA.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(
                staleToken,
                new Date(Date.now() + 3_600_000).toISOString()
            ),
            env.WUYA.prepare("INSERT INTO login_attempts (ip, success) VALUES (?, 0)").bind(CLIENT_IP),
            // 另一 IP 的失败记录：恢复入口是有意清全表，不是只清调用方 IP（与 /api/login 不同），
            // 否则刚重置完仍可能被别处的失败计数挡在限流外
            env.WUYA.prepare("INSERT INTO login_attempts (ip, success) VALUES (?, 0)").bind("198.51.100.77"),
        ]);

        const res = await postRecover({ token: TOKEN, password: NEW_PASSWORD });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true });

        // 会话与失败记录被清空，旧 Cookie 立刻失效
        expect(await countRows("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
        expect(await countRows("SELECT COUNT(*) AS n FROM login_attempts")).toBe(0);
        const guarded = await SELF.fetch("https://example.com/api/settings", {
            headers: { Cookie: `session=${staleToken}` },
        });
        expect(guarded.status).toBe(401);

        // 库里的哈希能被 Worker 侧 verifyPassword 验通（哈希与盐成对替换）
        const hashRow = (await env.WUYA.prepare(
            "SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'"
        ).first()) as {
            value: string;
        };
        const saltRow = (await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'PASSWORD_SALT'").first()) as {
            value: string;
        };
        expect((await verifyPassword(NEW_PASSWORD, hashRow.value, saltRow.value)).matched).toBe(true);

        expect((await login(NEW_PASSWORD)).status).toBe(200);
        expect((await login(SEED_PASSWORD)).status).toBe(401);
    });
});
