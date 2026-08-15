// url-safety.ts — URL 安全校验：仅允许 http/https 协议且非内网/元数据地址
// 用于防范 SSRF：阻止 Worker 向 169.254.169.254、10.0.0.0/8、CodeTabs/PhantomJS 代理访问内网等场景

/**
 * 把主机名归一化为 IPv4 字符串。
 * - 纯数字（十进制）主机名 → 还原为 IPv4
 * - `0x` 前缀（十六进制）主机名 → 还原为 IPv4
 * - `::ffff:a.b.c.d` 形态（IPv4-mapped IPv6）→ 抽取 IPv4
 * - 已经是 IPv4 字符串 → 直接返回
 * - 其他情况（含域名、合法 IPv6）→ 返回 null
 */
export function parseHostToIpv4(host: string): string | null {
    const h = host.toLowerCase();
    if (/^\d+$/.test(h)) {
        // 十进制 IPv4：解析为 4 段点分十进制
        const n = Number(h);
        if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
        const a = (n >>> 24) & 0xff;
        const b = (n >>> 16) & 0xff;
        const c = (n >>> 8) & 0xff;
        const d = n & 0xff;
        return `${a}.${b}.${c}.${d}`;
    }
    if (/^0x[0-9a-f]+$/.test(h)) {
        // 十六进制 IPv4
        const n = parseInt(h.slice(2), 16);
        if (!Number.isFinite(n)) return null;
        const a = (n >>> 24) & 0xff;
        const b = (n >>> 16) & 0xff;
        const c = (n >>> 8) & 0xff;
        const d = n & 0xff;
        return `${a}.${b}.${c}.${d}`;
    }
    const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return mapped[1];
    // IPv4-mapped IPv6 hex 形式：`::ffff:HHHH:HHHH`（Node URL 解析器实际输出形式）
    const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
        const hi = parseInt(hexMapped[1], 16);
        const lo = parseInt(hexMapped[2], 16);
        if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
        const a = (hi >>> 8) & 0xff;
        const b = hi & 0xff;
        const c = (lo >>> 8) & 0xff;
        const d = lo & 0xff;
        return `${a}.${b}.${c}.${d}`;
    }
    // 已经是 IPv4 字符串（4 段点分十进制）
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h;
    return null;
}

function isPrivateIpv4(ip: string): boolean {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
        throw new Error("IPv4 格式无效。");
    }
    const privatePatterns = [
        /^127\./,
        /^10\./,
        /^192\.168\./,
        /^169\.254\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^0\./,
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
    ];
    return privatePatterns.some(re => re.test(ip));
}

/**
 * 校验 URL 仅允许 http/https 协议且非内网地址
 * @throws Error 当协议非 http/https 或主机为内网/回环/链路本地/云元数据时
 */
export function assertSafeHttpUrl(raw: string): URL {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error("URL 格式无效。");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("仅允许 http/https 协议。");
    }
    let host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");

    // 归一化 IP 字面量：十进制、十六进制、IPv4-mapped IPv6
    const ipv4 = parseHostToIpv4(host);
    if (ipv4) {
        if (isPrivateIpv4(ipv4)) {
            throw new Error("不允许访问内网或元数据地址。");
        }
        return u;
    }

    // 回环 / 私有 / 链路本地 / CGNAT / 云元数据
    const privatePatterns = [
        /^127\./,
        /^10\./,
        /^192\.168\./,
        /^169\.254\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^0\./,
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
        /^::1$/,
        /^fe[89ab][0-9a-f]:/i,
        /^f[cd][0-9a-f]{2}:/i,
        /^metadata\.google\.internal$/i,
    ];
    if (privatePatterns.some(re => re.test(host))) {
        throw new Error("不允许访问内网或元数据地址。");
    }
    return u;
}
