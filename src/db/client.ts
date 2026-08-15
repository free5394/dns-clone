// client.ts — D1 数据库统一访问层
// 后续所有 sync 的唯一 DB 入口（阶段 D 起使用）；本阶段先承载 settings 读取

/** 查询全部结果（泛型版） */
export async function queryAll<T = unknown>(db: D1Database, sql: string, ...bind: unknown[]): Promise<T[]> {
    const { results } = await db.prepare(sql).bind(...bind).all<T>();
    return results as T[];
}

/** 查询首行 */
export async function queryFirst(db: D1Database, sql: string, ...bind: unknown[]) {
    return await db.prepare(sql).bind(...bind).first();
}

/** 执行写操作，返回 D1Result（含 meta.changes —— 修正 B1 的正确形态） */
export async function exec(db: D1Database, sql: string, ...bind: unknown[]) {
    return await db.prepare(sql).bind(...bind).run();
}

/** 批量执行（D1 事务语义） */
export async function batch(db: D1Database, statements: D1PreparedStatement[]) {
    return await db.batch(statements);
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
    'ADMIN_PASSWORD_HASH',
    'PASSWORD_SALT',
    'CF_API_TOKEN',
    'GITHUB_TOKEN',
]);

/** 读取安全的 settings（前端可见，已剔除敏感字段） */
export async function getSafeSettings(db: D1Database): Promise<Record<string, string>> {
    const all = await getFullSettings(db);
    for (const key of SENSITIVE_SETTINGS_KEYS) delete all[key];
    return all;
}

/** 读取 Cloudflare API 设置（token + zoneId） */
export async function getCfApiSettings(db: D1Database) {
    const [token, zoneId] = await Promise.all([
        getSetting(db, 'CF_API_TOKEN'),
        getSetting(db, 'CF_ZONE_ID'),
    ]);
    return { token: token || '', zoneId: zoneId || '' };
}

/** 读取 GitHub 设置（token + owner + repo） */
export async function getGitHubSettings(db: D1Database) {
    const [token, owner, repo] = await Promise.all([
        getSetting(db, 'GITHUB_TOKEN'),
        getSetting(db, 'GITHUB_OWNER'),
        getSetting(db, 'GITHUB_REPO'),
    ]);
    return { token, owner, repo };
}
