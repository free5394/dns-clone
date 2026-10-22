// api.ts — API 路由层（handleApiRequest + 所有 /api/* 处理函数）
// 从 index.legacy.js 提取（原 104-302、227-302、1085-1148 行区域）

import { getSetting, setSetting, getCfApiSettings, getGitHubSettings, getSafeSettings } from "../db/client.ts";
import { ensureInitialData } from "../db/migrations.ts";
import { jsonResponse, getCookie } from "../util/http.ts";
import { hashPassword, isAuthenticated, verifyPassword } from "../util/auth.ts";
import { getZoneName } from "../util/cf.ts";
import { FETCH_STRATEGIES } from "../sync/ip-sources.ts";
import { syncAllDomains, syncSystemDomains, syncSingleDomain } from "../sync/domains.ts";
import { syncSingleIpSource, syncAllIpSources } from "../sync/ip-sources.ts";
import { assertSafeHttpUrl } from "../util/url-safety.ts";
import { fetchWithTimeout } from "../util/fetch.ts";
import { MAX_BATCH_SIZE } from "../util/batch-size.ts";

/** 允许写入的 settings 白名单 */
const ALLOWED_SETTINGS_KEYS = new Set([
    "CF_API_TOKEN",
    "CF_ZONE_ID",
    "GITHUB_TOKEN",
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "THREE_NETWORK_SOURCE",
    "BATCH_SIZE",
]);

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
export async function handleApiRequest(request: Request, env: { WUYA: D1Database }): Promise<Response> {
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
    if (method === "POST" && path === "/api/domains") return await apiAddDomain(request, db);
    if (method === "POST" && path === "/api/sync")
        return syncAllDomains(env, true, request.signal) as Promise<Response>;
    if (method === "POST" && path === "/api/domains/sync_system")
        return syncSystemDomains(env, true, request.signal) as Promise<Response>;

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
        return syncSingleDomain(Number(id), env, true, request.signal) as Promise<Response>;
    }

    if (method === "GET" && path === "/api/ip_sources") return await apiGetIpSources(db);
    if (method === "POST" && path === "/api/ip_sources") return await apiAddIpSource(request, db);
    if (method === "POST" && path === "/api/ip_sources/probe") return await apiProbeIpSource(request);
    if (method === "POST" && path === "/api/ip_sources/sync_all")
        return syncAllIpSources(env, true, request.signal) as Promise<Response>;

    const ipSourceMatch = path.match(/^\/api\/ip_sources\/(\d+)$/);
    if (ipSourceMatch) {
        const id = Number(ipSourceMatch[1]);
        if (method === "PUT") return await apiUpdateIpSource(request, db, id);
        if (method === "DELETE") return await apiDeleteIpSource(db, id);
    }

    const ipSourceSyncMatch = path.match(/^\/api\/ip_sources\/(\d+)\/sync$/);
    if (ipSourceSyncMatch && method === "POST") {
        const id = Number(ipSourceSyncMatch[1]);
        return syncSingleIpSource(id, env, true, request.signal) as Promise<Response>;
    }

    return jsonResponse({ error: "API 端点未找到" }, 404);
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
    const [{ token, zoneId }, github, zoneName] = await Promise.all([
        getCfApiSettings(db),
        getGitHubSettings(db),
        getSetting(db, "CF_ZONE_NAME"),
    ]);
    return jsonResponse({
        ...settings,
        zoneName: zoneName || "",
        CF_CONFIGURED: Boolean(token && zoneId),
        GITHUB_CONFIGURED: Boolean(github.token && github.owner && github.repo),
    });
}

