// ip-sources-fetch.test.ts — D3 错误类别化 + IP 源抓取路径补测
// 覆盖：三策略错误路径聚合文案（HTTP 类别 / 超时类别）、回退顺序与 fetch_strategy 保持、
// 三网 HTML 表格解析（parseHtmlTableWithOperator 提成导出后直测）、describeFetchError 归一化。
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
    DEFAULT_HOSTMONIT_API_KEY,
    fetchIpsFromSource,
    fetchIpsWithStrategy,
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

    it("源返回 200 但页面无 IP 时，聚合文案逐条标注未匹配，类别为无可用IP", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("<table><tbody></tbody></table>", { status: 200 }))
        );
        const err = await fetchIpsFromSource(makeSource()).then(
            () => {
                throw new Error("应当失败");
            },
            (e: unknown) => e as Error
        );
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
        const pending = fetchIpsFromSource(makeSource());
        const settled = pending.catch((e: unknown) => e as Error);
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
