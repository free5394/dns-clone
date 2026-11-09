// ip-sources.ts — IP 源抓取与同步逻辑
// 从 index.legacy.js 提取（原 1158-1236、1598-1673 行 + sync 入口函数）

import {
    getGitHubSettings,
    getSetting,
    queryAll,
    releaseManualSyncLock,
    createManualSyncLockRenewer,
} from "../db/client.ts";
import { getCurrentGitHubContent, updateFileOnGitHub } from "./github.ts";
import { beijingTimeLog } from "../util/log.ts";
import { createLogStreamResponse } from "../util/sse.ts";
import { runWithOptionalLog } from "../util/run-with-log.ts";
import type { WaitUntil } from "../util/http.ts";
import { fetchWithTimeout } from "../util/fetch.ts";
import { HttpError, TimeoutError } from "../util/http-error.ts";
import { assertSafeHttpUrl } from "../util/url-safety.ts";
import { normalizeBatchSize } from "../util/batch-size.ts";
import { forEachIsolated } from "../util/batch-sync.ts";

interface IpSourceRow {
    id: number;
    url: string;
    github_path: string;
    commit_message: string;
    fetch_strategy: string;
    is_enabled: number;
}

type StrategyFn = (url: string) => Promise<string[]>;

/** 提取文本中的合法 IPv4（Suggestion ③：段值 ≤255，防止 999.x.x.x 伪 IP 发布给订阅器） */
function extractIpv4(text: string): string[] {
    const candidates = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
    return [...new Set(candidates.filter((ip) => ip.split(".").every((seg) => Number(seg) <= 255)))];
}

