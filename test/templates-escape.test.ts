// templates-escape.test.ts — P0-2：公开首页存储型 XSS 修复回归测试
// 验证 getPublicHomepage 对用户控制字段（notes/target_domain/github_path/url）做 HTML 实体转义
import { describe, it, expect } from "vitest";
import { getPublicHomepage } from "../src/ui/templates.js";

const requestUrl = "https://example.com/";

describe("getPublicHomepage HTML 转义 (P0-2)", () => {
    it("转义 notes 中的 <img onerror> payload", () => {
        const domains = [{
            target_domain: "safe.example.com",
            source_domain: "src.example.com",
            notes: '<img src=x onerror=alert(1)>',
            last_synced_time: "2026-01-01T00:00:00Z",
            is_enabled: 1,
            last_sync_status: "success",
        }];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 未转义的 <img 标签不应出现
        expect(html).not.toMatch(/<img src=x onerror=alert\(1\)>/);
        // 转义后的实体应当出现
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("转义 target_domain 中的属性逃逸 payload", () => {
        const domains = [{
            target_domain: '" onmouseover="alert(1)',
            source_domain: "src.example.com",
            notes: "正常备注",
            last_synced_time: "2026-01-01T00:00:00Z",
            is_enabled: 1,
            last_sync_status: "success",
        }];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 未转义的 onmouseover 属性不应出现
        expect(html).not.toMatch(/onmouseover="alert\(1\)"/);
        // 双引号应被转义为 &quot;
        expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    });

    it("转义 ipSource 的 github_path 中的 HTML payload", () => {
        const ipSources = [{
            url: "https://raw.githubusercontent.com/u/r/main/file.txt",
            github_path: '<script>alert(1)</script>/path.txt',
            last_synced_time: "2026-01-01T00:00:00Z",
        }];
        const html = getPublicHomepage(requestUrl, [], ipSources, "三网聚合", false);
        expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("转义 github_path 中的双引号属性逃逸", () => {
        const ipSources = [{
            url: "https://example.com/raw/file.txt",
            github_path: '" onmouseover="alert(1)/x.txt',
            last_synced_time: "2026-01-01T00:00:00Z",
        }];
        const html = getPublicHomepage(requestUrl, [], ipSources, "三网聚合", false);
        // 未转义的双引号应被替换为 &quot;，属性逃逸不成立
        expect(html).not.toMatch(/onmouseover="alert\(1\)"/);
        expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    });

    it("对 null/undefined 值安全降级为空串", () => {
        const domains = [{
            target_domain: "safe.example.com",
            source_domain: "src.example.com",
            notes: null,
            last_synced_time: null,
            is_enabled: 1,
            last_sync_status: "success",
        }];
        const html = getPublicHomepage(requestUrl, domains, [], "三网聚合", false);
        // 不应抛错，且应包含兜底文案
        expect(html).toContain("未知线路");
        expect(html).toContain("N/A");
    });
});
