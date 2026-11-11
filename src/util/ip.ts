// ip.ts — 共享 IPv4 / IPv6 校验与提取内核（issue #47）
// 所有链路共用：严格校验、归一、提取、去重、排序、按类型截断。
// IPv6 一律锚定全串做结构校验，不复用 domains.ts 的无锚定正则：
// 那条正则只在 DoH 场景可用（每条应答恰为一个干净 IP），放到任意正文上会把
// `::before`、`arr[::2]`、`IP=::1`、`[::1]:8080` 里的子串误判为地址。

const IPV4_GROUP_RE = /^\d{1,3}$/;
const IPV6_GROUP_RE = /^[0-9A-Fa-f]{1,4}$/;
// 边界沿用现有 \b 语义（不接受 `v1.2.3.4` 这类嵌在标识符里的形态），并额外排除点号，
// 避免从 `1.2.3.4.5` 里截出伪地址。
const IPV4_CANDIDATE_RE = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g;
// IPv6 候选先按「十六进制、冒号、点号」的最大连续段扫描，再交给严格校验过滤。
const IPV6_CANDIDATE_RE = /[0-9A-Fa-f:.]+/g;
// 候选两侧出现这些字符说明它嵌在标识符 / 代码表达式 / zone id 里，不是独立地址。
const IPV6_BAD_NEIGHBOR_RE = /[A-Za-z_=%[\]]/;
// 方括号前若是标识符，则是下标或切片语法（arr[::2]），不是 IPv6 字面量。
const IPV6_INDEX_NEIGHBOR_RE = /[0-9A-Za-z_$\]]/;

/** 是否合法 IPv4：四段十进制，每段 0–255 */
export function isValidIpv4(text: string): boolean {
    const segments = text.split(".");
    if (segments.length !== 4) return false;
    return segments.every((segment) => IPV4_GROUP_RE.test(segment) && Number(segment) <= 255);
}

/** 去掉一层完整包裹的方括号；不是完整包裹则原样返回 */
function stripBrackets(text: string): string {
    return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
}

/** 解析单个 IPv6 段为数值；非法段返回 null */
function parseGroup(segment: string): number | null {
    return IPV6_GROUP_RE.test(segment) ? Number.parseInt(segment, 16) : null;
}

/**
 * 把 IPv6 解析为 8 组数值；非法返回 null。
 * 结构规则：`::` 至多一次且显式组数 ≤7（压缩位至少一个）；无 `::` 时必须恰好 8 组；
 * 每段 1–4 位十六进制；拒绝 zone id（`%eth0`）与内嵌非法 IPv4。
 */
function parseIpv6Groups(text: string): number[] | null {
    const body = stripBrackets(text);
    if (body.length === 0 || body.includes("%")) return null;
    if (!/^[0-9A-Fa-f:.]+$/.test(body)) return null;

    let expanded = body;
    if (body.includes(".")) {
        // 内嵌 IPv4（如 `::ffff:192.0.2.1`）：校验后折算成两组十六进制
        const lastColon = body.lastIndexOf(":");
        if (lastColon < 0) return null;
        const ipv4Part = body.slice(lastColon + 1);
        if (!isValidIpv4(ipv4Part)) return null;
        const [a, b, c, d] = ipv4Part.split(".").map(Number);
        const high = ((a << 8) | b).toString(16);
        const low = ((c << 8) | d).toString(16);
        expanded = `${body.slice(0, lastColon + 1)}${high}:${low}`;
    }

    const halves = expanded.split("::");
    if (halves.length > 2) return null;

    if (halves.length === 2) {
        const head = halves[0] === "" ? [] : halves[0].split(":");
        const tail = halves[1] === "" ? [] : halves[1].split(":");
        const explicit = [...head, ...tail];
        if (explicit.length > 7) return null;
        const parsed = explicit.map(parseGroup);
        if (parsed.some((group) => group === null)) return null;
        const values = parsed as number[];
        const padded = Array.from({ length: 8 - explicit.length }, () => 0);
        return [...values.slice(0, head.length), ...padded, ...values.slice(head.length)];
    }

    const segments = expanded.split(":");
    if (segments.length !== 8) return null;
    const parsed = segments.map(parseGroup);
    return parsed.some((group) => group === null) ? null : (parsed as number[]);
}

