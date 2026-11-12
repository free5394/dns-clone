// ip-sources-fetch.test.ts — D3 错误类别化 + IP 源抓取路径补测
// 覆盖：三策略错误路径聚合文案（HTTP 类别 / 超时类别）、回退顺序与 fetch_strategy 保持、
// 三网 HTML 表格解析（parseHtmlTableWithOperator 提成导出后直测）、describeFetchError 归一化。
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
    DEFAULT_HOSTMONIT_API_KEY,
    FETCH_STRATEGIES,
    fetchIpsForTarget,
    fetchIpsFromSource,
    fetchIpsWithStrategy,
    fetchThreeNetworkIps,
    parseHtmlTableWithOperator,
    describeFetchError,
} from "../src/sync/ip-sources.ts";
import { HttpError, TimeoutError } from "../src/util/http-error.ts";
import { makeIpSourceRow, type IpSourceRow } from "./ip-source-row.ts";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/** 用例侧的简写：只关心抓取策略，其余字段取工厂默认值。 */
const makeSource = (fetch_strategy: IpSourceRow["fetch_strategy"] = "direct_regex") =>
    makeIpSourceRow({ fetch_strategy });

/**
 * 断言 promise 一定拒绝，并把拒绝值收窄成 Error。
 * 用 then 而非 catch：成功分支显式抛错后返回类型只剩 Error；catch 会保留成功值分支，
 * err.message 取不到。非 Error 拒绝值用 String() 兜底，避免 err.message 为 undefined 误导断言。
 */
function rejectionAsError(promise: Promise<unknown>): Promise<Error> {
    return promise.then(
        () => {
            throw new Error("应当失败");
        },
        (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
    );
}

describe("策略层错误路径（D3 类别化）", () => {
    it("源返回 502 时，聚合文案带 HTTP 类别与各策略摘要", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("boom", { status: 502 }))
        );
        const err = await rejectionAsError(fetchIpsFromSource(makeSource()));
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

    // issue #55：源站返回 200 但正文里没有 IP 属于「成功但 0 条」，IP 源链路（fetchIpsWithStrategy /
    // fetchIpsFromSource）据此返回空结果，交由同步层把主文件写成空内容并记 success，不再抛错。
    it("源返回 200 但页面无 IP 时返回空结果，不再抛 [无可用IP]（issue #55）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("<table><tbody></tbody></table>", { status: 200 }))
        );
        await expect(fetchIpsFromSource(makeSource())).resolves.toEqual([]);
    });

    // 同样的空正文，在「未显式要求 0 条当成功」的调用方（不传 emptyWhenNoIps）仍是错误：
    // 该分支保留诊断价值，逐策略标注谁没匹配到 IP，便于换源/换解析配置。
    it("不传 emptyWhenNoIps 时仍抛 [无可用IP] 并逐条标注未匹配", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("<table><tbody></tbody></table>", { status: 200 }))
        );
        const err = await rejectionAsError(fetchIpsForTarget(makeSource()));
        expect(err.message).toContain("[无可用IP]");
        expect(err.message).toContain("direct_regex: 未匹配到 IP");
        expect(err.message).toContain("phantomjs_cloud: 未匹配到 IP");
        expect(err.message).toContain("proxy_codetabs: 未匹配到 IP");
    });

    it("空结果与超时混合时，类别取真实错误，空结果策略仍出现在明细里", async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string, init: RequestInit) => {
                if (url.includes("api.codetabs.com")) {
                    return new Promise<Response>((_resolve, reject) => {
                        (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
                    });
                }
                return Promise.resolve(new Response("<table><tbody></tbody></table>", { status: 200 }));
            })
        );
        // 未传 emptyWhenNoIps（直调 target 层）时：空正文与抛错混合按真实错误类别收口
        const settled = rejectionAsError(fetchIpsForTarget(makeSource()));
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(20000);
        }
        const err = await settled;
        expect(err.message).toContain("[超时]");
        expect(err.message).toContain("direct_regex: 未匹配到 IP");
        expect(err.message).toContain("phantomjs_cloud: 未匹配到 IP");
        expect(err.message).toContain("proxy_codetabs: 超时");
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
                } else if (url.startsWith("https://r.jina.ai/")) {
                    calls.push("jina_reader");
                } else {
                    calls.push("direct_regex");
                }
                return new Response("no ip", { status: 503 });
            })
        );
        const source = makeSource("phantomjs_cloud");
        await expect(fetchIpsFromSource(source)).rejects.toThrow("所有抓取策略均未能从该URL获取到IP");
        // 策略链新增 jina_reader 后，回退顺序按声明顺序延展到它
        expect(calls).toEqual(["phantomjs_cloud", "direct_regex", "proxy_codetabs", "jina_reader"]);
        expect(source.fetch_strategy).toBe("phantomjs_cloud");
    });
});

