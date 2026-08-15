// scheduled-domains.test.ts — syncScheduledDomains 定时任务主路径
//
// 背景：该函数曾因 `const db` 声明晚于首次使用（TDZ）而每次调用必抛 ReferenceError，
// 定时任务的域名同步分支从未成功执行过。原 scheduled.test.ts 只断言 next_sync_task
// 轮转、且 index.ts 用 try/catch 吞掉了异常，故一直未被发现。
//
// 这里断言"同步确实跑到了"而非"没抛错"：验证 BATCH_SIZE 被读取并生效、
// 失败优先排序生效、单域名失败不中断整批。
import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncScheduledDomains } from "../src/sync/domains.ts";

/** 造 n 条启用域名 */
async function seedDomains(specs: { target: string; status?: string; syncedAt?: string | null }[]): Promise<void> {
    await env.WUYA.batch(specs.map(({ target, status = "pending", syncedAt = null }) =>
        env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, is_enabled, last_sync_status, last_synced_time) VALUES (?, ?, 'test-zone-id', 0, 60, 1, ?, ?)"
        ).bind(`src-${target}`, target, status, syncedAt)
    ));
}

/** 让 DoH 返回一条 CNAME、CF API 返回空列表：同步可完整走通 */
function stubHappyPathFetch() {
    const spy = vi.fn(async (url: string) => {
        if (url.includes("dns-query") || url.includes("cloudflare-dns.com")) {
            return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "cname-target.example.com." }] }), { status: 200 });
        }
        if (url.includes("api.cloudflare.com")) {
            return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
        }
        throw new Error(`未预期的 URL: ${url}`);
    });
    vi.stubGlobal("fetch", spy);
    return spy;
}

beforeEach(async () => {
    // 每个用例独占一套干净的 domains + CF 凭据
    await env.WUYA.prepare("DELETE FROM domains").run();
    await env.WUYA.batch([
        env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-cf-token"),
        env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("test-zone-id"),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await env.WUYA.prepare("DELETE FROM domains").run();
    await env.WUYA.prepare("DELETE FROM settings WHERE key = 'BATCH_SIZE'").run();
});

describe("syncScheduledDomains batch execution", () => {
    it("sync runs: domain status transitions pending to success (TDZ regression)", async () => {
        await seedDomains([{ target: "a.example.com" }]);
        stubHappyPathFetch();

        // 此前这行必抛 ReferenceError: Cannot access 'db' before initialization
        await expect(syncScheduledDomains(env)).resolves.toBeUndefined();

        const row = await env.WUYA.prepare(
            "SELECT last_sync_status FROM domains WHERE target_domain = 'a.example.com'"
        ).first() as { last_sync_status: string };
        // 关键：状态被改写，证明同步真正跑到了（而非静默抛错被吞）
        expect(row.last_sync_status).toBe("success");
    });

    it("BATCH_SIZE=2 only processes 2 rows, rest stay pending", async () => {
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('BATCH_SIZE', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        await seedDomains([
            { target: "b1.example.com" }, { target: "b2.example.com" },
            { target: "b3.example.com" }, { target: "b4.example.com" },
        ]);
        stubHappyPathFetch();

        await syncScheduledDomains(env);

        const { results } = await env.WUYA.prepare(
            "SELECT last_sync_status, COUNT(*) as n FROM domains GROUP BY last_sync_status"
        ).all() as { results: { last_sync_status: string; n: number }[] };
        const byStatus = Object.fromEntries(results.map((r) => [r.last_sync_status, r.n]));

        // 关键：BATCH_SIZE 真的限制了取数条数，而非"没抛错"就算过
        expect(byStatus.success).toBe(2);
        expect(byStatus.pending).toBe(2);
    });

    it("invalid BATCH_SIZE (non-numeric) falls back to default 10", async () => {
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('BATCH_SIZE', 'not-a-number') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        // 造 11 条：默认 10 生效则应剩 1 条 pending
        await seedDomains(Array.from({ length: 11 }, (_, i) => ({ target: `c${i}.example.com` })));
        stubHappyPathFetch();

        await syncScheduledDomains(env);

        const row = await env.WUYA.prepare(
            "SELECT COUNT(*) as n FROM domains WHERE last_sync_status = 'success'"
        ).first() as { n: number };
        expect(row.n).toBe(10);
    });

    it("failure-first: failed domains picked before pending ones", async () => {
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('BATCH_SIZE', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        // 先插 pending（更早的 last_synced_time），再插 failed —— 若无失败优先排序，会取到 pending
        await seedDomains([
            { target: "old-pending.example.com", status: "pending", syncedAt: "2000-01-01 00:00:00" },
            { target: "prior-failed.example.com", status: "failed", syncedAt: "2099-01-01 00:00:00" },
        ]);
        stubHappyPathFetch();

        await syncScheduledDomains(env);

        const failed = await env.WUYA.prepare(
            "SELECT last_sync_status FROM domains WHERE target_domain = 'prior-failed.example.com'"
        ).first() as { last_sync_status: string };
        const pending = await env.WUYA.prepare(
            "SELECT last_sync_status FROM domains WHERE target_domain = 'old-pending.example.com'"
        ).first() as { last_sync_status: string };

        expect(failed.last_sync_status).toBe("success");   // 失败的被优先重试
        expect(pending.last_sync_status).toBe("pending");  // 未轮到
    });

    it("single domain failure does not abort the batch", async () => {
        await seedDomains([{ target: "d1.example.com" }, { target: "d2.example.com" }]);
        // d1 的 DoH 查询失败，d2 正常
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            if (url.includes("d1.example.com")) throw new Error("boom");
            if (url.includes("dns-query") || url.includes("cloudflare-dns.com")) {
                return new Response(JSON.stringify({ Status: 0, Answer: [{ data: "t.example.com." }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
        }));

        await expect(syncScheduledDomains(env)).resolves.toBeUndefined();

        const d2 = await env.WUYA.prepare(
            "SELECT last_sync_status FROM domains WHERE target_domain = 'd2.example.com'"
        ).first() as { last_sync_status: string };
        // d1 失败不应阻断 d2
        expect(d2.last_sync_status).toBe("success");
    });

    it("missing CF credentials safely exit without mutating domain state", async () => {
        await env.WUYA.prepare("DELETE FROM settings WHERE key IN ('CF_API_TOKEN', 'CF_ZONE_ID')").run();
        await seedDomains([{ target: "e1.example.com" }]);

        await expect(syncScheduledDomains(env)).resolves.toBeUndefined();

        const row = await env.WUYA.prepare(
            "SELECT last_sync_status FROM domains WHERE target_domain = 'e1.example.com'"
        ).first() as { last_sync_status: string };
        expect(row.last_sync_status).toBe("pending");
    });
});
