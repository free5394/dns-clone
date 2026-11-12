// domain-row.ts — DomainRow 测试工厂
// 为什么需要：DomainRow 字段多、含多个可空列，用例里手写字面量时每加一列就要改多处；
// issue #62 收的正是这些手写字面量与按位置反推的类型。
// 与 ip-source-row.ts 同构：类型只有 src 一处，整行默认值集中在这里，用例只覆盖自己关心的字段。
import type { DomainRow } from "../src/sync/domains.ts";

/** 转出 src 的行类型：用例继续从本文件取，定义只有 src 一处（issue #62）。 */
export type { DomainRow };

/** 一条「可正常同步」的域名行：浅层克隆、启用、非系统内置。 */
const DEFAULTS: DomainRow = {
    id: 1,
    source_domain: "src.example.com",
    target_domain: "example.com",
    zone_id: "test-zone-id",
    is_deep_resolve: 0,
    ttl: 60,
    last_synced_records: null,
    is_enabled: 1,
    is_system: 0,
    source_type: null,
    source_url: null,
    parse_mode: null,
    parse_param: null,
    fetch_strategy: null,
};

/** 生成 DomainRow：overrides 覆盖默认值，每次返回新对象（不与 DEFAULTS 共享引用）。 */
export function makeDomainRow(overrides: Partial<DomainRow> = {}): DomainRow {
    return { ...DEFAULTS, ...overrides };
}
