// dashboard-helpers.test.ts — L-8：把「客户端转义助手」从源码字符串断言改成行为断言
// 这些函数通过 toString() 注入浏览器脚本，所以这里 import 到的是页面里真正执行的同一份实现。
import { describe, it, expect } from "vitest";
import { captureButtonStates, escapeHtmlClient, restoreButtonStates } from "../src/ui/dashboard-helpers.js";

describe("escapeHtmlClient 客户端转义", () => {
    it("转义五种 HTML 元字符", () => {
        expect(escapeHtmlClient(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    });

    it("阻断标签注入 payload", () => {
        const payload = "<img src=x onerror=alert(1)>";
        const escaped = escapeHtmlClient(payload);
        expect(escaped).not.toContain("<");
        expect(escaped).not.toContain(">");
        expect(escaped).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("阻断属性逃逸 payload", () => {
        const payload = '" onmouseover="alert(1)';
        const escaped = escapeHtmlClient(payload);
        expect(escaped).not.toContain('"');
        expect(escaped).toBe("&quot; onmouseover=&quot;alert(1)");
    });

    it("转义 script 结束标签，避免脚本上下文截断", () => {
        expect(escapeHtmlClient("</script>")).toBe("&lt;/script&gt;");
    });

    it("null 与 undefined 统一成空串", () => {
        expect(escapeHtmlClient(null)).toBe("");
        expect(escapeHtmlClient(undefined)).toBe("");
    });

    it("数字与布尔值按字符串处理", () => {
        expect(escapeHtmlClient(0)).toBe("0");
        expect(escapeHtmlClient(false)).toBe("false");
    });

    it("注入到仪表盘脚本的是同一个函数实现", async () => {
        const { getDashboardPage } = await import("../src/ui/templates.js");
        const html = getDashboardPage([], [], {});
        expect(html).toContain("const esc = function escapeHtmlClient");
        // 注入的函数体与模块实现逐字一致
        expect(html).toContain(escapeHtmlClient.toString());
    });
});

describe("按钮状态快照与还原 (P0)", () => {
    const button = (disabled: boolean) => ({ disabled });

    it("快照记录每个按钮请求前的禁用状态", () => {
        const states = captureButtonStates([button(true), button(false)]);
        expect(states.map(([, wasDisabled]) => wasDisabled)).toEqual([true, false]);
    });

    it("同步期间全部禁用后，还原时每个按钮回到请求前的状态", () => {
        const gated = button(true); // 待探测的 IP 源保存键：请求前就是禁用的
        const saveBtn = button(false); // 弹窗保存键：请求前可用，不能被永久禁用
        const states = captureButtonStates([gated, saveBtn]);
        for (const [b] of states) b.disabled = true;
        restoreButtonStates(states);
        expect(gated.disabled).toBe(true);
        expect(saveBtn.disabled).toBe(false);
    });
});
