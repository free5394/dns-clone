// index.ts — Worker 入口（阶段 E 最终形态：所有逻辑来自拆分模块）
import { initializeAndMigrateDatabase } from './db/migrations.ts';
import { getSetting, setSetting } from './db/client.ts';
import { jsonResponse } from './util/http.ts';
import { syncScheduledIpSources } from './sync/ip-sources.ts';
import { syncScheduledDomains } from './sync/domains.ts';
import { handleApiRequest } from './routes/api.ts';
import { handleGitHubFileProxy } from './routes/github-proxy.ts';
import { handleUiRequest } from './routes/ui.ts';

export default {
  async fetch(request: Request, env: { WUYA: D1Database }, ctx: ExecutionContext): Promise<Response> {
      try {
        await initializeAndMigrateDatabase(env);
      } catch (e) {
        console.error("数据库初始化失败：", e instanceof Error ? e.stack : e);
        return new Response("严重错误：数据库初始化失败，请检查Worker的D1数据库绑定是否正确配置为'WUYA'。", { status: 500 });
      }

      const url = new URL(request.url);
      const path = url.pathname;
      try {
          if (path.startsWith('/api/')) {
              return await handleApiRequest(request, env);
          }
          if (path.length > 1 && !path.startsWith('/api/') && !['/login', '/admin'].includes(path)) {
              const fileName = path.substring(1);
              return await handleGitHubFileProxy(fileName, env, ctx);
          }
          return await handleUiRequest(request, env);
      } catch (e) {
          console.error("全局兜底：", e instanceof Error ? e.stack : e);
          const status = (e as { status?: number }).status || 500;
          if (path.startsWith('/api/')) {
              // API 路径：返回结构化错误（details 仅含 message，不含 stack）
              const errorResponse = { error: "发生意外的服务器错误。", details: e instanceof Error ? e.message : String(e) };
              return jsonResponse(errorResponse, status);
          }
          // 非 API 路径：固定文案，杜绝 stack / 凭据泄露
          return new Response("服务器内部错误，请稍后重试。", { status: 500 });
      }
  },
  async scheduled(controller: ScheduledController, env: { WUYA: D1Database }, ctx: ExecutionContext): Promise<void> {
      console.log("定时任务开始：正在初始化...");
      try {
          await initializeAndMigrateDatabase(env);
      } catch (e) {
          console.error("定时任务中数据库初始化失败：", e instanceof Error ? e.stack : e);
          return;
      }

      const db = env.WUYA;
      const nextTask = await getSetting(db, 'next_sync_task') || 'domains';

      // 先轮转状态：无论 sync 成功或失败，下一分钟都跑另一个任务，避免单点失败永久卡死
      const otherTask = nextTask === 'domains' ? 'ip_sources' : 'domains';
      try {
          await setSetting(db, 'next_sync_task', otherTask);
      } catch (e) {
          console.error("轮转 next_sync_task 失败：", e instanceof Error ? e.stack : e);
      }

      try {
          if (nextTask === 'domains') {
              console.log("定时任务：正在同步一批 DNS 记录（失败优先）...");
              await syncScheduledDomains(env);
          } else {
              console.log("定时任务：正在把一批 IP 源同步到 GitHub（失败优先）...");
              await syncScheduledIpSources(env);
          }
      } catch (e) {
          console.error(`定时任务 '${nextTask}' 失败：`, e instanceof Error ? e.stack : e);
      }

      console.log("本轮定时任务执行完毕。");
  },
};
