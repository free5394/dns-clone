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

/** 读取单个 setting。D1 的 `first(colName)` 只取单列且返回 unknown，故此处保留断言；不适用行类型派生 */
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
    const results = await queryAll<Pick<SettingsRow, "key" | "value">>(db, "SELECT key, value FROM settings");
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

    // 锁路径刻意不改为调用 getSetting：issue #65 只做类型收口，不动互斥路径的语句与调用链；
    // 行形状仍从 SettingsRow 派生，保持单一来源。
    const row = await db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .bind(MANUAL_SYNC_LOCK_KEY)
        .first<Pick<SettingsRow, "value">>();
    if (!row) return null; // 竞态：对方刚释放，交给调用方下一轮再抢

    const current = Number(row.value);
    if (Number.isFinite(current) && current > now) return null; // 仍在运行中

    const takenOver = await db
        .prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .bind(token, MANUAL_SYNC_LOCK_KEY, row.value)
        .run();
    return (takenOver.meta.changes ?? 0) === 1 ? token : null;
}

/** 释放手动同步锁：只有锁值一致（仍是本次持有时）才删除，避免陈旧持有者误删新锁 */
export async function releaseManualSyncLock(db: D1Database, value: string | undefined): Promise<void> {
    if (!value) return;
    await db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(MANUAL_SYNC_LOCK_KEY, value).run();
}

/**
 * 续租手动同步锁：仅当锁值仍是 value 时，把到期时间推到 TTL 之后。
 * 成功返回**新的锁值**——锁值本身就是到期时间戳，续租会把它改写，
 * 调用方必须用返回值替换旧值，否则下一次续租/释放都会因为比对旧值而失配。
 * 失败（锁已过期并被接管）返回 null 且不改动锁值，避免把别人的锁改回自己。
 */
export async function touchManualSyncLock(db: D1Database, value: string): Promise<string | null> {
    const renewed = String(Date.now() + MANUAL_SYNC_LOCK_TTL_MS);
    const result = await db
        .prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .bind(renewed, MANUAL_SYNC_LOCK_KEY, value)
        .run();
    return (result.meta.changes ?? 0) === 1 ? renewed : null;
}

/** 续租函数：可直接 await 调用，另带 current() 取当前锁值供释放使用 */
export interface ManualSyncLockRenewer {
    (): Promise<void>;
    /** 当前锁值（续租会改写它），释放时必须传这个值而不是最初的 token */
    current(): string | undefined;
}

/**
 * 为一次全量同步创建带节流的续租函数：流开始时调用一次，之后每处理完一个条目调用。
 * 未持锁（token 为空）时为空操作；续租失败只记录「锁已易主」，不抛错中断同步。
 * 内部持有**最新**锁值：续租成功后更新它，释放时用 current() 取，避免用初始 token 去删已被改写的锁。
 */
export function createManualSyncLockRenewer(
    db: D1Database,
    token: string | undefined,
    log: (msg: string) => void
): ManualSyncLockRenewer {
    let lastRenewedAt = 0;
    let current = token;
    const renew = async () => {
        if (!current) return;
        const now = Date.now();
        if (now - lastRenewedAt < MANUAL_SYNC_LOCK_RENEW_INTERVAL_MS) return;
        lastRenewedAt = now;
        const renewed = await touchManualSyncLock(db, current);
        if (renewed) current = renewed;
        else log("手动同步锁已易主（可能被判定为陈旧后被接管），本次同步继续执行，但结果可能被其他任务覆盖。");
    };
    return Object.assign(renew, { current: () => current });
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
    "last_sync_status, last_sync_error, is_enabled, is_system, " +
    // issue #49 / 方案 §8.1：新增列进入投影，旧数据读出 null（不报错）
    "source_type, source_url, parse_mode, parse_param, fetch_strategy";

/**
 * domains 表的行类型。同步路径以 `SELECT * FROM domains` 读出整行，本类型只声明其中
 * 被消费的 14 列（与 DDL 的偏差见文末）。
 * 可空列声明为可选，是为了兼容只查部分列的调用方；整行读出时这些键仍然存在。
 *
 * issue #62：测试侧不再用按位置取参数类型的方式反推，改为 `import type` 本类型，
 * 保证领域定义只有这一处——签名一改，测试跟随类型报错而不是静默指向别的参数。
 *
 * issue #66：定义从 `src/sync/domains.ts` 下沉到 db 层。表定义（migrations.ts 的
 * `expectedSchemas.domains`）与列清单 `DOMAIN_COLUMNS` 都在 db 层，db 层（如 migrations.ts
 * 的 invalid domain 修复）需要派生行形状时，不该反向 import sync 层把依赖方向掰反；
 * `sync → db` 是既有方向，本类型不新增任何 import 边。
 *
 * 与 DDL 的已知偏差（刻意保持，issue #66 范围外）：`domains` 表有 18 列，本类型只覆盖 14 列，
 * 缺 `notes` / `last_synced_time` / `last_sync_status` / `last_sync_error`。补齐会触发一批
 * 既有类型报错，属另一个议题。
 */
export interface DomainRow {
    id: number;
    source_domain: string;
    target_domain: string;
    zone_id: string;
    is_deep_resolve: number;
    ttl: number;
    last_synced_records?: string | null;
    is_enabled: number;
    is_system: number;
    // issue #52 / 方案 §8.1：来源类型与 URL 解析配置。列可空，存量数据读出 null 按域名目标处理
    source_type?: string | null;
    source_url?: string | null;
    parse_mode?: string | null;
    parse_param?: string | null;
    fetch_strategy?: string | null;
}

export const IP_SOURCE_COLUMNS =
    "id, url, github_path, commit_message, fetch_strategy, " +
    "strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, " +
    "last_sync_status, last_sync_error, is_enabled, " +
    // issue #49 / 方案 §8.2：新增列进入投影，旧数据读出 null（不报错）
    "parse_mode, parse_param";

/**
 * 表行类型的单一来源（issue #65）：src/ 生产代码里 settings / sessions 的读取一律从这里派生投影
 * （同文件直接引用，跨层用 `import type`），不在调用点内联手写行形状。
 * test/ 里直接读 D1 原始行、断言库内真值的用例刻意不走这层（要验的是库里的值，不是生产投影）。
 * 列约束以 `src/db/migrations.ts` 的 `expectedSchemas` DDL 为准，改表时同步核对这些类型——
 * 与上面的列清单同处 db 层，避免行形状在多处漂移。
 */

/** settings 表的一行（DDL：src/db/migrations.ts 的 expectedSchemas.settings —— key TEXT PRIMARY KEY NOT NULL、value TEXT NOT NULL） */
export interface SettingsRow {
    key: string;
    value: string;
}

/** sessions 表的一行（DDL：src/db/migrations.ts 的 expectedSchemas.sessions —— token TEXT PRIMARY KEY NOT NULL、expires_at TIMESTAMP NOT NULL） */
export interface SessionRow {
    token: string;
    expires_at: string;
}
