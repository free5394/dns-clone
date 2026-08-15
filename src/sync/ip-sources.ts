// ip-sources.ts — IP 源抓取与同步逻辑
// 从 index.legacy.js 提取（原 1158-1236、1598-1673 行 + sync 入口函数）

import { getGitHubSettings, getSetting, queryAll } from '../db/client.ts';
import { getCurrentGitHubContent, updateFileOnGitHub } from './github.ts';
import { beijingTimeLog } from '../util/log.ts';
import { createLogStreamResponse } from '../util/sse.ts';
import { runWithOptionalLog } from '../util/run-with-log.ts';
import { fetchWithTimeout } from '../util/fetch.ts';
import { assertSafeHttpUrl } from '../util/url-safety.ts';

interface IpSourceRow {
    id: number;
    url: string;
    github_path: string;
    commit_message: string;
    fetch_strategy: string;
    is_enabled: number;
}

type StrategyFn = (url: string) => Promise<string[]>;

/** 抓取策略表 */
export const FETCH_STRATEGIES: Record<string, StrategyFn> = {
    direct_regex: async (url) => {
        const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 15000);
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const text = await res.text();
        const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
        return [...new Set(ips)];
    },
    phantomjs_cloud: async (url) => {
        const res = await fetchWithTimeout('https://PhantomJsCloud.com/api/browser/v2/a-demo-key-with-low-quota-per-ip-address/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, renderType: 'html' })
        }, 20000);
        if (!res.ok) throw new Error(`PhantomJsCloud API error ${res.status}`);
        const text = await res.text();
        const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
        return [...new Set(ips)];
    },
    proxy_codetabs: async (url) => {
        const proxyUrl = 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url);
        const res = await fetchWithTimeout(proxyUrl, {}, 15000);
        if (!res.ok) throw new Error(`CodeTabs Proxy error ${res.status}`);
        const text = await res.text();
        const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
        return [...new Set(ips)];
    },
};

type LogFn = (msg: string) => void;

