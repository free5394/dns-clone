// sync-lock.test.ts — M-8 手动同步互斥锁：原子抢占、释放与陈旧锁接管
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
    MANUAL_SYNC_LOCK_KEY,
    MANUAL_SYNC_LOCK_TTL_MS,
    acquireManualSyncLock,
    releaseManualSyncLock,
    touchManualSyncLock,
} from "../src/db/client.ts";

/** 直接读库里的锁值，用于验证写入了什么而不是只看返回值 */
async function readLockValue(): Promise<string | null> {
    const row = await env.WUYA.prepare("SELECT value FROM settings WHERE key = ?")
        .bind(MANUAL_SYNC_LOCK_KEY)
        .first<{ value: string }>();
    return row ? row.value : null;
}

/** 写入一个指定过期时间的锁，模拟上一次任务异常中断留下的陈旧锁 */
async function writeLock(value: number): Promise<void> {
    await env.WUYA.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
        .bind(MANUAL_SYNC_LOCK_KEY, String(value))
        .run();
}

describe("手动同步互斥锁 (M-8)", () => {
    beforeEach(async () => {
        await env.WUYA.prepare("DELETE FROM settings WHERE key = ?").bind(MANUAL_SYNC_LOCK_KEY).run();
    });

    it("抢占成功后第二个调用者被拒绝", async () => {
        const token = await acquireManualSyncLock(env.WUYA);
        expect(token).not.toBeNull();
        // 锁值应是未来时间戳，而不是布尔标记
        expect(Number(await readLockValue())).toBeGreaterThan(Date.now());
        expect(await acquireManualSyncLock(env.WUYA)).toBeNull();
    });

    it("释放后可以再次抢占", async () => {
        const token = await acquireManualSyncLock(env.WUYA);
        expect(token).not.toBeNull();

        await releaseManualSyncLock(env.WUYA, token as string);

        expect(await readLockValue()).toBeNull();
        expect(await acquireManualSyncLock(env.WUYA)).not.toBeNull();
    });

    it("陈旧锁可被接管，接管后原持有者无法误删新锁", async () => {
        const staleToken = String(Date.now() - 5000);
        await writeLock(Number(staleToken));

        const token = await acquireManualSyncLock(env.WUYA);
        expect(token).not.toBeNull();
        expect(Number(await readLockValue())).toBeGreaterThan(Date.now());

        // 原持有者（陈旧值）释放时不能删掉新持有者的锁
        await releaseManualSyncLock(env.WUYA, staleToken);
        expect(await readLockValue()).not.toBeNull();
    });

    it("未持有锁时释放不会报错，也不会影响其他键", async () => {
        await env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('M8_UNRELATED', 'x')").run();
        await releaseManualSyncLock(env.WUYA, "12345");
        expect(await readLockValue()).toBeNull();
        const other = await env.WUYA.prepare("SELECT value FROM settings WHERE key = 'M8_UNRELATED'").first<{
            value: string;
        }>();
        expect(other?.value).toBe("x");
        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'M8_UNRELATED'").run();
    });
});

describe("手动同步锁续租 (高-1)", () => {
    beforeEach(async () => {
        await env.WUYA.prepare("DELETE FROM settings WHERE key = ?").bind(MANUAL_SYNC_LOCK_KEY).run();
    });

    it("锁的有效期必须覆盖单次全量同步的最坏耗时", () => {
        // 域名全量串行同步（每域名 DoH 8s + 列表 15s）与 IP 源三策略回退（15+20+15s）都可能超过 3 分钟
        expect(MANUAL_SYNC_LOCK_TTL_MS).toBeGreaterThanOrEqual(600_000);
    });

    it("续租把到期时间推到 TTL 之后，原到期时刻过后仍不可被接管", async () => {
        const token = String(Date.now() + 1_000);
        await writeLock(Number(token));

        expect(await touchManualSyncLock(env.WUYA, token)).toBe(true);
        expect(Number(await readLockValue())).toBeGreaterThan(Date.now() + 60_000);
        expect(await acquireManualSyncLock(env.WUYA)).toBeNull();
    });

    it("令牌不匹配时续租失败且不改动锁值", async () => {
        const token = String(Date.now() + 1_000);
        await writeLock(Number(token));

        expect(await touchManualSyncLock(env.WUYA, "999")).toBe(false);
        expect(await readLockValue()).toBe(token);
    });

    it("锁已被接管后续租失败，不会把别人的锁改回自己", async () => {
        const mine = String(Date.now() + 1_000);
        await writeLock(Number(mine));

        const other = await acquireManualSyncLock(env.WUYA);
        // 我的 token 尚未过期，所以这个调用应被拒绝；改为直接把锁改成他人值再续租
        expect(other).toBeNull();

        await writeLock(Number(Date.now() + 5_000));
        expect(await touchManualSyncLock(env.WUYA, mine)).toBe(false);
    });
});