describe("新增抓取策略（直连被拦 / SPA 渲染）", () => {
    it("hostmonit 源命中专用 API 策略，不依赖 phantomjs 配额", async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                calls.push(url);
                if (url.includes("api.hostmonit.com/get_optimization_ip")) {
                    return new Response(
                        JSON.stringify({ code: 200, info: [{ ip: "172.67.172.3" }, { ip: "198.41.208.168" }] }),
                        {
                            status: 200,
                        }
                    );
                }
                return new Response("forbidden", { status: 403 });
            })
        );
        const source = { ...makeSource("direct_regex"), url: "https://stock.hostmonit.com/CloudFlareYes" };
        const ips = await fetchIpsFromSource(source);
        expect(ips).toEqual(["172.67.172.3", "198.41.208.168"]);
        expect(source.fetch_strategy).toBe("hostmonit_api");
        expect(calls.some((u) => u.includes("api.hostmonit.com"))).toBe(true);
    });

    it("直连被 403 时 jina_reader 回退可读，并写回策略", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.startsWith("https://r.jina.ai/")) {
                    return new Response("Title: x\nMarkdown Content: 8.222.219.140 47.57.245.232", { status: 200 });
                }
                return new Response("forbidden", { status: 403 });
            })
        );
        const source = makeSource("direct_regex");
        const ips = await fetchIpsFromSource(source);
        expect(ips).toEqual(["8.222.219.140", "47.57.245.232"]);
        expect(source.fetch_strategy).toBe("jina_reader");
    });

    it("hostmonit 专用策略不会作用到其它 URL", async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                calls.push(url);
                return new Response("no ip", { status: 503 });
            })
        );
        await expect(fetchIpsFromSource(makeSource())).rejects.toThrow("所有抓取策略均未能从该URL获取到IP");
        expect(calls.some((u) => u.includes("api.hostmonit.com"))).toBe(false);
    });

    // issue #68：缓存策略原先不过适用性门控，hostmonit_api 会忽略传入 url 直接返回自己的列表，
    // 于是「别的站点 + 历史 hostmonit 策略」会把 A 站写成 B 站订阅内容且日志显示成功。
    it("已缓存的 hostmonit 策略遇到非 hostmonit URL 时不入链（issue #68）", async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                calls.push(url);
                if (url.includes("api.hostmonit.com/get_optimization_ip")) {
                    return new Response(JSON.stringify({ code: 200, info: [{ ip: "172.67.172.3" }] }), {
                        status: 200,
                    });
                }
                return new Response("forbidden", { status: 403 });
            })
        );
        const source = makeSource("hostmonit_api");
        await expect(fetchIpsFromSource(source)).rejects.toThrow("所有抓取策略均未能从该URL获取到IP");
        expect(calls.some((u) => u.includes("api.hostmonit.com"))).toBe(false);
        // 未命中就没有「回退成功」可写入，缓存策略保持原样，交由下一次写入或探测清理
        expect(source.fetch_strategy).toBe("hostmonit_api");
    });

    it("已缓存的 hostmonit 策略在 hostmonit URL 上仍然优先命中（回归不破）", async () => {
        const calls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                calls.push(url);
                if (url.includes("api.hostmonit.com/get_optimization_ip")) {
                    return new Response(JSON.stringify({ code: 200, info: [{ ip: "172.67.172.3" }] }), {
                        status: 200,
                    });
                }
                return new Response("forbidden", { status: 403 });
            })
        );
        const source = { ...makeSource("hostmonit_api"), url: "https://stock.hostmonit.com/CloudFlareYes" };
        const ips = await fetchIpsFromSource(source);
        expect(ips).toEqual(["172.67.172.3"]);
        expect(calls[0]).toContain("api.hostmonit.com");
        expect(source.fetch_strategy).toBe("hostmonit_api");
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

async function writeHostmonitKey(value: string | null): Promise<void> {
    if (value === null) {
        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'HOSTMONIT_API_KEY'").run();
        return;
    }
    await env.WUYA.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('HOSTMONIT_API_KEY', ?)")
        .bind(value)
        .run();
}

/** 只让 hostmonit 专用接口成功，并记录请求体里的 key */
function stubHostmonitFetch(): { bodies: string[] } {
    const bodies: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (url.includes("api.hostmonit.com/get_optimization_ip")) {
                bodies.push(String(init?.body ?? ""));
                return new Response(JSON.stringify({ code: 200, info: [{ ip: "172.67.172.3" }] }), { status: 200 });
            }
            return new Response("forbidden", { status: 403 });
        })
    );
    return { bodies };
}

