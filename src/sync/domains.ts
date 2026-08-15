// domains.ts — 域名克隆同步逻辑
// 从 index.legacy.js 提取（原 syncScheduledDomains / syncDomainLogic / syncSingleDomain / syncAllDomains / syncSystemDomains / resolveRecursively / processInChunks / updateCloudflareDns / getDnsFromDoh）

import { getSetting, getCfApiSettings, queryAll } from '../db/client.ts';
import { fetchThreeNetworkIps } from './ip-sources.ts';
import { beijingTimeLog } from '../util/log.ts';
import { runWithOptionalLog } from '../util/run-with-log.ts';
import { fetchWithTimeout, fetchWithRetry } from '../util/fetch.ts';

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
}

type LogFn = (msg: string) => void;

/** DoH 查询（Cloudflare DNS over HTTPS，JSON 格式） */
export async function getDnsFromDoh(domain: string, type: string): Promise<string[]> {
    try {
        const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`;
        const response = await fetchWithTimeout(url, { headers: { 'accept': 'application/dns-json' } }, 8000);
        if (!response.ok) {
            console.warn(`DoH 查询失败 ${domain} (${type}): ${response.statusText}`);
            return [];
        }
        const data = await response.json() as { Answer?: { data: string }[] };
        return data.Answer ? data.Answer.map(ans => ans.data).filter(Boolean) : [];
    } catch (e) {
        console.error(`DoH 查询出错 ${domain} (${type}): ${e instanceof Error ? e.message : String(e)}`);
        return [];
    }
}

/** 定时任务：批量同步启用域名（失败优先） */
export async function syncScheduledDomains(env: { WUYA: D1Database }): Promise<void> {
    const db = env.WUYA;
    // FIX-12: BATCH_SIZE 由 settings 配置（默认 10；非法值回退）
    const BATCH_SIZE = Number(await getSetting(db, 'BATCH_SIZE')) || 10;
    const log: LogFn = (msg) => console.log(beijingTimeLog(msg));

    const { token, zoneId } = await getCfApiSettings(db);
    if (!token || !zoneId) {
        log("Cannot run scheduled domain sync: Cloudflare settings are missing.");
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
        log("No domains to sync in this batch.");
        return;
    }

    log(`Found ${domainsToSync.length} domains for this sync batch (failure-first).`);
    const syncContext: SyncContext = {};
    for (const domain of domainsToSync) {
        try {
            await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
        } catch (e) {
            log(`Error processing domain ${domain.target_domain} in batch: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

/** 单个域名同步入口 */
export async function syncSingleDomain(id: number, env: { WUYA: D1Database }, returnLogs: boolean, signal?: AbortSignal): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
        const { token, zoneId } = await getCfApiSettings(db);
        if (!token || !zoneId) throw new Error("尚未配置 Cloudflare API 令牌或区域 ID。");
        const domain = await db.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first() as DomainRow | null;
        if (!domain) throw new Error(`未找到 ID 为 ${id} 的目标。`);
        if (!domain.is_enabled) {
            log(`域名 ${domain.target_domain} 已被禁用，跳过同步。`);
            return;
        }
        const syncContext: SyncContext = {};
        await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
    };

    return await runWithOptionalLog(syncLogic, returnLogs, signal);
}

