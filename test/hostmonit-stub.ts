// hostmonit-stub.ts — hostmonit 专用接口的共享 fetch stub
// 收口 api.test.ts / ip-sources-fetch.test.ts 中逐字重复的内联 stub
// （docs/fix-plan-fetch-strategy.md §1，评审报告气味基线 1）。
// 先例：test/ip-source-row.ts / test/domain-row.ts 的非 .test.ts 共享 helper，vitest 只收集 *.test.ts。
import { vi } from "vitest";

const HOSTMONIT_ENDPOINT = "api.hostmonit.com/get_optimization_ip";

export interface HostmonitStub {
    /** 被拦截的全部请求 URL（hostmonit 命中与 fallback 都记录） */
    calls: string[];
    /** 仅 hostmonit 专用接口的请求体原文（hostmonit key 写入语义用例使用） */
    bodies: string[];
    /** 把 fetch 还原到装本 stub 之前的值；api.test.ts 的 try/finally 依赖它 */
    restore: () => void;
}

/**
 * 只放行 hostmonit 专用接口：命中回 code:200 的 IP 列表响应，
 * 其余 URL 一律回 fallbackStatus（默认 403）——与被收口各用例的原行为一致。
 * 经 vi.stubGlobal 安装：ip-sources-fetch.test.ts 的 afterEach(vi.unstubAllGlobals) 可整批还原；
 * 需要精确还原的用例（api.test.ts 的 try/finally）调 restore()。
 */
export function stubHostmonitOnlyFetch(options: { ips?: string[]; fallbackStatus?: number } = {}): HostmonitStub {
    const ips = options.ips ?? ["172.67.172.3"];
    const fallbackStatus = options.fallbackStatus ?? 403;
    const calls: string[] = [];
    const bodies: string[] = [];
    const origFetch = globalThis.fetch;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push(url);
            if (url.includes(HOSTMONIT_ENDPOINT)) {
                bodies.push(String(init?.body ?? ""));
                return new Response(JSON.stringify({ code: 200, info: ips.map((ip) => ({ ip })) }), { status: 200 });
            }
            return new Response("forbidden", { status: fallbackStatus });
        })
    );
    return {
        calls,
        bodies,
        restore: () => {
            vi.stubGlobal("fetch", origFetch);
        },
    };
}
