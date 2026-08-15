// api.ts — API 路由层（handleApiRequest + 所有 /api/* 处理函数）
// 从 index.legacy.js 提取（原 104-302、227-302、1085-1148 行区域）

import { getSetting, setSetting, getFullSettings, getCfApiSettings, getSafeSettings } from '../db/client.ts';
import { ensureInitialData } from '../db/migrations.ts';
import { jsonResponse, getCookie } from '../util/http.ts';
import { hashPassword, isAuthenticated, verifyPassword } from '../util/auth.ts';
import { getZoneName } from '../util/cf.ts';
import { FETCH_STRATEGIES } from '../sync/ip-sources.ts';
import { syncAllDomains, syncSystemDomains, syncSingleDomain } from '../sync/domains.ts';
import { syncSingleIpSource, syncAllIpSources } from '../sync/ip-sources.ts';
import { assertSafeHttpUrl } from '../util/url-safety.ts';

/** 允许写入的 settings 白名单 */
const ALLOWED_SETTINGS_KEYS = new Set([
    'CF_API_TOKEN',
    'CF_ZONE_ID',
    'GITHUB_TOKEN',
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'THREE_NETWORK_SOURCE',
]);

/** 检测 D1/SQLite UNIQUE 约束违例（D1 同时支持 message 与 code 两种错误呈现方式） */
const isUniqueViolation = (e: unknown): boolean =>
    e instanceof Error && (
        /UNIQUE constraint failed/i.test(e.message) ||
        /SQLITE_CONSTRAINT/i.test(e.message)
    );

/** API 路由分发 */
export async function handleApiRequest(request: Request, env: { WUYA: D1Database }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.WUYA;

  if (path === '/api/status' && method === 'GET') {
      const passwordSet = await getSetting(db, 'ADMIN_PASSWORD_HASH');
      return jsonResponse({ isInitialized: !!passwordSet });
  }
  if (path === '/api/setup' && method === 'POST') return await apiSetup(request, db);
  if (path === '/api/login' && method === 'POST') return await apiLogin(request, db);

  if (!await isAuthenticated(request, db)) return jsonResponse({ error: '未授权' }, 401);

  if (method === 'POST' && path === '/api/logout') return await apiLogout(request, db);
  if (method === 'GET' && path === '/api/settings') return await apiGetSettings(request, db);
  if (method === 'POST' && path === '/api/settings') return await apiSetSettings(request, db);
  if (method === 'GET' && path === '/api/domains') return await apiGetDomains(request, db);
  if (method === 'POST' && path === '/api/domains') return await apiAddDomain(request, db);
  if (method === 'POST' && path === '/api/sync') return syncAllDomains(env, true, request.signal) as Promise<Response>;
  if (method === 'POST' && path === '/api/domains/sync_system') return syncSystemDomains(env, true, request.signal) as Promise<Response>;

  const domainMatch = path.match(/^\/api\/domains\/(\d+)$/);
  if (domainMatch) {
      const id = domainMatch[1];
      if (method === 'PUT') return await apiUpdateDomain(request, db, id);
      if (method === 'DELETE') return await apiDeleteDomain(request, db, id);
  }

  const domainRecordsMatch = path.match(/^\/api\/domains\/(\d+)\/records$/);
  if (domainRecordsMatch && method === 'GET') {
      const id = domainRecordsMatch[1];
      return await apiGetDomainRecords(id, db);
  }

  const syncMatch = path.match(/^\/api\/domains\/(\d+)\/sync$/);
  if (syncMatch && method === 'POST') {
      const id = syncMatch[1];
      return syncSingleDomain(Number(id), env, true, request.signal) as Promise<Response>;
  }

  if (method === 'GET' && path === '/api/ip_sources') return await apiGetIpSources(db);
  if (method === 'POST' && path === '/api/ip_sources') return await apiAddIpSource(request, db);
  if (method === 'POST' && path === '/api/ip_sources/probe') return await apiProbeIpSource(request);
  if (method === 'POST' && path === '/api/ip_sources/sync_all') return syncAllIpSources(env, true, request.signal) as Promise<Response>;

  const ipSourceMatch = path.match(/^\/api\/ip_sources\/(\d+)$/);
  if (ipSourceMatch) {
      const id = Number(ipSourceMatch[1]);
      if (method === 'PUT') return await apiUpdateIpSource(request, db, id);
      if (method === 'DELETE') return await apiDeleteIpSource(db, id);
  }

  const ipSourceSyncMatch = path.match(/^\/api\/ip_sources\/(\d+)\/sync$/);
  if (ipSourceSyncMatch && method === 'POST') {
      const id = Number(ipSourceSyncMatch[1]);
      return syncSingleIpSource(id, env, true, request.signal) as Promise<Response>;
  }

  return jsonResponse({ error: 'API 端点未找到' }, 404);
}

