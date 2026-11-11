// api.ts — API 路由层（handleApiRequest + 所有 /api/* 处理函数）
// 从 index.legacy.js 提取（原 104-302、227-302、1085-1148 行区域）

import {
    getSetting,
    setSetting,
    getCfApiSettings,
    getGitHubSettings,
    getSafeSettings,
    acquireManualSyncLock,
    DOMAIN_COLUMNS,
    IP_SOURCE_COLUMNS,
} from "../db/client.ts";
import { ensureInitialData } from "../db/migrations.ts";
import { jsonResponse, getCookie } from "../util/http.ts";
import type { WaitUntil } from "../util/http.ts";
import { hashPassword, isAuthenticated, verifyPassword } from "../util/auth.ts";
import { getZoneName } from "../util/cf.ts";
import { FETCH_STRATEGIES, resolveHostmonitKey } from "../sync/ip-sources.ts";
import { deriveCompanionPath, normalizeGithubPath } from "../sync/github.ts";
import { parseContent, validateParseConfig, type ParseMode } from "../sync/ip-parse.ts";
import { syncAllDomains, syncSystemDomains, syncSingleDomain } from "../sync/domains.ts";
import { syncSingleIpSource, syncAllIpSources } from "../sync/ip-sources.ts";
import { assertSafeHttpUrl } from "../util/url-safety.ts";
import { fetchWithTimeout } from "../util/fetch.ts";
import {
    CONFIG_SETTING_KEYS,
    HOSTMONIT_API_KEY,
    MAX_IPS_PER_TYPE_KEY,
    isHostmonitKeyConfigured,
    normalizeSettingsInput,
    validateEffectiveSettings,
} from "../db/settings.ts";
import { normalizeMaxIpsPerType } from "../util/max-ips-per-type.ts";

/** 检测 D1/SQLite UNIQUE 约束违例（D1 同时支持 message 与 code 两种错误呈现方式） */
const isUniqueViolation = (e: unknown): boolean =>
    e instanceof Error && (/UNIQUE constraint failed/i.test(e.message) || /SQLITE_CONSTRAINT/i.test(e.message));

/** 读取 JSON 请求体；非法 JSON 返回 null，由调用方回 400（Suggestion ①：不冒泡成 500） */
async function readJsonBody<T>(request: Request): Promise<T | null> {
    try {
        return (await request.json()) as T;
    } catch {
        return null;
    }
}

const BAD_JSON = () => jsonResponse({ error: "请求体不是合法 JSON。" }, 400);

/** API 路由分发 */
export async function handleApiRequest(
    request: Request,
    env: { WUYA: D1Database },
    waitUntil?: WaitUntil
): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.WUYA;

    if (path === "/api/status" && method === "GET") {
        const passwordSet = await getSetting(db, "ADMIN_PASSWORD_HASH");
        return jsonResponse({ isInitialized: !!passwordSet });
    }
    if (path === "/api/setup" && method === "POST") return await apiSetup(request, db);
    if (path === "/api/login" && method === "POST") return await apiLogin(request, db);

    if (!(await isAuthenticated(request, db))) return jsonResponse({ error: "未授权" }, 401);

    if (method === "POST" && path === "/api/logout") return await apiLogout(request, db);
    if (method === "GET" && path === "/api/settings") return await apiGetSettings(request, db);
    if (method === "POST" && path === "/api/settings") return await apiSetSettings(request, db);
    if (method === "GET" && path === "/api/domains") return await apiGetDomains(request, db);
    if (method === "GET" && path === "/api/domains/records") return await apiGetDomainsRecords(db);
    if (method === "POST" && path === "/api/domains") return await apiAddDomain(request, db);
    if (method === "POST" && path === "/api/sync")
        return withManualSyncLock(db, (lockToken) => syncAllDomains(env, true, request.signal, lockToken, waitUntil));
    if (method === "POST" && path === "/api/domains/sync_system")
        return withManualSyncLock(db, (lockToken) =>
            syncSystemDomains(env, true, request.signal, lockToken, waitUntil)
        );

    const domainMatch = path.match(/^\/api\/domains\/(\d+)$/);
    if (domainMatch) {
        const id = domainMatch[1];
        if (method === "PUT") return await apiUpdateDomain(request, db, id);
        if (method === "DELETE") return await apiDeleteDomain(request, db, id);
    }

    const domainRecordsMatch = path.match(/^\/api\/domains\/(\d+)\/records$/);
    if (domainRecordsMatch && method === "GET") {
        const id = domainRecordsMatch[1];
        return await apiGetDomainRecords(id, db);
    }

    const syncMatch = path.match(/^\/api\/domains\/(\d+)\/sync$/);
    if (syncMatch && method === "POST") {
        const id = syncMatch[1];
        return syncSingleDomain(Number(id), env, true, request.signal, waitUntil) as Promise<Response>;
    }

    if (method === "GET" && path === "/api/ip_sources") return await apiGetIpSources(db);
    if (method === "POST" && path === "/api/ip_sources") return await apiAddIpSource(request, db);
    if (method === "POST" && path === "/api/ip_sources/probe") return await apiProbeIpSource(request, db);
    if (method === "POST" && path === "/api/ip_sources/sync_all")
        return withManualSyncLock(db, (lockToken) => syncAllIpSources(env, true, request.signal, lockToken, waitUntil));

    const ipSourceMatch = path.match(/^\/api\/ip_sources\/(\d+)$/);
    if (ipSourceMatch) {
        const id = Number(ipSourceMatch[1]);
        if (method === "PUT") return await apiUpdateIpSource(request, db, id);
        if (method === "DELETE") return await apiDeleteIpSource(db, id);
    }

    const ipSourceSyncMatch = path.match(/^\/api\/ip_sources\/(\d+)\/sync$/);
    if (ipSourceSyncMatch && method === "POST") {
        const id = Number(ipSourceSyncMatch[1]);
        return syncSingleIpSource(id, env, true, request.signal, waitUntil) as Promise<Response>;
    }

    return jsonResponse({ error: "API 端点未找到" }, 404);
}