/** 是否合法 IPv6：锚定全串结构校验，允许一层方括号包裹，拒绝 `%zone` 与端口后缀 */
export function isValidIpv6(text: string): boolean {
    return parseIpv6Groups(text) !== null;
}

/** IPv6 归一：去方括号、转小写；非法形态（含 `%zone`）返回 null */
export function normalizeIpv6(text: string): string | null {
    return parseIpv6Groups(text) === null ? null : stripBrackets(text).toLowerCase();
}

/** 是否 IPv4-mapped 地址（`::ffff:a.b.c.d`），这类地址归 IPv4 侧计数，避免重复 */
function isIpv4Mapped(normalized: string): boolean {
    const groups = parseIpv6Groups(normalized);
    if (groups === null) return false;
    return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
}

/** 提取正文中的合法 IPv4：严格过滤后按出现顺序去重 */
export function extractIpv4(text: string): string[] {
    const found = new Set<string>();
    for (const match of text.matchAll(IPV4_CANDIDATE_RE)) {
        if (isValidIpv4(match[0])) found.add(match[0]);
    }
    return [...found];
}

/**
 * 提取正文中的合法 IPv6：严格过滤、归一后去重。
 * - 方括号字面量要求 `[` 不是下标语法，且 `]` 后不紧跟端口；
 * - 非方括号候选要求两侧不是标识符 / `=` / 方括号 / `%`，避免代码片段误提取；
 * - IPv4-mapped 地址不进入 IPv6 结果（其 IPv4 由 extractIpv4 计数）。
 */
export function extractIpv6(text: string): string[] {
    const found = new Set<string>();
    for (const match of text.matchAll(IPV6_CANDIDATE_RE)) {
        const candidate = match[0];
        const start = match.index;
        const end = start + candidate.length;
        const before = start > 0 ? text[start - 1] : "";
        const after = end < text.length ? text[end] : "";
        // 句末点号会被最大连续段一起吞进来，地址本身不可能以点开头或结尾
        const trimmed = candidate.replace(/^\.+|\.+$/g, "");

        let value: string | null;
        if (before === "[" && after === "]") {
            const beforeBracket = start > 1 ? text[start - 2] : "";
            const afterBracket = end + 1 < text.length ? text[end + 1] : "";
            if (IPV6_INDEX_NEIGHBOR_RE.test(beforeBracket) || afterBracket === ":") continue;
            value = normalizeIpv6(`[${trimmed}]`);
        } else {
            if (IPV6_BAD_NEIGHBOR_RE.test(before) || IPV6_BAD_NEIGHBOR_RE.test(after)) continue;
            value = normalizeIpv6(trimmed);
        }

        // 纯 `::` 是未指定地址，正文里的「::」多是分隔符，不当作可发布地址
        if (value === null || value === "::" || isIpv4Mapped(value)) continue;
        found.add(value);
    }
    return [...found];
}

/** IPv4 数值升序（沿用既有比较器），返回新数组 */
export function sortIpv4(list: string[]): string[] {
    return [...list].sort((a, b) => {
        const aParts = a.split(".").map(Number);
        const bParts = b.split(".").map(Number);
        for (let i = 0; i < 4; i++) {
            if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
        }
        return 0;
    });
}

/** IPv6 归一后字典序，返回新数组 */
export function sortIpv6(list: string[]): string[] {
    return [...list].sort((a, b) => {
        const left = normalizeIpv6(a) ?? a.toLowerCase();
        const right = normalizeIpv6(b) ?? b.toLowerCase();
        if (left === right) return 0;
        return left < right ? -1 : 1;
    });
}

/** IPv4 / IPv6 各自截断到上限，两类互不影响 */
export function truncatePerType(
    ips: { ipv4: string[]; ipv6: string[] },
    max: number
): { ipv4: string[]; ipv6: string[] } {
    return { ipv4: ips.ipv4.slice(0, max), ipv6: ips.ipv6.slice(0, max) };
}
