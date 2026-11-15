// reset-local-admin-lib.test.ts — 本地重置脚本的纯逻辑与「语句真能在 D1 上跑通」
// 重点不是「脚本能跑」，而是「脚本造的哈希 Worker 认、语句能真改库」。
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    buildResetStatements,
    generateSalt,
    hashPassword,
    isValidPassword,
    pickLocalDatabase,
} from "../scripts/reset-local-admin-lib.mjs";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from "../src/util/auth.ts";

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

describe("reset-local-admin-lib 与 Worker 侧的边界常量一致", () => {
    it("长度上下限与 src/util/auth.ts 相同（脚本不会造出 API 不收的密码）", () => {
        expect(MIN_PASSWORD_LENGTH).toBe(PASSWORD_MIN_LENGTH);
        expect(MAX_PASSWORD_LENGTH).toBe(PASSWORD_MAX_LENGTH);
    });

    it("8 与 1024 通过，7 与 1025 拒绝，非字符串拒绝", () => {
        expect(isValidPassword("a".repeat(8))).toBe(true);
        expect(isValidPassword("a".repeat(1024))).toBe(true);
        expect(isValidPassword("a".repeat(7))).toBe(false);
        expect(isValidPassword("a".repeat(1025))).toBe(false);
        expect(isValidPassword(undefined)).toBe(false);
        expect(isValidPassword(12345678)).toBe(false);
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

    it("哈希或盐含非法字符时拒绝拼接进 SQL", () => {
        expect(() => buildResetStatements({ hash: "pbkdf2$1$x$' OR 1=1 --", salt: "s" })).toThrow(/非法字符/);
        expect(() => buildResetStatements({ hash: "pbkdf2$1$x$deadbeef", salt: "s'; --" })).toThrow(/非法字符/);
    });

    it("可以保留会话与失败记录（测试与排障用）", () => {
        const statements = buildResetStatements({ clearSessions: false, clearAttempts: false });
        expect(statements).not.toContain("DELETE FROM sessions");
        expect(statements).not.toContain("DELETE FROM login_attempts");
    });
});

describe("reset-local-admin-lib 生成的重置语句能在 D1 上真执行", () => {
    const upsert = (key: string, value: string) =>
        env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(key, value);

    async function run(statements: string[]): Promise<void> {
        await env.WUYA.batch(statements.map((sql) => env.WUYA.prepare(sql)));
    }

    async function readSetting(key: string): Promise<string | null> {
        const row = (await env.WUYA.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first()) as {
            value: string;
        } | null;
        return row?.value ?? null;
    }

    async function countRows(sql: string): Promise<number> {
        const row = (await env.WUYA.prepare(sql).first()) as { n: number };
        return row.n;
    }

    beforeEach(async () => {
        await env.WUYA.batch([
            upsert("ADMIN_PASSWORD_HASH", "pbkdf2$100000$old$deadbeef"),
            upsert("PASSWORD_SALT", "old-salt"),
            upsert("CF_ZONE_NAME", "zhishi.indevs.in"),
            env.WUYA.prepare("INSERT INTO sessions (token, expires_at) VALUES ('alive', '2099-01-01T00:00:00.000Z')"),
            env.WUYA.prepare("INSERT INTO login_attempts (ip, success) VALUES ('203.0.113.9', 0)"),
        ]);
    });

    it("写入模式真正 upsert 两行、清空会话与失败记录，其余设置不动", async () => {
        const salt = generateSalt();
        const hash = await hashPassword("devpass2026", salt);
        await run(buildResetStatements({ hash, salt }));

        expect(await readSetting("ADMIN_PASSWORD_HASH")).toBe(hash);
        expect(await readSetting("PASSWORD_SALT")).toBe(salt);
        expect(await countRows("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
        expect(await countRows("SELECT COUNT(*) AS n FROM login_attempts")).toBe(0);
        expect(await readSetting("CF_ZONE_NAME")).toBe("zhishi.indevs.in");

        // 写进去的哈希与盐成对可用
        const stored = await readSetting("ADMIN_PASSWORD_HASH");
        const storedSalt = await readSetting("PASSWORD_SALT");
        expect((await verifyPassword("devpass2026", stored as string, storedSalt as string)).matched).toBe(true);
    });

    it("写入模式可重复执行（ON CONFLICT 分支真的命中）", async () => {
        const firstSalt = generateSalt();
        await run(buildResetStatements({ hash: await hashPassword("first-pass-1", firstSalt), salt: firstSalt }));
        const secondSalt = generateSalt();
        const secondHash = await hashPassword("second-pass-2", secondSalt);
        await run(buildResetStatements({ hash: secondHash, salt: secondSalt }));

        expect(await readSetting("ADMIN_PASSWORD_HASH")).toBe(secondHash);
        expect(await readSetting("PASSWORD_SALT")).toBe(secondSalt);
        expect(await countRows("SELECT COUNT(*) AS n FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'")).toBe(1);
    });

    it("默认模式删掉密码两行，其余设置保留", async () => {
        await run(buildResetStatements());

        expect(await readSetting("ADMIN_PASSWORD_HASH")).toBeNull();
        expect(await readSetting("PASSWORD_SALT")).toBeNull();
        expect(await readSetting("CF_ZONE_NAME")).toBe("zhishi.indevs.in");
    });
});
