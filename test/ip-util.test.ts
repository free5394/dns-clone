// ip-util.test.ts — issue #47：共享 IPv4 / IPv6 校验与提取内核
import { describe, it, expect } from "vitest";
import {
    isValidIpv4,
    isValidIpv6,
    normalizeIpv6,
    extractIpv4,
    extractIpv6,
    sortIpv4,
    sortIpv6,
    truncatePerType,
    classifyIp,
    canonicalizeIpv6,
} from "../src/util/ip.ts";

describe("IPv4 严格校验", () => {
    it("接受四段且每段 0–255 的边界值", () => {
        expect(isValidIpv4("0.0.0.0")).toBe(true);
        expect(isValidIpv4("255.255.255.255")).toBe(true);
        expect(isValidIpv4("192.168.1.1")).toBe(true);
    });

    it("拒绝段值越界、段数错误与非数字段", () => {
        expect(isValidIpv4("256.0.0.1")).toBe(false);
        expect(isValidIpv4("999.1.1.1")).toBe(false);
        expect(isValidIpv4("1.2.3")).toBe(false);
        expect(isValidIpv4("1.2.3.4.5")).toBe(false);
        expect(isValidIpv4("1.2.3.-1")).toBe(false);
        expect(isValidIpv4("1.2.3.a")).toBe(false);
        expect(isValidIpv4("")).toBe(false);
    });
});

