// ip-parse.test.ts — issue #48：统一内容解析层与正则防护
import { describe, it, expect } from "vitest";
import {
    PARSE_MODES,
    DEFAULT_PARSE_MODE,
    MAX_JSON_PATH_LENGTH,
    MAX_REGEX_LENGTH,
    normalizeParseMode,
    validateParseConfig,
    isSafeRegexPattern,
    parseContent,
} from "../src/sync/ip-parse.ts";

describe("解析模式白名单", () => {
    it("暴露四种模式与默认值", () => {
        expect(PARSE_MODES).toEqual(["auto", "lines", "json_path", "custom_regex"]);
        expect(DEFAULT_PARSE_MODE).toBe("auto");
    });

    it("NULL、空串与空白按 auto 处理", () => {
        expect(normalizeParseMode(null)).toBe("auto");
        expect(normalizeParseMode(undefined)).toBe("auto");
        expect(normalizeParseMode("")).toBe("auto");
        expect(normalizeParseMode("   ")).toBe("auto");
    });

    it("已知模式原样返回，未知值回退 auto", () => {
        expect(normalizeParseMode("lines")).toBe("lines");
        expect(normalizeParseMode("json_path")).toBe("json_path");
        expect(normalizeParseMode("custom_regex")).toBe("custom_regex");
        expect(normalizeParseMode("regex")).toBe("auto");
        expect(normalizeParseMode(123)).toBe("auto");
    });
});

describe("解析配置校验", () => {
    it("auto 与 lines 不需要参数，传入的参数被归一为空", () => {
        expect(validateParseConfig(null, null)).toEqual({ ok: true, mode: "auto", param: null });
        expect(validateParseConfig("", "")).toEqual({ ok: true, mode: "auto", param: null });
        expect(validateParseConfig("lines", "残留路径")).toEqual({ ok: true, mode: "lines", param: null });
    });

    it("json_path 必须给出合法点路径", () => {
        expect(validateParseConfig("json_path", "data.ips")).toEqual({
            ok: true,
            mode: "json_path",
            param: "data.ips",
        });
        expect(validateParseConfig("json_path", "result.0.ip")).toEqual({
            ok: true,
            mode: "json_path",
            param: "result.0.ip",
        });
        expect(validateParseConfig("json_path", null).ok).toBe(false);
        expect(validateParseConfig("json_path", "").ok).toBe(false);
        expect(validateParseConfig("json_path", 123).ok).toBe(false);
        expect(validateParseConfig("json_path", `.${"a".repeat(10)}`).ok).toBe(false);
        expect(validateParseConfig("json_path", "data..ips").ok).toBe(false);
        expect(validateParseConfig("json_path", "data.ips.").ok).toBe(false);
        expect(validateParseConfig("json_path", "a".repeat(MAX_JSON_PATH_LENGTH + 1)).ok).toBe(false);
    });

    it("json_path 保存时去掉首尾空白", () => {
        expect(validateParseConfig("json_path", "  data.ips  ")).toEqual({
            ok: true,
            mode: "json_path",
            param: "data.ips",
        });
    });

    it("custom_regex 必须给出可构造且通过静态防护的正则", () => {
        expect(validateParseConfig("custom_regex", "(\\d{1,3}\\.){3}\\d{1,3}")).toEqual({
            ok: true,
            mode: "custom_regex",
            param: "(\\d{1,3}\\.){3}\\d{1,3}",
        });
        expect(validateParseConfig("custom_regex", "(?<ip>[0-9a-f:]{2,})").ok).toBe(true);
        expect(validateParseConfig("custom_regex", null).ok).toBe(false);
        expect(validateParseConfig("custom_regex", "").ok).toBe(false);
        expect(validateParseConfig("custom_regex", 42).ok).toBe(false);
        expect(validateParseConfig("custom_regex", "a".repeat(MAX_REGEX_LENGTH + 1)).ok).toBe(false);
    });

    it("高风险正则被拒绝", () => {
        expect(validateParseConfig("custom_regex", "(a+)+").ok).toBe(false);
        expect(validateParseConfig("custom_regex", "(a|a)*").ok).toBe(false);
    });

    it("无法构造的正则被拒绝", () => {
        expect(validateParseConfig("custom_regex", "(").ok).toBe(false);
        expect(validateParseConfig("custom_regex", "[a-").ok).toBe(false);
    });

    it("非法模式被拒绝", () => {
        expect(validateParseConfig("regex", null)).toEqual({
            ok: false,
            error: "解析模式非法：仅支持 auto、lines、json_path、custom_regex。",
        });
        expect(validateParseConfig(1, null).ok).toBe(false);
    });
});

