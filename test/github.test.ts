// github.test.ts — src/sync/github.ts 覆盖
// 重点：404 分支（仓库自动创建 / 文件不存在走新建）——此前因 fetchWithRetry 抛普通 Error 而完全不可达
import { describe, it, expect, vi, afterEach } from "vitest";
import {
    ensureRepoExists,
    getCurrentGitHubContent,
    updateFileOnGitHub,
    readFileForSubscriber,
} from "../src/sync/github.ts";

afterEach(() => {
    vi.unstubAllGlobals();
});

/** 构造按 URL + method 分发的 fetch mock */
function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
    const spy = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
    vi.stubGlobal("fetch", spy);
    return spy;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ensureRepoExists", () => {
    it("repo already exists: skip creation request", async () => {
        const spy = mockFetch(() => json({ name: "test-repo" }));
        const logs: string[] = [];

        await ensureRepoExists("token", "owner", "test-repo", (m) => logs.push(m));

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe("https://api.github.com/repos/owner/test-repo");
        expect(logs.some((l) => l.includes("已存在"))).toBe(true);
    });

    it("repo 404: auto-create private repo", async () => {
        const spy = mockFetch((url) => {
            if (url === "https://api.github.com/repos/owner/new-repo") return json({ message: "Not Found" }, 404);
            if (url === "https://api.github.com/user/repos") return json({ name: "new-repo" }, 201);
            throw new Error(`未预期的 URL: ${url}`);
        });
        const logs: string[] = [];

        await ensureRepoExists("token", "owner", "new-repo", (m) => logs.push(m));

        // 关键断言：确实发出了创建请求（此前该分支不可达）
        const createCall = spy.mock.calls.find((c) => c[0] === "https://api.github.com/user/repos");
        expect(createCall).toBeDefined();
        expect(createCall![1]?.method).toBe("POST");
        expect(JSON.parse(createCall![1]!.body as string)).toMatchObject({ name: "new-repo", private: true });
        expect(logs.some((l) => l.includes("成功创建私有仓库"))).toBe(true);
    });

    it("non-404 error (e.g. 401) rethrows without attempting create", async () => {
        const spy = mockFetch(() => json({ message: "Bad credentials" }, 401));

        await expect(ensureRepoExists("bad-token", "owner", "repo", () => {})).rejects.toThrow(/401/);
        // 未发出创建请求
        expect(spy.mock.calls.some((c) => c[0] === "https://api.github.com/user/repos")).toBe(false);
    });
});

describe("getCurrentGitHubContent", () => {
    it("file exists: returns raw text content", async () => {
        mockFetch(() => new Response("1.1.1.1\n2.2.2.2", { status: 200 }));

        const content = await getCurrentGitHubContent({
            token: "token",
            owner: "owner",
            repo: "repo",
            path: "ips.txt",
            log: () => {},
        });

        expect(content).toBe("1.1.1.1\n2.2.2.2");
    });

    it("file 404: returns null and logs (proceeds to create)", async () => {
        mockFetch(() => json({ message: "Not Found" }, 404));
        const logs: string[] = [];

        const content = await getCurrentGitHubContent({
            token: "token",
            owner: "owner",
            repo: "repo",
            path: "missing.txt",
            log: (m) => logs.push(m),
        });

        expect(content).toBeNull();
        expect(logs.some((l) => l.includes("不存在") && l.includes("missing.txt"))).toBe(true);
    });

    it("non-404 errors like 403 rethrow", async () => {
        mockFetch(() => json({ message: "Forbidden" }, 403));

        await expect(
            getCurrentGitHubContent({
                token: "token",
                owner: "owner",
                repo: "repo",
                path: "x.txt",
                log: () => {},
            })
        ).rejects.toThrow(/403/);
    });
});

