// migrations.test.ts — D1 迁移幂等性 + 门控写入（I1）
import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { initializeAndMigrateDatabase } from "../src/db/migrations.ts";

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

    it("initializeAndMigrateDatabase writes last_migrated_at gate even without CF credentials (I1)", async () => {
        // 测试库未配置 CF_API_TOKEN/CF_ZONE_ID：旧实现在凭据检查处提前 return，
        // 门控永不落库 → 每次请求都重跑全量 DDL。契约：门控写入不得依赖 CF 凭据。
        await initializeAndMigrateDatabase({ WUYA: env.WUYA });

        const gate = await env.WUYA.prepare(
            "SELECT value FROM settings WHERE key = 'last_migrated_at'"
        ).first();
        expect(gate).not.toBeNull();
    });
});