describe("正则静态防护", () => {
    it("拒绝嵌套量词导致的指数回溯", () => {
        expect(isSafeRegexPattern("(a+)+")).toBe(false);
        expect(isSafeRegexPattern("(a*)*")).toBe(false);
        expect(isSafeRegexPattern("(\\d+){2,}")).toBe(false);
        expect(isSafeRegexPattern("((a+))+")).toBe(false);
        expect(isSafeRegexPattern("(?:a+)+")).toBe(false);
    });

    it("拒绝分支首字符重叠的量化交替", () => {
        expect(isSafeRegexPattern("(a|a)*")).toBe(false);
        expect(isSafeRegexPattern("(a|ab)+")).toBe(false);
        expect(isSafeRegexPattern("(\\d|1)+")).toBe(false);
        expect(isSafeRegexPattern("(a|.)*")).toBe(false);
        expect(isSafeRegexPattern("(.|b)+")).toBe(false);
        expect(isSafeRegexPattern("(a|.){2,}")).toBe(false);
        expect(isSafeRegexPattern("(a|b)*")).toBe(true);
    });

    it("常见安全模式不被误杀", () => {
        expect(isSafeRegexPattern("(\\d{1,3}\\.){3}\\d{1,3}")).toBe(true);
        expect(isSafeRegexPattern("(?<ip>[0-9a-f:]{2,})")).toBe(true);
        expect(isSafeRegexPattern("[\\w.-]+")).toBe(true);
        expect(isSafeRegexPattern("(\\d+|x)")).toBe(true);
    });

    it("括号不平衡视为不安全", () => {
        expect(isSafeRegexPattern("(a")).toBe(false);
        expect(isSafeRegexPattern("a)")).toBe(false);
    });
});

describe("auto 模式全文提取", () => {
    it("从 HTML 与纯文本中提取，并拒绝伪地址", () => {
        const html = `
            <ul>
                <li>节点 A：1.2.3.4</li>
                <li>节点 B：2001:db8::1</li>
                <li>噪声：1.2.3.256、1.2.3.4.5、999.1.1.1</li>
            </ul>
        `;
        expect(parseContent(html, "auto")).toEqual({
            ipv4: ["1.2.3.4"],
            ipv6: ["2001:db8::1"],
        });
    });

    it("JSON 正文按全文提取", () => {
        expect(parseContent('{"a":["10.0.0.1"],"b":"2001:DB8::2"}', null)).toEqual({
            ipv4: ["10.0.0.1"],
            ipv6: ["2001:db8::2"],
        });
    });

    it("结果去重并按类型排序", () => {
        expect(parseContent("10.0.0.10 10.0.0.9 10.0.0.10", "auto")).toEqual({
            ipv4: ["10.0.0.9", "10.0.0.10"],
            ipv6: [],
        });
    });

    it("IPv4-mapped 只计 IPv4，不重复进入 IPv6", () => {
        expect(parseContent("::ffff:192.0.2.1", "auto")).toEqual({
            ipv4: ["192.0.2.1"],
            ipv6: [],
        });
    });

    it("全零展开写法按未指定地址排除，不输出 ::", () => {
        expect(parseContent("0:0:0:0:0:0:0:0", "auto")).toEqual({ ipv4: [], ipv6: [] });
        expect(parseContent("节点 0:0:0:0:0:0:0:1", "auto")).toEqual({ ipv4: [], ipv6: ["::1"] });
    });

    it("空正文与无匹配返回空结果", () => {
        expect(parseContent("", "auto")).toEqual({ ipv4: [], ipv6: [] });
        expect(parseContent("没有任何地址", "auto")).toEqual({ ipv4: [], ipv6: [] });
    });

    it("非法模式返回空结果而不抛错", () => {
        expect(parseContent("1.2.3.4", "regex")).toEqual({ ipv4: [], ipv6: [] });
        expect(parseContent("1.2.3.4", "json_path", null)).toEqual({ ipv4: [], ipv6: [] });
    });
});

