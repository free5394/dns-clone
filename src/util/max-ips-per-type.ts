// max-ips-per-type.ts — MAX_IPS_PER_TYPE 的数值常量与读取归一（issue #49 / 方案 §8.4）
// 与 batch-size.ts 同形：数值常量与归一函数放 util，设置键名与写入白名单留在 db/settings.ts。
// 这样视图层（src/ui）与路由层共用同一处判据，不必让 UI 反向依赖 db 层。

/** DNS 单类型记录上限的默认值 */
export const DEFAULT_MAX_IPS_PER_TYPE = 20;

/** DNS 单类型记录上限的下限 */
export const MIN_MAX_IPS_PER_TYPE = 1;

/** DNS 单类型记录上限的上限 */
export const MAX_MAX_IPS_PER_TYPE = 200;

/**
 * 归一 MAX_IPS_PER_TYPE：缺失、空值、非整数或越界都回退默认值（与 normalizeBatchSize 同风格）。
 * 写入校验拦不住存量脏数据（手工改库、旧版本遗留），读取侧必须自己兜底。
 */
export function normalizeMaxIpsPerType(raw: string | null | undefined): number {
    if (raw === null || raw === undefined) return DEFAULT_MAX_IPS_PER_TYPE;
    const text = String(raw).trim();
    if (text === "") return DEFAULT_MAX_IPS_PER_TYPE;
    const n = Number(text);
    if (!Number.isInteger(n) || n < MIN_MAX_IPS_PER_TYPE || n > MAX_MAX_IPS_PER_TYPE) return DEFAULT_MAX_IPS_PER_TYPE;
    return n;
}
