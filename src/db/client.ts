// client.ts — D1 数据库统一访问层
// 后续所有 sync 的唯一 DB 入口（阶段 D 起使用）；本阶段先承载 settings 读取

import { SENSITIVE_SETTINGS_KEYS } from "./settings.ts";

/** 查询全部结果（泛型版） */
export async function queryAll<T = unknown>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T[]> {
    const { results } = await db
        .prepare(sql)
        .bind(...bind)
        .all<T>();
    return results as T[];
}

/** 读取单个 setting */
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
    return (await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value")) as string | null;
}

/** 写入/删除 setting（null/undefined 时删除） */
export async function setSetting(db: D1Database, key: string, value: string | null | undefined) {
    if (value === undefined || value === null) {
        await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
    } else {
        await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
    }
}

/** 读取全部 settings 为对象 */
export async function getFullSettings(db: D1Database) {
    const results = await queryAll<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
    const settings: Record<string, string> = {};
    for (const row of results) {
        settings[row.key] = row.value;
    }
    return settings;
}

/** 手动同步互斥锁的 settings 键：仅供内部互斥，不进入用户可见设置、也不在写入白名单里 */
export const MANUAL_SYNC_LOCK_KEY = "MANUAL_SYNC_RUNNING";

/**
 * 锁最长有效时间：超过即视为上次任务异常中断，允许接管，避免异常后永久锁死。
 * 取 10 分钟而不是 3 分钟：域名全量同步串行处理，每个域名至少有 8 秒 DoH 与 15 秒列表请求；
 * IP 源的三策略回退最坏为 15 + 20 + 15 秒，两者都可能超过 3 分钟。长任务期间由
 * touchManualSyncLock 定期续租，固定 TTL 只负责兜底异常中断。
 */
export const MANUAL_SYNC_LOCK_TTL_MS = 600_000;

/** 续租节流窗口：距上次续租不足 60 秒就跳过，避免每个条目都多写一次 D1 */
const MANUAL_SYNC_LOCK_RENEW_INTERVAL_MS = 60_000;

/**
 * 抢占手动同步锁，成功返回本次持有令牌（过期时间戳字符串），失败返回 null。
 * 先 `INSERT OR IGNORE` 抢新锁；已存在时判断是否陈旧，再用 CAS（比对原值）接管，
 * 避免两个请求同时判定「已过期」后双跑。
 */
export async function acquireManualSyncLock(db: D1Database): Promise<string | null> {
    const now = Date.now();
    const token = String(now + MANUAL_SYNC_LOCK_TTL_MS);

    const inserted = await db
        .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
        .bind(MANUAL_SYNC_LOCK_KEY, token)
        .run();
    if ((inserted.meta.changes ?? 0) === 1) return token;

    const row = await db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .bind(MANUAL_SYNC_LOCK_KEY)
        .first<{ value: string }>();
    if (!row) return null; // 竞态：对方刚释放，交给调用方下一轮再抢

    const current = Number(row.value);
    if (Number.isFinite(current) && current > now) return null; // 仍在运行中

    const takenOver = await db
        .prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .bind(token, MANUAL_SYNC_LOCK_KEY, row.value)
        .run();
    return (takenOver.meta.changes ?? 0) === 1 ? token : null;
}

/** 释放手动同步锁：只有令牌一致（仍是本次持有时）才删除，避免陈旧持有者误删新锁 */
export async function releaseManualSyncLock(db: D1Database, token: string): Promise<void> {
    await db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(MANUAL_SYNC_LOCK_KEY, token).run();
}

/**
 * 续租手动同步锁：仅当锁值仍是本次令牌时，把到期时间推到 TTL 之后。
 * 令牌不匹配（锁已过期并被接管）时返回 false 且不改动锁值，避免把别人的锁改回自己。
 */
export async function touchManualSyncLock(db: D1Database, token: string): Promise<boolean> {
    const renewed = String(Date.now() + MANUAL_SYNC_LOCK_TTL_MS);
    const result = await db
        .prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .bind(renewed, MANUAL_SYNC_LOCK_KEY, token)
        .run();
    return (result.meta.changes ?? 0) === 1;
}

/**
 * 为一次全量同步创建带节流的续租函数：流开始时调用一次，之后每处理完一个条目调用。
 * 未持锁（token 为空）时为空操作；续租失败只记录「锁已易主」，不抛错中断同步。
 */
export function createManualSyncLockRenewer(
    db: D1Database,
    token: string | undefined,
    log: (msg: string) => void
): () => Promise<void> {
    let lastRenewedAt = 0;
    return async () => {
        if (!token) return;
        const now = Date.now();
        if (now - lastRenewedAt < MANUAL_SYNC_LOCK_RENEW_INTERVAL_MS) return;
        lastRenewedAt = now;
        if (!(await touchManualSyncLock(db, token))) {
            log("手动同步锁已易主（可能被判定为陈旧后被接管），本次同步继续执行，但结果可能被其他任务覆盖。");
        }
    };
}

/** 读取安全的 settings（前端可见，已剔除敏感字段） */
export async function getSafeSettings(db: D1Database): Promise<Record<string, string>> {
    const all = await getFullSettings(db);
    for (const key of SENSITIVE_SETTINGS_KEYS) delete all[key];
    // 运行标记不是用户设置，不回传给前端
    delete all[MANUAL_SYNC_LOCK_KEY];
    return all;
}

/** 读取 Cloudflare API 设置（token + zoneId） */
export async function getCfApiSettings(db: D1Database) {
    const [token, zoneId] = await Promise.all([getSetting(db, "CF_API_TOKEN"), getSetting(db, "CF_ZONE_ID")]);
    return { token: token || "", zoneId: zoneId || "" };
}

/** 读取 GitHub 设置（token + owner + repo） */
export async function getGitHubSettings(db: D1Database) {
    const [token, owner, repo] = await Promise.all([
        getSetting(db, "GITHUB_TOKEN"),
        getSetting(db, "GITHUB_OWNER"),
        getSetting(db, "GITHUB_REPO"),
    ]);
    return { token, owner, repo };
}

/**
 * 行投影的单一来源（M-6）：列表接口、UI 与同步路径共用同一份列清单，
 * 避免同一结构在多处漂移。时间列统一格式化为 ISO 8601（UTC），前端契约不变。
 */
export const DOMAIN_COLUMNS =
    "id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, " +
    "strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, " +
    "last_sync_status, last_sync_error, is_enabled, is_system";

export const IP_SOURCE_COLUMNS =
    "id, url, github_path, commit_message, fetch_strategy, " +
    "strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, " +
    "last_sync_status, last_sync_error, is_enabled";