describe("lines 模式逐 token 校验", () => {
    it("按换行、逗号与空白切分", () => {
        const text = "1.2.3.4, 2001:db8::1\n5.6.7.8\t9.9.9.9";
        expect(parseContent(text, "lines")).toEqual({
            ipv4: ["1.2.3.4", "5.6.7.8", "9.9.9.9"],
            ipv6: ["2001:db8::1"],
        });
    });

    it("带标点或端口的 token 视为未匹配", () => {
        expect(parseContent("9.9.9.9;", "lines")).toEqual({ ipv4: [], ipv6: [] });
        expect(parseContent("1.2.3.4:8080", "lines")).toEqual({ ipv4: [], ipv6: [] });
    });

    it("可从 HTML 正文按空白切分，并拒绝伪地址", () => {
        const html = "<ul><li> 1.2.3.4 </li><li> 2001:db8::1 </li><li> 1.2.3.256 </li></ul>";
        expect(parseContent(html, "lines")).toEqual({ ipv4: ["1.2.3.4"], ipv6: ["2001:db8::1"] });
    });

    it("IPv4 数值升序，IPv6 规范化字典序", () => {
        const text = "2001:db8::10, 2001:db8::2, 10.0.0.10, 10.0.0.9";
        expect(parseContent(text, "lines")).toEqual({
            ipv4: ["10.0.0.9", "10.0.0.10"],
            ipv6: ["2001:db8::10", "2001:db8::2"],
        });
    });

    it("等价 IPv6 写法规范化后只保留一条", () => {
        const text = "2001:DB8::1 2001:db8:0:0:0:0:0:1";
        expect(parseContent(text, "lines")).toEqual({ ipv4: [], ipv6: ["2001:db8::1"] });
    });

    it("空正文返回空结果", () => {
        expect(parseContent("", "lines")).toEqual({ ipv4: [], ipv6: [] });
    });
});

describe("json_path 模式", () => {
    it("对象路径取字符串或字符串数组", () => {
        const body = '{"data":{"ips":["1.2.3.4","2001:db8::1","1.2.3.256"]}}';
        expect(parseContent(body, "json_path", "data.ips")).toEqual({
            ipv4: ["1.2.3.4"],
            ipv6: ["2001:db8::1"],
        });
        expect(parseContent('{"ip":"9.9.9.9"}', "json_path", "ip")).toEqual({
            ipv4: ["9.9.9.9"],
            ipv6: [],
        });
    });

    it("支持数组索引与根数组", () => {
        expect(parseContent('{"result":[{"ip":"5.6.7.8"}]}', "json_path", "result.0.ip")).toEqual({
            ipv4: ["5.6.7.8"],
            ipv6: [],
        });
        expect(parseContent('["10.0.0.1","2001:db8::2"]', "json_path", "0")).toEqual({
            ipv4: ["10.0.0.1"],
            ipv6: [],
        });
    });

    it("路径不存在、非 JSON 与原型属性都不抛错且返回空", () => {
        expect(parseContent('{"data":{"ips":[]}}', "json_path", "data.missing")).toEqual({
            ipv4: [],
            ipv6: [],
        });
        expect(parseContent("<html>1.2.3.4</html>", "json_path", "data")).toEqual({
            ipv4: [],
            ipv6: [],
        });
        expect(parseContent('{"a":1}', "json_path", "constructor")).toEqual({
            ipv4: [],
            ipv6: [],
        });
        expect(parseContent('{"a":1}', "json_path", "a.0.b")).toEqual({ ipv4: [], ipv6: [] });
    });

    it("非字符串值不参与解析", () => {
        expect(parseContent('{"ip":1234}', "json_path", "ip")).toEqual({ ipv4: [], ipv6: [] });
        expect(parseContent('{"ips":[{"ip":"1.2.3.4"}]}', "json_path", "ips")).toEqual({
            ipv4: [],
            ipv6: [],
        });
    });

    it("路径带首尾空白时按去空白后的路径取值", () => {
        expect(parseContent('{"data":{"ips":["1.2.3.4"]}}', "json_path", " data.ips ")).toEqual({
            ipv4: ["1.2.3.4"],
            ipv6: [],
        });
    });

    it("超过 512KB 的尾部内容被截断后再解析", () => {
        const body = `{"a":"${"x".repeat(600 * 1024)}","ip":"1.2.3.4"}`;
        expect(parseContent(body, "json_path", "ip")).toEqual({ ipv4: [], ipv6: [] });
    });
});

