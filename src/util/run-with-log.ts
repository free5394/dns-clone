// run-with-log.ts — 统一 sync 函数的"返回 SSE 流 / 直接执行"二选一逻辑包装器
import { createLogStreamResponse } from './sse.ts';
import { beijingTimeLog } from './log.ts';

type LogFn = (msg: string) => void;

/**
 * 统一包装 sync 函数的流式日志行为
 * - returnLogs=true：返回 SSE Response，将日志实时推给客户端
 * - returnLogs=false：直接执行，noOpLog 写到 console.log
 */
export function runWithOptionalLog(
    logic: (log: LogFn) => Promise<void>,
    returnLogs: boolean,
    signal?: AbortSignal,
): Response | Promise<void> {
    if (returnLogs) return createLogStreamResponse(logic, signal);
    return logic((msg) => console.log(beijingTimeLog(msg)));
}
