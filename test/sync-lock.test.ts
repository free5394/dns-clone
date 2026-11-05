// sync-lock.test.ts — M-8 手动同步互斥锁：原子抢占、释放与陈旧锁接管
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { MANUAL_SYNC_LOCK_KEY, acquireManualSyncLock, releaseManualSyncLock } from "../src/db/client.ts";

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
