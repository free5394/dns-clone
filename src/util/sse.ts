// sse.ts — SSE（Server-Sent Events）日志流响应
// 从 index.legacy.js 提取（原 1450-1479 行）

import { beijingTimeLog } from "./log.ts";
import type { WaitUntil } from "./http.ts";

/**
 * 创建 SSE 日志流响应：把 logFunction 的执行过程实时推送给客户端
 * @param logFunction 异步函数，接收 log 回调用于输出日志
 * @param signal 客户端断开信号（AbortSignal）—— 可选；触发后立即停止推送并关闭流。
 *               它不会主动打断后端任务，但「关流后任务还能跑完」不由本函数保证：
 *               必须由调用方把任务注册给 waitUntil，否则响应结束即请求生命周期结束，
 *               运行时可以连带取消这个游离 Promise（锁释放与状态写回就丢了）。
 * @param waitUntil Workers 的 ctx.waitUntil —— 可选；传入后后台任务被注册为延寿任务，
 *               关流后仍会跑到 finally 释放锁。
 */
export function createLogStreamResponse(
    logFunction: (log: (message: string) => void) => Promise<void>,
    signal?: AbortSignal,
    waitUntil?: WaitUntil
): Response {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    // 初值取 signal 当前状态：客户端在 handler 进入前已断开时，
    // addEventListener('abort') 不会再触发，只能靠初值拦截
    let aborted = signal?.aborted ?? false;
    let closed = false;

    // 单一 close 路径：避免 abort 与 finally 双重 close 引发的 TypeError（FIX-09）
    const safeClose = () => {
        if (closed) return Promise.resolve();
        closed = true;
        return writer.close().catch(() => {});
    };

    const log = (message: string) => {
        if (aborted) return;
        const logMsg = beijingTimeLog(message);
        // writer.write 返回 Promise，不能被同步 try/catch 捕获；用 .catch 链式处理
        writer
            .write(encoder.encode(`data: ${logMsg}\n\n`))
            .catch((e) => console.error("Failed to write to stream:", e instanceof Error ? e.message : e));
    };

    if (signal) {
        signal.addEventListener(
            "abort",
            () => {
                aborted = true;
                void safeClose();
            },
            { once: true }
        );
    }

    const task = (async () => {
        try {
            await logFunction(log);
        } catch (e) {
            if (!aborted) {
                log(`[FATAL_ERROR] ${e instanceof Error ? e.message : String(e)}`);
                // 上游（sync* 系列函数）通常已经通过 log() 把失败原因告知了用户，
                // 并将状态写回了 D1。这里把错误降级为控制台 warn，避免误导为"崩溃"。
                console.warn(`Streaming log function ended with error: ${e instanceof Error ? e.message : String(e)}`);
            }
        } finally {
            await safeClose();
        }
    })();

    // 注册给运行时：客户端 abort 导致流提前关闭时，任务与锁释放仍需跑完
    if (waitUntil) waitUntil(task);

    return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
}