async function apiSetup(request: Request, db: D1Database): Promise<Response> {
  const passwordSet = await getSetting(db, 'ADMIN_PASSWORD_HASH');
  if (passwordSet) return jsonResponse({ error: '应用已经初始化。' }, 403);
  const { password } = await request.json() as { password?: string };
  if (!password || password.length < 8 || password.length > 1024) return jsonResponse({ error: '密码长度必须为 8 到 1024 个字符之间。' }, 400);
  const salt = crypto.randomUUID();
  const hash = await hashPassword(password, salt);
  await db.batch([
      db.prepare("INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?)").bind(hash),
      db.prepare("INSERT INTO settings (key, value) VALUES ('PASSWORD_SALT', ?)").bind(salt),
  ]);
  return jsonResponse({ success: true });
}

async function apiLogin(request: Request, db: D1Database): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // 速率限制：5 分钟内失败 ≥5 次则拒绝
  const recent = await db
    .prepare("SELECT COUNT(*) as n FROM login_attempts WHERE ip = ? AND success = 0 AND attempted_at > datetime('now', '-5 minutes')")
    .bind(ip)
    .first();
  if (recent && (recent as { n: number }).n >= 5) {
    return jsonResponse({ error: "尝试过于频繁，请稍后再试。" }, 429);
  }

  const { password } = await request.json() as { password?: string };
  const [storedHash, salt] = await Promise.all([getSetting(db, 'ADMIN_PASSWORD_HASH'), getSetting(db, 'PASSWORD_SALT')]);
  if (!storedHash || !salt) return jsonResponse({ error: '应用尚未初始化。' }, 400);
  const result = await verifyPassword(password || '', storedHash, salt);
  if (result.matched) {
      // legacy 旧哈希登录成功后立即升级为 PBKDF2
      if (result.upgradedHash) await setSetting(db, 'ADMIN_PASSWORD_HASH', result.upgradedHash);
      const token = crypto.randomUUID();
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.batch([
        db.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expires.toISOString()),
        db.prepare("INSERT INTO login_attempts (ip, success) VALUES (?, 1)").bind(ip),
        db.prepare("DELETE FROM login_attempts WHERE ip = ? AND success = 0").bind(ip),
      ]);
      const sessionCookie = `session=${token}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=86400`;
      return jsonResponse({ success: true }, 200, { 'Set-Cookie': sessionCookie });
  }
  await db.prepare("INSERT INTO login_attempts (ip, success) VALUES (?, 0)").bind(ip).run();
  return jsonResponse({ error: '密码无效。' }, 401);
}

async function apiLogout(request: Request, db: D1Database): Promise<Response> {
  const token = getCookie(request, 'session');
  if (token) await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  const expiryCookie = 'session=; HttpOnly; Secure; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  return jsonResponse({ success: true }, 200, { 'Set-Cookie': expiryCookie });
}

async function apiGetSettings(request: Request, db: D1Database): Promise<Response> {
    const settings = await getSafeSettings(db);
    const { token, zoneId } = await getCfApiSettings(db);
    if (token && zoneId) {
        try { settings.zoneName = await getZoneName(token, zoneId); } catch (e) { console.warn("Could not fetch zone name for settings endpoint"); }
    }
    return jsonResponse(settings);
}