/**
 * 手动全量同步的互斥入口：抢不到锁直接 409，避免重复点击把同一批任务跑两遍。
 * 锁在任务流内部（`finally`）释放，覆盖成功、异常与中断三种结束方式。
 */
async function withManualSyncLock(
    db: D1Database,
    run: (lockToken: string) => Promise<Response | void>
): Promise<Response> {
    const lockToken = await acquireManualSyncLock(db);
    if (!lockToken) return jsonResponse({ error: "手动同步任务正在执行，请稍后再试。" }, 409);
    return (await run(lockToken)) as Response;
}

async function apiSetup(request: Request, db: D1Database): Promise<Response> {
    const body = await readJsonBody<{ password?: string }>(request);
    if (body === null) return BAD_JSON();
    const { password } = body;
    if (!password || password.length < 8 || password.length > 1024)
        return jsonResponse({ error: "密码长度必须为 8 到 1024 个字符之间。" }, 400);

    // L2：hash 与 salt 在同一个原子 batch 写入；并发时只有首个请求能写入。
    // 兼容旧实现的 pending 占位哈希：若上次中断留下占位，允许本次完整重写。
    const salt = crypto.randomUUID();
    const hash = await hashPassword(password, salt);
    const placeholder = "pbkdf2$100000$pending$pending";
    const claims = await db.batch([
        db
            .prepare("UPDATE settings SET value = ? WHERE key = 'ADMIN_PASSWORD_HASH' AND value = ?")
            .bind(hash, placeholder),
        db
            .prepare(
                "INSERT INTO settings (key, value) SELECT 'ADMIN_PASSWORD_HASH', ? WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'ADMIN_PASSWORD_HASH')"
            )
            .bind(hash),
        db
            .prepare(
                "INSERT INTO settings (key, value) SELECT 'PASSWORD_SALT', ? WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'ADMIN_PASSWORD_HASH' AND value = ?)"
            )
            .bind(salt, hash),
    ]);
    const claimed = (claims[0].meta.changes || 0) + (claims[1].meta.changes || 0);
    if (claimed === 0) {
        return jsonResponse({ error: "应用已经初始化。" }, 403);
    }
    return jsonResponse({ success: true });
}

