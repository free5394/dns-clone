// dashboard-api.test.ts — 仪表盘请求封装的行为断言（M-1）
// apiFetch 依赖浏览器环境，抽成工厂后可以注入 fetch / 提示 / 跳转，从而在测试里覆盖 401 与业务错误分支。

import { describe, it, expect, vi } from "vitest";
import { createApiFetch } from "../src/ui/dashboard-api.js";

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeApi(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    const notify = vi.fn();
    const redirect = vi.fn();
    const schedule = vi.fn((_fn: () => void, _ms: number) => undefined as unknown);
    const apiFetch = createApiFetch({ fetchImpl: impl, notify, redirect, schedule });
    return { apiFetch, notify, redirect, schedule };
}

describe("仪表盘请求封装 (M-1)", () => {
    it("成功响应直接返回解析后的 JSON", async () => {
        const { apiFetch, notify } = makeApi(async () => jsonResponse(200, { success: true, value: 1 }));

        await expect(apiFetch("/api/x")).resolves.toEqual({ success: true, value: 1 });
        expect(notify).not.toHaveBeenCalled();
    });

    it("默认带上 JSON 头，且调用方的 headers 覆盖默认值", async () => {
        const seen: Array<RequestInit | undefined> = [];
        const { apiFetch } = makeApi(async (_url, init) => {
            seen.push(init);
            return jsonResponse(200, {});
        });

        await apiFetch("/api/x");
        await apiFetch("/api/y", { method: "POST", headers: { "Content-Type": "text/plain" } });

        const firstHeaders = seen[0]?.headers as Record<string, string>;
        const secondHeaders = seen[1]?.headers as Record<string, string>;
        expect(firstHeaders["Content-Type"]).toBe("application/json");
        expect(secondHeaders["Content-Type"]).toBe("text/plain");
        expect(seen[1]).toMatchObject({ method: "POST" });
    });

    it("401 提示会话过期、延迟跳转登录，并抛出后端文案", async () => {
        const { apiFetch, notify, redirect, schedule } = makeApi(async () => jsonResponse(401, { error: "未授权" }));

        await expect(apiFetch("/api/x")).rejects.toThrow("未授权");
        expect(notify).toHaveBeenCalledWith("会话已过期，请重新登录。", "error");
        expect(redirect).not.toHaveBeenCalled();
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(schedule.mock.calls[0][1]).toBe(2000);

        schedule.mock.calls[0][0]();
        expect(redirect).toHaveBeenCalledWith("/login");
    });

    it("非 401 的业务错误直接抛出后端文案", async () => {
        const { apiFetch, notify } = makeApi(async () => jsonResponse(400, { error: "BATCH_SIZE 必须是整数。" }));

        await expect(apiFetch("/api/x")).rejects.toThrow("BATCH_SIZE 必须是整数。");
        expect(notify).not.toHaveBeenCalled();
    });

    it("错误响应不是 JSON 时退回状态码文案", async () => {
        const { apiFetch } = makeApi(async () => new Response("bad gateway", { status: 502 }));

        await expect(apiFetch("/api/x")).rejects.toThrow("HTTP 错误: 502");
    });

    it("成功响应体不是 JSON 时返回空对象而不是抛错", async () => {
        const { apiFetch } = makeApi(async () => new Response("ok", { status: 200 }));

        await expect(apiFetch("/api/x")).resolves.toEqual({});
    });
});
