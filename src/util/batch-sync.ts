// batch-sync.ts — 批同步的通用编排（M-5）
// 红线（AGENTS.md）：批量同步时单条失败不得中断整批。
// 各业务模块只保留「取哪些行」与「失败怎么记」两处差异，循环骨架收敛到这里。

export type BatchErrorHandler<T> = (item: T, error: unknown) => void;

/**
 * 顺序执行每条同步任务，单条抛错只交给 onError 记录，不中断后续条目。
 * 顺序而非并发：Workers 有出站连接与 CPU 预算限制，并发取数会把一批同步打成限流。
 */
export async function forEachIsolated<T>(
    items: readonly T[],
    run: (item: T) => Promise<void>,
    onError: BatchErrorHandler<T>
): Promise<void> {
    for (const item of items) {
        try {
            await run(item);
        } catch (e) {
            onError(item, e);
        }
    }
}
