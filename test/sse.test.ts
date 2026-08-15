// sse.test.ts — src/util/sse.ts 覆盖
// 重点：FIX-09 单一 close 路径（abort 与 finally 不得双重 close 引发 TypeError）
import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogStreamResponse } from "../src/util/sse.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

/** 读干 SSE 响应体，返回解码后的完整文本 */
async function drain(res: Response): Promise<string> {
    return await res.text();
}

/** 从 SSE 文本中提取 data: 行的负载 */
function dataLines(text: string): string[] {
    return text.split("\n\n").filter(Boolean).map((chunk) => chunk.replace(/^data: /, ""));
}

describe("createLogStreamResponse", () => {
    it("returns SSE standard response headers", () => {
        const res = createLogStreamResponse(async () => {});
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        expect(res.headers.get("Cache-Control")).toBe("no-cache");
        expect(res.headers.get("Connection")).toBe("keep-alive");
    });

    it("each logFunction entry is pushed as a data: frame", async () => {
        const res = createLogStreamResponse(async (log) => {
            log("第一步");
            log("第二步");
        });

        const lines = dataLines(await drain(res));
        expect(lines).toHaveLength(2);
        // beijingTimeLog 会加时间前缀，故用 contains 断言
        expect(lines[0]).toContain("第一步");
        expect(lines[1]).toContain("第二步");
    });

    it("logFunction throw pushes [FATAL_ERROR] frame and closes stream cleanly", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const res = createLogStreamResponse(async (log) => {
            log("开始");
            throw new Error("同步任务炸了");
        });

        const lines = dataLines(await drain(res));
        expect(lines[0]).toContain("开始");
        expect(lines[1]).toContain("[FATAL_ERROR]");
        expect(lines[1]).toContain("同步任务炸了");
        // 错误已通过 [FATAL_ERROR] 帧推送给客户端，服务端仅 console.warn（降级，不再误报崩溃）
        expect(warnSpy).toHaveBeenCalled();
    });

    it("non-Error throws (e.g. string) are safely serialized", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});

        const res = createLogStreamResponse(async () => {
            throw "字符串异常";
        });

        const lines = dataLines(await drain(res));
        expect(lines[0]).toContain("[FATAL_ERROR]");
        expect(lines[0]).toContain("字符串异常");
    });

    it("after client abort stops pushing; no double-close error (FIX-09)", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const controller = new AbortController();

        // 用 deferred 精确控制：abort 发生在 logFunction 执行中途
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        const res = createLogStreamResponse(async (log) => {
            log("abort 前");
            await gate;
            log("abort 后");  // 应被 aborted 守卫丢弃
        }, controller.signal);

        controller.abort();
        release();

        const text = await drain(res);
        // abort 后的日志不应出现
        expect(text).not.toContain("abort 后");
        // 关键：finally 中的 safeClose 不得因流已关闭而抛 TypeError
        const closeErrors = errorSpy.mock.calls.filter((c) =>
            String(c[0]).includes("TypeError") || c[1] instanceof TypeError
        );
        expect(closeErrors).toHaveLength(0);
    });

    it("already-aborted signal pushes no logs", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const controller = new AbortController();
        controller.abort();

        const res = createLogStreamResponse(async (log) => {
            log("不该出现");
        }, controller.signal);

        expect(await drain(res)).toBe("");
    });
});
