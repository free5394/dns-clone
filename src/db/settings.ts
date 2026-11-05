// settings.ts — settings 键名与安全分组的单一来源（M-4）
// 这里只放「词汇与分组」：键名字符串、白名单、密钥分组、敏感字段。
// 读写语义（null 清除、空串不得误清 Secret、配对校验）留在调用点，
// 因为它们依赖具体路由的响应形状，搬进来反而更难读。

/** Cloudflare 侧配置键：令牌与区域 ID 必须成对存在 */
export const CF_CONFIG_KEYS = ["CF_API_TOKEN", "CF_ZONE_ID"] as const;

/** GitHub 侧配置键：令牌、Owner、Repo 三者必须同时配置 */
export const GITHUB_CONFIG_KEYS = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"] as const;

/** 用户可在设置页写入的全部配置键（配对校验与合并有效配置时使用） */
export const CONFIG_SETTING_KEYS = [...CF_CONFIG_KEYS, ...GITHUB_CONFIG_KEYS] as const;

/** 写入白名单：只有这些键允许通过 /api/settings 落库 */
export const WRITABLE_SETTING_KEYS: ReadonlySet<string> = new Set<string>([
    ...CONFIG_SETTING_KEYS,
    "THREE_NETWORK_SOURCE",
    "BATCH_SIZE",
]);

/** 密钥类键：空字符串表示「保持不变」，不能被当成清除指令 */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set<string>(["CF_API_TOKEN", "GITHUB_TOKEN"]);

/** 敏感字段：序列化到前端前过滤（Token、密码哈希、Salt） */
export const SENSITIVE_SETTINGS_KEYS: ReadonlySet<string> = new Set<string>([
    ...SECRET_SETTING_KEYS,
    "ADMIN_PASSWORD_HASH",
    "PASSWORD_SALT",
]);
