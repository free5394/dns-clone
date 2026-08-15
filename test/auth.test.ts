// auth.test.ts — 用例 7/8：hashPassword + isAuthenticated + verifyPassword（legacy 兼容）
// 中文注释；断言文案用英文（文案三档规则）
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { hashPassword, isAuthenticated, verifyPassword } from "../src/util/auth.ts";

/** 自构造 legacy `raw$<hex>` 哈希（auth.ts 不再导出 legacyHashPassword） */
async function makeLegacyHash(password: string, salt: string): Promise<string> {
    const data = new TextEncoder().encode(password + salt);
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `raw$${hex}`;
}

describe("hashPassword (PBKDF2)", () => {
    it("returns a prefixed string containing salt and hex", async () => {
        const hash = await hashPassword("test-password-123", "test-salt");
        expect(hash).toMatch(/^pbkdf2\$100000\$test-salt\$[0-9a-f]{64}$/);
    });

    it("produces different hashes for different salts", async () => {
        const h1 = await hashPassword("same-password", "salt-1");
        const h2 = await hashPassword("same-password", "salt-2");
        expect(h1).not.toBe(h2);
    });

    it("fails to match a tampered hash", async () => {
        const hash = await hashPassword("test-password-123", "test-salt");
        const tampered = hash.slice(0, -2) + (hash.endsWith("00") ? "ff" : "00");
        expect(tampered).not.toBe(hash);
    });
});

describe("verifyPassword (multi-format)", () => {
    it("accepts PBKDF2 format and returns no upgrade hash", async () => {
        const hash = await hashPassword("test-password-123", "test-salt");
        const result = await verifyPassword("test-password-123", hash, "test-salt");
        expect(result.matched).toBe(true);
        expect(result.upgradedHash).toBeUndefined();
    });

    it("accepts legacy raw$ SHA-256 format and returns upgraded hash", async () => {
        const legacySalt = "old-salt";
        const legacyHash = await makeLegacyHash("test-password-123", legacySalt);
        const result = await verifyPassword("test-password-123", legacyHash, legacySalt);
        expect(result.matched).toBe(true);
        expect(result.upgradedHash).toMatch(/^pbkdf2\$100000\$/);
    });

    it("rejects wrong password for PBKDF2", async () => {
        const hash = await hashPassword("correct", "test-salt");
        const result = await verifyPassword("wrong", hash, "test-salt");
        expect(result.matched).toBe(false);
    });

    it("rejects wrong password for legacy", async () => {
        const legacyHash = await makeLegacyHash("correct", "old-salt");
        const result = await verifyPassword("wrong", legacyHash, "old-salt");
        expect(result.matched).toBe(false);
    });
});

describe("isAuthenticated", () => {
    it("returns true for a valid session cookie", async () => {
        const token = crypto.randomUUID();
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await env.WUYA.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expires).run();
        const request = new Request("https://example.com/admin", {
            headers: { Cookie: `session=${token}` },
        });
        expect(await isAuthenticated(request, env.WUYA)).toBe(true);
    });

    it("returns false for an expired session cookie", async () => {
        const token = crypto.randomUUID();
        const expires = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await env.WUYA.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expires).run();
        const request = new Request("https://example.com/admin", {
            headers: { Cookie: `session=${token}` },
        });
        expect(await isAuthenticated(request, env.WUYA)).toBe(false);
    });

    it("returns false without a cookie", async () => {
        const request = new Request("https://example.com/admin");
        expect(await isAuthenticated(request, env.WUYA)).toBe(false);
    });
});