async function apiSetSettings(request: Request, db: D1Database): Promise<Response> {
    const rawSettings = await request.json() as Record<string, unknown>;

    // 白名单：仅允许写入已知 key；保留 null 以表达"清除该字段"语义
    const settings: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(rawSettings)) {
        if (!ALLOWED_SETTINGS_KEYS.has(key)) continue;
        if (value === null || value === undefined) {
            settings[key] = null;
        } else if (typeof value === 'string') {
            settings[key] = value;
        } else {
            settings[key] = String(value);
        }
    }

    const { CF_API_TOKEN, CF_ZONE_ID, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = settings;

    // Cloudflare 凭据配对验证：只要任一出现，必须两个都提供
    if ((CF_API_TOKEN !== undefined) !== (CF_ZONE_ID !== undefined)) {
        return jsonResponse({ error: 'Cloudflare API 令牌和区域 ID 必须同时提供。' }, 400);
    }
    if (CF_API_TOKEN && CF_ZONE_ID) {
        try {
            const zoneName = await getZoneName(CF_API_TOKEN, CF_ZONE_ID);
            await ensureInitialData(db, CF_ZONE_ID, zoneName);
        } catch (e) {
            return jsonResponse({ error: `Cloudflare API 验证失败: ${e instanceof Error ? e.message : String(e)}` }, 400);
        }
    }

    // GitHub 凭据配对验证：同上
    const ghDefined = [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO].filter(v => v !== undefined);
    if (ghDefined.length > 0 && ghDefined.length < 3) {
        return jsonResponse({ error: 'GitHub Token、Owner、Repo 必须同时提供。' }, 400);
    }

    // FIX-18: 用 setSetting 替代裸 INSERT OR REPLACE —— null/空字符串统一表示清除
    // 单条 SQL 失败的概率极低；setSetting 已实现正确的 null 删除语义
    await Promise.all(
        Object.entries(settings).map(([key, value]) =>
            setSetting(db, key, value === '' ? null : value)
        )
    );
    return jsonResponse({ success: true, message: '设置已成功保存。' });
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

async function handleDomainMutation(request: Request, db: D1Database, isUpdate = false, id: string | null = null): Promise<Response> {
  const { source_domain, target_domain_prefix, is_deep_resolve, ttl, notes } = await request.json() as {
      source_domain?: string; target_domain_prefix?: string; is_deep_resolve?: number; ttl?: number; notes?: string;
  };
  if (!source_domain || !target_domain_prefix) {
      return jsonResponse({ error: '缺少必填字段。' }, 400);
  }
  try {
      const { zoneId, token } = await getCfApiSettings(db);
      if (!token || !zoneId) return jsonResponse({ error: 'Cloudflare API 未配置。' }, 400);
      const zoneName = (await getZoneName(token, zoneId)).replace(/\.$/, '');
      const target_domain = target_domain_prefix === '@' ? zoneName : `${target_domain_prefix}.${zoneName}`;

      if (isUpdate && id) {
          // 系统域名保护：禁止修改 source_domain
          const existing = await db.prepare("SELECT source_domain, is_system FROM domains WHERE id = ?").bind(id).first() as { source_domain: string; is_system: number } | null;
          if (!existing) return jsonResponse({ error: '目标不存在。' }, 404);
          if (existing.is_system === 1 && existing.source_domain !== source_domain) {
              return jsonResponse({ error: '系统预设域名的源域名不可修改。' }, 403);
          }
          await db.prepare("UPDATE domains SET source_domain=?, target_domain=?, zone_id=?, is_deep_resolve=?, ttl=?, notes=? WHERE id=?")
              .bind(source_domain, target_domain, zoneId, is_deep_resolve ?? 1, ttl ?? 60, notes || null, id).run();
          return jsonResponse({ success: true, message: '目标更新成功。' });
      }
      await db.prepare("INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(source_domain, target_domain, zoneId, is_deep_resolve ?? 1, ttl ?? 60, notes || null).run();
      return jsonResponse({ success: true, message: '目标添加成功。' });
  } catch (e) {
      if (isUniqueViolation(e)) return jsonResponse({ error: '目标域名已存在。' }, 409);
      throw e;
  }
}

async function apiAddDomain(request: Request, db: D1Database): Promise<Response> { return handleDomainMutation(request, db, false); }
async function apiUpdateDomain(request: Request, db: D1Database, id: string): Promise<Response> { return handleDomainMutation(request, db, true, id); }

async function apiDeleteDomain(request: Request, db: D1Database, id: string): Promise<Response> {
    const { meta } = await db.prepare('DELETE FROM domains WHERE id = ? AND is_system = 0').bind(id).run();
    if (meta.changes === 0) {
        return jsonResponse({ error: "删除失败，目标为系统预设或不存在。" }, 403);
    }
    return jsonResponse({ success: true, message: "目标删除成功。" });
}

async function apiGetDomainRecords(id: string, db: D1Database): Promise<Response> {
    try {
        const { token, zoneId } = await getCfApiSettings(db);
        if (!token || !zoneId) return jsonResponse({ error: 'Cloudflare API 未配置。' }, 400);
        const domain = await db.prepare("SELECT target_domain FROM domains WHERE id = ?").bind(id).first() as { target_domain: string } | null;
        if (!domain) return jsonResponse({ error: '目标不存在。' }, 404);
        const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${domain.target_domain}&per_page=100`;
        const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await response.json() as { success: boolean; result?: unknown; errors?: unknown[] };
        if (!data.success) return jsonResponse({ error: `Cloudflare API 错误: ${JSON.stringify(data.errors)}` }, 500);
        return jsonResponse(data.result);
    } catch (e) {
        return jsonResponse({ error: `获取记录失败: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
}

async function apiGetIpSources(db: D1Database): Promise<Response> {
    const { results } = await db.prepare("SELECT id, url, github_path, commit_message, fetch_strategy, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled FROM ip_sources ORDER BY github_path").all();
    return jsonResponse(results);
}

async function apiAddIpSource(request: Request, db: D1Database): Promise<Response> {
    const { url, github_path, commit_message, fetch_strategy } = await request.json() as {
        url?: string; github_path?: string; commit_message?: string; fetch_strategy?: string;
    };
    if (!url || !github_path || !commit_message || !fetch_strategy) {
        return jsonResponse({ error: '缺少必填字段或尚未成功探测获取策略。' }, 400);
    }
    try {
        assertSafeHttpUrl(url);
    } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : 'URL 校验失败' }, 400);
    }
    try {
        await db.prepare("INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)")
            .bind(url, github_path, commit_message, fetch_strategy).run();
        return jsonResponse({ success: true, message: 'IP源添加成功。' });
    } catch (e) {
        if (isUniqueViolation(e)) return jsonResponse({ error: '该URL或GitHub文件路径已存在。' }, 409);
        throw e;
    }
}

