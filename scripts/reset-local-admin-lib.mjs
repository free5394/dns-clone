// reset-local-admin-lib.mjs — 本地管理员密码重置的纯逻辑（无 fs / sqlite 依赖）
//
// 为什么单独成文件：vitest（workerd 运行时）里没有 node:* 模块，但哈希格式必须与
// src/util/auth.ts 保持一致才算「重置出来的密码真能登录」。把判据放进这个纯模块后，
// 测试可以直接 import 它并与 Worker 侧的 verifyPassword 对拍。
// 真相源仍是 src/util/auth.ts:25-37 —— 这里任何参数变动都要同步过去。

/** PBKDF2 迭代次数（与 src/util/auth.ts 的 hashPassword 一致） */
export const PBKDF2_ITERATIONS = 100000;

/** 密码长度下限（与 /api/setup、/api/recover 一致） */
export const MIN_PASSWORD_LENGTH = 8;

/** 密码长度上限（与 /api/setup、/api/recover 一致） */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * 长度判据：命令行与端点共用同一套边界，避免脚本造出 API 不收的密码
 * @param {unknown} password
 * @returns {boolean}
 */
export function isValidPassword(password) {
    return (
        typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH
    );
}

/** 生成随机盐（UUID，与 Worker 侧 crypto.randomUUID() 同源） */
export function generateSalt() {
    return crypto.randomUUID();
}

/** PBKDF2-HMAC-SHA256/100k/256bit → `pbkdf2$100000$<salt>$<hex>` */
export async function hashPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" },
        keyMaterial,
        256
    );
    const hex = Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `pbkdf2$${iterations}$${salt}$${hex}`;
}

/**
 * 从候选 sqlite 文件中挑出本地 D1 主库，判据是「含 settings 表」。
 * 入参是 [{ path, tables }]，tables 为该文件的普通表名。
 * 少于或多于一个候选都直接报错——猜错库会把别的 miniflare 对象当 D1 写，比报错糟得多。
 */
/**
 * @param {{ path: string, tables: string[] }[] | undefined} candidates
 * @returns {string}
 */
export function pickLocalDatabase(candidates) {
    const matches = (candidates ?? []).filter((item) => Array.isArray(item.tables) && item.tables.includes("settings"));
    if (matches.length === 1) return matches[0].path;
    if (matches.length === 0) {
        throw new Error("未找到本地 D1 主库（没有任何候选文件包含 settings 表），请先在仓库根目录运行一次 pnpm dev。");
    }
    const paths = matches.map((item) => item.path).join("、");
    throw new Error(`找到 ${matches.length} 个疑似本地 D1 主库，无法确定该改哪个：${paths}`);
}

/**
 * 生成重置语句。
 * - hash 为 null：删除密码两行，浏览器回到「系统初始化」页重设（README Q8 的原语义）
 * - hash 非空：直接写入新哈希与盐，刷新页面即可用新密码登录
 * clearSessions 默认 true：重置后旧 Cookie 必须失效，否则「重置了却还登着」。
 * clearAttempts 默认 true：清掉限流失败记录，避免刚重置就被自己的重试挡在门外。
 */
/**
 * @param {{ hash?: string | null, salt?: string | null, clearSessions?: boolean, clearAttempts?: boolean }} [options]
 */
export function buildResetStatements({ hash = null, salt = null, clearSessions = true, clearAttempts = true } = {}) {
    if (hash && !salt) throw new Error("写入模式必须同时提供 salt。");

    const statements = [];
    if (!hash) {
        statements.push(
            "DELETE FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'",
            "DELETE FROM settings WHERE key = 'PASSWORD_SALT'"
        );
    } else {
        // 值为 hash/salt 生成物（十六进制与 UUID），不含引号；这里用字面量是为了让脚本
        // 无需 sqlite 参数绑定即可执行同一串语句（wrangler d1 execute 也吃这一串）。
        statements.push(
            `INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', '${hash}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            `INSERT INTO settings (key, value) VALUES ('PASSWORD_SALT', '${salt}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        );
    }
    if (clearSessions) statements.push("DELETE FROM sessions");
    if (clearAttempts) statements.push("DELETE FROM login_attempts");
    return statements;
}
