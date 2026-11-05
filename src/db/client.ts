// client.ts — D1 数据库统一访问层
// 后续所有 sync 的唯一 DB 入口（阶段 D 起使用）；本阶段先承载 settings 读取

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

/** 敏感字段：序列化到前端前过滤（Token、密码哈希等） */
export const SENSITIVE_SETTINGS_KEYS = new Set([
    "ADMIN_PASSWORD_HASH",
    "PASSWORD_SALT",
    "CF_API_TOKEN",
    "GITHUB_TOKEN",
]);

/** 手动同步互斥锁的 settings 键：仅供内部互斥，不进入用户可见设置、也不在写入白名单里 */
export const MANUAL_SYNC_LOCK_KEY = "MANUAL_SYNC_RUNNING";

/** 锁最长有效时间：超过即视为上次任务异常中断，允许接管，避免异常后永久锁死 */
const MANUAL_SYNC_LOCK_TTL_MS = 180000;

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
