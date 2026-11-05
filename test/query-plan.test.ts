// query-plan.test.ts — M-11：定时取批的排序必须走索引，不得退回临时 B 树排序
// 这两个查询是定时任务的热路径：表一旦变大，全表扫描 + 临时 B 树排序会成为每轮固定开销。
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { initializeAndMigrateDatabase } from "../src/db/migrations.ts";

const DOMAINS_BATCH_SQL = `SELECT * FROM domains
    WHERE is_enabled = 1
    ORDER BY CASE last_sync_status WHEN 'failed' THEN 0 ELSE 1 END, last_synced_time ASC
    LIMIT 10`;

const IP_SOURCES_BATCH_SQL = `SELECT id FROM ip_sources
    WHERE is_enabled = 1
    ORDER BY CASE last_sync_status WHEN 'failed' THEN 0 ELSE 1 END, last_synced_time ASC
    LIMIT 10`;

async function queryPlan(sql: string): Promise<string[]> {
    const result = await env.WUYA.prepare("EXPLAIN QUERY PLAN " + sql).all();
    return (result.results as Array<{ detail: string }>).map((row) => row.detail);
}

describe("定时取批查询计划 (M-11)", () => {
    beforeAll(async () => {
        await initializeAndMigrateDatabase({ WUYA: env.WUYA });
    });

    it("取批查询命中表达式索引且不做临时排序", async () => {
        const domainsPlan = await queryPlan(DOMAINS_BATCH_SQL);
        expect(domainsPlan.join("\n")).toContain("idx_domains_batch");
        expect(domainsPlan.join("\n")).not.toContain("TEMP B-TREE");

        const ipPlan = await queryPlan(IP_SOURCES_BATCH_SQL);
        expect(ipPlan.join("\n")).toContain("idx_ip_sources_batch");
        expect(ipPlan.join("\n")).not.toContain("TEMP B-TREE");
    });

    it("索引保持失败优先的顺序语义", async () => {
        const db = env.WUYA;
        await db.prepare("DELETE FROM domains").run();
        const insert = db.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_enabled, last_sync_status, last_synced_time) VALUES (?, ?, 'z', 1, ?, ?)"
        );
        await db.batch([
            insert.bind("s1", "t1.example.com", "success", "2026-01-01T00:00:00Z"),
            insert.bind("s2", "t2.example.com", "failed", "2026-03-01T00:00:00Z"),
            insert.bind("s3", "t3.example.com", "never", null),
            insert.bind("s4", "t4.example.com", "failed", "2026-02-01T00:00:00Z"),
        ]);

        const rows = await db
            .prepare(
                "SELECT target_domain FROM domains WHERE is_enabled = 1 ORDER BY CASE last_sync_status WHEN 'failed' THEN 0 ELSE 1 END, last_synced_time ASC"
            )
            .all();
        const order = (rows.results as Array<{ target_domain: string }>).map((row) => row.target_domain);
        // 失败优先，且失败组内按上次同步时间升序；其余按时间升序（NULL 在前）
        expect(order).toEqual(["t4.example.com", "t2.example.com", "t3.example.com", "t1.example.com"]);
    });
});