describe("custom_regex 模式", () => {
    it("优先使用命名组 ip", () => {
        const text = "v6=2001:db8::1;";
        expect(parseContent(text, "custom_regex", "(?<ip>[0-9a-f:]{2,})")).toEqual({
            ipv4: [],
            ipv6: ["2001:db8::1"],
        });
    });

    it("其次使用捕获组 1", () => {
        const text = "ip=1.2.3.4; ip=5.6.7.8;";
        expect(parseContent(text, "custom_regex", "ip=(\\d{1,3}(?:\\.\\d{1,3}){3})")).toEqual({
            ipv4: ["1.2.3.4", "5.6.7.8"],
            ipv6: [],
        });
    });

    it("没有捕获组或捕获值不是地址时不匹配", () => {
        expect(parseContent("1.2.3.4", "custom_regex", "\\d{1,3}(?:\\.\\d{1,3}){3}")).toEqual({
            ipv4: [],
            ipv6: [],
        });
        expect(parseContent("abc=", "custom_regex", "(\\w+)=")).toEqual({ ipv4: [], ipv6: [] });
    });

    it("捕获值同样经过严格校验", () => {
        expect(parseContent("ip=1.2.3.256", "custom_regex", "ip=(\\d{1,3}(?:\\.\\d{1,3}){3})")).toEqual({
            ipv4: [],
            ipv6: [],
        });
        expect(parseContent("<li>ip=1.2.3.256</li>", "custom_regex", "ip=(\\d{1,3}(?:\\.\\d{1,3}){3})")).toEqual({
            ipv4: [],
            ipv6: [],
        });
    });

    it("可从 HTML 正文中按模式取值", () => {
        const html = "<ul><li>ip=1.2.3.4</li><li>ip=5.6.7.8</li></ul>";
        expect(parseContent(html, "custom_regex", "ip=(\\d{1,3}(?:\\.\\d{1,3}){3})")).toEqual({
            ipv4: ["1.2.3.4", "5.6.7.8"],
            ipv6: [],
        });
    });

    it("高风险正则直接返回空结果而不抛错", () => {
        expect(parseContent("aaaaaaaaaaaaaaaa", "custom_regex", "(a+)+")).toEqual({
            ipv4: [],
            ipv6: [],
        });
    });
});

describe("运行期 512KB 截断", () => {
    it("超出上限的尾部地址不参与解析", () => {
        const text = `${"x".repeat(600 * 1024)} 1.2.3.4`;
        expect(parseContent(text, "lines")).toEqual({ ipv4: [], ipv6: [] });
        expect(parseContent(text, "auto")).toEqual({ ipv4: [], ipv6: [] });
        expect(parseContent(text, "custom_regex", "(1\\.2\\.3\\.4)")).toEqual({ ipv4: [], ipv6: [] });
    });

    it("上限内的地址正常提取", () => {
        const text = `1.2.3.4 ${"x".repeat(600 * 1024)}`;
        expect(parseContent(text, "auto")).toEqual({ ipv4: ["1.2.3.4"], ipv6: [] });
    });
});

describe("IPv4-mapped 在非 auto 模式下的口径", () => {
    it("lines 与 json_path 同样折算到 IPv4", () => {
        expect(parseContent("::ffff:192.0.2.1", "lines")).toEqual({
            ipv4: ["192.0.2.1"],
            ipv6: [],
        });
        expect(parseContent('{"ip":"::ffff:192.0.2.1"}', "json_path", "ip")).toEqual({
            ipv4: ["192.0.2.1"],
            ipv6: [],
        });
    });
});