/** 定时任务：批量同步 IP 源（失败优先） */
export async function syncScheduledIpSources(env: { WUYA: D1Database }): Promise<void> {
    // FIX-12: BATCH_SIZE 由 settings 配置（默认 10；非法值回退）
    const BATCH_SIZE = Number(await getSetting(env.WUYA, 'BATCH_SIZE')) || 10;
    const db = env.WUYA;
    const log: LogFn = (msg) => console.log(beijingTimeLog(msg));

    const githubSettings = await getGitHubSettings(db);
    if (!githubSettings.token || !githubSettings.owner || !githubSettings.repo) {
        log("Cannot run scheduled IP source sync: GitHub settings are missing.");
        return;
    }

    const query = `
        SELECT id FROM ip_sources
        WHERE is_enabled = 1
        ORDER BY
            CASE last_sync_status WHEN 'failed' THEN 0 ELSE 1 END,
            last_synced_time ASC
        LIMIT ?`;

    const sourcesToSync = await queryAll<{ id: number }>(db, query, BATCH_SIZE);

    if (sourcesToSync.length === 0) {
        log("No IP sources to sync in this batch.");
        return;
    }

    log(`Found ${sourcesToSync.length} IP sources for this sync batch (failure-first).`);
    for (const source of sourcesToSync) {
        await syncSingleIpSource(source.id, env, false).catch(e => {
            log(`Error processing IP source ID ${source.id} in batch: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
}

/** 单个 IP 源同步入口 */
export async function syncSingleIpSource(id: number, env: { WUYA: D1Database }, returnLogs: boolean, signal?: AbortSignal): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
        const githubSettings = await getGitHubSettings(db);
        if (!githubSettings.token || !githubSettings.owner || !githubSettings.repo) {
            throw new Error("GitHub API设置不完整。");
        }
        const gh = githubSettings as { token: string; owner: string; repo: string };
        const source = await db.prepare("SELECT * FROM ip_sources WHERE id = ? AND is_enabled = 1").bind(id).first() as IpSourceRow | null;
        if (!source) throw new Error(`未找到ID为 ${id} 的IP源或该源已被禁用。`);

        log(`======== 开始同步IP源: ${source.url} ========`);

        try {
            const ips = await fetchIpsFromSource(source, db);
            log(`成功获取 ${ips.length} 个IP。`);

            const newContent = ips.join('\n');
            const oldContent = await getCurrentGitHubContent({ ...gh, path: source.github_path, log });

            if (oldContent !== null && newContent.trim() === oldContent.trim()) {
                log(`内容无变化，无需更新 GitHub。`);
                await db.prepare("UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL WHERE id = ?").bind(id).run();
                log(`✔ 状态更新为内容一致。`);
                return;
            }

            await updateFileOnGitHub({ ...gh, path: source.github_path, content: newContent, message: source.commit_message, log });
            log(`✔ 成功同步到GitHub: ${source.github_path}`);

            await db.prepare("UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success', last_sync_error = NULL WHERE id = ?").bind(id).run();
        } catch (e) {
            log(`❌ 同步失败: ${e instanceof Error ? e.message : String(e)}`);
            await db.prepare("UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'failed', last_sync_error = ? WHERE id = ?").bind(e instanceof Error ? e.message : String(e), id).run();
            throw e;
        }
    };

    return await runWithOptionalLog(syncLogic, returnLogs, signal);
}

/** 批量同步全部启用 IP 源 */
export async function syncAllIpSources(env: { WUYA: D1Database }, returnLogs: boolean, signal?: AbortSignal): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
        log("开始批量同步IP源...");
        const sources = await queryAll<IpSourceRow>(db, "SELECT * FROM ip_sources WHERE is_enabled = 1");
        if (sources.length === 0) {
            log("没有已启用的IP源需要同步。");
            return;
        }
        for (const source of sources) {
            await syncSingleIpSource(source.id, env, false).catch(e => log(`处理ID ${source.id} 失败: ${e instanceof Error ? e.message : String(e)}`));
        }
        log("所有IP源同步任务执行完毕。");
    };

    if (returnLogs) return createLogStreamResponse(syncLogic, signal);

    const noOpLog: LogFn = (msg) => console.log(beijingTimeLog(msg));
    await syncLogic(noOpLog);
}

/** 按策略抓取 IP（带排序 + 失败自动回退） */
export async function fetchIpsFromSource(source: IpSourceRow, db?: D1Database): Promise<string[]> {
    assertSafeHttpUrl(source.url);
    // 构造尝试顺序：缓存策略优先，回退策略按声明顺序依次尝试
    const strategyNames = Object.keys(FETCH_STRATEGIES);
    const orderedNames = [source.fetch_strategy, ...strategyNames.filter(n => n !== source.fetch_strategy)];

    let lastError: unknown;
    for (const name of orderedNames) {
        const fn = FETCH_STRATEGIES[name];
        if (!fn) continue;
        try {
            const ips = await fn(source.url);
            if (ips && ips.length > 0) {
                if (name !== source.fetch_strategy) {
                    // 回退策略命中：更新传入对象的 fetch_strategy（调用方可感知），若提供了 db 则持久化
                    (source as { fetch_strategy: string }).fetch_strategy = name;
                    if (db) {
                        await db.prepare("UPDATE ip_sources SET fetch_strategy = ? WHERE id = ?").bind(name, source.id).run();
                    }
                }
                const sortIps = (a: string, b: string) => {
                    const aParts = a.split('.').map(Number);
                    const bParts = b.split('.').map(Number);
                    for (let i = 0; i < 4; i++) {
                        if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
                    }
                    return 0;
                };
                return ips.sort(sortIps);
            }
        } catch (e) {
            lastError = e;
        }
    }
    const detail = lastError instanceof Error ? `（最后错误：${lastError.message}）` : '';
    throw new Error(`所有抓取策略均未能从该URL获取到IP${detail}，请检查URL或在添加/编辑IP源时重新探测。`);
}

/** 三大运营商 IP 抓取（hostmonit HTML 表格解析）。失败抛错，由调用方决定是否降级。 */
export async function fetchThreeNetworkIps(source: string, log: (msg: string) => void): Promise<{ yd: string[]; dx: string[]; lt: string[] }> {
    log(`正在从源 [${source}] 获取IP...`);

    async function parseHtmlTableWithOperator(htmlContent: string) {
        const ips: { yd: Set<string>; dx: Set<string>; lt: Set<string> } = { yd: new Set(), dx: new Set(), lt: new Set() };
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

        let rowMatch;
        while ((rowMatch = rowRegex.exec(htmlContent)) !== null) {
            const cells = Array.from(rowMatch[1].matchAll(cellRegex), m => m[1].replace(/<[^>]+>/g, '').trim());
            if (cells.length >= 2) {
                const lineCell = cells.find(c => c.includes('电信') || c.includes('联通') || c.includes('移动'));
                const ipCell = cells.find(c => ipRegex.test(c));

                if (lineCell && ipCell) {
                    const ip = ipCell.match(ipRegex)?.[0] as string;
                    if (lineCell.includes('移动')) ips.yd.add(ip);
                    else if (lineCell.includes('电信')) ips.dx.add(ip);
                    else if (lineCell.includes('联通')) ips.lt.add(ip);
                }
            }
        }

        const allIpsArray = [...ips.yd, ...ips.dx, ...ips.lt];
        if (allIpsArray.length > 0) {
            const allIps = new Set(allIpsArray);
            if (ips.yd.size === 0) ips.yd = allIps;
            if (ips.dx.size === 0) ips.dx = allIps;
            if (ips.lt.size === 0) ips.lt = allIps;
        }

        return { yd: Array.from(ips.yd), dx: Array.from(ips.dx), lt: Array.from(ips.lt) };
    }

    let url: string;
    let usePhantom = false;
    switch (source) {
        case 'api.uouin.com':
            url = 'https://api.uouin.com/cloudflare.html';
            break;
        case 'wetest.vip':
            url = 'https://www.wetest.vip/page/cloudflare/address_v4.html';
            break;
        case 'CloudFlareYes':
        default:
            url = 'https://stock.hostmonit.com/CloudFlareYes';
            usePhantom = true;
            break;
    }

    const res = usePhantom
        ? await fetchWithTimeout('https://PhantomJsCloud.com/api/browser/v2/a-demo-key-with-low-quota-per-ip-address/', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, renderType: 'html' })
          }, 20000)
        : await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 15000);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);

    const htmlContent = await res.text();
    const result = await parseHtmlTableWithOperator(htmlContent);
    log(`从 [${source}] 获取到 ${result.yd.length + result.dx.length + result.lt.length} 个IP。`);
    return result;
}
