// 迁移门控：从「纯时间」改为「版本 + 时间」双键
// 背景：24 小时门控会让新增或丢失的索引最长延迟 24 小时才生效，
// 部署新索引版本时 M-11 的性能收益会拖到下一个迁移窗口。

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { initializeAndMigrateDatabase, MIGRATION_VERSION } from "../src/db/migrations.ts";

async function indexNames(): Promise<string[]> {
    const { results } = await env.WUYA.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{
        name: string;
    }>();
    return (results ?? []).map((row) => row.name);
}

async function writeSetting(key: string, value: string): Promise<void> {
    await env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
}

describe("迁移门控：版本 + 时间双键", () => {
    it("版本不一致时，即使 24 小时内也要补齐丢失的索引", async () => {
        await initializeAndMigrateDatabase({ WUYA: env.WUYA });
        await env.WUYA.prepare("DROP INDEX idx_domains_batch").run();
        await writeSetting("last_migrated_at", new Date().toISOString());
        await writeSetting("migration_version", "stale-version");

        await initializeAndMigrateDatabase({ WUYA: env.WUYA });

        expect(await indexNames()).toContain("idx_domains_batch");
    });

    it("版本一致且未满 24 小时时跳过整套 DDL", async () => {
        await initializeAndMigrateDatabase({ WUYA: env.WUYA });
        await env.WUYA.prepare("DROP INDEX idx_ip_sources_batch").run();
        await writeSetting("last_migrated_at", new Date().toISOString());
        await writeSetting("migration_version", MIGRATION_VERSION);

        await initializeAndMigrateDatabase({ WUYA: env.WUYA });

        expect(await indexNames()).not.toContain("idx_ip_sources_batch");
    });

    it("迁移完成后同时写入版本与时间", async () => {
        await env.WUYA.prepare("DELETE FROM settings WHERE key IN ('migration_version', 'last_migrated_at')").run();

        await initializeAndMigrateDatabase({ WUYA: env.WUYA });

        const version = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'migration_version'").first<{
            value: string;
        }>();
        const migratedAt = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'last_migrated_at'").first<{
            value: string;
        }>();
        expect(typeof MIGRATION_VERSION).toBe("string");
        expect(MIGRATION_VERSION.length).toBeGreaterThan(0);
        expect(version?.value).toBe(MIGRATION_VERSION);
        expect(migratedAt?.value).toBeTruthy();
    });
});