async function apiLogin(request: Request, db: D1Database): Promise<Response> {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    // 速率限制：5 分钟内失败 ≥5 次则拒绝
    const recent = await db
        .prepare(
            "SELECT COUNT(*) as n FROM login_attempts WHERE ip = ? AND success = 0 AND attempted_at > datetime('now', '-5 minutes')"
        )
        .bind(ip)
        .first();
    if (recent && (recent as { n: number }).n >= 5) {
        return jsonResponse({ error: "尝试过于频繁，请稍后再试。" }, 429);
    }

    const loginBody = await readJsonBody<{ password?: string }>(request);
    if (loginBody === null) return BAD_JSON();
    const { password } = loginBody;
    const [storedHash, salt] = await Promise.all([
        getSetting(db, "ADMIN_PASSWORD_HASH"),
        getSetting(db, "PASSWORD_SALT"),
    ]);
    if (!storedHash || !salt) return jsonResponse({ error: "应用尚未初始化。" }, 400);
    const result = await verifyPassword(password || "", storedHash, salt);
    if (result.matched) {
        // legacy 旧哈希登录成功后立即升级为 PBKDF2
        if (result.upgradedHash) await setSetting(db, "ADMIN_PASSWORD_HASH", result.upgradedHash);
        const token = crypto.randomUUID();
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await db.batch([
            db.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expires.toISOString()),
            db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')"),
            db.prepare("INSERT INTO login_attempts (ip, success) VALUES (?, 1)").bind(ip),
            db.prepare("DELETE FROM login_attempts WHERE ip = ? AND success = 0").bind(ip),
        ]);
        const sessionCookie = `session=${token}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=86400`;
        return jsonResponse({ success: true }, 200, { "Set-Cookie": sessionCookie });
    }
    await db.prepare("INSERT INTO login_attempts (ip, success) VALUES (?, 0)").bind(ip).run();
    return jsonResponse({ error: "密码无效。" }, 401);
}

async function apiLogout(request: Request, db: D1Database): Promise<Response> {
    const token = getCookie(request, "session");
    if (token) await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    const expiryCookie = "session=; HttpOnly; Secure; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
    return jsonResponse({ success: true }, 200, { "Set-Cookie": expiryCookie });
}

async function apiGetSettings(request: Request, db: D1Database): Promise<Response> {
    const settings = await getSafeSettings(db);
    const [{ token, zoneId }, github, zoneName, hostmonitKey] = await Promise.all([
        getCfApiSettings(db),
        getGitHubSettings(db),
        getSetting(db, "CF_ZONE_NAME"),
        getSetting(db, HOSTMONIT_API_KEY),
    ]);
    return jsonResponse({
        ...settings,
        // issue #49：读取归一——缺失或损坏的存量值回退默认 20（与 normalizeBatchSize 同风格）
        [MAX_IPS_PER_TYPE_KEY]: normalizeMaxIpsPerType(settings[MAX_IPS_PER_TYPE_KEY]),
        zoneName: zoneName || "",
        CF_CONFIGURED: Boolean(token && zoneId),
        GITHUB_CONFIGURED: Boolean(github.token && github.owner && github.repo),
        // 只回传是否已自定义，key 原文属于敏感字段（getSafeSettings 已剔除）；
        // 判据与抓取一致：纯空白等同未配置（issue #32）
        HOSTMONIT_CONFIGURED: isHostmonitKeyConfigured(hostmonitKey),
    });
}

async function apiSetSettings(request: Request, db: D1Database): Promise<Response> {
    const rawBody = await readJsonBody<Record<string, unknown>>(request);
    if (rawBody === null || typeof rawBody !== "object") return BAD_JSON();
    const normalized = normalizeSettingsInput(rawBody);
    if (!normalized.ok) return jsonResponse({ error: normalized.error }, 400);
    const settings = normalized.settings;

    const currentConfig = Object.fromEntries(
        await Promise.all(CONFIG_SETTING_KEYS.map(async (key) => [key, await getSetting(db, key)]))
    ) as Record<(typeof CONFIG_SETTING_KEYS)[number], string | null>;
    const effective = { ...currentConfig, ...settings };
    const { CF_API_TOKEN, CF_ZONE_ID } = effective;

    // 配对校验基于合并现有配置后的有效配置，允许保留旧 Token 只修改其它字段。
    const pairingError = validateEffectiveSettings(effective);
    if (pairingError !== null) return jsonResponse({ error: pairingError }, 400);

    const cfConfigChanged = settings.CF_API_TOKEN !== undefined || settings.CF_ZONE_ID !== undefined;
    if (CF_API_TOKEN && CF_ZONE_ID && cfConfigChanged) {
        try {
            const zoneName = await getZoneName(CF_API_TOKEN, CF_ZONE_ID);
            settings.CF_ZONE_NAME = zoneName;
            await ensureInitialData(db, CF_ZONE_ID, zoneName);
        } catch (e) {
            return jsonResponse(
                { error: `Cloudflare API 验证失败: ${e instanceof Error ? e.message : String(e)}` },
                400
            );
        }
    }
    if (!CF_API_TOKEN || !CF_ZONE_ID) settings.CF_ZONE_NAME = null;

    // FIX-18: setSetting 提供 null 删除语义；这里不再把空串折叠成清除。
    await Promise.all(Object.entries(settings).map(([key, value]) => setSetting(db, key, value)));
    return jsonResponse({ success: true, message: "设置已成功保存。" });
}