describe("updateFileOnGitHub", () => {
    it("existing file: commits update with sha", async () => {
        const spy = mockFetch((url, init) => {
            if (url === "https://api.github.com/repos/owner/repo") return json({ name: "repo" });
            if (init?.method === "PUT") return json({ commit: { sha: "new-sha" } });
            return json({ sha: "existing-sha" });
        });

        await updateFileOnGitHub({
            token: "token",
            owner: "owner",
            repo: "repo",
            path: "ips.txt",
            content: "1.1.1.1",
            message: "update ips",
            log: () => {},
        });

        const putCall = spy.mock.calls.find((c) => c[1]?.method === "PUT");
        expect(putCall).toBeDefined();
        const body = JSON.parse(putCall![1]!.body as string);
        expect(body.sha).toBe("existing-sha");
        expect(body.message).toBe("update ips");
    });

    it("new file (sha lookup 404): creates without sha field", async () => {
        const spy = mockFetch((url, init) => {
            if (url === "https://api.github.com/repos/owner/repo") return json({ name: "repo" });
            if (init?.method === "PUT") return json({ commit: { sha: "new-sha" } }, 201);
            // GET 取 sha → 文件不存在
            return json({ message: "Not Found" }, 404);
        });

        await updateFileOnGitHub({
            token: "token",
            owner: "owner",
            repo: "repo",
            path: "brand-new.txt",
            content: "1.1.1.1",
            message: "create",
            log: () => {},
        });

        // 关键断言：404 未冒泡，PUT 正常发出且 sha 为 undefined（此前该路径直接抛错）
        const putCall = spy.mock.calls.find((c) => c[1]?.method === "PUT");
        expect(putCall).toBeDefined();
        expect(JSON.parse(putCall![1]!.body as string).sha).toBeUndefined();
    });

    it("content is base64 encoded; UTF-8 Chinese round-trips correctly", async () => {
        const spy = mockFetch((url, init) => {
            if (url === "https://api.github.com/repos/owner/repo") return json({ name: "repo" });
            if (init?.method === "PUT") return json({});
            return json({ message: "Not Found" }, 404);
        });

        await updateFileOnGitHub({
            token: "token",
            owner: "owner",
            repo: "repo",
            path: "notes.txt",
            content: "优选 IP 列表",
            message: "msg",
            log: () => {},
        });

        const putCall = spy.mock.calls.find((c) => c[1]?.method === "PUT");
        const encoded = JSON.parse(putCall![1]!.body as string).content as string;
        expect(decodeURIComponent(escape(atob(encoded)))).toBe("优选 IP 列表");
    });

    it("large content (200KB) encodes without RangeError and round-trips", async () => {
        const spy = mockFetch((url, init) => {
            if (url === "https://api.github.com/repos/owner/repo") return json({ name: "repo" });
            if (init?.method === "PUT") return json({});
            return json({ message: "Not Found" }, 404);
        });

        // 200,000 字节远超 V8 spread 实参上限（约 65k）：旧实现 String.fromCharCode(...bytes) 必抛 RangeError
        const largeContent = "1.2.3.4\n".repeat(25000);
        await updateFileOnGitHub({
            token: "token",
            owner: "owner",
            repo: "repo",
            path: "big.txt",
            content: largeContent,
            message: "big",
            log: () => {},
        });

        const putCall = spy.mock.calls.find((c) => c[1]?.method === "PUT");
        expect(putCall).toBeDefined();
        const encoded = JSON.parse(putCall![1]!.body as string).content as string;
        expect(atob(encoded)).toBe(largeContent);
    });
});

// H-1 回归：Contents API 路径必须按段编码，owner / repo 必须走白名单校验
describe("GitHub API URL 构造与路径校验 (H-1)", () => {
    it("path 含空格与中文时按段 encodeURIComponent", async () => {
        const spy = mockFetch(() => new Response("1.1.1.1", { status: 200 }));

        await getCurrentGitHubContent({
            token: "token",
            owner: "owner",
            repo: "repo",
            path: "优选 IP/列表.txt",
            log: () => {},
        });

        expect(spy.mock.calls[0][0]).toBe(
            "https://api.github.com/repos/owner/repo/contents/%E4%BC%98%E9%80%89%20IP/%E5%88%97%E8%A1%A8.txt"
        );
    });

    it("path 中的 ? 与 # 被编码，不会改写查询串或片段", async () => {
        const spy = mockFetch((url, init) => {
            if (url === "https://api.github.com/repos/owner/repo") return json({ name: "repo" });
            if (init?.method === "PUT") return json({});
            return json({ message: "Not Found" }, 404);
        });

        await updateFileOnGitHub({
            token: "token",
            owner: "owner",
            repo: "repo",
            path: "a?b#c.txt",
            content: "x",
            message: "m",
            log: () => {},
        });

        const contentsCall = spy.mock.calls.find((c) => String(c[0]).includes("/contents/"));
        expect(contentsCall?.[0]).toBe("https://api.github.com/repos/owner/repo/contents/a%3Fb%23c.txt");
    });

    it("非法 owner / repo 直接拒绝，且不发出任何请求", async () => {
        for (const badOwner of ["../evil", "a/b", "a?b", "", "x".repeat(40)]) {
            const spy = mockFetch(() => json({ name: "repo" }));
            await expect(ensureRepoExists("token", badOwner, "repo", () => {})).rejects.toThrow(/GitHub owner/);
            expect(spy, `owner=${JSON.stringify(badOwner)} 不应触网`).not.toHaveBeenCalled();
        }

        const spy = mockFetch(() => json({ name: "repo" }));
        await expect(ensureRepoExists("token", "owner", "a/b", () => {})).rejects.toThrow(/GitHub repo/);
        expect(spy).not.toHaveBeenCalled();
    });

    it("绝对路径、.. 段、空段、反斜杠均被拒绝且不触网", async () => {
        for (const badPath of ["/etc/passwd", "a/../b.txt", "a//b.txt", "a\\b.txt"]) {
            const spy = mockFetch(() => new Response("x", { status: 200 }));
            await expect(
                getCurrentGitHubContent({
                    token: "token",
                    owner: "owner",
                    repo: "repo",
                    path: badPath,
                    log: () => {},
                })
            ).rejects.toThrow(/GitHub 文件路径/);
            expect(spy, `path=${JSON.stringify(badPath)} 不应触网`).not.toHaveBeenCalled();
        }
    });

    it("readFileForSubscriber 非法路径不读缓存也不触网", async () => {
        const cacheMatch = vi.fn(async () => undefined);
        const cachePut = vi.fn(async () => undefined);
        vi.stubGlobal("caches", { default: { match: cacheMatch, put: cachePut } });
        const spy = mockFetch(() => new Response("x", { status: 200 }));

        await expect(
            readFileForSubscriber({ token: "token", owner: "owner", repo: "repo" }, "../etc/passwd")
        ).rejects.toThrow(/GitHub 文件路径/);

        expect(cacheMatch).not.toHaveBeenCalled();
        expect(spy).not.toHaveBeenCalled();
    });
});