describe("IPv6 严格校验", () => {
    it("接受压缩形式、完整展开形式与方括号包裹", () => {
        expect(isValidIpv6("::1")).toBe(true);
        expect(isValidIpv6("::")).toBe(true);
        expect(isValidIpv6("2001:db8::1")).toBe(true);
        expect(isValidIpv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(true);
        expect(isValidIpv6("[2001:DB8::1]")).toBe(true);
        expect(isValidIpv6("::ffff:192.0.2.1")).toBe(true);
    });

    it("拒绝 zone id、压缩位越界与非法结构", () => {
        expect(isValidIpv6("fe80::1%eth0")).toBe(false);
        expect(isValidIpv6("1:2:3:4:5:6:7:8:9")).toBe(false);
        expect(isValidIpv6("1:2:3:4:5:6:7")).toBe(false);
        expect(isValidIpv6("2001:db8::1::2")).toBe(false);
        expect(isValidIpv6("1:2:3:4:5:6:7:8::")).toBe(false);
        expect(isValidIpv6("12345::1")).toBe(false);
        expect(isValidIpv6("::1.2.3.400")).toBe(false);
        expect(isValidIpv6("")).toBe(false);
    });

    it("拒绝代码片段里的伪地址", () => {
        expect(isValidIpv6("::before")).toBe(false);
        expect(isValidIpv6("arr[::2]")).toBe(false);
        expect(isValidIpv6("IP=::1")).toBe(false);
        expect(isValidIpv6("[::1]:8080")).toBe(false);
    });
});

describe("IPv6 归一化", () => {
    it("去方括号并转小写", () => {
        expect(normalizeIpv6("[2001:DB8::1]")).toBe("2001:db8::1");
        expect(normalizeIpv6("FE80::1")).toBe("fe80::1");
        expect(normalizeIpv6("[::1]")).toBe("::1");
    });

    it("对含 zone id 或非法形态返回 null", () => {
        expect(normalizeIpv6("fe80::1%eth0")).toBeNull();
        expect(normalizeIpv6("[::1]:8080")).toBeNull();
        expect(normalizeIpv6("1.2.3.4")).toBeNull();
    });
});

describe("IPv4 提取", () => {
    it("提取并严格过滤，按出现顺序去重", () => {
        const text = "a 1.2.3.4 b 255.255.255.255 c 999.1.1.1 d 1.2.3.4";
        expect(extractIpv4(text)).toEqual(["1.2.3.4", "255.255.255.255"]);
    });

    it("不从更长数字串或标识符里截出伪 IPv4", () => {
        expect(extractIpv4("1.2.3.4.5")).toEqual([]);
        expect(extractIpv4("1234.5.6.7")).toEqual([]);
        expect(extractIpv4("release v1.2.3.4")).toEqual([]);
    });
});

describe("IPv6 提取", () => {
    it("提取压缩形式与方括号字面量并归一", () => {
        expect(extractIpv6("2606:4700:4700::1111\n2606:4700:4700::1001")).toEqual([
            "2606:4700:4700::1111",
            "2606:4700:4700::1001",
        ]);
        expect(extractIpv6("访问 [2001:DB8::1] 即可")).toEqual(["2001:db8::1"]);
        expect(extractIpv6("dns is 2001:db8::1.")).toEqual(["2001:db8::1"]);
    });

    it("同一地址的大小写形态只计一次", () => {
        expect(extractIpv6("2001:DB8::1 2001:db8::1")).toEqual(["2001:db8::1"]);
    });

    it("不提取 HTML/CSS/代码片段里的伪地址", () => {
        expect(extractIpv6('<div class="::before">1.2.3.4</div>')).toEqual([]);
        expect(extractIpv6("arr[::2]")).toEqual([]);
        expect(extractIpv6("IP=::1")).toEqual([]);
        expect(extractIpv6("[::1]:8080")).toEqual([]);
        expect(extractIpv6("fe80::1%eth0")).toEqual([]);
        expect(extractIpv6("标题 :: 分隔")).toEqual([]);
    });

    it("IPv4-mapped 地址不重复计数", () => {
        const text = "1.2.3.4 与 ::ffff:1.2.3.4";
        expect(extractIpv4(text)).toEqual(["1.2.3.4"]);
        expect(extractIpv6(text)).toEqual([]);
    });
});

describe("排序与截断", () => {
    it("IPv4 按数值升序", () => {
        expect(sortIpv4(["10.0.0.1", "2.0.0.2", "9.255.255.255", "2.0.0.1"])).toEqual([
            "2.0.0.1",
            "2.0.0.2",
            "9.255.255.255",
            "10.0.0.1",
        ]);
    });

    it("IPv6 按归一后字典序", () => {
        expect(sortIpv6(["fe80::1", "2001:db8::1", "::1"])).toEqual(["2001:db8::1", "::1", "fe80::1"]);
    });

    it("按类型各自截断，两类互不影响", () => {
        const ips = {
            ipv4: ["1.1.1.1", "1.1.1.2", "1.1.1.3"],
            ipv6: ["::1", "::2", "::3"],
        };
        expect(truncatePerType(ips, 2)).toEqual({
            ipv4: ["1.1.1.1", "1.1.1.2"],
            ipv6: ["::1", "::2"],
        });
        expect(truncatePerType({ ipv4: ["1.1.1.1"], ipv6: [] }, 1)).toEqual({
            ipv4: ["1.1.1.1"],
            ipv6: [],
        });
    });
});

describe("IPv6 规范化", () => {
    it("压缩最长零段并统一小写", () => {
        expect(canonicalizeIpv6("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
        expect(canonicalizeIpv6("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe("2001:db8::ff00:42:8329");
    });

    it("单段零不压缩，首尾与全零边界正确", () => {
        expect(canonicalizeIpv6("::")).toBe("::");
        expect(canonicalizeIpv6("::1")).toBe("::1");
        expect(canonicalizeIpv6("2001:db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
    });

    it("非法形态返回 null", () => {
        expect(canonicalizeIpv6("1.2.3.4")).toBeNull();
        expect(canonicalizeIpv6("2001:db8::1%eth0")).toBeNull();
    });
});

describe("单 token 分类", () => {
    it("识别合法 IPv4 与 IPv6", () => {
        expect(classifyIp("192.168.1.1")).toEqual({ type: "ipv4", value: "192.168.1.1" });
        expect(classifyIp(" 2001:DB8::1 ")).toEqual({ type: "ipv6", value: "2001:db8::1" });
        expect(classifyIp("[::1]")).toEqual({ type: "ipv6", value: "::1" });
        expect(classifyIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toEqual({
            type: "ipv6",
            value: "2001:db8::1",
        });
    });

    it("拒绝宽松正则能匹配的伪地址", () => {
        expect(classifyIp("1.2.3.256")).toBeNull();
        expect(classifyIp("999.1.1.1")).toBeNull();
        expect(classifyIp("1.2.3.4.5")).toBeNull();
        expect(classifyIp("1.2.3.4:8080")).toBeNull();
        expect(classifyIp("2001:db8::1%eth0")).toBeNull();
        expect(classifyIp("::")).toBeNull();
        expect(classifyIp("not-an-ip")).toBeNull();
        expect(classifyIp("")).toBeNull();
    });

    it("IPv4-mapped 归 IPv4 侧；十六进制写法不虚构地址", () => {
        expect(classifyIp("::ffff:192.0.2.1")).toEqual({ type: "ipv4", value: "192.0.2.1" });
        expect(classifyIp("::ffff:c000:201")).toBeNull();
    });
});
