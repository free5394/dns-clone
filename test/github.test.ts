// github.test.ts — src/sync/github.ts 覆盖
// 重点：404 分支（仓库自动创建 / 文件不存在走新建）——此前因 fetchWithRetry 抛普通 Error 而完全不可达
import { describe, it, expect, vi, afterEach } from "vitest";
import { ensureRepoExists, getCurrentGitHubContent, updateFileOnGitHub } from "../src/sync/github.ts";

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
            token: "token", owner: "owner", repo: "repo", path: "ips.txt", log: () => {},
        });

        expect(content).toBe("1.1.1.1\n2.2.2.2");
    });

    it("file 404: returns null and logs (proceeds to create)", async () => {
        mockFetch(() => json({ message: "Not Found" }, 404));
        const logs: string[] = [];

        const content = await getCurrentGitHubContent({
            token: "token", owner: "owner", repo: "repo", path: "missing.txt", log: (m) => logs.push(m),
        });

        expect(content).toBeNull();
        expect(logs.some((l) => l.includes("不存在") && l.includes("missing.txt"))).toBe(true);
    });

    it("non-404 errors like 403 rethrow", async () => {
        mockFetch(() => json({ message: "Forbidden" }, 403));

        await expect(getCurrentGitHubContent({
            token: "token", owner: "owner", repo: "repo", path: "x.txt", log: () => {},
        })).rejects.toThrow(/403/);
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
            token: "token", owner: "owner", repo: "repo", path: "ips.txt",
            content: "1.1.1.1", message: "update ips", log: () => {},
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
            token: "token", owner: "owner", repo: "repo", path: "brand-new.txt",
            content: "1.1.1.1", message: "create", log: () => {},
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
            token: "token", owner: "owner", repo: "repo", path: "notes.txt",
            content: "优选 IP 列表", message: "msg", log: () => {},
        });

        const putCall = spy.mock.calls.find((c) => c[1]?.method === "PUT");
        const encoded = JSON.parse(putCall![1]!.body as string).content as string;
        expect(decodeURIComponent(escape(atob(encoded)))).toBe("优选 IP 列表");
    });
});
