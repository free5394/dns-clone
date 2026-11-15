// reset-local-admin-lib.test.ts — 本地重置脚本的纯逻辑
// 重点不是「脚本能跑」，而是「脚本造的哈希，Worker 侧的 verifyPassword 认」。
import { describe, expect, it } from "vitest";
import {
    buildResetStatements,
    generateSalt,
    hashPassword,
    isValidPassword,
    pickLocalDatabase,
} from "../scripts/reset-local-admin-lib.mjs";
import { verifyPassword } from "../src/util/auth.ts";

describe("reset-local-admin-lib 哈希与 Worker 侧互通", () => {
    it("产出的哈希能被 verifyPassword 接受，错误密码被拒绝", async () => {
        const salt = generateSalt();
        const hash = await hashPassword("devpass2026", salt);
        expect(hash.startsWith(`pbkdf2$100000$${salt}$`)).toBe(true);
        expect(hash.length).toBeGreaterThan(64);

        expect((await verifyPassword("devpass2026", hash, salt)).matched).toBe(true);
        expect((await verifyPassword("devpass2027", hash, salt)).matched).toBe(false);
    });

    it("同一密码在不同盐下产出不同哈希（盐确实参与运算）", async () => {
        const [a, b] = await Promise.all([
            hashPassword("devpass2026", generateSalt()),
            hashPassword("devpass2026", generateSalt()),
        ]);
        expect(a).not.toBe(b);
    });
});

describe("reset-local-admin-lib 密码长度判据", () => {
    it("8 与 1024 通过，7 与 1025 拒绝，非字符串拒绝", () => {
        expect(isValidPassword("a".repeat(8))).toBe(true);
        expect(isValidPassword("a".repeat(1024))).toBe(true);
        expect(isValidPassword("a".repeat(7))).toBe(false);
        expect(isValidPassword("a".repeat(1025))).toBe(false);
        expect(isValidPassword(undefined)).toBe(false);
    });
});

describe("reset-local-admin-lib 选择本地库", () => {
    it("只挑含 settings 表的候选", () => {
        const picked = pickLocalDatabase([
            { path: "/tmp/metadata.sqlite", tables: ["_cf_METADATA"] },
            { path: "/tmp/app.sqlite", tables: ["settings", "domains"] },
        ]);
        expect(picked).toBe("/tmp/app.sqlite");
    });

    it("没有候选时报错并提示先跑 pnpm dev", () => {
        expect(() => pickLocalDatabase([])).toThrow(/pnpm dev/);
        expect(() => pickLocalDatabase(undefined)).toThrow(/pnpm dev/);
    });

    it("多个候选时报错而不是猜", () => {
        expect(() =>
            pickLocalDatabase([
                { path: "/tmp/a.sqlite", tables: ["settings"] },
                { path: "/tmp/b.sqlite", tables: ["settings"] },
            ])
        ).toThrow(/无法确定/);
    });
});

describe("reset-local-admin-lib 重置语句", () => {
    it("默认删除密码两行并清空会话与失败记录", () => {
        const statements = buildResetStatements();
        expect(statements).toContain("DELETE FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'");
        expect(statements).toContain("DELETE FROM settings WHERE key = 'PASSWORD_SALT'");
        expect(statements).toContain("DELETE FROM sessions");
        expect(statements).toContain("DELETE FROM login_attempts");
        expect(statements.some((sql) => sql.startsWith("INSERT INTO settings"))).toBe(false);
    });

    it("写入模式对哈希与盐做 upsert", () => {
        const statements = buildResetStatements({ hash: "pbkdf2$100000$salt$deadbeef", salt: "salt" });
        expect(
            statements.filter((sql) => sql.includes("ON CONFLICT(key) DO UPDATE SET value = excluded.value"))
        ).toHaveLength(2);
        expect(statements).toContain("DELETE FROM sessions");
    });

    it("写入模式缺 salt 直接报错，避免半坏状态", () => {
        expect(() => buildResetStatements({ hash: "pbkdf2$100000$salt$deadbeef" })).toThrow(/salt/);
    });

    it("可以保留会话与失败记录（测试与排障用）", () => {
        const statements = buildResetStatements({ clearSessions: false, clearAttempts: false });
        expect(statements).not.toContain("DELETE FROM sessions");
        expect(statements).not.toContain("DELETE FROM login_attempts");
    });
});
