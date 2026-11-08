// ip-sources-fetch.test.ts — D3 错误类别化 + IP 源抓取路径补测
// 覆盖：三策略错误路径聚合文案（HTTP 类别 / 超时类别）、回退顺序与 fetch_strategy 保持、
// 三网 HTML 表格解析（parseHtmlTableWithOperator 提成导出后直测）、describeFetchError 归一化。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
    fetchIpsFromSource,
    fetchThreeNetworkIps,
    parseHtmlTableWithOperator,
    describeFetchError,
} from "../src/sync/ip-sources.ts";
import { HttpError, TimeoutError } from "../src/util/http-error.ts";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const makeSource = (fetch_strategy = "direct_regex") => ({
    id: 1,
    url: "https://example.com/ips.txt",
    github_path: "ips.txt",
    commit_message: "update",
    fetch_strategy,
});

describe("策略层错误路径（D3 类别化）", () => {
    it("源返回 502 时，聚合文案带 HTTP 类别与各策略摘要", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("boom", { status: 502 }))
        );
        const err = await fetchIpsFromSource(makeSource()).then(
            () => {
                throw new Error("应当失败");
            },
            (e: unknown) => e as Error
        );
        expect(err.message).toContain("所有抓取策略均未能从该URL获取到IP");
        expect(err.message).toContain("HTTP 502");
        expect(err.message).toContain("direct_regex");
        expect(err.message).toContain("phantomjs_cloud");
        expect(err.message).toContain("proxy_codetabs");
    });

    it("全部策略超时（abort）时，聚合文案带超时类别", async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_url: string, init: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
                    })
            )
        );
        const pending = fetchIpsFromSource(makeSource());
        const assertion = expect(pending).rejects.toThrow("[超时]");
        // 三策略串行（15s/20s/15s），分多轮推进 fake 时钟逐个触发超时
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(20000);
        }
        await assertion;
    });

    it("fetchThreeNetworkIps 非 2xx 抛 HttpError（第四处裸抛类别化）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("x", { status: 500 }))
        );
        await expect(fetchThreeNetworkIps("wetest.vip", () => {})).rejects.toBeInstanceOf(HttpError);
    });
});

describe("回退顺序与策略字段", () => {
    it("回退按缓存策略优先 + 声明顺序尝试，全败时 fetch_strategy 保持原值", async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.startsWith("https://PhantomJsCloud.com")) {
                    calls.push("phantomjs_cloud");
                } else if (url.includes("api.codetabs.com")) {
                    calls.push("proxy_codetabs");
                } else {
                    calls.push("direct_regex");
                }
                return new Response("no ip", { status: 503 });
            })
        );
        const source = makeSource("phantomjs_cloud");
        await expect(fetchIpsFromSource(source)).rejects.toThrow("所有抓取策略均未能从该URL获取到IP");
        expect(calls).toEqual(["phantomjs_cloud", "direct_regex", "proxy_codetabs"]);
        expect(source.fetch_strategy).toBe("phantomjs_cloud");
    });
});

describe("parseHtmlTableWithOperator（提成导出后直测）", () => {
    it("按运营商分类三网 IP 并去重", async () => {
        const html = [
            "<table>",
            "<tr><td>1.1.1.1</td><td>移动</td></tr>",
            "<tr><td>1.1.1.1</td><td>移动</td></tr>",
            "<tr><td>2.2.2.2</td><td>电信</td></tr>",
            "<tr><td>3.3.3.3</td><td>联通</td></tr>",
            "</table>",
        ].join("");
        const r = await parseHtmlTableWithOperator(html);
        expect(r.yd).toEqual(["1.1.1.1"]);
        expect(r.dx).toEqual(["2.2.2.2"]);
        expect(r.lt).toEqual(["3.3.3.3"]);
    });

    it("某运营商无 IP 时用全集回填", async () => {
        const html = "<tr><td>1.1.1.1</td><td>移动</td></tr><tr><td>2.2.2.2</td><td>电信</td></tr>";
        const r = await parseHtmlTableWithOperator(html);
        expect(r.yd).toEqual(["1.1.1.1"]);
        expect(r.dx).toEqual(["2.2.2.2"]);
        expect(r.lt).toEqual(["1.1.1.1", "2.2.2.2"]);
    });
});

describe("describeFetchError 归一化", () => {
    it("HttpError → HTTP <status>，TimeoutError → 超时，普通 Error → message 截断", () => {
        expect(describeFetchError(new HttpError(502, "HTTP 502: x"))).toBe("HTTP 502");
        expect(describeFetchError(new TimeoutError("请求超时"))).toBe("超时");
        expect(describeFetchError(new Error("boom"))).toBe("boom");
        expect(describeFetchError("字符串异常")).toBe("字符串异常");
        expect(describeFetchError(new Error("x".repeat(500))).length).toBeLessThanOrEqual(201);
    });
});
