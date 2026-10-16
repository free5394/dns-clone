// batch-size.ts — BATCH_SIZE 归一化（I5）
// 语义：非法/越界值一律回退默认 10。负数绝不能透传：SQLite 的 LIMIT 负数
// 表示"无上限"，会让单轮 cron 处理全表，拖垮 Workers 时限与 API 配额。

export const DEFAULT_BATCH_SIZE = 10;
export const MAX_BATCH_SIZE = 100;

/** 把 settings 中的 BATCH_SIZE 原始值钳制为 1..100 的整数，非法回退默认值 */
export function normalizeBatchSize(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) return DEFAULT_BATCH_SIZE;
    return n;
}
