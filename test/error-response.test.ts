// error-response.test.ts — 中-8：API 全局兜底不得把异常细节回传给调用方
import { describe, it, expect } from "vitest";
import { buildApiErrorResponse } from "../src/index.ts";

describe("API 全局兜底错误响应 (中-8)", () => {
    it("响应体只含固定文案，不携带 details 或异常 message", async () => {
        const res = buildApiErrorResponse(new Error("internal https://secret.example/token?x=1"), 500);
        expect(res.status).toBe(500);

        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toEqual({ error: "发生意外的服务器错误。" });
        expect(Object.keys(body)).not.toContain("details");
        expect(JSON.stringify(body)).not.toContain("secret.example");
    });

    it("非 Error 抛值同样不泄露内容", async () => {
        const res = buildApiErrorResponse({ token: "abc123" }, 503);
        expect(res.status).toBe(503);

        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toEqual({ error: "发生意外的服务器错误。" });
        expect(JSON.stringify(body)).not.toContain("abc123");
    });
});