describe("hostmonit 抓取 key 配置化 (issue #25)", () => {
    const hostmonitSource = () => ({
        ...makeSource("hostmonit_api"),
        url: "https://stock.hostmonit.com/CloudFlareYes",
    });

    afterEach(async () => {
        await writeHostmonitKey(null);
    });

    it("保存新值后，下一次抓取立即使用新 key（无需重启/重新部署）", async () => {
        await writeHostmonitKey("custom-hostmonit-key");
        const { bodies } = stubHostmonitFetch();

        await fetchIpsWithStrategy(hostmonitSource(), env.WUYA);

        expect(bodies).toHaveLength(1);
        expect(JSON.parse(bodies[0])).toEqual({ key: "custom-hostmonit-key" });
    });

    it("留空/未配置时沿用内置默认 key", async () => {
        await writeHostmonitKey(null);
        const { bodies } = stubHostmonitFetch();

        await fetchIpsWithStrategy(hostmonitSource(), env.WUYA);

        expect(JSON.parse(bodies[0])).toEqual({ key: DEFAULT_HOSTMONIT_API_KEY });
        expect(DEFAULT_HOSTMONIT_API_KEY).toBe("iDetkOys");
    });

    it("显式清除后回到内置默认 key", async () => {
        await writeHostmonitKey("temporary-key");
        await writeHostmonitKey(null);
        const { bodies } = stubHostmonitFetch();

        await fetchIpsWithStrategy(hostmonitSource(), env.WUYA);

        expect(JSON.parse(bodies[0])).toEqual({ key: DEFAULT_HOSTMONIT_API_KEY });
    });

    it("库里是空白字符串时也不把空 key 发出去", async () => {
        await writeHostmonitKey("   ");
        const { bodies } = stubHostmonitFetch();

        await fetchIpsWithStrategy(hostmonitSource(), env.WUYA);

        expect(JSON.parse(bodies[0])).toEqual({ key: DEFAULT_HOSTMONIT_API_KEY });
    });
});

// issue #50：抓取策略只返回正文，IPv4 / IPv6 由统一解析层按配置提取
describe("统一解析层接入 (issue #50)", () => {
    const parseSource = (mode: string | null, param: string | null = null) =>
        makeIpSourceRow({ parse_mode: mode, parse_param: param });

    it("策略层返回原始正文，不自行提取 IP", async () => {
        const body = "<html><body>1.1.1.1\n2606:4700:4700::1111</body></html>";
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status: 200 }))
        );

        const text = await FETCH_STRATEGIES.direct_regex("https://example.com/ips.txt");

        expect(text).toBe(body);
    });

    it("auto 模式同时解析出 IPv4 与 IPv6，各自排序去重", async () => {
        const body = ["3.3.3.3", "2606:4700:4700::1111", "1.1.1.1", "2001:db8::1", "3.3.3.3"].join("\n");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status: 200 }))
        );

        const result = await fetchIpsWithStrategy(parseSource("auto"));

        expect(result.ipv4).toEqual(["1.1.1.1", "3.3.3.3"]);
        expect(result.ipv6).toEqual(["2001:db8::1", "2606:4700:4700::1111"]);
        expect(result.strategy).toBe("direct_regex");
    });

    it("json_path 模式只取配置路径下的地址", async () => {
        const body = JSON.stringify({
            data: { ips: ["9.9.9.9", "2001:db8::1"] },
            other: ["8.8.4.4"],
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status: 200 }))
        );

        const result = await fetchIpsWithStrategy(parseSource("json_path", "data.ips"));

        expect(result.ipv4).toEqual(["9.9.9.9"]);
        expect(result.ipv6).toEqual(["2001:db8::1"]);
    });

    it("custom_regex 模式按捕获组提取", async () => {
        const body = ["IP=5.5.5.5", "IP=6.6.6.6", "TXT=7.7.7.7"].join("\n");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status: 200 }))
        );

        const result = await fetchIpsWithStrategy(parseSource("custom_regex", "IP=(\\d+\\.\\d+\\.\\d+\\.\\d+)"));

        expect(result.ipv4).toEqual(["5.5.5.5", "6.6.6.6"]);
        expect(result.ipv6).toEqual([]);
    });

    it("lines 模式按行严格校验，忽略夹杂文本", async () => {
        const body = ["9.9.9.9", "ip=1.2.3.4", "1.1.1.1"].join("\n");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status: 200 }))
        );

        const result = await fetchIpsWithStrategy(parseSource("lines"));

        expect(result.ipv4).toEqual(["1.1.1.1", "9.9.9.9"]);
        expect(result.ipv6).toEqual([]);
    });

    it("只有 IPv6 也算策略命中，不再回退到下一个策略", async () => {
        const fetchMock = vi.fn(async () => new Response("2606:4700:4700::1111", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        const result = await fetchIpsWithStrategy(parseSource("auto"));

        expect(result.ipv4).toEqual([]);
        expect(result.ipv6).toEqual(["2606:4700:4700::1111"]);
        expect(result.strategy).toBe("direct_regex");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("存量数据 parse_mode 为 NULL 时按 auto 解析", async () => {
        const body = ["1.1.1.1", "2606:4700:4700::1111"].join("\n");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(body, { status: 200 }))
        );

        const result = await fetchIpsWithStrategy(parseSource(null, null));

        expect(result.ipv4).toEqual(["1.1.1.1"]);
        expect(result.ipv6).toEqual(["2606:4700:4700::1111"]);
    });
});
