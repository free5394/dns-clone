// fetch.test.ts — L-9：fetchWithTimeout / fetchWithRetry 的直接测试
// 这两支此前只被 sync 层间接覆盖，超时、退避与「哪些 4xx 不该重试」的分支没有断言。
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout, fetchWithRetry } from "../src/util/fetch.ts";
import { HttpError } from "../src/util/http-error.ts";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("fetchWithTimeout 超时包装", () => {
    it("成功时透传 URL 与 init，并注入 AbortSignal", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: RequestInit) => {
                calls.push({ url, init });
                return new Response("ok", { status: 200 });
            })
        );

        const response = await fetchWithTimeout("https://example.com/a.txt", { headers: { "X-Trace": "1" } }, 5000);

        expect(response.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://example.com/a.txt");
        expect((calls[0].init.headers as Record<string, string>)["X-Trace"]).toBe("1");
        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it("超时后 abort 信号，且不残留定时器", async () => {
        vi.useFakeTimers();
        let observedSignal: AbortSignal | undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_url: string, init: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        observedSignal = init.signal as AbortSignal;
                        observedSignal.addEventListener("abort", () => reject(new Error("aborted by timeout")));
                    })
            )
        );

        const pending = fetchWithTimeout("https://example.com/slow", {}, 1000);
        const assertion = expect(pending).rejects.toThrow("aborted by timeout");
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;

        expect(observedSignal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("请求立即完成时清掉超时定时器", async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("ok", { status: 200 }))
        );

        await fetchWithTimeout("https://example.com/fast", {}, 10000);

        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("fetchWithRetry 重试策略", () => {
    it("2xx 直接返回，不重试", async () => {
        const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        const response = await fetchWithRetry("https://example.com/ok", {}, 2, 1000);

        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("404 属客户端错误，立即抛 HttpError 且只请求一次", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
        vi.stubGlobal("fetch", fetchMock);

        const pending = fetchWithRetry("https://example.com/missing", {}, 2, 1000);
        const assertion = expect(pending).rejects.toBeInstanceOf(HttpError);
        await assertion;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("5xx 按指数退避重试到上限，最终抛 HttpError", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
        vi.stubGlobal("fetch", fetchMock);

        const pending = fetchWithRetry("https://example.com/500", {}, 2, 1000);
        const assertion = expect(pending).rejects.toBeInstanceOf(HttpError);
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);
        await assertion;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        await expect(pending).rejects.toMatchObject({ status: 500 });
    });

    it("429 与 408 会重试，而不是当客户端错误直接抛出", async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
            .mockResolvedValueOnce(new Response("ok", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        const pending = fetchWithRetry("https://example.com/429", {}, 1, 1000);
        await vi.advanceTimersByTimeAsync(1000);

        expect((await pending).status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("网络错误重试后抛出最后一次的错误", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => {
            throw new TypeError("network down");
        });
        vi.stubGlobal("fetch", fetchMock);

        const pending = fetchWithRetry("https://example.com/net", {}, 1, 1000);
        const assertion = expect(pending).rejects.toThrow("network down");
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("抛出的不是 Error 时包装为 Error，保留原始文案", async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(() => Promise.reject("字符串异常"));
        vi.stubGlobal("fetch", fetchMock);

        const pending = fetchWithRetry("https://example.com/string", {}, 0, 1000);
        const assertion = expect(pending).rejects.toThrow("字符串异常");
        await assertion;

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
