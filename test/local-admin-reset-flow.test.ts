// local-admin-reset-flow.test.ts — 「pnpm reset:local-admin 之后能重新登录」的端到端语义
// 直接执行脚本会执行的同一串语句，再走真实 HTTP 端点，避免把「语句写对了」误当成「用户能登录」。
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildResetStatements, generateSalt, hashPassword } from "../scripts/reset-local-admin-lib.mjs";

const NEW_PASSWORD = "flow-pass-2026";

async function run(statements: string[]): Promise<void> {
    await env.WUYA.batch(statements.map((sql) => env.WUYA.prepare(sql)));
}

function post(path: string, body: unknown): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("本地重置脚本 → 初始化页 → 登录", () => {
    it("默认模式（删两行）后 /api/status 变未初始化，/api/setup 能重设密码并立即登录", async () => {
        await run(buildResetStatements());

        const status = (await (await SELF.fetch("https://example.com/api/status")).json()) as {
            isInitialized: boolean;
        };
        expect(status.isInitialized).toBe(false);

        expect((await post("/api/setup", { password: NEW_PASSWORD })).status).toBe(200);
        const login = await post("/api/login", { password: NEW_PASSWORD });
        expect(login.status).toBe(200);
        expect(login.headers.get("Set-Cookie")).toContain("session=");
    });

    it("--password 模式（写哈希）后无需初始化页，旧密码失效、新密码可登录", async () => {
        const salt = generateSalt();
        const hash = await hashPassword(NEW_PASSWORD, salt);
        await run(buildResetStatements({ hash, salt }));

        const status = (await (await SELF.fetch("https://example.com/api/status")).json()) as {
            isInitialized: boolean;
        };
        expect(status.isInitialized).toBe(true);

        // 库被重置后 /api/setup 应当已关闭，避免第二人再抢设密码
        expect((await post("/api/setup", { password: "another-pass-1" })).status).toBe(403);
        expect((await post("/api/login", { password: "test-password-123" })).status).toBe(401);
        expect((await post("/api/login", { password: NEW_PASSWORD })).status).toBe(200);
    });
});
