// ip-sources.ts — IP 源抓取与同步逻辑
// 从 index.legacy.js 提取（原 1158-1236、1598-1673 行 + sync 入口函数）

import {
    getGitHubSettings,
    getSetting,
    queryAll,
    releaseManualSyncLock,
    createManualSyncLockRenewer,
} from "../db/client.ts";
import { deleteFileOnGitHub, deriveCompanionPath, getCurrentGitHubContent, updateFileOnGitHub } from "./github.ts";
import { beijingTimeLog } from "../util/log.ts";
import { createLogStreamResponse } from "../util/sse.ts";
import { runWithOptionalLog } from "../util/run-with-log.ts";
import type { WaitUntil } from "../util/http.ts";
import { fetchWithTimeout } from "../util/fetch.ts";
import { HttpError, TimeoutError } from "../util/http-error.ts";
import { assertSafeHttpUrl } from "../util/url-safety.ts";
import { normalizeBatchSize } from "../util/batch-size.ts";
import { HOSTMONIT_API_KEY, normalizeHostmonitKey } from "../db/settings.ts";
import { forEachIsolated } from "../util/batch-sync.ts";
import { parseContent } from "./ip-parse.ts";

interface IpSourceRow {
    id: number;
    url: string;
    github_path: string;
    commit_message: string;
    /** 列可空（迁移里的 fetch_strategy 无 NOT NULL），读取处一律按空串归一 */
    fetch_strategy: string | null;
    /** 解析模式，列可空；NULL / 空串按 auto 处理（issue #48 / #50） */
    parse_mode: string | null;
    /** 解析参数，仅 json_path / custom_regex 使用 */
    parse_param: string | null;
    is_enabled: number;
}

/** hostmonit 接口的内置 key（issue #25）：设置页留空/未配置时使用它 */
export const DEFAULT_HOSTMONIT_API_KEY = "iDetkOys";

/** 抓取上下文：目前只有 hostmonit 专用接口需要外部参数 */
export interface FetchStrategyContext {
    hostmonitKey: string;
}

/**
 * 抓取策略只负责「拿到正文」，IP 提取统一交给解析层（issue #50）。
 * 返回值是响应原文，截断与解析由 parseContent 承担。
 */
type StrategyFn = (url: string, context?: FetchStrategyContext) => Promise<string>;