async function apiUpdateIpSource(request: Request, db: D1Database, id: number): Promise<Response> {
    const { url, github_path, commit_message, fetch_strategy } = await request.json() as {
        url?: string; github_path?: string; commit_message?: string; fetch_strategy?: string;
    };
    if (!url || !github_path || !commit_message || !fetch_strategy) {
        return jsonResponse({ error: '缺少必填字段或尚未成功探测获取策略。' }, 400);
    }
    try {
        assertSafeHttpUrl(url);
    } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : 'URL 校验失败' }, 400);
    }
    try {
        await db.prepare("UPDATE ip_sources SET url=?, github_path=?, commit_message=?, fetch_strategy=? WHERE id=?")
            .bind(url, github_path, commit_message, fetch_strategy, id).run();
        return jsonResponse({ success: true, message: 'IP源更新成功。' });
    } catch (e) {
        if (isUniqueViolation(e)) return jsonResponse({ error: '该URL或GitHub文件路径已存在。' }, 409);
        throw e;
    }
}

async function apiDeleteIpSource(db: D1Database, id: number): Promise<Response> {
    await db.prepare('DELETE FROM ip_sources WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true, message: "IP源删除成功。" });
}

async function apiProbeIpSource(request: Request): Promise<Response> {
    const { url } = await request.json() as { url?: string };
    if (!url) return jsonResponse({ error: '缺少用于探测的 URL 参数。' }, 400);
    try {
        assertSafeHttpUrl(url);
    } catch (e) {
        return jsonResponse({ error: e instanceof Error ? e.message : 'URL 校验失败' }, 400);
    }

    for (const [strategyName, strategyFn] of Object.entries(FETCH_STRATEGIES)) {
        try {
            const ips = await strategyFn(url);
            if (ips && ips.length > 0) {
                return jsonResponse({
                    success: true,
                    strategy: strategyName,
                    ipCount: ips.length,
                    sampleIps: ips.slice(0, 5)
                });
            }
        } catch (e) {
            console.log(`Strategy '${strategyName}' failed for URL '${url}': ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return jsonResponse({ error: '所有探测方案均失败，无法从此URL提取IP。' }, 400);
}
