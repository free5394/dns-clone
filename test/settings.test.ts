// settings.test.ts — M-4：settings 清洗与配对校验的纯函数契约
// 说明：/api/settings 的路由级用例（含 HOSTMONIT_API_KEY 三态）集中在 test/api.test.ts，
// 那里复用既有的 PASSWORD/loginAndGetCookie，本文件只留纯函数契约。
import { describe, it, expect } from "vitest";
import {
    normalizeSettingsInput,
    validateEffectiveSettings,
    normalizeHostmonitKey,
    isHostmonitKeyConfigured,
    MAX_IPS_PER_TYPE_KEY,
    WRITABLE_SETTING_KEYS,
    SECRET_SETTING_KEYS,
    SENSITIVE_SETTINGS_KEYS,
} from "../src/db/settings.ts";
// 说明：归一与常量已迁到 util（与 batch-size.ts 同形），设置键名与写入白名单仍在 db/settings.ts。
import {
    normalizeMaxIpsPerType,
    DEFAULT_MAX_IPS_PER_TYPE,
    MIN_MAX_IPS_PER_TYPE,
    MAX_MAX_IPS_PER_TYPE,
} from "../src/util/max-ips-per-type.ts";

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

describe("hostmonit key 判据一致性 (issue #37 R2)", () => {
    // 同一批输入下，两个导出函数必须给出互相自洽的结论，避免「显示未配置但抓取用了自定义值」这类分叉
    const inputs: Array<string | null | undefined> = ["", "   ", "\t\n ", "  key  ", null, undefined];

    it("isHostmonitKeyConfigured 与 normalizeHostmonitKey 对同一批输入保持一致", () => {
        for (const input of inputs) {
            expect(isHostmonitKeyConfigured(input)).toBe(normalizeHostmonitKey(input) !== "");
        }
    });

    it("空白与缺失都归一为空串，非空值只去掉首尾空白", () => {
        expect(normalizeHostmonitKey("   ")).toBe("");
        expect(normalizeHostmonitKey(null)).toBe("");
        expect(normalizeHostmonitKey(undefined)).toBe("");
        expect(normalizeHostmonitKey("  key  ")).toBe("key");
    });
});

describe("MAX_IPS_PER_TYPE 写入校验与读取归一 (issue #49)", () => {
    it("在白名单内，且不属于密钥/敏感分组", () => {
        expect(WRITABLE_SETTING_KEYS.has(MAX_IPS_PER_TYPE_KEY)).toBe(true);
        expect(SECRET_SETTING_KEYS.has(MAX_IPS_PER_TYPE_KEY)).toBe(false);
        expect(SENSITIVE_SETTINGS_KEYS.has(MAX_IPS_PER_TYPE_KEY)).toBe(false);
    });

    it("接受 1 与 200 两个边界值并落为字符串", () => {
        const low = normalizeSettingsInput({ MAX_IPS_PER_TYPE: MIN_MAX_IPS_PER_TYPE });
        expect(low.ok).toBe(true);
        if (!low.ok) return;
        expect(low.settings.MAX_IPS_PER_TYPE).toBe("1");

        const high = normalizeSettingsInput({ MAX_IPS_PER_TYPE: MAX_MAX_IPS_PER_TYPE });
        expect(high.ok).toBe(true);
        if (!high.ok) return;
        expect(high.settings.MAX_IPS_PER_TYPE).toBe("200");
    });

    it.each(["0", "201", "1.5", "abc", "-1", "20abc"])("非法值 %s 被拒绝且整批失败", (value) => {
        const result = normalizeSettingsInput({ MAX_IPS_PER_TYPE: value, THREE_NETWORK_SOURCE: "wetest.vip" });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain("MAX_IPS_PER_TYPE");
    });

    it("非字符串却折叠成空的输入按非法拒绝，不能当成清除 (issue #49 复核)", () => {
        // String([]) === ""，若按折叠后的 null 判断会被误判成显式清除并返回 200（方案 §9.5 要求 400）
        for (const value of [[], [""]] as const) {
            const result = normalizeSettingsInput({ MAX_IPS_PER_TYPE: value });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toContain("MAX_IPS_PER_TYPE");
        }
    });

    it("null 与空串表示显式清除，不算非法（读取时回退默认）", () => {
        for (const value of [null, ""] as const) {
            const result = normalizeSettingsInput({ MAX_IPS_PER_TYPE: value });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.settings.MAX_IPS_PER_TYPE).toBeNull();
        }
    });

    it("读取归一：缺失、空值、非整数、越界与脏字符串一律回退 20", () => {
        for (const raw of [null, undefined, "", "   ", "abc", "1.5", "0", "-3", "201", "1e3"]) {
            expect(normalizeMaxIpsPerType(raw)).toBe(DEFAULT_MAX_IPS_PER_TYPE);
        }
        expect(DEFAULT_MAX_IPS_PER_TYPE).toBe(20);
    });

    it("读取归一：范围内整数原样返回（含写入后的往返）", () => {
        expect(normalizeMaxIpsPerType("1")).toBe(1);
        expect(normalizeMaxIpsPerType("200")).toBe(200);
        expect(normalizeMaxIpsPerType(" 30 ")).toBe(30);

        const written = normalizeSettingsInput({ MAX_IPS_PER_TYPE: "30" });
        expect(written.ok).toBe(true);
        if (!written.ok) return;
        expect(normalizeMaxIpsPerType(written.settings.MAX_IPS_PER_TYPE)).toBe(30);
    });
});