/** 抓取策略表 */
export const FETCH_STRATEGIES: Record<string, StrategyFn> = {
    direct_regex: async (url) => {
        const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 15000);
        if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}: ${url}`);
        return await res.text();
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
        return await res.text();
    },
    proxy_codetabs: async (url) => {
        const proxyUrl = "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url);
        const res = await fetchWithTimeout(proxyUrl, {}, 15000);
        if (!res.ok) throw new HttpError(res.status, `CodeTabs Proxy HTTP ${res.status}`);
        return await res.text();
    },
    // 免费渲染/转发通道：源站按 Cloudflare 出口 IP 拦截（直连 403）时仍能取到正文。
    // 实测 ipdb.api.030101.xyz 直连对 Worker 403、经 jina 返回 116 个 IP。
    jina_reader: async (url) => {
        const res = await fetchWithTimeout("https://r.jina.ai/" + url, {}, 20000);
        if (!res.ok) throw new HttpError(res.status, `Jina Reader HTTP ${res.status}`);
        return await res.text();
    },
    // hostmonit 是前端 SPA，页面本身无 IP；数据来自公开 JSON 接口（key 取自其前端 bundle），直连即可。
    // key 允许在设置页覆盖（对方轮换后无需改代码），未配置时回落到内置默认值。
    hostmonit_api: async (_url, context) => {
        const res = await fetchWithTimeout(
            "https://api.hostmonit.com/get_optimization_ip",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: context?.hostmonitKey || DEFAULT_HOSTMONIT_API_KEY }),
            },
            15000
        );
        if (!res.ok) throw new HttpError(res.status, `HostMonit API HTTP ${res.status}`);
        return await res.text();
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

type GitHubTarget = { token: string; owner: string; repo: string };

/**
 * 单个文件的「按内容比对后写入」：远端内容与待写内容 trim 归一后相同就跳过，
 * 不同才落盘，并返回本轮是否真的写过 —— 主文件与 IPv6 伴生文件的变更检测走同一跳流水线，
 * 只差两条日志文案，避免两段逐行重复各自漂移。
 */
async function writeGitHubFileIfChanged(
    gh: GitHubTarget,
    path: string,
    content: string,
    message: string,
    log: LogFn,
    logs: { unchanged: string; written: string }
): Promise<boolean> {
    const remoteContent = await getCurrentGitHubContent({ ...gh, path, log });
    if (remoteContent !== null && content.trim() === remoteContent.trim()) {
        log(logs.unchanged);
        return false;
    }
    await updateFileOnGitHub({ ...gh, path, content, message, log });
    log(logs.written);
    return true;
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
        const gh = githubSettings as GitHubTarget;
        const source = (await db
            .prepare("SELECT * FROM ip_sources WHERE id = ? AND is_enabled = 1")
            .bind(id)
            .first()) as IpSourceRow | null;
        if (!source) throw new Error(`未找到ID为 ${id} 的IP源或该源已被禁用。`);

        log(`======== 开始同步IP源: ${source.url} ========`);

        try {
            const { ipv4, ipv6, strategy, configuredStrategy } = await fetchIpsWithStrategy(source, db);
            // issue #22 P4：日志写实际生效策略；确实发生过回退时才点明从哪个策略退下来的
            const fellBack = configuredStrategy !== "" && configuredStrategy !== strategy;
            const strategyNote = fellBack
                ? `（抓取策略: ${strategy}，已从 ${configuredStrategy} 回退）`
                : `（抓取策略: ${strategy}）`;
            // 日志只写策略与两类数量，不落正文（§13.2）
            log(`成功获取 ${ipv4.length} 个IPv4、${ipv6.length} 个IPv6${strategyNote}。`);

            // 主文件仍只装 IPv4；IPv6 走伴生文件（issue #51）。两条链路的变更检测彼此独立：
            // 主文件「无变化」不再提前返回，否则纯 IPv4 源永远走不到伴生删除、纯 IPv6 源永远走不到伴生写入。
            const companionPath = deriveCompanionPath(source.github_path);
            if (ipv4.length === 0 && ipv6.length > 0) {
                log(`仅解析到 IPv6：主文件按空内容处理，IPv6 伴生文件为 ${companionPath}。`);
            }

            let wroteSomething = false;

            if (
                await writeGitHubFileIfChanged(gh, source.github_path, ipv4.join("\n"), source.commit_message, log, {
                    unchanged: "主文件内容无变化，无需更新 GitHub。",
                    written: `✔ 成功同步到GitHub: ${source.github_path}`,
                })
            ) {
                wroteSomething = true;
            }

            // 伴生文件：非空则比对后写入；为空且远端存在才删除（deleteFileOnGitHub 内部 GET 404 时不发 DELETE）
            if (ipv6.length > 0) {
                if (
                    await writeGitHubFileIfChanged(gh, companionPath, ipv6.join("\n"), source.commit_message, log, {
                        unchanged: `IPv6 伴生文件内容无变化，无需更新: ${companionPath}`,
                        written: `✔ 成功同步 IPv6 伴生文件到GitHub: ${companionPath}`,
                    })
                ) {
                    wroteSomething = true;
                }
            } else if (await deleteFileOnGitHub({ ...gh, path: companionPath, message: source.commit_message, log })) {
                log(`✔ 已删除 IPv6 伴生文件: ${companionPath}`);
                wroteSomething = true;
            } else {
                log(`IPv6 为空且远端无伴生文件，跳过删除: ${companionPath}`);
            }

            // 整轮无任何写入才算 no_change；有任一文件落盘即 success
            const status = wroteSomething ? "success" : "no_change";
            await db
                .prepare(
                    "UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = ?, last_sync_error = NULL WHERE id = ?"
                )
                .bind(status, id)
                .run();
            log(wroteSomething ? `✔ 状态更新为同步成功。` : `✔ 状态更新为内容一致。`);
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

/** 抓取结果：解析出的 IPv4 / IPv6，以及本次真正生效的策略（issue #22 P4 / #50）。 */
export interface IpFetchResult {
    ipv4: string[];
    ipv6: string[];
    /** 本次实际生效的抓取策略名（回退命中时为回退后的策略） */
    strategy: string;
    /** 调用前配置/缓存里的策略名，用于判断本次是否发生了回退 */
    configuredStrategy: string;
}

/**
 * 解析本次实际使用的 hostmonit key（issue #25）：
 * 库里保存的非空值优先；未配置、已显式清除或只剩空白时回落到内置默认。
 * 空白判定与设置页的「已配置」状态共用 normalizeHostmonitKey（issue #32）。
 */
export async function resolveHostmonitKey(db: D1Database): Promise<string> {
    const stored = await getSetting(db, HOSTMONIT_API_KEY);
    return normalizeHostmonitKey(stored) || DEFAULT_HOSTMONIT_API_KEY;
}

/**
 * 抓取目标的最小形状：IP 源与域名（URL 输入）两类目标都能满足。
 * 策略链只关心 URL 与解析配置，抓到的结果落到哪张表由调用方注入（§6.3）。
 */
export interface StrategyTarget {
    id: number;
    url: string;
    fetch_strategy?: string | null;
    parse_mode?: string | null;
    parse_param?: string | null;
}

export interface StrategyFetchOptions {
    /** 回退命中后持久化实际生效的策略；不传则只就地改写 target.fetch_strategy（不落库） */
    persistStrategy?: (strategy: string, target: StrategyTarget) => Promise<void>;
    /**
     * 全链都取得正文却解析不到 IP 时返回空结果，而不是抛「[无可用IP]」。
     * 域名 URL 输入用它把「取得正文但 0 条」交给 syncDomainLogic 的 0 条分支判定（§6.3 / 验收 #8）；
     * IP 源保持既有抛错语义（诊断文案是它的主要价值）。
     */
    emptyWhenNoIps?: boolean;
}

/**
 * 按策略抓取并解析 IP（带排序 + 失败自动回退），并回报实际生效的策略。
 * 单一真相源：策略表、适用性判定、回退顺序与聚合错误文案都只在这里演进。
 */
export async function fetchIpsForTarget(
    target: StrategyTarget,
    db?: D1Database,
    options: StrategyFetchOptions = {}
): Promise<IpFetchResult> {
    assertSafeHttpUrl(target.url);
    // 列可空：NULL 归一到空串，避免日志里出现「已从 null 回退」
    const configuredStrategy = target.fetch_strategy ?? "";
    // 构造尝试顺序：缓存策略优先，回退策略按声明顺序依次尝试
    const strategyNames = Object.keys(FETCH_STRATEGIES).filter((n) => {
        const applies = STRATEGY_APPLIES[n];
        return !applies || applies(target.url);
    });
    const orderedNames = [configuredStrategy, ...strategyNames.filter((n) => n !== configuredStrategy)];
    // 设置页保存后下一次抓取立即生效：每次抓取都重新读取，不缓存到模块级变量
    const context: FetchStrategyContext = {
        hostmonitKey: db ? await resolveHostmonitKey(db) : DEFAULT_HOSTMONIT_API_KEY,
    };

    let lastError: unknown;
    // 是否至少有一条策略「成功取到正文但解析 0 条」：与「全部抓取抛错」是两种不同语义（§13.1）
    let fetchedWithoutIps = false;
    const attempts: string[] = [];
    for (const name of orderedNames) {
        const fn = FETCH_STRATEGIES[name];
        if (!fn) continue;
        try {
            // 策略只返回正文；「成功」= 取得正文且统一解析后至少 1 个 IP（IPv4/IPv6 合计，§6.2）
            const text = await fn(target.url, context);
            const { ipv4, ipv6 } = parseContent(text, target.parse_mode, target.parse_param);
            if (ipv4.length > 0 || ipv6.length > 0) {
                if (name !== configuredStrategy) {
                    // 回退策略命中：更新传入对象的 fetch_strategy（调用方可感知），由调用方决定是否落库
                    (target as { fetch_strategy: string }).fetch_strategy = name;
                    if (options.persistStrategy) await options.persistStrategy(name, target);
                }
                return { ipv4, ipv6, strategy: name, configuredStrategy };
            }
            // 空结果也记账：源站返回 200 但没有 IP 时若静默跳过，诊断文案只剩抛错的策略，
            // 会把人误导成"换个代理就好"（实测 id=8 页面 tbody 为空，文案却只显示 proxy_codetabs 超时）
            fetchedWithoutIps = true;
            attempts.push(`${name}: 未匹配到 IP`);
        } catch (e) {
            lastError = e;
            attempts.push(`${name}: ${describeFetchError(e)}`);
        }
    }
    // D3 类别化文案：类别前缀 + 每策略摘要，随 last_sync_error 落库（只存 e.message，本文案即 message）
    const detail = attempts.length > 0 ? `（${attempts.join("; ")}）` : "";
    // §13.1「成功但 0 条」与「抓取抛错」是两条不同分支：只要有一条策略成功取到正文却没有 IP，
    // 就属于前者——哪怕其它策略抛过错，也不能被 lastError 短路成抓取失败（否则 DNS 侧会误标 failed）。
    if (options.emptyWhenNoIps && (fetchedWithoutIps || lastError === undefined)) {
        return { ipv4: [], ipv6: [], strategy: "", configuredStrategy };
    }
    if (lastError === undefined) {
        throw new Error(
            `[无可用IP] 所有抓取策略均未能从该URL获取到IP${detail}，源站页面未返回任何 IP，请确认该列表是否已下架或在添加/编辑IP源时更换源。`
        );
    }
    const category = describeErrorCategory(lastError);
    throw new Error(`[${category}] 所有抓取策略均未能从该URL获取到IP${detail}，请检查URL或在添加/编辑IP源时重新探测。`);
}

/** 按策略抓取 IP 源（带排序 + 失败自动回退），回退命中后把策略持久化到 ip_sources */
export async function fetchIpsWithStrategy(source: IpSourceRow, db?: D1Database): Promise<IpFetchResult> {
    return fetchIpsForTarget(source, db, {
        persistStrategy: db
            ? async (strategy, target) => {
                  await db
                      .prepare("UPDATE ip_sources SET fetch_strategy = ? WHERE id = ?")
                      .bind(strategy, target.id)
                      .run();
              }
            : undefined,
    });
}

/** @internal 兼容测试/旧调用方；生产同步走 fetchIpsWithStrategy（需要实际生效的策略信息）。 */
export async function fetchIpsFromSource(source: IpSourceRow, db?: D1Database): Promise<string[]> {
    const { ipv4 } = await fetchIpsWithStrategy(source, db);
    return ipv4;
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