/** 批量同步全部启用域名 */
export async function syncAllDomains(env: { WUYA: D1Database }, returnLogs: boolean, signal?: AbortSignal): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
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
        for (const domain of domains) {
            try {
                await syncDomainLogic(domain, token, zoneId, db, log, syncContext);
            } catch (e) {
                log(`处理域名 ${domain.target_domain} 失败: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        log("所有目标同步任务执行完毕。");
    };

    return runWithOptionalLog(syncLogic, returnLogs, signal);
}

/** 批量同步系统预设域名 */
export async function syncSystemDomains(env: { WUYA: D1Database }, returnLogs: boolean, signal?: AbortSignal): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
        log("开始同步系统预设域名...");
        const { token, zoneId } = await getCfApiSettings(db);
        if (!token || !zoneId) throw new Error("尚未配置 Cloudflare API 令牌或区域 ID。");
        const domains = await queryAll<DomainRow>(db, "SELECT * FROM domains WHERE is_enabled = 1 AND is_system = 1");
        if (domains.length === 0) {
            log("没有需要同步的已启用系统域名。");
            return;
        }
        log(`发现 ${domains.length} 个已启用的系统域名需要同步。`);
        const syncContext: SyncContext = {};
        for (const domain of domains) {
            await syncDomainLogic(domain, token, zoneId, db, log, syncContext).catch(
                (e) => {
                    log(`系统域名 ${domain.target_domain} 同步失败: ${e instanceof Error ? e.message : String(e)}`);
                },
            );
        }
        log("系统域名同步任务执行完毕。");
    };

    return runWithOptionalLog(syncLogic, returnLogs, signal);
}

/**
 * 根据域名配置解析需更新的 DNS 记录（三分支策略）
 * - internal:hostmonit:*：系统内置三网优选 IP
 * - is_deep_resolve=1：递归解析 CNAME 链
 * - 否则：浅层克隆（源域名必须是 CNAME）
 */
export async function resolveRecordsForDomain(domain: DomainRow, db: D1Database, log: LogFn, syncContext: SyncContext): Promise<DnsRecord[]> {
    if (domain.source_domain.startsWith('internal:hostmonit:')) {
        const type = domain.source_domain.split(':')[2];
        const sourceName = await getSetting(db, 'THREE_NETWORK_SOURCE') || 'CloudFlareYes';
        log(`模式: 系统内置源 (三网优选IP - ${type}, 来源: ${sourceName})`);
        if (!syncContext.threeNetworkIps || (syncContext.threeNetworkIps as { source?: string }).source !== sourceName) {
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
        const ips = syncContext.threeNetworkIps[type as 'yd' | 'dx' | 'lt'] || [];
        return ips.map(ip => ({ type: 'A', content: ip }));
    }
    if (domain.is_deep_resolve) {
        log(`模式: 深度解析 (追踪CNAME)`);
        return await resolveRecursively(domain.source_domain, log);
    }
    log(`模式: 浅层克隆 (直接克隆CNAME)`);
    const cnames = await getDnsFromDoh(domain.source_domain, 'CNAME');
    if (cnames.length > 0) return [{ type: 'CNAME', content: cnames[0].replace(/\.$/, "") }];
    throw new Error(`在浅层克隆模式下，源域名 ${domain.source_domain} 必须是一个CNAME记录。`);
}

/** 核心同步逻辑：解析 → 比对 → 写回 Cloudflare DNS → 状态更新 */
export async function syncDomainLogic(domain: DomainRow, token: string, zoneId: string, db: D1Database, log: LogFn, syncContext: SyncContext): Promise<void> {
    log(`======== 开始同步: ${domain.target_domain} ========`);
    try {
        let recordsToUpdate: DnsRecord[] | undefined;
        recordsToUpdate = await resolveRecordsForDomain(domain, db, log, syncContext);

        if (!recordsToUpdate || recordsToUpdate.length === 0) {
            let lastRecords: DnsRecord[] = [];
            try {
                lastRecords = JSON.parse(domain.last_synced_records || '[]') as DnsRecord[];
            } catch {
                log(`last_synced_records 字段损坏（域名 ${domain.target_domain}），按空数组处理。`);
            }
            if (lastRecords.length === 0) {
                log(`源域名 ${domain.source_domain} 未找到任何记录，与上次同步结果一致，无需操作。`);
                await db.prepare("UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL WHERE id = ?").bind(domain.id).run();
                log(`✔ 成功同步 ${domain.target_domain} (内容一致)。`);
                return;
            } else {
                throw new Error(`源域名 ${domain.source_domain} 未找到任何可解析的记录（上次曾有记录）。`);
            }
        }

        const updateResult = await updateCloudflareDns(token, zoneId, domain, recordsToUpdate, log);
        if (updateResult === 'no_change') {
            await db.prepare("UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL WHERE id = ?").bind(domain.id).run();
            log(`✔ 成功同步 ${domain.target_domain} (内容一致)。`);
        } else {
            await db.prepare("UPDATE domains SET last_synced_records = ?, last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success', last_sync_error = NULL WHERE id = ?").bind(JSON.stringify(recordsToUpdate), domain.id).run();
            log(`✔ 成功同步 ${domain.target_domain} (内容已更新)。`);
        }
    } catch (e) {
        log(`❌ 同步 ${domain.target_domain} 失败: ${e instanceof Error ? e.message : String(e)}`);
        await db.prepare("UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'failed', last_sync_error = ? WHERE id = ?").bind(e instanceof Error ? e.message : String(e), domain.id).run();
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
    const cnames = await getDnsFromDoh(domain, 'CNAME');
    if (cnames.length > 0) {
        const cnameTarget = cnames[0].replace(/\.$/, "");
        log(`(深度 ${depth}) 发现CNAME -> ${cnameTarget}`);
        const nextRecords = await resolveRecursively(cnameTarget, log, depth + 1);
        if (nextRecords.length > 0) {
            return nextRecords;
        }
        log(`(深度 ${depth + 1}) CNAME ${cnameTarget} 未解析到最终IP，将直接克隆此CNAME记录。`);
        return [{ type: 'CNAME', content: cnameTarget }];
    }
    log(`(深度 ${depth}) 未发现CNAME，查询最终IP for ${domain}`);
    const ipv4s = await getDnsFromDoh(domain, 'A');
    const ipv6s = await getDnsFromDoh(domain, 'AAAA');
    const validIPv4s = ipv4s.filter(ip => /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip));
    const validIPv6s = ipv6s.filter(ip => /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/.test(ip));
    return [...validIPv4s.map(ip => ({ type: 'A', content: ip })), ...validIPv6s.map(ip => ({ type: 'AAAA', content: ip }))];
}

/**
 * 分块并发处理（每块 Promise.allSettled）。
 * - fulfilled 且 `res.ok === false` 时立即抛错，短路后续批次，避免连接池与配额浪费
 * - fulfilled 时主动消费 body（arrayBuffer）释放连接到连接池
 * - 所有失败的 promise 收集后聚合抛错
 */
export async function processInChunks<T, R extends Response>(items: T[], chunkSize: number, processFn: (item: T) => Promise<R>, log: LogFn): Promise<R[]> {
    const allResponses: R[] = [];
    const errors: Error[] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        log(`正在处理一个包含 ${chunk.length} 个项目的批次...`);
        const settled = await Promise.allSettled(chunk.map(processFn));
        for (const s of settled) {
            if (s.status === 'fulfilled') {
                const res = s.value;
                if (!res.ok) {
                    // 早失败早退出：消费错误体后立即抛错，短路后续批次
                    const errBody = await res.json().catch(() => ({})) as { errors?: { code: number; message: string }[] };
                    const detail = (errBody.errors || []).map(e => `(Code ${e.code}: ${e.message})`).join(', ');
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
        throw new Error(`批次处理中发生 ${errors.length} 个错误: ${errors.map(e => e.message).join('; ')}`);
    }
    return allResponses;
}

/** 将解析结果写回 Cloudflare DNS（比对差异后增删） */
export async function updateCloudflareDns(token: string, zoneId: string, domain: DomainRow, newRecords: DnsRecord[], log: LogFn): Promise<string> {
    const API_CHUNK_SIZE = 10;
    const { target_domain, ttl } = domain;
    const API_ENDPOINT = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const listUrl = `${API_ENDPOINT}?name=${target_domain}&per_page=100`;
    const listResponse = await fetchWithRetry(listUrl, { headers }, 1, 15000);
    if (!listResponse.ok) throw new Error(`获取DNS记录列表失败: ${await listResponse.text()}`);
    const listResult = await listResponse.json() as { success: boolean; result: { id: string; type: string; content: string; proxied?: boolean; ttl?: number }[]; errors?: unknown[] };
    if (!listResult.success) throw new Error(`获取DNS记录列表API错误: ${JSON.stringify(listResult.errors)}`);

    const existingRecords = listResult.result;
    log(`目标 ${target_domain} 当前有 ${existingRecords.length} 条相关记录。`);

    const recordsToDelete: typeof existingRecords = [];
    const recordsToAdd = newRecords.map(r => ({ ...r, content: r.content.replace(/\.$/, "") }));
    const newRecordIsCname = recordsToAdd.some(r => r.type === 'CNAME');

    for (const existing of existingRecords) {
        const normalizedExistingContent = existing.content.replace(/\.$/, "");
        if ((newRecordIsCname && ['A', 'AAAA', 'CNAME'].includes(existing.type)) || (!newRecordIsCname && existing.type === 'CNAME')) {
            recordsToDelete.push(existing);
            continue;
        }
        let foundMatch = false;
        for (let i = recordsToAdd.length - 1; i >= 0; i--) {
            if (recordsToAdd[i].type === existing.type && recordsToAdd[i].content === normalizedExistingContent) {
                if (existing.proxied === false && existing.ttl === ttl) {
                    recordsToAdd.splice(i, 1);
                    foundMatch = true;
                    break;
                }
            }
        }
        if (!foundMatch && ['A', 'AAAA', 'CNAME'].includes(existing.type)) {
            recordsToDelete.push(existing);
        }
    }

    if (recordsToDelete.length === 0 && recordsToAdd.length === 0) {
        log(`记录无变化，无需操作。`);
        return 'no_change';
    }

    log(`计划删除 ${recordsToDelete.length} 条记录, 添加 ${recordsToAdd.length} 条记录。`);

    const deleteFn = (record: { id: string; type: string; content: string }) => {
        log(`- 准备删除旧记录: [${record.type}] ${record.content}`);
        return fetchWithRetry(`${API_ENDPOINT}/${record.id}`, { method: 'DELETE', headers }, 1, 15000);
    };

    const addFn = (record: DnsRecord) => {
        log(`+ 准备添加新记录: [${record.type}] ${record.content}`);
        return fetchWithRetry(API_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ type: record.type, name: target_domain, content: record.content, ttl, proxied: false }) }, 1, 15000);
    };

    const deleteResponses = await processInChunks(recordsToDelete, API_CHUNK_SIZE, deleteFn, log);
    const addResponses = await processInChunks(recordsToAdd, API_CHUNK_SIZE, addFn, log);

    // processInChunks 已在内部对非 2xx 短路抛错；此处仅做防御性聚合
    return 'success';
}
