// migrations.test.ts — 用例 8/8：D1 迁移幂等性
import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("D1 migrations", () => {
    it("applyD1Migrations runs twice without throwing", async () => {
        const migrations = (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
        // 第一遍已在 setupFiles（apply-migrations.ts）跑过；这里再跑两遍验证幂等
        await applyD1Migrations(env.WUYA, migrations);
        await applyD1Migrations(env.WUYA, migrations);
        // 若抛异常则测试失败；再验证表结构存在
        const tables = await env.WUYA.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'domains', 'sessions', 'ip_sources') ORDER BY name"
        ).all();
        expect(tables.results.map((r: { name: string }) => r.name)).toEqual(["domains", "ip_sources", "sessions", "settings"]);
    });
});
