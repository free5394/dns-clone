// migrations.test.ts — D1 迁移幂等性 + 门控写入（I1）
import { env, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { describe, it, expect } from "vitest";
import { ensureInitialData, initializeAndMigrateDatabase, MIGRATION_VERSION } from "../src/db/migrations.ts";
import { DOMAIN_COLUMNS, IP_SOURCE_COLUMNS } from "../src/db/client.ts";

describe("D1 migrations", () => {
    it("applyD1Migrations runs twice without throwing", async () => {
        // issue #62：第三方签名同样用具名类型 D1Migration，不再按位置反推 applyD1Migrations 的第 2 个参数。
        const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
        // 第一遍已在 setupFiles（apply-migrations.ts）跑过；这里再跑两遍验证幂等
        await applyD1Migrations(env.WUYA, migrations);
        await applyD1Migrations(env.WUYA, migrations);
        // 若抛异常则测试失败；再验证表结构存在
        const tables = await env.WUYA.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'domains', 'sessions', 'ip_sources') ORDER BY name"
        ).all<{ name: string }>();
        expect(tables.results.map((r) => r.name)).toEqual(["domains", "ip_sources", "sessions", "settings"]);
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
        ).all<{ name: string }>();
        expect(tables.results.map((r) => r.name)).toEqual([
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

// issue #49（方案 §8.1/§8.2/§8.3）：迁移列 + 行投影 + 已部署实例立即生效
describe("issue #49：IP 抓取统一化新增列", () => {
    const NEW_DOMAIN_COLUMNS = ["source_type", "source_url", "parse_mode", "parse_param", "fetch_strategy"];
    const NEW_IP_SOURCE_COLUMNS = ["parse_mode", "parse_param"];

    async function columnInfo(table: string): Promise<Array<{ name: string; notnull: number }>> {
        const { results } = await env.WUYA.prepare(`PRAGMA table_info(${table})`).all<{
            name: string;
            notnull: number;
        }>();
        return results ?? [];
    }

    it("重复执行迁移不报错，新列已存在且全部可空（验收 ①）", async () => {
        await initializeAndMigrateDatabase({ WUYA: env.WUYA });
        await expect(initializeAndMigrateDatabase({ WUYA: env.WUYA })).resolves.not.toThrow();

        const domainColumns = await columnInfo("domains");
        for (const name of NEW_DOMAIN_COLUMNS) {
            const column = domainColumns.find((c) => c.name === name);
            expect(column, `domains.${name} 应存在`).toBeDefined();
            expect(column?.notnull, `domains.${name} 必须可空`).toBe(0);
        }
        const ipSourceColumns = await columnInfo("ip_sources");
        for (const name of NEW_IP_SOURCE_COLUMNS) {
            const column = ipSourceColumns.find((c) => c.name === name);
            expect(column, `ip_sources.${name} 应存在`).toBeDefined();
            expect(column?.notnull, `ip_sources.${name} 必须可空`).toBe(0);
        }
    });

    it("旧版本库缺列时补齐，版本号变化后不受 24 小时门控延迟（验收 ②）", async () => {
        // 构造「上个版本已部署」的现场：domains 是迁移前的旧结构，门控写着旧版本号且时间未满 24h
        await env.WUYA.prepare("DROP TABLE domains").run();
        await env.WUYA.prepare(
            `CREATE TABLE domains (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_domain TEXT NOT NULL,
                target_domain TEXT NOT NULL,
                zone_id TEXT NOT NULL,
                is_deep_resolve INTEGER NOT NULL DEFAULT 1,
                ttl INTEGER NOT NULL DEFAULT 60,
                notes TEXT,
                last_synced_records TEXT DEFAULT '[]',
                last_synced_time TIMESTAMP,
                last_sync_status TEXT DEFAULT 'pending',
                last_sync_error TEXT,
                is_enabled INTEGER DEFAULT 1 NOT NULL,
                is_system INTEGER NOT NULL DEFAULT 0,
                UNIQUE(target_domain)
            )`
        ).run();
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id) VALUES ('legacy.example.com', 'legacy.example.com', 'z')"
        ).run();
        await env.WUYA.batch([
            env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_migrated_at', ?)").bind(
                new Date().toISOString()
            ),
            env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_version', ?)").bind(
                "2026-11-07-index-guard"
            ),
        ]);

        await initializeAndMigrateDatabase({ WUYA: env.WUYA });

        const columnNames = (await columnInfo("domains")).map((c) => c.name);
        for (const name of NEW_DOMAIN_COLUMNS) expect(columnNames).toContain(name);
        const version = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'migration_version'").first<{
            value: string;
        }>();
        expect(version?.value).toBe(MIGRATION_VERSION);
        // 版本号已推进：下一次请求走「版本一致 + 未满 24h」的跳过分支，不再重跑 DDL
        const migratedAt = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'last_migrated_at'").first();
        expect(migratedAt).not.toBeNull();
    });

    it("旧行在域名与 IP 源投影里读出 null，而不是报错（验收 ③）", async () => {
        await initializeAndMigrateDatabase({ WUYA: env.WUYA });
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id) VALUES ('legacy-proj.example.com', 'legacy-proj.example.com', 'z') ON CONFLICT(target_domain) DO NOTHING"
        ).run();
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message) VALUES ('https://legacy.example.com/list.txt', 'legacy/list.txt', 'msg') ON CONFLICT(url) DO NOTHING"
        ).run();

        const domain = await env.WUYA.prepare(
            `SELECT ${DOMAIN_COLUMNS} FROM domains WHERE source_domain = 'legacy-proj.example.com'`
        ).first<Record<string, unknown>>();
        expect(domain).not.toBeNull();
        for (const name of NEW_DOMAIN_COLUMNS) expect(domain?.[name]).toBeNull();

        const ipSource = await env.WUYA.prepare(
            `SELECT ${IP_SOURCE_COLUMNS} FROM ip_sources WHERE github_path = 'legacy/list.txt'`
        ).first<Record<string, unknown>>();
        expect(ipSource).not.toBeNull();
        for (const name of NEW_IP_SOURCE_COLUMNS) expect(ipSource?.[name]).toBeNull();
    });
});
