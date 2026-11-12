// ip-source-row.ts — IpSourceRow 测试工厂
// 为什么需要：IpSourceRow 有 8 个字段（含 3 个可空 / 可选列），用例里手写字面量时
// 每加一列就要改十几处——issue #60 的 22 处 TS2739 + 6 处 TS2741 都是这么攒出来的。
// 默认值集中在这里，用例只覆盖自己关心的字段。
import type { IpSourceRow } from "../src/sync/ip-sources.ts";

/** 转出 src 的行类型：用例继续从本文件取，定义只有 src 一处（issue #61）。 */
export type { IpSourceRow };

/** 一条「可正常抓取」的源：direct_regex、auto 解析、启用。 */
const DEFAULTS: IpSourceRow = {
    id: 1,
    url: "https://example.com/ips.txt",
    github_path: "ips.txt",
    commit_message: "update",
    fetch_strategy: "direct_regex",
    parse_mode: null,
    parse_param: null,
    is_enabled: 1,
};

/** 生成 IpSourceRow：overrides 覆盖默认值，每次返回新对象（不与 DEFAULTS 共享引用）。 */
export function makeIpSourceRow(overrides: Partial<IpSourceRow> = {}): IpSourceRow {
    return { ...DEFAULTS, ...overrides };
}
