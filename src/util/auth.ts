// auth.ts — 认证与密码哈希工具
// 从 index.legacy.js 提取（原 1844-1846 行）

import { getCookie } from './http.ts';

/** 恒定时间十六进制字符串比对（先比较长度，再对每字符做 XOR 累积差异） */
function timingSafeHexEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

/**
 * 哈希密码（PBKDF2，100k 迭代）
 * 隐含修正 B3：原单轮 SHA-256 升级为 PBKDF2，防彩虹表/字典攻击
 *
 * 哈希格式：前缀标记实现多版本并存
 *   `pbkdf2$100000$<salt>$<hex>` —— 新格式（PBKDF2-HMAC-SHA256）
 *   `raw$64hex`                —— legacy 单轮 SHA-256 兼容（已部署实例）
 */
export async function hashPassword(password: string, salt: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        256
    );
    const hex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `pbkdf2$100000$${salt}$${hex}`;
}

/**
 * legacy 哈希：单轮 SHA-256（与原 index.legacy.js 同算法）
 * 仅供密码登录时回退验证；登录成功后立即升级为 PBKDF2
 * 不导出：测试可通过 `raw$` 前缀 + crypto.subtle.digest 自构造
 */
async function legacyHashPassword(password: string, salt: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password + salt);
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `raw$${hex}`;
}

/**
 * 校验密码（兼容旧哈希）；返回 matched + 旧格式升级所需的新 hash（仅当匹配且为 legacy 时返回）
 *
 * 语义契约：`upgradedHash` 仅在 `matched=true` 且 storedHash 为 legacy（`raw$` 或纯 hex）格式时返回，
 * 用于调用方调用 setSetting 替换旧哈希；错误路径不显式置空但调用方仅在 matched=true 时读取该字段。
 */
export async function verifyPassword(password: string, storedHash: string, legacySalt: string): Promise<{ matched: boolean; upgradedHash?: string }> {
    if (storedHash.startsWith('pbkdf2$')) {
        const parts = storedHash.split('$');
        if (parts.length !== 4) return { matched: false };
        const [, iterStr, salt, hex] = parts;
        const iterations = Number(iterStr);
        if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 10_000_000) {
            return { matched: false };
        }
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations, hash: 'SHA-256' }, keyMaterial, 256);
        const candidate = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
        return { matched: timingSafeHexEqual(candidate, hex) };
    }
    if (storedHash.startsWith('raw$')) {
        const candidate = await legacyHashPassword(password, legacySalt);
        if (timingSafeHexEqual(candidate, storedHash)) {
            const newSalt = crypto.randomUUID();
            const upgraded = await hashPassword(password, newSalt);
            return { matched: true, upgradedHash: upgraded };
        }
        return { matched: false };
    }
    // 极早期版本可能只有纯 hex（无前缀），按 raw 处理
    const encoder = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', encoder.encode(password + legacySalt));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (timingSafeHexEqual(hex, storedHash)) {
        const newSalt = crypto.randomUUID();
        const upgraded = await hashPassword(password, newSalt);
        return { matched: true, upgradedHash: upgraded };
    }
    return { matched: false };
}

/**
 * 验证会话：读取 session Cookie 并检查是否有效
 */
export async function isAuthenticated(request: Request, db: D1Database): Promise<boolean> {
    const token = getCookie(request, 'session');
    if (!token) return false;
    const session = await db.prepare("SELECT expires_at FROM sessions WHERE token = ?").bind(token).first() as { expires_at: string } | null;
    if (!session || new Date(session.expires_at) < new Date()) {
        if (session) await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
        return false;
    }
    return true;
}

/** 从请求 Cookie 头解析指定 name 的值；re-export 自 util/http，保持单一来源 */
export { getCookie } from './http.ts';
