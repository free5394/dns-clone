// settings.ts — settings 键名与安全分组的单一来源（M-4）
// 这里只放「词汇与分组」：键名字符串、白名单、密钥分组、敏感字段。
// 读写语义（null 清除、空串不得误清 Secret、配对校验）留在调用点，
// 因为它们依赖具体路由的响应形状，搬进来反而更难读。

import { MAX_BATCH_SIZE } from "../util/batch-size.ts";

/** Cloudflare 侧配置键：令牌与区域 ID 必须成对存在 */
export const CF_CONFIG_KEYS = ["CF_API_TOKEN", "CF_ZONE_ID"] as const;

/** GitHub 侧配置键：令牌、Owner、Repo 三者必须同时配置 */
export const GITHUB_CONFIG_KEYS = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"] as const;

/**
 * hostmonit 三网优选 IP 接口的抓取 key（issue #25）。
 * 该 key 是 hostmonit 前端 bundle 里的公开值，写死会在对方轮换后失效，故允许设置页覆盖。
 */
export const HOSTMONIT_API_KEY = "HOSTMONIT_API_KEY";

/** 用户可在设置页写入的全部配置键（配对校验与合并有效配置时使用） */
export const CONFIG_SETTING_KEYS = [...CF_CONFIG_KEYS, ...GITHUB_CONFIG_KEYS] as const;

/** 写入白名单：只有这些键允许通过 /api/settings 落库 */
export const WRITABLE_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
    ...CONFIG_SETTING_KEYS,
    HOSTMONIT_API_KEY,
    "THREE_NETWORK_SOURCE",
    "BATCH_SIZE",
]);

/** 密钥类键：空字符串表示「保持不变」，不能被当成清除指令 */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
    "CF_API_TOKEN",
    "GITHUB_TOKEN",
    HOSTMONIT_API_KEY,
]);

/** 敏感字段：序列化到前端前过滤（Token、密码哈希、Salt） */
export const SENSITIVE_SETTINGS_KEYS: ReadonlySet<string> = new Set<string>([
    ...SECRET_SETTING_KEYS,
    "ADMIN_PASSWORD_HASH",
    "PASSWORD_SALT",
]);

/** 清洗结果：白名单过滤 + 空值语义 + BATCH_SIZE 范围，任一失败即整批拒绝 */
export type SettingsInputResult = { ok: true; settings: Record<string, string | null> } | { ok: false; error: string };

/**
 * 把请求体清洗成可落库的 settings：
 * - 白名单外的键直接丢弃（不报错，保持旧行为）
 * - null / undefined 表示显式清除
 * - 空字符串：Secret 类键表示「保持不变」，其它键表示清除
 * - BATCH_SIZE 必须是 1..MAX 的整数，负数在 SQLite LIMIT 中等于无上限
 */
export function normalizeSettingsInput(raw: Record<string, unknown>): SettingsInputResult {
    const settings: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!WRITABLE_SETTING_KEYS.has(key)) continue;
        if (value === null || value === undefined) {
            settings[key] = null;
        } else {
            const text = (typeof value === "string" ? value : String(value)).trim();
            if (text === "") {
                if (SECRET_SETTING_KEYS.has(key)) continue;
                settings[key] = null;
            } else {
                settings[key] = text;
            }
        }
        if (key === "BATCH_SIZE") {
            const n = Number(settings[key]);
            if (settings[key] === null || !Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
                return { ok: false, error: `BATCH_SIZE 必须为 1 到 ${MAX_BATCH_SIZE} 之间的整数。` };
            }
        }
    }
    return { ok: true, settings };
}

/**
 * 合并「现有配置 + 本次提交」后的配对校验，返回错误文案；null 表示通过。
 * 基于有效值而非本次提交值，允许只改非 Token 字段时沿用旧 Token。
 */
export function validateEffectiveSettings(effective: Record<string, string | null>): string | null {
    const { CF_API_TOKEN, CF_ZONE_ID, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = effective;
    if (Boolean(CF_API_TOKEN) !== Boolean(CF_ZONE_ID)) return "Cloudflare API 令牌和区域 ID 必须同时配置。";
    const githubValues = [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO];
    if (githubValues.some(Boolean) && githubValues.some((value) => !value)) {
        return "GitHub Token、Owner、Repo 必须同时配置。";
    }
    return null;
}
