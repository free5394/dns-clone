// smoke.test.ts — 阶段 F：环境冒烟测试（验证 worker 内 D1 + SELF 可用）
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("smoke", () => {
    it("has WUYA D1 binding with seeded tables", async () => {
        const { results } = await env.WUYA.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        ).all();
        const names = results.map((r: { name: string }) => r.name);
        expect(names).toContain("settings");
        expect(names).toContain("domains");
    });

    it("seeded ADMIN_PASSWORD_HASH setting exists", async () => {
        const row = await env.WUYA.prepare(
            "SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'"
        ).first();
        expect(row).not.toBeNull();
    });

    it("SELF serves /api/status as unauthenticated 200", async () => {
        const res = await SELF.fetch("https://example.com/api/status");
        expect(res.status).toBe(200);
        const body = await res.json() as { isInitialized: boolean };
        expect(body.isInitialized).toBe(true);
    });
});
