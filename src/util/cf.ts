// cf.ts — Cloudflare API 工具
// 从 index.legacy.js 提取（原 1835-1842 行）

import { fetchWithTimeout } from './fetch.ts';

/** 获取 Zone 名称 */
export async function getZoneName(token: string, zoneId: string): Promise<string> {
    if (!token || !zoneId) throw new Error("API 令牌和区域 ID 不能为空。");
    const response = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/zones/${zoneId}`, { headers: { 'Authorization': `Bearer ${token}` } }, 10000);
    if (!response.ok) { const errText = await response.text(); throw new Error(`无法从 Cloudflare 获取区域信息: ${errText}`); }
    const data = (await response.json()) as { success: boolean; result: { name: string }; errors?: unknown[] };
    if (!data.success) throw new Error(`Cloudflare API 返回错误: ${JSON.stringify(data.errors)}`);
    return data.result.name;
}
