// settings.test.ts — M-4：settings 清洗与配对校验的纯函数契约
import { describe, it, expect } from "vitest";
import {
    normalizeSettingsInput,
    validateEffectiveSettings,
    WRITABLE_SETTING_KEYS,
    SECRET_SETTING_KEYS,
    SENSITIVE_SETTINGS_KEYS,
} from "../src/db/settings.ts";

describe("normalizeSettingsInput 清洗", () => {
    it("丢弃白名单之外的键", () => {
        const result = normalizeSettingsInput({ UNKNOWN_KEY: "x", BATCH_SIZE: "20" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Object.keys(result.settings)).toEqual(["BATCH_SIZE"]);
        expect(result.settings.BATCH_SIZE).toBe("20");
    });

    it("null 表示显式清除", () => {
        const result = normalizeSettingsInput({ THREE_NETWORK_SOURCE: null });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.settings.THREE_NETWORK_SOURCE).toBeNull();
    });

    it("非 Secret 字段的空字符串表示清除", () => {
        const result = normalizeSettingsInput({ GITHUB_OWNER: "" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.settings.GITHUB_OWNER).toBeNull();
    });

    it("Secret 字段的空字符串表示保持不变，不写库", () => {
        const result = normalizeSettingsInput({ CF_API_TOKEN: "", GITHUB_TOKEN: "   " });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.settings).toEqual({});
    });

    it("字符串值会被 trim，数字值转成字符串", () => {
        const result = normalizeSettingsInput({ THREE_NETWORK_SOURCE: "  ipv4.icanhazip.com  ", BATCH_SIZE: 20 });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.settings.THREE_NETWORK_SOURCE).toBe("ipv4.icanhazip.com");
        expect(result.settings.BATCH_SIZE).toBe("20");
    });

    it.each(["0", "101", "1.5", "abc", ""])("BATCH_SIZE 非法值 %s 被拒绝", (value) => {
        const result = normalizeSettingsInput({ BATCH_SIZE: value });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain("BATCH_SIZE");
    });

    it("BATCH_SIZE 边界值 1 与 100 通过", () => {
        for (const value of ["1", "100"]) {
            const result = normalizeSettingsInput({ BATCH_SIZE: value });
            expect(result.ok).toBe(true);
        }
    });
});

describe("validateEffectiveSettings 配对校验", () => {
    it("Cloudflare 令牌与区域 ID 齐全时通过", () => {
        expect(validateEffectiveSettings({ CF_API_TOKEN: "t", CF_ZONE_ID: "z" })).toBeNull();
    });

    it("只配置 Cloudflare 令牌时拒绝", () => {
        const error = validateEffectiveSettings({ CF_API_TOKEN: "t", CF_ZONE_ID: null });
        expect(error).toContain("Cloudflare");
    });

    it("只配置 Cloudflare 区域 ID 时拒绝", () => {
        const error = validateEffectiveSettings({ CF_API_TOKEN: null, CF_ZONE_ID: "z" });
        expect(error).toContain("Cloudflare");
    });

    it("GitHub 三项齐全时通过", () => {
        expect(validateEffectiveSettings({ GITHUB_TOKEN: "t", GITHUB_OWNER: "o", GITHUB_REPO: "r" })).toBeNull();
    });

    it("GitHub 只配一部分时拒绝", () => {
        const error = validateEffectiveSettings({ GITHUB_TOKEN: "t", GITHUB_OWNER: "o", GITHUB_REPO: null });
        expect(error).toContain("GitHub");
    });

    it("全部未配置时通过（允许清空）", () => {
        expect(validateEffectiveSettings({ CF_API_TOKEN: null, CF_ZONE_ID: null, GITHUB_TOKEN: null })).toBeNull();
    });
});

describe("hostmonit 抓取 key 的写入语义 (issue #25)", () => {
    it("保存新值：非空字符串 trim 后落库", () => {
        const result = normalizeSettingsInput({ HOSTMONIT_API_KEY: "  my-hostmonit-key  " });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.settings.HOSTMONIT_API_KEY).toBe("my-hostmonit-key");
    });

    it("留空：空字符串视为保持不变，不写库（继续沿用内置默认）", () => {
        const result = normalizeSettingsInput({ HOSTMONIT_API_KEY: "   " });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.settings).toEqual({});
    });

    it("显式清除：null 落为删除指令，回到内置默认", () => {
        const result = normalizeSettingsInput({ HOSTMONIT_API_KEY: null });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.settings.HOSTMONIT_API_KEY).toBeNull();
    });

    it("在白名单内且按 Secret 处理（空串不误清）", () => {
        expect(WRITABLE_SETTING_KEYS.has("HOSTMONIT_API_KEY")).toBe(true);
        expect(SECRET_SETTING_KEYS.has("HOSTMONIT_API_KEY")).toBe(true);
    });

    it("属于敏感字段：安全设置视图不会回传明文", () => {
        expect(SENSITIVE_SETTINGS_KEYS.has("HOSTMONIT_API_KEY")).toBe(true);
    });
});
