// domains.ts — 域名克隆同步逻辑
// 从 index.legacy.js 提取（原 syncScheduledDomains / syncDomainLogic / syncSingleDomain / syncAllDomains / syncSystemDomains / resolveRecursively / processInChunks / updateCloudflareDns / getDnsFromDoh）

import {
    getSetting,
    getCfApiSettings,
    queryAll,
    releaseManualSyncLock,
    createManualSyncLockRenewer,
} from "../db/client.ts";
import { fetchIpsForTarget, fetchThreeNetworkIps } from "./ip-sources.ts";
import { normalizeParseMode } from "./ip-parse.ts";
import { beijingTimeLog } from "../util/log.ts";
import { runWithOptionalLog } from "../util/run-with-log.ts";
import type { WaitUntil } from "../util/http.ts";
import { fetchWithTimeout, fetchWithRetry } from "../util/fetch.ts";
import { normalizeBatchSize } from "../util/batch-size.ts";
import { forEachIsolated } from "../util/batch-sync.ts";
import { normalizeMaxIpsPerType } from "../util/max-ips-per-type.ts";
import { isValidIpv4, canonicalizeIpv6, isPublishableIpv6, sortIpv4, sortIpv6 } from "../util/ip.ts";
import { MAX_IPS_PER_TYPE_KEY } from "../db/settings.ts";

