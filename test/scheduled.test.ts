// scheduled.test.ts — 用例 5：scheduled() 轮转
// 覆盖 plan v2 用例表：#5 scheduled 轮转（next_sync_task 从 domains 切换到 ip_sources）
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index.ts";

describe("scheduled handler", () => {
    it("rotates next_sync_task from domains to ip_sources", async () => {
        // 置初值
        await env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('next_sync_task', 'domains') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

        const ctx = createExecutionContext();
        const controller = createScheduledController({
            scheduledTime: new Date(1000),
            cron: "* * * * *",
        });
        await worker.scheduled(controller, env, ctx);
        await waitOnExecutionContext(ctx);

        // 验证轮转：domains → ip_sources
        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'next_sync_task'").first() as { value: string };
        expect(row.value).toBe("ip_sources");
    });

    it("rotates next_sync_task from ip_sources back to domains", async () => {
        await env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('next_sync_task', 'ip_sources') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

        const ctx = createExecutionContext();
        const controller = createScheduledController({
            scheduledTime: new Date(1000),
            cron: "* * * * *",
        });
        await worker.scheduled(controller, env, ctx);
        await waitOnExecutionContext(ctx);

        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'next_sync_task'").first() as { value: string };
        expect(row.value).toBe("domains");
    });
});

describe("scheduled handler resilience (Task 1.2 状态机)", () => {
    it("still rotates next_sync_task even when sync throws", async () => {
        // 注入坏数据让 syncScheduledDomains 抛错：缺 CF 凭据
        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'CF_API_TOKEN'").run();
        await env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('next_sync_task', 'domains') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

        const ctx = createExecutionContext();
        const controller = createScheduledController({
            scheduledTime: new Date(1000),
            cron: "* * * * *",
        });
        await worker.scheduled(controller, env, ctx);
        await waitOnExecutionContext(ctx);

        // 关键：sync 失败时状态仍要轮转（先 setSetting 再 sync 的实现保证）
        const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'next_sync_task'").first() as { value: string };
        expect(row.value).toBe("ip_sources");
    });
});
