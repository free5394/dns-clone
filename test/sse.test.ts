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
    return text
        .split("\n\n")
        .filter(Boolean)
        .map((chunk) => chunk.replace(/^data: /, ""));
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
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const res = createLogStreamResponse(async (log) => {
            log("abort 前");
            await gate;
            log("abort 后"); // 应被 aborted 守卫丢弃
        }, controller.signal);

        controller.abort();
        release();

        const text = await drain(res);
        // abort 后的日志不应出现
        expect(text).not.toContain("abort 后");
        // 关键：finally 中的 safeClose 不得因流已关闭而抛 TypeError
        const closeErrors = errorSpy.mock.calls.filter(
            (c) => String(c[0]).includes("TypeError") || c[1] instanceof TypeError
        );
        expect(closeErrors).toHaveLength(0);
    });

    it("后台任务不依赖读者驱动：无人读取时已执行到结束，随后关流正常", async () => {
        const steps: string[] = [];
        let done!: () => void;
        const finished = new Promise<void>((resolve) => {
            done = resolve;
        });

        // 刻意不消费 res.body：createLogStreamResponse 返回时后台任务已启动，不依赖读者驱动
        const res = createLogStreamResponse(async (log) => {
            log("第一步");
            steps.push("第一步");
            log("第二步");
            steps.push("第二步");
            done();
        });

        await finished;
        expect(steps).toEqual(["第一步", "第二步"]);
        // 中-1：上面只等到 logFunction 结束，未覆盖外层包装与 safeClose；补一次排空证明关流也已完成
        expect(await drain(res)).toContain("第二步");
    });

    it("abort 只停止推送，不会终止后端任务", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const controller = new AbortController();

        let done!: () => void;
        const finished = new Promise<void>((resolve) => {
            done = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let tailRan = false;

        const res = createLogStreamResponse(async (log) => {
            log("abort 前");
            await gate;
            log("abort 后"); // 应被 aborted 守卫丢弃
            tailRan = true;
            done();
        }, controller.signal);

        controller.abort();
        expect(tailRan, "abort 不应中断后端任务").toBe(false);

        release();
        await finished;
        expect(tailRan, "后端任务应在 abort 后继续执行到结束，锁与状态才有机会释放").toBe(true);

        const text = await drain(res);
        expect(text).toContain("abort 前");
        expect(text).not.toContain("abort 后");
    });

    it("把后台任务注册给 waitUntil：运行时延寿后任务与关流都能跑完", async () => {
        const registered: Promise<unknown>[] = [];
        let taskSettled = false;

        const res = createLogStreamResponse(
            async (log) => {
                log("延寿步骤");
            },
            undefined,
            (p) => {
                registered.push(p);
                void p.then(() => {
                    taskSettled = true;
                });
            }
        );

        // 高-1：后台任务是游离 Promise，不注册给运行时的话，客户端 abort 关流后可能被连带终止
        expect(registered, "必须把后台任务交给 waitUntil").toHaveLength(1);
        // 先开始消费：writer.close() 要等可读侧被排空，否则注册的 Promise 永远不 resolve（真实客户端一直在读）
        const drained = drain(res);
        await registered[0];
        expect(taskSettled, "注册的 Promise 应在任务与关流都结束后才 resolve").toBe(true);
        expect(await drained).toContain("延寿步骤");
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