interface DomainRow {
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

interface DnsRecord {
    type: string;
    content: string;
}

/** 三网聚合优选 IP 缓存：移动/电信/联通 IP 列表 + 来源标识 */
interface ThreeNetworkIpsCache {
    yd: string[];
    dx: string[];
    lt: string[];
    source: string;
}

/** 域名同步共享上下文：跨多个域名同步时复用的派生状态 */
interface SyncContext {
    threeNetworkIps?: ThreeNetworkIpsCache;
    /**
     * URL 类型目标的同批抓取结果缓存（方案 §6.3）。
     * 键 = url + 归一后的 parse_mode + parse_param，同批内相同配置只抓一次；
     * 只缓存成功结果（取得正文且解析到 ≥1 个 IP），失败不缓存——与三网 FIX-15/FIX-16 语义一致。
     * 缓存同时记住实际生效策略：命中方同样要落库，否则第二个目标下轮仍从空策略起试（验收 #6）。
     */
    urlRecords?: Map<string, CachedUrlRecords>;
    /**
     * 本批生效的 DNS 单类型记录上限（issue #53 / 方案 §11.2）。
     * 批入口读一次 settings 后填入，后续每个域名复用，避免逐域名重复读库。
     */
    maxIpsPerType?: number;
}

/** 变更备注前缀（方案 §12.4）：comment 表示记录集最近一次变更时间，不是最近一次同步时间 */
const CHANGE_COMMENT_PREFIX = "DNS Clone 变更于 ";

/**
 * 是否携带变更备注的记录类型（方案 §12.4：仅 A / AAAA 写入，CNAME 不写）。
 * 创建请求与保留记录刷新共用这一处判据，避免将来扩展类型时两处口径分叉。
 */
function carriesChangeComment(type: string): boolean {
    return type === "A" || type === "AAAA";
}

/**
 * 生成变更备注：北京时间 YYYY-MM-DD HH:mm，精确到分钟（方案 §12.4）。
 * 北京时间固定为 UTC+8 且无夏令时，直接平移时间戳后用 UTC 取值，
 * 避免依赖运行时 Intl 时区数据库（workerd 与 Node 的差异会污染测试）。
 */
export function formatChangeComment(now: Date = new Date()): string {
    const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const date = [
        shifted.getUTCFullYear(),
        String(shifted.getUTCMonth() + 1).padStart(2, "0"),
        String(shifted.getUTCDate()).padStart(2, "0"),
    ].join("-");
    const time = [
        String(shifted.getUTCHours()).padStart(2, "0"),
        String(shifted.getUTCMinutes()).padStart(2, "0"),
    ].join(":");
    return `${CHANGE_COMMENT_PREFIX}${date} ${time}`;
}

/**
 * 按类型截断记录集合（issue #53 / 方案 §12.3）：A 与 AAAA 各保留前 N 条。
 * CNAME 分支不参与截断，原样保留；其余顺序不变，便于与解析结果逐项比对。
 */
export function limitIpRecords(records: DnsRecord[], maxPerType: number): DnsRecord[] {
    const limit = Math.max(1, maxPerType);
    let ipv4Count = 0;
    let ipv6Count = 0;
    const limited: DnsRecord[] = [];
    for (const record of records) {
        if (record.type === "A") {
            if (ipv4Count >= limit) continue;
            ipv4Count++;
        } else if (record.type === "AAAA") {
            if (ipv6Count >= limit) continue;
            ipv6Count++;
        }
        limited.push(record);
    }
    return limited;
}

/**
 * 惰性读取本批的 MAX_IPS_PER_TYPE 并写回上下文（issue #53 / 方案 §11.2）。
 * 批入口显式调用一次；syncDomainLogic 再调一次也只是命中已填值，不会重复读库。
 */
async function ensureMaxIpsPerType(db: D1Database, syncContext: SyncContext): Promise<number> {
    if (syncContext.maxIpsPerType === undefined) {
        syncContext.maxIpsPerType = normalizeMaxIpsPerType(await getSetting(db, MAX_IPS_PER_TYPE_KEY));
    }
    return syncContext.maxIpsPerType;
}

/** 同批 URL 抓取缓存值：记录集合 + 本次实际生效的抓取策略 */
interface CachedUrlRecords {
    records: DnsRecord[];
    strategy: string;
}

/**
 * URL 类型目标的缓存键：三个字段共同决定解析结果，任一不同即视为不同请求。
 * parse_mode 先归一再入键：存量行可能是 NULL、新行是 "auto"，两者语义相同，不归一就会重复抓取。
 */
function urlRecordsCacheKey(domain: DomainRow): string {
    const url = (domain.source_url ?? "").trim();
    return `${url}\u0000${normalizeParseMode(domain.parse_mode)}\u0000${domain.parse_param ?? ""}`;
}

type LogFn = (msg: string) => void;

/** DoH 查询（Cloudflare DNS over HTTPS，JSON 格式） */
export async function getDnsFromDoh(domain: string, type: string): Promise<string[]> {
    try {
        const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`;
        const response = await fetchWithTimeout(url, { headers: { accept: "application/dns-json" } }, 8000);
        if (!response.ok) {
            console.warn(`DoH 查询失败 ${domain} (${type}): ${response.statusText}`);
            return [];
        }
        const data = (await response.json()) as { Answer?: { data: string }[] };
        return data.Answer ? data.Answer.map((ans) => ans.data).filter(Boolean) : [];
    } catch (e) {
        console.error(`DoH 查询出错 ${domain} (${type}): ${e instanceof Error ? e.message : String(e)}`);
        return [];
    }
}

/** 定时任务：批量同步启用域名（失败优先） */
export async function syncScheduledDomains(env: { WUYA: D1Database }): Promise<void> {
    const db = env.WUYA;
    // FIX-12: BATCH_SIZE 由 settings 配置（默认 10；非法值回退）；I5: 负数钳制为默认值
    const BATCH_SIZE = normalizeBatchSize(await getSetting(db, "BATCH_SIZE"));
    const log: LogFn = (msg) => console.log(beijingTimeLog(msg));

    const { token, zoneId } = await getCfApiSettings(db);
    if (!token || !zoneId) {
        log("Cloudflare 配置缺失，跳过本轮域名同步。");
        return;
    }

    const query = `
        SELECT * FROM domains
        WHERE is_enabled = 1
        ORDER BY
            CASE last_sync_status WHEN 'failed' THEN 0 ELSE 1 END,
            last_synced_time ASC
        LIMIT ?`;

    const domainsToSync = await queryAll<DomainRow>(db, query, BATCH_SIZE);

    if (domainsToSync.length === 0) {
        log("本轮没有需要同步的域名。");
        return;
    }

    log(`本轮按失败优先选取 ${domainsToSync.length} 个域名。`);
    const syncContext: SyncContext = {};
    // issue #53 / 方案 §11.2：批次内只读一次单类型上限，整批域名复用
    await ensureMaxIpsPerType(db, syncContext);
    await forEachIsolated(
        domainsToSync,
        (domain) => syncDomainLogic(domain, token, zoneId, db, log, syncContext),
        (domain, e) => log(`批量处理域名 ${domain.target_domain} 失败: ${e instanceof Error ? e.stack : e}`)
    );
}

/** 单个域名同步入口 */
export async function syncSingleDomain(
    id: number,
    env: { WUYA: D1Database },
    returnLogs: boolean,
    signal?: AbortSignal,
    waitUntil?: WaitUntil
): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
        const { token, zoneId } = await getCfApiSettings(db);
        if (!token || !zoneId) throw new Error("尚未配置 Cloudflare API 令牌或区域 ID。");
        const domain = (await db.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first()) as DomainRow | null;
        if (!domain) throw new Error(`未找到 ID 为 ${id} 的目标。`);
        if (!domain.is_enabled) {
            log(`域名 ${domain.target_domain} 已被禁用，跳过同步。`);
            return;
        }
        const syncContext: SyncContext = {};
        await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
    };

    return await runWithOptionalLog(syncLogic, returnLogs, signal, waitUntil);
}

/** 批量同步全部启用域名（lockToken 由路由层抢占，任务结束后在此释放） */
export async function syncAllDomains(
    env: { WUYA: D1Database },
    returnLogs: boolean,
    signal?: AbortSignal,
    lockToken?: string,
    waitUntil?: WaitUntil
): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
        // 续租器要活到 finally：锁值会被续租改写，释放必须用最新值而不是初始 token
        const renewLock = createManualSyncLockRenewer(db, lockToken, log);
        try {
            log("开始批量同步任务...");
            const { token, zoneId } = await getCfApiSettings(db);
            if (!token || !zoneId) throw new Error("尚未配置 Cloudflare API 令牌或区域 ID。");
            const domains = await queryAll<DomainRow>(db, "SELECT * FROM domains WHERE is_enabled = 1");
            if (domains.length === 0) {
                log("没有需要同步的已启用目标。");
                return;
            }
            log(`发现 ${domains.length} 个已启用的目标需要同步。`);
            const syncContext: SyncContext = {};
            await ensureMaxIpsPerType(db, syncContext);
            await renewLock();
            await forEachIsolated(
                domains,
                async (domain) => {
                    try {
                        await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
                    } finally {
                        // 单个域名耗时可能很长，每处理完一个条目续租一次（内部按 60 秒节流）
                        await renewLock();
                    }
                },
                (domain, e) =>
                    log(`处理域名 ${domain.target_domain} 失败: ${e instanceof Error ? e.message : String(e)}`)
            );
            log("所有目标同步任务执行完毕。");
        } finally {
            await releaseManualSyncLock(db, renewLock.current());
        }
    };

    return runWithOptionalLog(syncLogic, returnLogs, signal, waitUntil);
}

/** 批量同步系统预设域名（lockToken 由路由层抢占，任务结束后在此释放） */
export async function syncSystemDomains(
    env: { WUYA: D1Database },
    returnLogs: boolean,
    signal?: AbortSignal,
    lockToken?: string,
    waitUntil?: WaitUntil
): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
        // 续租器要活到 finally：锁值会被续租改写，释放必须用最新值而不是初始 token
        const renewLock = createManualSyncLockRenewer(db, lockToken, log);
        try {
            log("开始同步系统预设域名...");
            const { token, zoneId } = await getCfApiSettings(db);
            if (!token || !zoneId) throw new Error("尚未配置 Cloudflare API 令牌或区域 ID。");
            const domains = await queryAll<DomainRow>(
                db,
                "SELECT * FROM domains WHERE is_enabled = 1 AND is_system = 1"
            );
            if (domains.length === 0) {
                log("没有需要同步的已启用系统域名。");
                return;
            }
            log(`发现 ${domains.length} 个已启用的系统域名需要同步。`);
            const syncContext: SyncContext = {};
            await ensureMaxIpsPerType(db, syncContext);
            await renewLock();
            await forEachIsolated(
                domains,
                async (domain) => {
                    try {
                        await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
                    } finally {
                        // 单个域名耗时可能很长，每处理完一个条目续租一次（内部按 60 秒节流）
                        await renewLock();
                    }
                },
                (domain, e) =>
                    log(`系统域名 ${domain.target_domain} 同步失败: ${e instanceof Error ? e.message : String(e)}`)
            );
            log("系统域名同步任务执行完毕。");
        } finally {
            await releaseManualSyncLock(db, renewLock.current());
        }
    };

    return runWithOptionalLog(syncLogic, returnLogs, signal, waitUntil);
}

/**
 * 根据域名配置解析需更新的 DNS 记录（四分支策略）
 * - source_type=url：抓取 URL 正文并经统一解析层得 IPv4/IPv6（issue #52）
 * - internal:hostmonit:*：系统内置三网优选 IP
 * - is_deep_resolve=1：递归解析 CNAME 链
 * - 否则：浅层克隆（源域名必须是 CNAME）
 *
 * 四条分支统一在出口按 MAX_IPS_PER_TYPE 截断（issue #53 / 方案 §11.1、§12.3）：
 * 截断放在出口而不是各分支内，才能保证「全来源」口径一致、不因新增分支漏截。
 */
export async function resolveRecordsForDomain(
    domain: DomainRow,
    db: D1Database,
    log: LogFn,
    syncContext: SyncContext
): Promise<DnsRecord[]> {
    const records = await resolveRawRecordsForDomain(domain, db, log, syncContext);
    // 兜底：批入口已读过时这里命中已填值，不重复读库；若将来新增入口漏调，
    // 也只是退化为逐域名读一次设置，不会静默回退默认值而绕过用户配置（方案 §11.2）。
    const maxPerType = await ensureMaxIpsPerType(db, syncContext);
    const limited = limitIpRecords(records, maxPerType);
    if (limited.length !== records.length) {
        log(`按单类型上限 ${maxPerType} 截断记录: ${records.length} → ${limited.length} 条`);
    }
    return limited;
}

/**
 * 把原始 IP 字符串收敛成 A / AAAA 记录（issue #59 / 方案 §7.3）：
 * 逐项严格校验 → 同类型去重 → 排序。
 * - IPv4 走 isValidIpv4 + sortIpv4（数值升序）；
 * - IPv6 走 canonicalizeIpv6 后去重，并按 extractIpv6 的口径排除 `::`、
 *   全零展开与 IPv4-mapped——这些不是可发布的 AAAA 地址；
 * - CNAME 不经过这里，仍由调用方原样返回。
 *
 * 截断由 resolveRecordsForDomain 在出口统一执行，所以顺序必须在这里定下来：
 * limitIpRecords 按输入顺序取前 N，排序晚于截断就会取到错的那 N 条（验收 #1）。
 */
function buildIpRecords(ipv4s: string[], ipv6s: string[]): DnsRecord[] {
    const uniqueV4 = new Set<string>();
    for (const ip of ipv4s) {
        const text = ip.trim();
        if (isValidIpv4(text)) uniqueV4.add(text);
    }
    const uniqueV6 = new Set<string>();
    for (const ip of ipv6s) {
        const canonical = canonicalizeIpv6(ip.trim());
        if (canonical !== null && isPublishableIpv6(canonical)) uniqueV6.add(canonical);
    }
    return [
        ...sortIpv4([...uniqueV4]).map((ip) => ({ type: "A", content: ip })),
        ...sortIpv6([...uniqueV6]).map((ip) => ({ type: "AAAA", content: ip })),
    ];
}

/**
 * 四分支解析的原始结果（未截断），截断由 resolveRecordsForDomain 统一执行。
 */
async function resolveRawRecordsForDomain(
    domain: DomainRow,
    db: D1Database,
    log: LogFn,
    syncContext: SyncContext
): Promise<DnsRecord[]> {
    if (domain.source_type === "url") {
        return await resolveUrlRecordsForDomain(domain, db, log, syncContext);
    }
    if (domain.source_domain.startsWith("internal:hostmonit:")) {
        const type = domain.source_domain.split(":")[2];
        const sourceName = (await getSetting(db, "THREE_NETWORK_SOURCE")) || "CloudFlareYes";
        log(`模式: 系统内置源 (三网优选IP - ${type}, 来源: ${sourceName})`);
        if (
            !syncContext.threeNetworkIps ||
            (syncContext.threeNetworkIps as { source?: string }).source !== sourceName
        ) {
            log(`正在从 ${sourceName} 获取三网优选IP...`);
            try {
                const fetched = await fetchThreeNetworkIps(sourceName, log);
                const totalCount = fetched.yd.length + fetched.dx.length + fetched.lt.length;
                if (totalCount > 0) {
                    // 仅在成功获取 IP 时才缓存（避免失败空对象污染后续同批域名）
                    syncContext.threeNetworkIps = { ...fetched, source: sourceName };
                    log(`获取成功: 移动(${fetched.yd.length}) 电信(${fetched.dx.length}) 联通(${fetched.lt.length})`);
                } else {
                    log(`未获取到任何三网IP，下次同步将重新尝试。`);
                    delete syncContext.threeNetworkIps;
                }
            } catch (e) {
                // FIX-16: 网络故障时保留上次成功缓存，让同批后续域名仍能完成同步
                // 若从未成功过（无旧缓存），向上抛错由 syncDomainLogic 标 failed
                log(`网络故障，使用上次成功缓存（如有）: ${e instanceof Error ? e.message : String(e)}`);
                if (!syncContext.threeNetworkIps) throw e;
            }
        }
        // FIX-15: 上游源返回 0 IP 时 syncContext.threeNetworkIps 已被 delete，
        // 若直接 [type] 解引会抛 "Cannot read properties of undefined"。
        // 返回空数组交给 syncDomainLogic 走 "无记录" 分支判定 no_change / 抛错。
        if (!syncContext.threeNetworkIps) return [];
        const ips = syncContext.threeNetworkIps[type as "yd" | "dx" | "lt"] || [];
        // issue #59：上游 HTML 只按形态匹配 `\d{1,3}.` 四段，越界值也会被带进来；
        // 与深度解析同口径过内核（校验 → 去重 → 数值升序），排序必须先于出口截断。
        return buildIpRecords(ips, []);
    }
    if (domain.is_deep_resolve) {
        log(`模式: 深度解析 (追踪CNAME)`);
        return await resolveRecursively(domain.source_domain, log);
    }
    log(`模式: 浅层克隆 (直接克隆CNAME)`);
    const cnames = await getDnsFromDoh(domain.source_domain, "CNAME");
    if (cnames.length > 0) return [{ type: "CNAME", content: cnames[0].replace(/\.$/, "") }];
    throw new Error(`在浅层克隆模式下，源域名 ${domain.source_domain} 必须是一个CNAME记录。`);
}

/**
 * 把本次实际生效的抓取策略写回 domains（验收 #6）。
 * 只落库，不做去重判断：调用方知道自己是否已经写过同一策略，避免这里靠猜 target 的当前值。
 */
async function persistFetchStrategy(db: D1Database, strategy: string, target: { id: number }): Promise<void> {
    if (!strategy) return;
    await db.prepare("UPDATE domains SET fetch_strategy = ? WHERE id = ?").bind(strategy, target.id).run();
}

/**
 * URL 类型目标：复用 IP 源的策略链取正文，经统一解析层得 IPv4/IPv6 并映射成 A/AAAA（方案 §6.2 / §6.3）。
 * - 同批缓存：键 = url + parse_mode + parse_param，只缓存成功结果；同批同配置只抓一次。
 * - 取得正文但解析 0 条：不写缓存，返回空集合交由 syncDomainLogic 的 0 条分支判定。
 * - 抓取抛错：不写缓存、向上抛，由 syncDomainLogic 标 failed 且不改动现有 DNS。
 */
async function resolveUrlRecordsForDomain(
    domain: DomainRow,
    db: D1Database,
    log: LogFn,
    syncContext: SyncContext
): Promise<DnsRecord[]> {
    const cacheKey = urlRecordsCacheKey(domain);
    const cached = syncContext.urlRecords?.get(cacheKey);
    if (cached) {
        log(`模式: URL 抓取 (同批缓存命中，${cached.records.length} 条记录)`);
        // 命中缓存也要落库：抓取只发生在第一个目标上，策略也只写进了它那一行；
        // 后续目标若跳过落库，下一轮仍从空策略起试，验收 #6「下一轮优先尝试」就不成立。
        if ((domain.fetch_strategy ?? "") !== cached.strategy) {
            await persistFetchStrategy(db, cached.strategy, domain);
        }
        domain.fetch_strategy = cached.strategy;
        return cached.records;
    }
    const url = (domain.source_url ?? "").trim();
    if (!url) throw new Error(`URL 类型目标 ${domain.target_domain} 缺少 URL，请重新编辑该目标。`);
    log(`模式: URL 抓取 (${url})`);
    const result = await fetchIpsForTarget(
        {
            id: domain.id,
            url,
            fetch_strategy: domain.fetch_strategy ?? null,
            parse_mode: domain.parse_mode ?? null,
            parse_param: domain.parse_param ?? null,
        },
        db,
        {
            // 回退命中后把实际生效策略持久化到 domains，下一轮优先尝试（验收 #6）
            persistStrategy: async (strategy, target) => {
                await persistFetchStrategy(db, strategy, target);
            },
            // 取得正文但 0 条不抛错：交给 syncDomainLogic 走「上次有无记录」两分支（验收 #8）
            emptyWhenNoIps: true,
        }
    );
    // 回退命中时同步内存对象，同一 DomainRow 后续复用可感知（与 ip_sources 侧就地改写口径一致）
    if (result.strategy !== "" && result.strategy !== result.configuredStrategy) {
        domain.fetch_strategy = result.strategy;
    }
    const records: DnsRecord[] = [
        ...result.ipv4.map((ip) => ({ type: "A", content: ip })),
        ...result.ipv6.map((ip) => ({ type: "AAAA", content: ip })),
    ];
    log(
        `取得 ${result.ipv4.length} 个 IPv4 / ${result.ipv6.length} 个 IPv6（策略: ${result.strategy || "全部未命中"}）`
    );
    if (records.length === 0) {
        // §6.3：全链取得正文但解析 0 条时不写缓存（避免空结果污染同批其它目标）
        log("未解析到任何 IP，交由同步逻辑按上次记录判定。");
        return [];
    }
    if (!syncContext.urlRecords) syncContext.urlRecords = new Map<string, CachedUrlRecords>();
    syncContext.urlRecords.set(cacheKey, { records, strategy: result.strategy });
    return records;
}

/** 核心同步逻辑：解析 → 比对 → 写回 Cloudflare DNS → 状态更新 */
export async function syncDomainLogic(
    domain: DomainRow,
    token: string,
    zoneId: string,
    db: D1Database,
    log: LogFn,
    syncContext: SyncContext
): Promise<void> {
    log(`======== 开始同步: ${domain.target_domain} ========`);
    try {
        // 单类型上限由 resolveRecordsForDomain 出口兜底读取，这里不再单独读库
        let recordsToUpdate: DnsRecord[] | undefined;
        recordsToUpdate = await resolveRecordsForDomain(domain, db, log, syncContext);

        if (!recordsToUpdate || recordsToUpdate.length === 0) {
            let lastRecords: DnsRecord[] = [];
            try {
                lastRecords = JSON.parse(domain.last_synced_records || "[]") as DnsRecord[];
            } catch {
                log(`last_synced_records 字段损坏（域名 ${domain.target_domain}），按空数组处理。`);
            }
            if (lastRecords.length === 0) {
                log(`源域名 ${domain.source_domain} 未找到任何记录，与上次同步结果一致，无需操作。`);
                await db
                    .prepare(
                        "UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL WHERE id = ?"
                    )
                    .bind(domain.id)
                    .run();
                log(`✔ 成功同步 ${domain.target_domain} (内容一致)。`);
                return;
            } else {
                throw new Error(`源域名 ${domain.source_domain} 未找到任何可解析的记录（上次曾有记录）。`);
            }
        }

        const updateResult = await updateCloudflareDns(token, zoneId, domain, recordsToUpdate, log);
        if (updateResult === "no_change") {
            await db
                .prepare(
                    "UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL WHERE id = ?"
                )
                .bind(domain.id)
                .run();
            log(`✔ 成功同步 ${domain.target_domain} (内容一致)。`);
        } else {
            await db
                .prepare(
                    "UPDATE domains SET last_synced_records = ?, last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success', last_sync_error = NULL WHERE id = ?"
                )
                .bind(JSON.stringify(recordsToUpdate), domain.id)
                .run();
            log(`✔ 成功同步 ${domain.target_domain} (内容已更新)。`);
        }
    } catch (e) {
        log(`❌ 同步 ${domain.target_domain} 失败: ${e instanceof Error ? e.message : String(e)}`);
        await db
            .prepare(
                "UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'failed', last_sync_error = ? WHERE id = ?"
            )
            .bind(e instanceof Error ? e.message : String(e), domain.id)
            .run();
        throw e;
    }
}

/** 递归解析 CNAME 链直到最终 IP */
export async function resolveRecursively(domain: string, log: LogFn, depth = 0): Promise<DnsRecord[]> {
    const MAX_DEPTH = 10;
    if (depth > MAX_DEPTH) {
        log(`错误：解析深度超过 ${MAX_DEPTH} 层，可能存在CNAME循环。中止解析 ${domain}。`);
        return [];
    }
    log(`(深度 ${depth}) 正在解析: ${domain}`);
    const cnames = await getDnsFromDoh(domain, "CNAME");
    if (cnames.length > 0) {
        const cnameTarget = cnames[0].replace(/\.$/, "");
        log(`(深度 ${depth}) 发现CNAME -> ${cnameTarget}`);
        const nextRecords = await resolveRecursively(cnameTarget, log, depth + 1);
        if (nextRecords.length > 0) {
            return nextRecords;
        }
        log(`(深度 ${depth + 1}) CNAME ${cnameTarget} 未解析到最终IP，将直接克隆此CNAME记录。`);
        return [{ type: "CNAME", content: cnameTarget }];
    }
    log(`(深度 ${depth}) 未发现CNAME，查询最终IP for ${domain}`);
    const ipv4s = await getDnsFromDoh(domain, "A");
    const ipv6s = await getDnsFromDoh(domain, "AAAA");
    // issue #59：与三网分支共用内核（校验 → 去重 → 规范化 → 排序），
    // 不再各自维护一份正则——旧 IPv6 正则无锚定且放行 %zone，已由 isValidIpv6 取代。
    return buildIpRecords(ipv4s, ipv6s);
}

/**
 * 分块并发处理（每块 Promise.allSettled）。
 * - fulfilled 且 `res.ok === false` 时立即抛错，短路后续批次，避免连接池与配额浪费
 * - fulfilled 时主动消费 body（arrayBuffer）释放连接到连接池
 * - 所有失败的 promise 收集后聚合抛错
 */
export async function processInChunks<T, R extends Response>(
    items: T[],
    chunkSize: number,
    processFn: (item: T) => Promise<R>,
    log: LogFn
): Promise<R[]> {
    const allResponses: R[] = [];
    const errors: Error[] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        log(`正在处理一个包含 ${chunk.length} 个项目的批次...`);
        const settled = await Promise.allSettled(chunk.map(processFn));
        for (const s of settled) {
            if (s.status === "fulfilled") {
                const res = s.value;
                if (!res.ok) {
                    // 早失败早退出：消费错误体后立即抛错，短路后续批次
                    const errBody = (await res.json().catch(() => ({}))) as {
                        errors?: { code: number; message: string }[];
                    };
                    const detail = (errBody.errors || []).map((e) => `(Code ${e.code}: ${e.message})`).join(", ");
                    throw new Error(`Cloudflare API 失败: ${res.status} ${detail}`);
                }
                // 主动消费 body 释放连接到连接池
                await res.arrayBuffer();
                allResponses.push(res);
            } else {
                errors.push(s.reason instanceof Error ? s.reason : new Error(String(s.reason)));
            }
        }
    }
    if (errors.length > 0) {
        throw new Error(`批次处理中发生 ${errors.length} 个错误: ${errors.map((e) => e.message).join("; ")}`);
    }
    return allResponses;
}

/**
 * 将解析结果写回 Cloudflare DNS（比对差异后增删）。
 *
 * 变更时间备注（issue #53 / 方案 §12.4）：
 * - 只有本次记录集合发生增删时，才写入/刷新 `comment`；`no_change` 不产生任何 PATCH。
 * - 新增记录随创建请求带 `comment`；保留下来的既有 A/AAAA 记录用 PATCH 刷新 `comment`。
 * - CNAME 不参与备注，也不参与截断。
 *
 * 顺序说明：方案 §11.1 画的是「POST → DELETE → PATCH」，但 §13.1 要求备注 PATCH 失败时
 * 记录集合保持不变。POST/DELETE 之后再 PATCH 无法回滚，只有把幂等且不改记录集合的注释刷新
 * 提到集合变更之前，两条约束才能同时成立，故这里按「PATCH 备注 → DELETE → POST」执行。
 */
export async function updateCloudflareDns(
    token: string,
    zoneId: string,
    domain: DomainRow,
    newRecords: DnsRecord[],
    log: LogFn
): Promise<string> {
    const API_CHUNK_SIZE = 10;
    const { target_domain, ttl } = domain;
    const API_ENDPOINT = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    interface ExistingRecord {
        id: string;
        type: string;
        content: string;
        proxied?: boolean;
        ttl?: number;
        comment?: string | null;
    }
    const existingRecords: ExistingRecord[] = [];
    for (let page = 1; ; page++) {
        const query = new URLSearchParams({ name: target_domain, per_page: "100", page: String(page) }).toString();
        const listResponse = await fetchWithRetry(`${API_ENDPOINT}?${query}`, { headers }, 1, 15000);
        if (!listResponse.ok) throw new Error(`获取DNS记录列表失败: ${await listResponse.text()}`);
        const listResult = (await listResponse.json()) as {
            success: boolean;
            result: ExistingRecord[];
            result_info?: { page?: number; total_pages?: number };
            errors?: unknown[];
        };
        if (!listResult.success) throw new Error(`获取DNS记录列表API错误: ${JSON.stringify(listResult.errors)}`);
        existingRecords.push(...listResult.result);
        const totalPages = listResult.result_info?.total_pages ?? 1;
        if (page >= totalPages) break;
    }
    log(`目标 ${target_domain} 当前有 ${existingRecords.length} 条相关记录。`);

    const recordsToDelete: typeof existingRecords = [];
    const recordsToAdd = newRecords.map((r) => ({ ...r, content: r.content.replace(/\.$/, "") }));
    const newRecordIsCname = recordsToAdd.some((r) => r.type === "CNAME");
    // 保留下来的 A/AAAA 既有记录：本次有增删时要刷新 comment（方案 §12.4）
    const recordsToRefresh: ExistingRecord[] = [];

    for (const existing of existingRecords) {
        const normalizedExistingContent = existing.content.replace(/\.$/, "");
        if (
            (newRecordIsCname && ["A", "AAAA", "CNAME"].includes(existing.type)) ||
            (!newRecordIsCname && existing.type === "CNAME")
        ) {
            recordsToDelete.push(existing);
            continue;
        }
        let foundMatch = false;
        for (let i = recordsToAdd.length - 1; i >= 0; i--) {
            if (recordsToAdd[i].type === existing.type && recordsToAdd[i].content === normalizedExistingContent) {
                if (existing.proxied === false && existing.ttl === ttl) {
                    recordsToAdd.splice(i, 1);
                    recordsToRefresh.push(existing);
                    foundMatch = true;
                    break;
                }
            }
        }
        if (!foundMatch && ["A", "AAAA", "CNAME"].includes(existing.type)) {
            recordsToDelete.push(existing);
        }
    }

    if (recordsToDelete.length === 0 && recordsToAdd.length === 0) {
        log(`记录无变化，无需操作。`);
        return "no_change";
    }

    log(`计划删除 ${recordsToDelete.length} 条记录, 添加 ${recordsToAdd.length} 条记录。`);

    // 变更时间备注：本次确有增删才产生注释写操作（方案 §12.4）
    const changeComment = formatChangeComment();

    // 两个过滤条件（方案 §12.4）：
    // 1) 只有 A/AAAA 写备注，匹配上的 CNAME 一律跳过；
    // 2) 保留记录的 comment 已是本次同分钟时间戳时跳过——同一分钟内多次变更不对同一记录重复 PATCH。
    const recordsToPatchComment = recordsToRefresh.filter(
        (record) => carriesChangeComment(record.type) && record.comment !== changeComment
    );

    const patchCommentFn = (record: ExistingRecord) => {
        log(`~ 准备刷新备注: [${record.type}] ${record.content} -> ${changeComment}`);
        return fetchWithRetry(
            `${API_ENDPOINT}/${record.id}`,
            {
                method: "PATCH",
                headers,
                body: JSON.stringify({ comment: changeComment }),
            },
            1,
            15000
        );
    };

    const deleteFn = (record: { id: string; type: string; content: string }) => {
        log(`- 准备删除旧记录: [${record.type}] ${record.content}`);
        return fetchWithRetry(`${API_ENDPOINT}/${record.id}`, { method: "DELETE", headers }, 1, 15000);
    };

    const addFn = (record: DnsRecord) => {
        log(`+ 准备添加新记录: [${record.type}] ${record.content}`);
        return fetchWithRetry(
            API_ENDPOINT,
            {
                method: "POST",
                headers,
                body: JSON.stringify({
                    type: record.type,
                    name: target_domain,
                    content: record.content,
                    ttl,
                    proxied: false,
                    // 备注仅 A/AAAA 携带；CNAME 分支不参与备注（方案 §12.4）
                    ...(carriesChangeComment(record.type) ? { comment: changeComment } : {}),
                }),
            },
            1,
            15000
        );
    };

    // 顺序：先刷新保留记录的备注，再删除多余、再新增最后执行。
    // 原因见函数头注释：备注 PATCH 失败要落在记录集合未变的位置，必须早于 DELETE/POST。
    if (recordsToPatchComment.length > 0) {
        log(`刷新 ${recordsToPatchComment.length} 条保留记录的变更备注。`);
        await processInChunks(recordsToPatchComment, API_CHUNK_SIZE, patchCommentFn, log);
    }
    await processInChunks(recordsToDelete, API_CHUNK_SIZE, deleteFn, log);
    await processInChunks(recordsToAdd, API_CHUNK_SIZE, addFn, log);

    // processInChunks 已在内部对非 2xx 短路抛错；此处无需再检查响应
    return "success";
}
