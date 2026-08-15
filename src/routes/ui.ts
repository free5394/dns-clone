// ui.ts — UI 路由层（handleUiRequest）
// 从 index.legacy.js 提取（原 handleUiRequest）
// 注：UI 模板函数（getHtmlLayout / getSetupPage / getPublicHomepage / getDashboardPage / getDashboardScript）仍在 legacy，阶段 E 拆分

import { getSetting, getSafeSettings, getCfApiSettings } from '../db/client.ts';
import { ensureInitialData } from '../db/migrations.ts';
import { isAuthenticated } from '../util/auth.ts';
import { getZoneName } from '../util/cf.ts';
// UI 模板函数从 templates.js 导入
import { getHtmlLayout, getSetupPage, getPublicHomepage, getDashboardPage } from '../ui/templates.js';

/** UI 路由分发：/admin 仪表盘 / 首页 / 初始化引导 */
export async function handleUiRequest(request: Request, env: { WUYA: D1Database }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.WUYA;

  const isInitialized = !!(await getSetting(db, 'ADMIN_PASSWORD_HASH'));
  const loggedIn = await isAuthenticated(request, db);
  let pageContent: string, pageTitle: string;

  if (!isInitialized) {
      pageTitle = '系统初始化';
      pageContent = getSetupPage();
  } else if (path === '/admin' && loggedIn) {
      pageTitle = 'DNS Clone Dashboard';
      const settings = await getSafeSettings(db);

      const { token, zoneId } = await getCfApiSettings(db);
      if (token && zoneId) {
          try {
              settings.zoneName = await getZoneName(token, zoneId);
              await ensureInitialData(db, zoneId, settings.zoneName);
          } catch (e) {
              console.warn("Could not fetch zone name or ensure initial data.", e instanceof Error ? e.message : e);
          }
      }

      const domainsPromise = db.prepare("SELECT id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled, is_system FROM domains ORDER BY is_system DESC, target_domain").all();
      const ipSourcesPromise = db.prepare("SELECT id, url, github_path, commit_message, fetch_strategy, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled FROM ip_sources ORDER BY github_path").all();

      const [{ results: domains }, { results: ipSources }] = await Promise.all([domainsPromise, ipSourcesPromise]);

      pageContent = getDashboardPage(domains, ipSources, settings);
  } else if (path === '/admin' && !loggedIn) {
      return new Response(null, { status: 302, headers: { 'Location': '/' } });
  } else {
      pageTitle = 'CF-DNS-Clon';
      const domainsPromise = db.prepare("SELECT source_domain, target_domain, notes, last_synced_time, is_system FROM domains WHERE is_enabled = 1 AND last_sync_status IN ('success', 'no_change') ORDER BY is_system DESC, notes").all();
      const ipSourcesPromise = db.prepare("SELECT url, github_path, last_synced_time FROM ip_sources WHERE is_enabled = 1 AND last_sync_status IN ('success', 'no_change') ORDER BY github_path").all();
      const threeNetworkSourcePromise = getSetting(db, 'THREE_NETWORK_SOURCE');

      const [{ results: domains }, { results: ipSources }, threeNetworkSource] = await Promise.all([domainsPromise, ipSourcesPromise, threeNetworkSourcePromise]);

      const sourceNameMap: Record<string, string> = { CloudFlareYes: 'CloudFlareYes', 'api.uouin.com': 'UoUin', 'wetest.vip': 'Wetest' };
      const sourceDisplayName = sourceNameMap[threeNetworkSource || ''] || '未知';

      pageContent = getPublicHomepage(request.url, domains, ipSources, sourceDisplayName, loggedIn);
  }
  return new Response(getHtmlLayout(pageTitle, pageContent), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