async function apiGetDomains(request: Request, db: D1Database): Promise<Response> {
    const query = `SELECT ${DOMAIN_COLUMNS} FROM domains ORDER BY is_system DESC, target_domain`;
    const { results } = await db.prepare(query).all();
    return jsonResponse(results);
}

/** 深解析开关：只接受 0 / 1 与布尔值，字符串与其它数字一律拒绝，避免脏值被 ?. 隐式兜底成 1 写库 */
function normalizeDeepResolve(value: unknown): { ok: true; value: number | null } | { ok: false } {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (value === true || value === 1) return { ok: true, value: 1 };
    if (value === false || value === 0) return { ok: true, value: 0 };
    return { ok: false };
}

/**
 * 读取缓存的 Cloudflare 区域名称；缺失时按需从 API 获取并回填。
 * 全新环境可能只配置了 Token / Zone ID 而没有 CF_ZONE_NAME（该值原本只在保存设置时回填），
 * 添加目标时补全即可，不必要求管理员先保存一次设置（issue #21）。
 */
async function resolveZoneName(
    db: D1Database,
    token: string,
    zoneId: string
): Promise<{ ok: true; zoneName: string } | { ok: false; error: string }> {
    let zoneName = ((await getSetting(db, "CF_ZONE_NAME")) || "").replace(/\.$/, "");
    if (zoneName) return { ok: true, zoneName };
    try {
        zoneName = (await getZoneName(token, zoneId)).replace(/\.$/, "");
    } catch (e) {
        const detail = e instanceof Error ? `：${e.message}` : "";
        return {
            ok: false,
            error: `无法获取 Cloudflare 区域名称，请先在「系统设置」重新保存 Cloudflare 配置${detail}`,
        };
    }
    if (!zoneName) {
        return { ok: false, error: "无法获取 Cloudflare 区域名称，请先在「系统设置」重新保存 Cloudflare 配置。" };
    }
    await setSetting(db, "CF_ZONE_NAME", zoneName);
    return { ok: true, zoneName };
}

async function handleDomainMutation(
    request: Request,
    db: D1Database,
    isUpdate = false,
    id: string | null = null
): Promise<Response> {
    const body = await readJsonBody<{
        source_domain?: string;
        target_domain_prefix?: string;
        is_deep_resolve?: unknown;
        ttl?: number;
        notes?: string;
    }>(request);
    if (body === null) return BAD_JSON();
    const { source_domain, target_domain_prefix, is_deep_resolve, ttl, notes } = body;
    const source = String(source_domain ?? "").trim();

    let existing: { source_domain: string; is_system: number } | null = null;
    if (isUpdate && id) {
        existing = (await db.prepare("SELECT source_domain, is_system FROM domains WHERE id = ?").bind(id).first()) as {
            source_domain: string;
            is_system: number;
        } | null;
        if (!existing) return jsonResponse({ error: "目标不存在。" }, 404);
        if (existing.is_system === 1 && existing.source_domain !== source) {
            return jsonResponse({ error: "系统预设域名的源域名不可修改。" }, 403);
        }
    }
    const prefix = String(target_domain_prefix ?? "").trim() || "@";
    const effectiveTtl = ttl === undefined ? 60 : ttl;
    const hostnamePattern =
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    if (!source || (!source.startsWith("internal:") && !hostnamePattern.test(source))) {
        return jsonResponse({ error: "源域名格式无效。" }, 400);
    }
    if (source.startsWith("internal:") && !/^internal:hostmonit:(yd|dx|lt)$/.test(source)) {
        return jsonResponse({ error: "内置源域名格式无效。" }, 400);
    }
    if (prefix !== "@" && !labelPattern.test(prefix)) {
        return jsonResponse({ error: "目标前缀必须是单个 DNS label 或 @。" }, 400);
    }
    if (
        typeof effectiveTtl !== "number" ||
        !Number.isInteger(effectiveTtl) ||
        effectiveTtl < 1 ||
        effectiveTtl > 86400 ||
        (effectiveTtl > 1 && effectiveTtl < 60)
    ) {
        return jsonResponse({ error: "TTL 必须为 1（自动）或 60 到 86400 之间的整数。" }, 400);
    }
    const deepResolve = normalizeDeepResolve(is_deep_resolve);
    if (!deepResolve.ok) return jsonResponse({ error: "is_deep_resolve 必须为 0 或 1。" }, 400);
    try {
        const { zoneId, token } = await getCfApiSettings(db);
        if (!token || !zoneId) {
            return jsonResponse({ error: "Cloudflare API 未配置，请先在「系统设置」填写 API 令牌与区域 ID。" }, 400);
        }
        const resolved = await resolveZoneName(db, token, zoneId);
        if (!resolved.ok) return jsonResponse({ error: resolved.error }, 400);
        const zoneName = resolved.zoneName;
        const target_domain = prefix === "@" ? zoneName : `${prefix}.${zoneName}`;

        if (isUpdate && id) {
            await db
                .prepare(
                    "UPDATE domains SET source_domain=?, target_domain=?, zone_id=?, is_deep_resolve=?, ttl=?, notes=? WHERE id=?"
                )
                .bind(source, target_domain, zoneId, deepResolve.value ?? 1, effectiveTtl, notes || null, id)
                .run();
            return jsonResponse({ success: true, message: "目标更新成功。" });
        }
        await db
            .prepare(
                "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes) VALUES (?, ?, ?, ?, ?, ?)"
            )
            .bind(source, target_domain, zoneId, deepResolve.value ?? 1, effectiveTtl, notes || null)
            .run();
        return jsonResponse({ success: true, message: "目标添加成功。" });
    } catch (e) {
        if (isUniqueViolation(e)) return jsonResponse({ error: "目标域名已存在。" }, 409);
        throw e;
    }
}