/** 抓取策略表 */
export const FETCH_STRATEGIES: Record<string, StrategyFn> = {
    direct_regex: async (url) => {
        const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 15000);
        if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}: ${url}`);
        const text = await res.text();
        return extractIpv4(text);
    },
    phantomjs_cloud: async (url) => {
        const res = await fetchWithTimeout(
            "https://PhantomJsCloud.com/api/browser/v2/a-demo-key-with-low-quota-per-ip-address/",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, renderType: "html" }),
            },
            20000
        );
        if (!res.ok) throw new HttpError(res.status, `PhantomJsCloud API HTTP ${res.status}`);
        const text = await res.text();
        return extractIpv4(text);
    },
    proxy_codetabs: async (url) => {
        const proxyUrl = "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url);
        const res = await fetchWithTimeout(proxyUrl, {}, 15000);
        if (!res.ok) throw new HttpError(res.status, `CodeTabs Proxy HTTP ${res.status}`);
        const text = await res.text();
        return extractIpv4(text);
    },
    // 免费渲染/转发通道：源站按 Cloudflare 出口 IP 拦截（直连 403）时仍能取到正文。
    // 实测 ipdb.api.030101.xyz 直连对 Worker 403、经 jina 返回 116 个 IP。
    jina_reader: async (url) => {
        const res = await fetchWithTimeout("https://r.jina.ai/" + url, {}, 20000);
        if (!res.ok) throw new HttpError(res.status, `Jina Reader HTTP ${res.status}`);
        return extractIpv4(await res.text());
    },
    // hostmonit 是前端 SPA，页面本身无 IP；数据来自公开 JSON 接口（key 取自其前端 bundle），直连即可
    hostmonit_api: async () => {
        const res = await fetchWithTimeout(
            "https://api.hostmonit.com/get_optimization_ip",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: "iDetkOys" }),
            },
            15000
        );
        if (!res.ok) throw new HttpError(res.status, `HostMonit API HTTP ${res.status}`);
        return extractIpv4(await res.text());
    },
};

/** 专用策略的适用性判定：不匹配的 URL 不进入尝试链，避免污染其它源的失败明细 */
const STRATEGY_APPLIES: Record<string, (url: string) => boolean> = {
    hostmonit_api: (url) => /(^|\.)hostmonit\.com$/i.test(new URL(url).hostname),
};

type LogFn = (msg: string) => void;

/** 定时任务：批量同步 IP 源（失败优先） */
export async function syncScheduledIpSources(env: { WUYA: D1Database }): Promise<void> {
    // FIX-12: BATCH_SIZE 由 settings 配置（默认 10；非法值回退）；I5: 负数钳制为默认值
    const BATCH_SIZE = normalizeBatchSize(await getSetting(env.WUYA, "BATCH_SIZE"));
    const db = env.WUYA;
    const log: LogFn = (msg) => console.log(beijingTimeLog(msg));

    const githubSettings = await getGitHubSettings(db);
    if (!githubSettings.token || !githubSettings.owner || !githubSettings.repo) {
        log("GitHub 配置缺失，跳过本轮 IP 源同步。");
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
        log("本轮没有需要同步的 IP 源。");
        return;
    }

    log(`本轮按失败优先选取 ${sourcesToSync.length} 个 IP 源。`);
    await forEachIsolated(
        sourcesToSync,
        async (source) => {
            await syncSingleIpSource(source.id, env, false);
        },
        (source, e) => log(`批量处理 IP 源 ID ${source.id} 失败: ${e instanceof Error ? e.stack : e}`)
    );
}

/** 单个 IP 源同步入口 */
export async function syncSingleIpSource(
    id: number,
    env: { WUYA: D1Database },
    returnLogs: boolean,
    signal?: AbortSignal,
    waitUntil?: WaitUntil
): Promise<Response | void> {
    const db = env.WUYA;
    const syncLogic = async (log: LogFn) => {
        const githubSettings = await getGitHubSettings(db);
        if (!githubSettings.token || !githubSettings.owner || !githubSettings.repo) {
            throw new Error("GitHub API设置不完整。");
        }
        const gh = githubSettings as { token: string; owner: string; repo: string };
        const source = (await db
            .prepare("SELECT * FROM ip_sources WHERE id = ? AND is_enabled = 1")
            .bind(id)
            .first()) as IpSourceRow | null;
        if (!source) throw new Error(`未找到ID为 ${id} 的IP源或该源已被禁用。`);

        log(`======== 开始同步IP源: ${source.url} ========`);

        try {
            const { ips, strategy, configuredStrategy } = await fetchIpsWithStrategy(source, db);
            // issue #22 P4：日志写实际生效策略；回退时点明从哪个策略退下来的
            const strategyNote =
                strategy === configuredStrategy
                    ? `（抓取策略: ${strategy}）`
                    : `（抓取策略: ${strategy}，已从 ${configuredStrategy} 回退）`;
            log(`成功获取 ${ips.length} 个IP${strategyNote}。`);

            const newContent = ips.join("\n");
            const oldContent = await getCurrentGitHubContent({ ...gh, path: source.github_path, log });

            if (oldContent !== null && newContent.trim() === oldContent.trim()) {
                log(`内容无变化，无需更新 GitHub。`);
                await db
                    .prepare(
                        "UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL WHERE id = ?"
                    )
                    .bind(id)
                    .run();
                log(`✔ 状态更新为内容一致。`);
                return;
            }

            await updateFileOnGitHub({
                ...gh,
                path: source.github_path,
                content: newContent,
                message: source.commit_message,
                log,
            });
            log(`✔ 成功同步到GitHub: ${source.github_path}`);

            await db
                .prepare(
                    "UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success', last_sync_error = NULL WHERE id = ?"
                )
                .bind(id)
                .run();
        } catch (e) {
            log(`❌ 同步失败: ${e instanceof Error ? e.message : String(e)}`);
            await db
                .prepare(
                    "UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'failed', last_sync_error = ? WHERE id = ?"
                )
                .bind(e instanceof Error ? e.message : String(e), id)
                .run();
            throw e;
        }
    };

    return await runWithOptionalLog(syncLogic, returnLogs, signal, waitUntil);
}

/** 批量同步全部启用 IP 源（lockToken 由路由层抢占，任务结束后在此释放） */
export async function syncAllIpSources(
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
            log("开始批量同步IP源...");
            const sources = await queryAll<IpSourceRow>(db, "SELECT * FROM ip_sources WHERE is_enabled = 1");
            if (sources.length === 0) {
                log("没有已启用的IP源需要同步。");
                return;
            }
            await renewLock();
            await forEachIsolated(
                sources,
                async (source) => {
                    try {
                        await syncSingleIpSource(source.id, env, false);
                    } finally {
                        // 单个 IP 源的三策略回退可能接近 1 分钟，每处理完一个条目续租一次（内部按 60 秒节流）
                        await renewLock();
                    }
                },
                (source, e) => log(`处理ID ${source.id} 失败: ${e instanceof Error ? e.message : String(e)}`)
            );
            log("所有IP源同步任务执行完毕。");
        } finally {
            await releaseManualSyncLock(db, renewLock.current());
        }
    };

    if (returnLogs) return createLogStreamResponse(syncLogic, signal, waitUntil);

    const noOpLog: LogFn = (msg) => console.log(beijingTimeLog(msg));
    await syncLogic(noOpLog);
}

/** 聚合错误的类别前缀：仪表盘文案一眼区分"源返回错误"与"链路超时"。
 * 前缀取最后一次尝试（lastError）的类别——与历史文案"（最后错误：…）"口径一致；
 * 各策略明细已逐一列进聚合文案括号内，混合失败时类别信息不丢。 */
function describeErrorCategory(e: unknown): string {
    if (e instanceof HttpError) return `HTTP ${e.status}`;
    if (e instanceof TimeoutError) return "超时";
    return "抓取失败";
}

/**
 * 把抓取失败归一成短诊断文案：已类别化的错误复用类别文案，
 * 其余取 message（超 200 字符截断，防止大响应原文塞爆 last_sync_error）。
 */
export function describeFetchError(e: unknown): string {
    if (e instanceof HttpError || e instanceof TimeoutError) return describeErrorCategory(e);
    const msg = e instanceof Error ? e.message : String(e);
    return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** 抓取结果：除了 IP，还要带回本次真正生效的策略（issue #22 P4）。 */
export interface IpFetchResult {
    ips: string[];
    /** 本次实际生效的抓取策略名（回退命中时为回退后的策略） */
    strategy: string;
    /** 调用前配置/缓存里的策略名，用于判断本次是否发生了回退 */
    configuredStrategy: string;
}

/** 按策略抓取 IP（带排序 + 失败自动回退），并回报实际生效的策略 */
export async function fetchIpsWithStrategy(source: IpSourceRow, db?: D1Database): Promise<IpFetchResult> {
    assertSafeHttpUrl(source.url);
    const configuredStrategy = source.fetch_strategy;
    // 构造尝试顺序：缓存策略优先，回退策略按声明顺序依次尝试
    const strategyNames = Object.keys(FETCH_STRATEGIES).filter((n) => {
        const applies = STRATEGY_APPLIES[n];
        return !applies || applies(source.url);
    });
    const orderedNames = [source.fetch_strategy, ...strategyNames.filter((n) => n !== source.fetch_strategy)];

    let lastError: unknown;
    const attempts: string[] = [];
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
                        await db
                            .prepare("UPDATE ip_sources SET fetch_strategy = ? WHERE id = ?")
                            .bind(name, source.id)
                            .run();
                    }
                }
                const sortIps = (a: string, b: string) => {
                    const aParts = a.split(".").map(Number);
                    const bParts = b.split(".").map(Number);
                    for (let i = 0; i < 4; i++) {
                        if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
                    }
                    return 0;
                };
                return { ips: ips.sort(sortIps), strategy: name, configuredStrategy };
            }
            // 空结果也记账：源站返回 200 但没有 IP 时若静默跳过，诊断文案只剩抛错的策略，
            // 会把人误导成"换个代理就好"（实测 id=8 页面 tbody 为空，文案却只显示 proxy_codetabs 超时）
            attempts.push(`${name}: 未匹配到 IP`);
        } catch (e) {
            lastError = e;
            attempts.push(`${name}: ${describeFetchError(e)}`);
        }
    }
    // D3 类别化文案：类别前缀 + 每策略摘要，随 last_sync_error 落库（只存 e.message，本文案即 message）
    const detail = attempts.length > 0 ? `（${attempts.join("; ")}）` : "";
    if (lastError === undefined) {
        throw new Error(
            `[无可用IP] 所有抓取策略均未能从该URL获取到IP${detail}，源站页面未返回任何 IP，请确认该列表是否已下架或在添加/编辑IP源时更换源。`
        );
    }
    const category = describeErrorCategory(lastError);
    throw new Error(`[${category}] 所有抓取策略均未能从该URL获取到IP${detail}，请检查URL或在添加/编辑IP源时重新探测。`);
}

/** 只要 IP 的旧入口（探测/兼容调用方用），策略信息走 fetchIpsWithStrategy。 */
export async function fetchIpsFromSource(source: IpSourceRow, db?: D1Database): Promise<string[]> {
    const { ips } = await fetchIpsWithStrategy(source, db);
    return ips;
}

/** 三网 IP 分类（yd 移动 / dx 电信 / lt 联通），供三网抓取与表格解析共用。 */
export interface ThreeNetworkIps {
    yd: string[];
    dx: string[];
    lt: string[];
}

/** 解析三网 IP HTML 表格（hostmonit 类页面结构）：按运营商分类，空分类用全集回填。 */
export async function parseHtmlTableWithOperator(htmlContent: string): Promise<ThreeNetworkIps> {
    const ips: { yd: Set<string>; dx: Set<string>; lt: Set<string> } = {
        yd: new Set(),
        dx: new Set(),
        lt: new Set(),
    };
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

    let rowMatch;
    while ((rowMatch = rowRegex.exec(htmlContent)) !== null) {
        const cells = Array.from(rowMatch[1].matchAll(cellRegex), (m) => m[1].replace(/<[^>]+>/g, "").trim());
        if (cells.length >= 2) {
            const lineCell = cells.find((c) => c.includes("电信") || c.includes("联通") || c.includes("移动"));
            const ipCell = cells.find((c) => ipRegex.test(c));

            if (lineCell && ipCell) {
                const ip = ipCell.match(ipRegex)?.[0] as string;
                if (lineCell.includes("移动")) ips.yd.add(ip);
                else if (lineCell.includes("电信")) ips.dx.add(ip);
                else if (lineCell.includes("联通")) ips.lt.add(ip);
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

/** 三大运营商 IP 抓取（hostmonit HTML 表格解析）。失败抛错，由调用方决定是否降级。 */
export async function fetchThreeNetworkIps(source: string, log: (msg: string) => void): Promise<ThreeNetworkIps> {
    log(`正在从源 [${source}] 获取IP...`);

    let url: string;
    let usePhantom = false;
    switch (source) {
        case "api.uouin.com":
            url = "https://api.uouin.com/cloudflare.html";
            break;
        case "wetest.vip":
            url = "https://www.wetest.vip/page/cloudflare/address_v4.html";
            break;
        case "CloudFlareYes":
        default:
            url = "https://stock.hostmonit.com/CloudFlareYes";
            usePhantom = true;
            break;
    }

    const res = usePhantom
        ? await fetchWithTimeout(
              "https://PhantomJsCloud.com/api/browser/v2/a-demo-key-with-low-quota-per-ip-address/",
              {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ url, renderType: "html" }),
              },
              20000
          )
        : await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 15000);
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}: ${url}`);

    const htmlContent = await res.text();
    const result = await parseHtmlTableWithOperator(htmlContent);
    log(`从 [${source}] 获取到 ${result.yd.length + result.dx.length + result.lt.length} 个IP。`);
    return result;
}
