// migrations.test.ts — D1 迁移幂等性 + 门控写入（I1）
import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { ensureInitialData, initializeAndMigrateDatabase } from "../src/db/migrations.ts";

describe("D1 migrations", () => {
    it("applyD1Migrations runs twice without throwing", async () => {
        const migrations = (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
            .TEST_MIGRATIONS;
        // 第一遍已在 setupFiles（apply-migrations.ts）跑过；这里再跑两遍验证幂等
        await applyD1Migrations(env.WUYA, migrations);
        await applyD1Migrations(env.WUYA, migrations);
        // 若抛异常则测试失败；再验证表结构存在
        const tables = await env.WUYA.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'domains', 'sessions', 'ip_sources') ORDER BY name"
        ).all();
        expect(tables.results.map((r: { name: string }) => r.name)).toEqual([
            "domains",
            "ip_sources",
            "sessions",
            "settings",
        ]);
    });

    it("initializeAndMigrateDatabase writes last_migrated_at gate even without CF credentials (I1)", async () => {
        // 测试库未配置 CF_API_TOKEN/CF_ZONE_ID：旧实现在凭据检查处提前 return，
        // 门控永不落库 → 每次请求都重跑全量 DDL。契约：门控写入不得依赖 CF 凭据。
        await initializeAndMigrateDatabase({ WUYA: env.WUYA });

        const gate = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'last_migrated_at'").first();
        expect(gate).not.toBeNull();
    });

    it("同一 zone 只初始化一次，切换 zone 后重新初始化", async () => {
        const firstZone = "marker-zone-1";
        const secondZone = "marker-zone-2";
        await ensureInitialData(env.WUYA, firstZone, "first.example.com");

        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = 'yd.first.example.com'").run();
        await ensureInitialData(env.WUYA, firstZone, "first.example.com");
        const sameZoneRow = await env.WUYA.prepare(
            "SELECT id FROM domains WHERE target_domain = 'yd.first.example.com'"
        ).first();
        expect(sameZoneRow).toBeNull();

        await ensureInitialData(env.WUYA, secondZone, "second.example.com");
        const marker = (await env.WUYA.prepare(
            "SELECT value FROM settings WHERE key = 'INITIALIZED_ZONE_ID'"
        ).first()) as { value: string };
        const secondZoneRow = await env.WUYA.prepare(
            "SELECT id FROM domains WHERE target_domain = 'yd.second.example.com'"
        ).first();
        expect(marker.value).toBe(secondZone);
        expect(secondZoneRow).not.toBeNull();
    });

    it("bootstraps a fully empty database without throwing (FIX-19)", async () => {
        // FIX-19 回归：全新空库连 settings 表都没有，门控读取抛 no such table，
        // 旧实现在建表 DDL 之前就崩溃 → 首个请求永久 500。契约：空库必须能自举。
        await env.WUYA.batch([
            env.WUYA.prepare("DROP TABLE IF EXISTS login_attempts"),
            env.WUYA.prepare("DROP TABLE IF EXISTS ip_sources"),
            env.WUYA.prepare("DROP TABLE IF EXISTS sessions"),
            env.WUYA.prepare("DROP TABLE IF EXISTS domains"),
            env.WUYA.prepare("DROP TABLE IF EXISTS settings"),
        ]);

        await expect(initializeAndMigrateDatabase({ WUYA: env.WUYA })).resolves.not.toThrow();

        // 5 张表全部重建
        const tables = await env.WUYA.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'domains', 'sessions', 'login_attempts', 'ip_sources') ORDER BY name"
        ).all();
        expect(tables.results.map((r: { name: string }) => r.name)).toEqual([
            "domains",
            "ip_sources",
            "login_attempts",
            "sessions",
            "settings",
        ]);

        // 门控已写入，下次请求不再重跑 DDL
        const gate = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'last_migrated_at'").first();
        expect(gate).not.toBeNull();
    });
});