async function apiAddDomain(request: Request, db: D1Database): Promise<Response> {
    return handleDomainMutation(request, db, false);
}
async function apiUpdateDomain(request: Request, db: D1Database, id: string): Promise<Response> {
    return handleDomainMutation(request, db, true, id);
}

async function apiDeleteDomain(request: Request, db: D1Database, id: string): Promise<Response> {
    const { meta } = await db.prepare("DELETE FROM domains WHERE id = ? AND is_system = 0").bind(id).run();
    if (meta.changes === 0) {
        return jsonResponse({ error: "删除失败，目标为系统预设或不存在。" }, 403);
    }
    return jsonResponse({ success: true, message: "目标删除成功。" });
}

/** 批量取记录时同时发出的 Cloudflare 请求数上限，避免一次把出站额度打满 */
const RECORDS_FETCH_CONCURRENCY = 4;

type ZoneRecordsResult = { ok: true; records: unknown[] } | { ok: false; error: string };

/**
 * 拉取单个目标域名在 Cloudflare 上的 DNS 记录。
 * 单个端点与批量端点共用同一段出站逻辑，保证编码（Suggestion ⑨）、超时与错误文案只有一处定义。
 */
async function fetchZoneRecords(token: string, zoneId: string, name: string): Promise<ZoneRecordsResult> {
    try {
        const q = new URLSearchParams({ name, per_page: "100" }).toString();
        const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?${q}`;
        const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 10000);
        const data = (await response.json()) as { success: boolean; result?: unknown; errors?: unknown[] };
        if (!data.success) {
            // 上游错误详情只进日志：返回体不回传第三方报文，避免把内部细节暴露到浏览器
            console.error("Cloudflare DNS 记录查询失败", JSON.stringify(data.errors ?? []));
            return { ok: false, error: "Cloudflare API 返回错误，请稍后重试。" };
        }
        return { ok: true, records: (data.result ?? []) as unknown[] };
    } catch (e) {
        console.error("获取 DNS 记录失败", e instanceof Error ? e.stack : e);
        return { ok: false, error: "获取记录失败，请稍后重试。" };
    }
}

async function apiGetDomainRecords(id: string, db: D1Database): Promise<Response> {
    const { token, zoneId } = await getCfApiSettings(db);
    if (!token || !zoneId) return jsonResponse({ error: "Cloudflare API 未配置。" }, 400);
    const domain = (await db.prepare("SELECT target_domain FROM domains WHERE id = ?").bind(id).first()) as {
        target_domain: string;
    } | null;
    if (!domain) return jsonResponse({ error: "目标不存在。" }, 404);
    const result = await fetchZoneRecords(token, zoneId, domain.target_domain);
    if (!result.ok) return jsonResponse({ error: result.error }, 500);
    return jsonResponse(result.records);
}

/**
 * M-10：仪表盘一次性取回所有域名的 DNS 记录。
 * 旧行为是前端对每张卡片各发一次请求，每个请求都重新鉴权并重读 Cloudflare 配置，
 * 域名越多请求数与 D1 查询数线性增长（N+1）。
 */
async function apiGetDomainsRecords(db: D1Database): Promise<Response> {
    const { token, zoneId } = await getCfApiSettings(db);
    if (!token || !zoneId) return jsonResponse({ error: "Cloudflare API 未配置。" }, 400);
    const { results } = await db.prepare("SELECT id, target_domain FROM domains ORDER BY id").all();
    const rows = results as Array<{ id: number; target_domain: string }>;
    const payload: Record<string, { records: unknown[] } | { error: string }> = {};
    for (let i = 0; i < rows.length; i += RECORDS_FETCH_CONCURRENCY) {
        const slice = rows.slice(i, i + RECORDS_FETCH_CONCURRENCY);
        await Promise.all(
            slice.map(async (row) => {
                const result = await fetchZoneRecords(token, zoneId, row.target_domain);
                payload[String(row.id)] = result.ok ? { records: result.records } : { error: result.error };
            })
        );
    }
    return jsonResponse(payload);
}

async function apiGetIpSources(db: D1Database): Promise<Response> {
    const { results } = await db.prepare(`SELECT ${IP_SOURCE_COLUMNS} FROM ip_sources ORDER BY github_path`).all();
    return jsonResponse(results);
}

/** IP 源输入（新增与更新共用），所有字段通过结构校验后才允许落库 */
interface IpSourceInput {
    url: string;
    github_path: string;
    commit_message: string;
    fetch_strategy: string;
    parse_mode: ParseMode;
    parse_param: string | null;
}

type IpSourceValidation = { ok: true; input: IpSourceInput } | { ok: false; error: string };

/** 请求体可能缺字段，校验函数负责把缺失当成非法值处理 */
type IpSourceInputBody = Partial<IpSourceInput>;

/**
 * 校验 GitHub 文件路径并返回归一后的落库值。
 * 复用同步层的 normalizeGithubPath（一次解码 + 同一套形态校验 + 孤立代理项拦截），
 * 再叠加接口侧的总长与首尾空白约束，避免两处规则各自漂移。
 */
function validateGithubPath(path: string): { ok: true; value: string } | { ok: false; error: string } {
    let normalized: string;
    try {
        normalized = normalizeGithubPath(path);
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "GitHub 文件路径非法。" };
    }
    if (normalized.length > 512) return { ok: false, error: "GitHub 文件路径总长必须在 1–512 个字符之间。" };
    if (normalized.trim() !== normalized) return { ok: false, error: "GitHub 文件路径首尾不能包含空白。" };
    // 派生的 IPv6 伴生路径必须和主路径过同一套形态校验（issue #51 / 方案 §9.2）：
    // 只查总长会放过「末段 253–255 字符」的路径，保存放行后同步期才抛单段超限，
    // 该源每轮 failed 且永不收敛。
    const companionPath = deriveCompanionPath(normalized);
    if (companionPath.length > 512) {
        return { ok: false, error: "派生出的 IPv6 伴生文件路径超过 512 个字符，请缩短 GitHub 文件路径。" };
    }
    try {
        normalizeGithubPath(companionPath);
    } catch (e) {
        const reason = e instanceof Error ? e.message : "请在末段留出余量。";
        return { ok: false, error: `派生出的 IPv6 伴生文件路径非法：${reason}` };
    }
    return { ok: true, value: normalized };
}

/** 信任边界校验：URL 先走 SSRF 防护再限长；路径、提交信息与策略逐一约束 */
function validateIpSourceInput(body: IpSourceInputBody): IpSourceValidation {
    const { url, github_path, commit_message, fetch_strategy } = body;

    if (typeof url !== "string" || url.length === 0) return { ok: false, error: "URL 不能为空。" };
    try {
        assertSafeHttpUrl(url);
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "URL 校验失败。" };
    }
    if (url.length > 2048) return { ok: false, error: "URL 长度不能超过 2048 个字符。" };

    if (typeof github_path !== "string") return { ok: false, error: "GitHub 文件路径不能为空。" };
    const pathValidation = validateGithubPath(github_path);
    if (!pathValidation.ok) return { ok: false, error: pathValidation.error };

    if (typeof commit_message !== "string") return { ok: false, error: "提交信息不能为空。" };
    const trimmedMessage = commit_message.trim();
    if (trimmedMessage.length < 1 || trimmedMessage.length > 200)
        return { ok: false, error: "提交信息长度必须在 1–200 个字符之间。" };

    const strategyNames = Object.keys(FETCH_STRATEGIES);
    if (typeof fetch_strategy !== "string" || !strategyNames.includes(fetch_strategy))
        return { ok: false, error: `抓取策略非法：仅支持 ${strategyNames.join("、")}。` };

    // 解析配置与保存/探测共用同一套校验（§9.5）：NULL / 空串按 auto，非法值直接 400
    const parseValidation = validateParseConfig(body.parse_mode, body.parse_param);
    if (!parseValidation.ok) return { ok: false, error: parseValidation.error };

    return {
        ok: true,
        input: {
            url,
            github_path: pathValidation.value,
            commit_message,
            fetch_strategy,
            parse_mode: parseValidation.mode,
            parse_param: parseValidation.param,
        },
    };
}

type CompanionCheck = { status: "ok" } | { status: "conflict"; conflictPath: string } | { status: "missing" };

/**
 * 主文件与 IPv6 伴生文件共用同一份 Git 路径命名空间（issue #51）：
 * A 的主文件不能等于 B 的伴生文件，A 的伴生文件也不能等于 B 的主文件。
 * 只比较派生后的路径，不比较前缀 —— 这里按字符串全等判定双向冲突。
 * 更新路径顺带在这一趟扫描里确认目标行是否存在（不存在→missing），
 * 免得为「判存在」再多打一次 D1 往返。
 */
async function checkCompanionConflict(
    db: D1Database,
    githubPath: string,
    excludeId: number | undefined
): Promise<CompanionCheck> {
    const rows = await db.prepare("SELECT id, github_path FROM ip_sources").all<{
        id: number;
        github_path: string;
    }>();
    const companion = deriveCompanionPath(githubPath);
    let targetSeen = false;
    for (const row of rows.results ?? []) {
        if (excludeId !== undefined && row.id === excludeId) {
            targetSeen = true;
            continue;
        }
        // 新主文件撞了别人的伴生文件，或新伴生文件撞了别人的主文件
        if (row.github_path === companion || deriveCompanionPath(row.github_path) === githubPath) {
            return { status: "conflict", conflictPath: row.github_path };
        }
    }
    if (excludeId !== undefined && !targetSeen) return { status: "missing" };
    return { status: "ok" };
}

/**
 * 新增与更新的写库路径只在 SQL、附加绑定与成功文案上不同，
 * 解析、结构校验、伴生路径冲突与唯一键冲突处理保持同一条流水线，避免两处规则各自漂移。
 */
async function writeIpSource(
    request: Request,
    db: D1Database,
    options: {
        sql: string;
        bindings: unknown[];
        successMessage: string;
        /** 更新路径专用：id 不存在时 UPDATE 影响 0 行，此时不能报成功 */
        notFoundWhenNoRows?: boolean;
        /** 更新路径专用：冲突自检需要排除自身 */
        excludeId?: number;
    }
): Promise<Response> {
    const body = await readJsonBody<IpSourceInputBody>(request);
    if (body === null) return BAD_JSON();
    const validation = validateIpSourceInput(body);
    if (!validation.ok) return jsonResponse({ error: validation.error }, 400);
    const { url, github_path, commit_message, fetch_strategy, parse_mode, parse_param } = validation.input;
    const check = await checkCompanionConflict(db, github_path, options.excludeId);
    if (check.status === "missing") return jsonResponse({ error: "目标不存在。" }, 404);
    if (check.status === "conflict") {
        return jsonResponse(
            { error: `该 GitHub 文件路径与已有IP源 ${check.conflictPath} 的 IPv6 伴生文件路径互相冲突。` },
            409
        );
    }
    try {
        const result = await db
            .prepare(options.sql)
            .bind(url, github_path, commit_message, fetch_strategy, parse_mode, parse_param, ...options.bindings)
            .run();
        // UPDATE 命中 0 行说明 id 不存在：返回 404，避免把失败包装成「更新成功」
        if (options.notFoundWhenNoRows && (result.meta?.changes ?? 0) === 0) {
            return jsonResponse({ error: "目标不存在。" }, 404);
        }
        return jsonResponse({ success: true, message: options.successMessage });
    } catch (e) {
        if (isUniqueViolation(e)) return jsonResponse({ error: "该URL或GitHub文件路径已存在。" }, 409);
        throw e;
    }
}

function apiAddIpSource(request: Request, db: D1Database): Promise<Response> {
    return writeIpSource(request, db, {
        sql: "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy, parse_mode, parse_param) VALUES (?, ?, ?, ?, ?, ?)",
        bindings: [],
        successMessage: "IP源添加成功。",
    });
}

function apiUpdateIpSource(request: Request, db: D1Database, id: number): Promise<Response> {
    return writeIpSource(request, db, {
        sql: "UPDATE ip_sources SET url=?, github_path=?, commit_message=?, fetch_strategy=?, parse_mode=?, parse_param=? WHERE id=?",
        bindings: [id],
        successMessage: "IP源更新成功。",
        notFoundWhenNoRows: true,
        excludeId: id,
    });
}

async function apiDeleteIpSource(db: D1Database, id: number): Promise<Response> {
    const result = await db.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    // 删除命中 0 行说明 id 不存在：返回 404，不能把「什么都没删」报成「删除成功」
    if ((result.meta?.changes ?? 0) === 0) return jsonResponse({ error: "目标不存在。" }, 404);
    return jsonResponse({ success: true, message: "IP源删除成功。" });
}

/** 探测总预算：三个策略各自 15–20 秒超时，串行最坏约 50 秒，远超一次请求的合理等待时间 */
const PROBE_TOTAL_TIMEOUT_MS = 25000;

/** 探测总预算耗尽标记，用于把「超时」与「策略自身失败」区分开 */
class ProbeTimeoutError extends Error {}

/** 用剩余预算包住单次策略调用，超时抛出 ProbeTimeoutError 并清理定时器 */
async function withProbeTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new ProbeTimeoutError("探测总时长预算已用尽")), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function apiProbeIpSource(request: Request, db: D1Database): Promise<Response> {
    const body = await readJsonBody<{ url?: unknown; parse_mode?: unknown; parse_param?: unknown }>(request);
    if (body === null) return BAD_JSON();
    const { url } = body;
    // 解析配置非法时直接 400，不进入抓取（§9.3）
    const parseValidation = validateParseConfig(body.parse_mode, body.parse_param);
    if (!parseValidation.ok) return jsonResponse({ error: parseValidation.error }, 400);
    if (typeof url !== "string" || url.length === 0) return jsonResponse({ error: "缺少用于探测的 URL 参数。" }, 400);
    try {
        assertSafeHttpUrl(url);
    } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "URL 校验失败" }, 400);
    }

    // 探测与同步使用同一份 key 解析结果，避免设置页改了 key 但探测仍用旧默认值
    const hostmonitKey = await resolveHostmonitKey(db);
    const deadlineAt = Date.now() + PROBE_TOTAL_TIMEOUT_MS;
    let attempts = 0;
    let budgetExhausted = false;

    for (const [strategyName, strategyFn] of Object.entries(FETCH_STRATEGIES)) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
            budgetExhausted = true;
            break;
        }
        attempts += 1;
        try {
            // 与同步链路同一条解析路径：策略只取正文，解析配置在入口已校验
            const text = await withProbeTimeout(strategyFn(url, { hostmonitKey }), remaining);
            const { ipv4, ipv6 } = parseContent(text, parseValidation.mode, parseValidation.param);
            if (ipv4.length > 0 || ipv6.length > 0) {
                return jsonResponse({
                    success: true,
                    strategy: strategyName,
                    ipv4Count: ipv4.length,
                    ipv6Count: ipv6.length,
                    // 兼容旧前端/旧调用方：ipCount 仍表示 IPv4 数量
                    ipCount: ipv4.length,
                    sampleIps: ipv4.slice(0, 5),
                    sampleIpv6: ipv6.slice(0, 5),
                });
            }
        } catch (e) {
            if (e instanceof ProbeTimeoutError) budgetExhausted = true;
            console.log(`IP 源探测失败：URL '${url}'，策略 '${strategyName}'：${e instanceof Error ? e.stack : e}`);
        }
    }

    if (budgetExhausted) {
        return jsonResponse(
            {
                error: `IP 源探测超时：已尝试 ${attempts} 个策略，总时长超过 ${PROBE_TOTAL_TIMEOUT_MS / 1000} 秒预算，未提取到 IP。`,
            },
            400
        );
    }
    return jsonResponse({ error: "所有探测方案均失败，无法从此URL提取IP。" }, 400);
}