async function apiSetSettings(request: Request, db: D1Database): Promise<Response> {
    const rawBody = await readJsonBody<Record<string, unknown>>(request);
    if (rawBody === null || typeof rawBody !== "object") return BAD_JSON();
    const rawSettings = rawBody;

    // 白名单：Secret Token 的空字符串表示保持不变，其它字段沿用空串清除语义。
    const secretSettingKeys = new Set(["CF_API_TOKEN", "GITHUB_TOKEN"]);
    const settings: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(rawSettings)) {
        if (!ALLOWED_SETTINGS_KEYS.has(key)) continue;
        if (value === null || value === undefined) {
            settings[key] = null;
        } else {
            const text = (typeof value === "string" ? value : String(value)).trim();
            if (text === "") {
                if (secretSettingKeys.has(key)) continue;
                settings[key] = null;
            } else {
                settings[key] = text;
            }
        }
        // I5: BATCH_SIZE 必须是 1..100 的整数——负数在 SQLite LIMIT 中等于无上限
        if (key === "BATCH_SIZE") {
            const n = Number(settings[key]);
            if (settings[key] === null || !Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
                return jsonResponse({ error: `BATCH_SIZE 必须为 1 到 ${MAX_BATCH_SIZE} 之间的整数。` }, 400);
            }
        }
    }

    const configKeys = ["CF_API_TOKEN", "CF_ZONE_ID", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"];
    const currentConfig = Object.fromEntries(
        await Promise.all(configKeys.map(async (key) => [key, await getSetting(db, key)]))
    ) as Record<(typeof configKeys)[number], string | null>;
    const effective = { ...currentConfig, ...settings };
    const { CF_API_TOKEN, CF_ZONE_ID, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = effective;

    // 配对校验基于合并现有配置后的有效配置，允许保留旧 Token 只修改其它字段。
    if (Boolean(CF_API_TOKEN) !== Boolean(CF_ZONE_ID)) {
        return jsonResponse({ error: "Cloudflare API 令牌和区域 ID 必须同时配置。" }, 400);
    }
    const githubValues = [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO];
    if (githubValues.some(Boolean) && githubValues.some((value) => !value)) {
        return jsonResponse({ error: "GitHub Token、Owner、Repo 必须同时配置。" }, 400);
    }

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
    const query = `
      SELECT id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes,
             strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time,
             last_sync_status, last_sync_error, is_enabled, is_system
      FROM domains ORDER BY is_system DESC, target_domain`;
    const { results } = await db.prepare(query).all();
    return jsonResponse(results);
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
        is_deep_resolve?: number;
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
    try {
        const { zoneId, token } = await getCfApiSettings(db);
        if (!token || !zoneId) return jsonResponse({ error: "Cloudflare API 未配置。" }, 400);
        const zoneName = ((await getSetting(db, "CF_ZONE_NAME")) || "").replace(/\.$/, "");
        if (!zoneName) return jsonResponse({ error: "Cloudflare 区域名称未缓存，请重新保存 Cloudflare 设置。" }, 400);
        const target_domain = prefix === "@" ? zoneName : `${prefix}.${zoneName}`;

        if (isUpdate && id) {
            await db
                .prepare(
                    "UPDATE domains SET source_domain=?, target_domain=?, zone_id=?, is_deep_resolve=?, ttl=?, notes=? WHERE id=?"
                )
                .bind(source, target_domain, zoneId, is_deep_resolve ?? 1, effectiveTtl, notes || null, id)
                .run();
            return jsonResponse({ success: true, message: "目标更新成功。" });
        }
        await db
            .prepare(
                "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes) VALUES (?, ?, ?, ?, ?, ?)"
            )
            .bind(source, target_domain, zoneId, is_deep_resolve ?? 1, effectiveTtl, notes || null)
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

async function apiGetDomainRecords(id: string, db: D1Database): Promise<Response> {
    try {
        const { token, zoneId } = await getCfApiSettings(db);
        if (!token || !zoneId) return jsonResponse({ error: "Cloudflare API 未配置。" }, 400);
        const domain = (await db.prepare("SELECT target_domain FROM domains WHERE id = ?").bind(id).first()) as {
            target_domain: string;
        } | null;
        if (!domain) return jsonResponse({ error: "目标不存在。" }, 404);
        // Suggestion ⑨: 查询参数编码（未编码时 " / & / 空格 会破坏或改写 CF API 查询）+ 超时
        const q = new URLSearchParams({ name: domain.target_domain, per_page: "100" }).toString();
        const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?${q}`;
        const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 10000);
        const data = (await response.json()) as { success: boolean; result?: unknown; errors?: unknown[] };
        if (!data.success) return jsonResponse({ error: `Cloudflare API 错误: ${JSON.stringify(data.errors)}` }, 500);
        return jsonResponse(data.result);
    } catch (e) {
        return jsonResponse({ error: `获取记录失败: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
}

async function apiGetIpSources(db: D1Database): Promise<Response> {
    const { results } = await db
        .prepare(
            "SELECT id, url, github_path, commit_message, fetch_strategy, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled FROM ip_sources ORDER BY github_path"
        )
        .all();
    return jsonResponse(results);
}

async function apiAddIpSource(request: Request, db: D1Database): Promise<Response> {
    const body = await readJsonBody<{
        url?: string;
        github_path?: string;
        commit_message?: string;
        fetch_strategy?: string;
    }>(request);
    if (body === null) return BAD_JSON();
    const { url, github_path, commit_message, fetch_strategy } = body;
    if (!url || !github_path || !commit_message || !fetch_strategy) {
        return jsonResponse({ error: "缺少必填字段或尚未成功探测获取策略。" }, 400);
    }
    try {
        assertSafeHttpUrl(url);
    } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "URL 校验失败" }, 400);
    }
    try {
        await db
            .prepare("INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)")
            .bind(url, github_path, commit_message, fetch_strategy)
            .run();
        return jsonResponse({ success: true, message: "IP源添加成功。" });
    } catch (e) {
        if (isUniqueViolation(e)) return jsonResponse({ error: "该URL或GitHub文件路径已存在。" }, 409);
        throw e;
    }
}

async function apiUpdateIpSource(request: Request, db: D1Database, id: number): Promise<Response> {
    const body = await readJsonBody<{
        url?: string;
        github_path?: string;
        commit_message?: string;
        fetch_strategy?: string;
    }>(request);
    if (body === null) return BAD_JSON();
    const { url, github_path, commit_message, fetch_strategy } = body;
    if (!url || !github_path || !commit_message || !fetch_strategy) {
        return jsonResponse({ error: "缺少必填字段或尚未成功探测获取策略。" }, 400);
    }
    try {
        assertSafeHttpUrl(url);
    } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "URL 校验失败" }, 400);
    }
    try {
        await db
            .prepare("UPDATE ip_sources SET url=?, github_path=?, commit_message=?, fetch_strategy=? WHERE id=?")
            .bind(url, github_path, commit_message, fetch_strategy, id)
            .run();
        return jsonResponse({ success: true, message: "IP源更新成功。" });
    } catch (e) {
        if (isUniqueViolation(e)) return jsonResponse({ error: "该URL或GitHub文件路径已存在。" }, 409);
        throw e;
    }
}

async function apiDeleteIpSource(db: D1Database, id: number): Promise<Response> {
    await db.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    return jsonResponse({ success: true, message: "IP源删除成功。" });
}

async function apiProbeIpSource(request: Request): Promise<Response> {
    const body = await readJsonBody<{ url?: string }>(request);
    if (body === null) return BAD_JSON();
    const { url } = body;
    if (!url) return jsonResponse({ error: "缺少用于探测的 URL 参数。" }, 400);
    try {
        assertSafeHttpUrl(url);
    } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : "URL 校验失败" }, 400);
    }

    for (const [strategyName, strategyFn] of Object.entries(FETCH_STRATEGIES)) {
        try {
            const ips = await strategyFn(url);
            if (ips && ips.length > 0) {
                return jsonResponse({
                    success: true,
                    strategy: strategyName,
                    ipCount: ips.length,
                    sampleIps: ips.slice(0, 5),
                });
            }
        } catch (e) {
            console.log(
                `Strategy '${strategyName}' failed for URL '${url}': ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }

    return jsonResponse({ error: "所有探测方案均失败，无法从此URL提取IP。" }, 400);
}
