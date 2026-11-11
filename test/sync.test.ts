// sync.test.ts — 用例 3/4：域名同步写回 D1 + IP 源多源回退 + 禁用源守卫
// 覆盖 plan v2 用例表：#3 syncDomainRecord 写回 D1、#4 fetchIpSource 多源回退
// 覆盖 fix-plan：#6 syncSingleIpSource 禁用源跳过
import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIpsFromSource, syncSingleIpSource } from "../src/sync/ip-sources.ts";
import { deriveCompanionPath } from "../src/sync/github.ts";
import {
    syncDomainLogic,
    syncSystemDomains,
    resolveRecordsForDomain,
    resolveRecursively,
    processInChunks,
    updateCloudflareDns,
    formatChangeComment,
    limitIpRecords,
} from "../src/sync/domains.ts";

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * 独立计算的期望备注：走 Intl 时区库（与既有 beijingTimeLog 同一机制），
 * 而不是复用被测实现的手工 UTC+8 平移——否则时区整体跑偏时两边一起错，测不出问题。
 */
function expectedChangeComment(now: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `DNS Clone 变更于 ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

describe("fetchIpsFromSource multi-source fallback", () => {
    it("uses the primary strategy successfully", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("3.3.3.3\n1.1.1.1\n2.2.2.2", { status: 200 }))
        );
        const ips = await fetchIpsFromSource({
            id: 1,
            url: "https://example.com/ips.txt",
            github_path: "ips.txt",
            commit_message: "update",
            fetch_strategy: "direct_regex",
        });
        // 排序后返回
        expect(ips).toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
    });

    // issue #55：IP 源侧「取得正文但 0 条」不再抛错，改为返回空数组，
    // 让同步层把主文件写成空内容并标 success（§13.1）；抛错语义只留给「全部策略抓取失败」。
    it("策略返回 0 条时返回空数组，不再抛错（issue #55）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("no ips here", { status: 200 }))
        );
        await expect(
            fetchIpsFromSource({
                id: 1,
                url: "https://example.com/empty.txt",
                github_path: "empty.txt",
                commit_message: "update",
                fetch_strategy: "direct_regex",
            })
        ).resolves.toEqual([]);
    });

    it("falls back to another strategy when primary fails", async () => {
        let callCount = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                callCount++;
                if (url.startsWith("https://PhantomJsCloud.com")) {
                    // 主策略（phantomjs_cloud）返回无 IP
                    return new Response("no ips here", { status: 200 });
                }
                // 回退策略（direct_regex）返回有 IP
                return new Response("10.0.0.1\n10.0.0.2", { status: 200 });
            })
        );
        const source = {
            id: 99,
            url: "https://example.com/ips.txt",
            github_path: "fallback-test.txt",
            commit_message: "update",
            fetch_strategy: "phantomjs_cloud",
        };
        const ips = await fetchIpsFromSource(source);
        expect(ips).toEqual(["10.0.0.1", "10.0.0.2"]);
        // fetchIpsFromSource 会就地更新 source.fetch_strategy
        expect(source.fetch_strategy).toBe("direct_regex");
        expect(callCount).toBeGreaterThan(1);
    });

    it("persists new strategy to db when fallback succeeds (db provided)", async () => {
        const uniquePath = `fallback-db-${crypto.randomUUID()}.txt`;
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind("https://fallback-db.example.com/ips.txt", uniquePath, "update", "phantomjs_cloud")
            .run();
        const row = (await env.WUYA.prepare("SELECT * FROM ip_sources WHERE github_path = ?")
            .bind(uniquePath)
            .first()) as {
            id: number;
            url: string;
            github_path: string;
            commit_message: string;
            fetch_strategy: string;
            is_enabled: number;
        };

        let callCount = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                callCount++;
                if (url.startsWith("https://PhantomJsCloud.com")) {
                    return new Response("no ips", { status: 200 });
                }
                return new Response("192.168.1.1\n192.168.1.2", { status: 200 });
            })
        );

        const ips = await fetchIpsFromSource(row, env.WUYA);
        expect(ips).toEqual(["192.168.1.1", "192.168.1.2"]);

        // 验证 DB 中策略已被更新
        const updated = (await env.WUYA.prepare("SELECT fetch_strategy FROM ip_sources WHERE id = ?")
            .bind(row.id)
            .first()) as { fetch_strategy: string };
        expect(updated.fetch_strategy).toBe("direct_regex");
        expect(callCount).toBeGreaterThan(1);

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(row.id).run();
    });

    it("filters out pseudo-IPv4 with octets > 255 (Suggestion ③)", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("300.1.1.1\n1.1.1.1\n999.999.999.999\n256.0.0.1", { status: 200 }))
        );
        const ips = await fetchIpsFromSource({
            id: 1,
            url: "https://example.com/mixed.txt",
            github_path: "mixed.txt",
            commit_message: "update",
            fetch_strategy: "direct_regex",
        });
        // 只有合法 IPv4 入选：越界段（999/300/256）不得发布给订阅器
        expect(ips).toEqual(["1.1.1.1"]);
    });
});

describe("syncDomainLogic writes back to D1", () => {
    it("upserts DNS records via Cloudflare API and marks success", async () => {
        // 配置 CF 凭据（syncDomainLogic 需要）
        await env.WUYA.batch([
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ).bind("test-cf-token"),
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ).bind("test-zone-id"),
        ]);

        // 种子域名（浅层克隆模式 → DoH CNAME 查询 → 写回 CF）
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system) VALUES (?, ?, ?, 0, 60, 'test', 0)"
        )
            .bind("origin.example.com", "clone.example.com", "test-zone-id")
            .run();

        // mock 外部 fetch：DoH 查询 + Cloudflare API 列表（返回空 → 需新增）
        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes("dns-query")) {
                return new Response(
                    JSON.stringify({
                        Answer: [{ data: "cname-target.example.com." }],
                    }),
                    { status: 200 }
                );
            }
            if (url.includes("api.cloudflare.com")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [],
                    }),
                    { status: 200 }
                );
            }
            throw new Error(`Unexpected URL: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const domain = (await env.WUYA.prepare(
            "SELECT * FROM domains WHERE target_domain = 'clone.example.com'"
        ).first()) as {
            id: number;
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
        };

        const log = () => {};
        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, log, {});

        // 验证写回 D1
        const updated = (await env.WUYA.prepare(
            "SELECT last_sync_status, last_synced_records FROM domains WHERE id = ?"
        )
            .bind(domain.id)
            .first()) as { last_sync_status: string; last_synced_records: string };
        expect(updated.last_sync_status).toBe("success");
        expect(JSON.parse(updated.last_synced_records)).toEqual([
            { type: "CNAME", content: "cname-target.example.com" },
        ]);

        // 验证 POST 调用了 Cloudflare API 新增记录
        const postCalls = fetchMock.mock.calls.filter(
            (c) => c[0].includes("api.cloudflare.com") && c[1]?.method === "POST"
        );
        expect(postCalls.length).toBe(1);
    });
});

describe("syncSingleIpSource (Task 2.1 is_enabled 守卫)", () => {
    it("throws when source is disabled", async () => {
        // 使用随机唯一 path 避免与 ensureInitialData 种子冲突
        const uniquePath = `disabled-${crypto.randomUUID()}.txt`;
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy, is_enabled) VALUES (?, ?, ?, ?, 0)"
        )
            .bind("https://disabled.example.com/ips.txt", uniquePath, "update", "direct_regex")
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind(uniquePath)
            .first()) as { id: number };

        // mock fetch：不应被调用（守卫应先抛错）
        const fetchSpy = vi.fn(async () => new Response("5.5.5.5", { status: 200 }));
        vi.stubGlobal("fetch", fetchSpy);

        await expect(syncSingleIpSource(row.id, env, false)).rejects.toThrow(/已被禁用/);
        // 确认 fetch 未被调用（GitHub API 完全跳过）
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws when source id does not exist", async () => {
        await expect(syncSingleIpSource(999999, env, false)).rejects.toThrow(/未找到|已被禁用/);
    });
});

// issue #22（P4）：成功日志必须写明本次实际生效的抓取策略；发生回退时写回退后的那个，
// 而不是配置里写的那个——否则管理员看到的"策略"与真实抓取链路不符。
describe("syncSingleIpSource 日志包含实际生效的抓取策略 (issue #22)", () => {
    async function seedGitHubSettings() {
        for (const [key, value] of [
            ["GITHUB_TOKEN", "test-token"],
            ["GITHUB_OWNER", "test-owner"],
            ["GITHUB_REPO", "test-repo"],
        ]) {
            await env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            )
                .bind(key, value)
                .run();
        }
    }

    /** GitHub 侧全部 mock 掉：仓库存在、文件不存在（404 → 新建）、PUT 成功。 */
    function stubFetch(ipResponseFor: (url: string) => Response | null) {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                if (url === "https://api.github.com/repos/test-owner/test-repo") {
                    return new Response("{}", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    if ((init?.method ?? "GET").toUpperCase() === "PUT") return new Response("{}", { status: 200 });
                    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                const ipResponse = ipResponseFor(url);
                if (ipResponse) return ipResponse;
                throw new Error(`未预期的请求: ${url}`);
            })
        );
    }

    async function insertSource(strategy: string | null, url: string) {
        const uniquePath = `strategy-log-${crypto.randomUUID()}.txt`;
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?)"
        )
            .bind(url, uniquePath, "update", strategy)
            .run();
        const row = (await env.WUYA.prepare("SELECT * FROM ip_sources WHERE github_path = ?")
            .bind(uniquePath)
            .first()) as { id: number };
        return row.id;
    }

    async function captureLogs(run: () => Promise<unknown>): Promise<string[]> {
        const logs: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
            logs.push(String(msg));
        });
        try {
            await run();
        } finally {
            spy.mockRestore();
        }
        return logs;
    }

    it("成功日志行带实际生效策略名", async () => {
        await seedGitHubSettings();
        const id = await insertSource("direct_regex", "https://example.com/ips.txt");
        stubFetch((url) => (url === "https://example.com/ips.txt" ? new Response("1.1.1.1\n2.2.2.2") : null));

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        const successLine = logs.find((line) => line.includes("成功获取"));
        expect(successLine).toBeDefined();
        expect(successLine).toContain("direct_regex");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("回退后日志显示回退后真正生效的策略", async () => {
        await seedGitHubSettings();
        const id = await insertSource("phantomjs_cloud", "https://example.com/fallback.txt");
        stubFetch((url) => {
            if (url.startsWith("https://PhantomJsCloud.com")) return new Response("no ips here");
            if (url === "https://example.com/fallback.txt") return new Response("10.0.0.1\n10.0.0.2");
            return null;
        });

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        const successLine = logs.find((line) => line.includes("成功获取"));
        expect(successLine).toBeDefined();
        // 写回退后真正生效的策略，并点明是从哪个策略退下来的
        expect(successLine).toContain("direct_regex");
        expect(successLine).toContain("phantomjs_cloud");

        const updated = (await env.WUYA.prepare("SELECT fetch_strategy FROM ip_sources WHERE id = ?")
            .bind(id)
            .first()) as { fetch_strategy: string };
        expect(updated.fetch_strategy).toBe("direct_regex");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("fetch_strategy 为 NULL 时只写实际策略，不打「已从 null 回退」", async () => {
        await seedGitHubSettings();
        // 列可空（迁移里 fetch_strategy 无 NOT NULL）：插入 NULL 模拟历史数据
        const id = await insertSource(null, "https://example.com/null-strategy.txt");
        stubFetch((url) => (url === "https://example.com/null-strategy.txt" ? new Response("9.9.9.9") : null));

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        const successLine = logs.find((line) => line.includes("成功获取"));
        // NULL 已在读取处归一为空串，fellBack 因此为 false：只写实际策略，不带回退说明
        expect(successLine).toMatch(/（抓取策略: direct_regex）/);
        expect(successLine).not.toContain("已从");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });
});

// issue #50：主文件只写 IPv4；仅解析到 IPv6 时写空主文件，伴生文件留给后续能力
describe("IP 源主文件语义 (issue #50)", () => {
    async function seedGitHubSettings() {
        for (const [key, value] of [
            ["GITHUB_TOKEN", "test-token"],
            ["GITHUB_OWNER", "test-owner"],
            ["GITHUB_REPO", "test-repo"],
        ]) {
            await env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            )
                .bind(key, value)
                .run();
        }
    }

    async function insertSource(url: string) {
        const githubPath = `ip-main-${crypto.randomUUID()}.txt`;
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy, parse_mode) VALUES (?, ?, ?, ?, ?)"
        )
            .bind(url, githubPath, "update", "direct_regex", "auto")
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind(githubPath)
            .first()) as {
            id: number;
        };
        return { id: row.id, githubPath };
    }

    async function syncState(id: number): Promise<{ status: string; error: string | null }> {
        const row = (await env.WUYA.prepare("SELECT last_sync_status, last_sync_error FROM ip_sources WHERE id = ?")
            .bind(id)
            .first()) as { last_sync_status: string; last_sync_error: string | null } | null;
        return { status: row?.last_sync_status ?? "", error: row?.last_sync_error ?? null };
    }

    async function lastSyncStatus(id: number): Promise<string> {
        return (await syncState(id)).status;
    }

    async function captureLogs(run: () => Promise<unknown>): Promise<string[]> {
        const logs: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
            logs.push(String(msg));
        });
        try {
            await run();
        } finally {
            spy.mockRestore();
        }
        return logs;
    }

    it("存量 IPv4 内容一致时逐字节不变，不发 PUT", async () => {
        await seedGitHubSettings();
        const { id, githubPath } = await insertSource("https://example.com/same.txt");
        const putBodies: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                if (url === "https://example.com/same.txt") {
                    return new Response("2.2.2.2\n1.1.1.1", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    if ((init?.method ?? "GET").toUpperCase() === "PUT") {
                        putBodies.push(String(init?.body ?? ""));
                        return new Response("{}", { status: 200 });
                    }
                    // 主文件线上就是排序后的同一内容；伴生文件远端不存在（#51 起仍要 GET 一次判断是否删除）
                    if (decodeURIComponent(url.split("/contents/")[1]) === githubPath) {
                        return new Response("1.1.1.1\n2.2.2.2", { status: 200 });
                    }
                    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        expect(putBodies).toHaveLength(0);
        expect(logs.some((line) => line.includes("无变化") || line.includes("内容一致"))).toBe(true);

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("仅解析到 IPv6 时主文件写空内容，IPv6 写入伴生文件", async () => {
        await seedGitHubSettings();
        const { id, githubPath } = await insertSource("https://example.com/v6.txt");
        const companionPath = deriveCompanionPath(githubPath);
        const puts: Array<{ path: string; body: string }> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                if (url === "https://example.com/v6.txt") {
                    return new Response("2606:4700:4700::1111", { status: 200 });
                }
                if (url === "https://api.github.com/repos/test-owner/test-repo") {
                    return new Response("{}", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    if ((init?.method ?? "GET").toUpperCase() === "PUT") {
                        puts.push({
                            path: decodeURIComponent(url.split("/contents/")[1]),
                            body: String(init?.body ?? ""),
                        });
                        return new Response("{}", { status: 200 });
                    }
                    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        // 主文件（空内容）+ 伴生文件（IPv6）各写一次
        expect(puts).toHaveLength(2);
        expect(puts[0].path).toBe(githubPath);
        expect((JSON.parse(puts[0].body) as { content: string }).content).toBe("");
        expect(puts[1].path).toBe(companionPath);
        expect(Buffer.from((JSON.parse(puts[1].body) as { content: string }).content, "base64").toString("utf8")).toBe(
            "2606:4700:4700::1111"
        );
        expect(logs.some((line) => line.includes("IPv6 伴生文件"))).toBe(true);

        expect(await lastSyncStatus(id)).toBe("success");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("IPv6 为空且远端存在伴生文件时删除，状态记 success", async () => {
        await seedGitHubSettings();
        const { id, githubPath } = await insertSource("https://example.com/drop-v6.txt");
        const companionPath = deriveCompanionPath(githubPath);
        const deleteCalls: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                const method = (init?.method ?? "GET").toUpperCase();
                if (url === "https://example.com/drop-v6.txt") {
                    return new Response("1.1.1.1", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
                    if (method === "DELETE") {
                        deleteCalls.push(path);
                        return new Response("{}", { status: 200 });
                    }
                    if (path === githubPath) {
                        // 主文件已是同样的 IPv4，不需要再写
                        return new Response("1.1.1.1", { status: 200 });
                    }
                    if (path === companionPath) {
                        return new Response(
                            JSON.stringify({
                                content: Buffer.from("2606:4700:4700::1111", "utf8").toString("base64"),
                                sha: "companion-sha",
                            }),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        );
                    }
                    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        expect(deleteCalls).toEqual([companionPath]);
        expect(logs.some((line) => line.includes("已删除 IPv6 伴生文件"))).toBe(true);

        expect(await lastSyncStatus(id)).toBe("success");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("IPv6 为空且远端无伴生文件时不发 DELETE，状态记 no_change", async () => {
        await seedGitHubSettings();
        const { id, githubPath } = await insertSource("https://example.com/none-v6.txt");
        const methods: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                const method = (init?.method ?? "GET").toUpperCase();
                if (url === "https://example.com/none-v6.txt") {
                    return new Response("1.1.1.1", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    methods.push(method);
                    const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
                    if (path === githubPath && method === "GET") {
                        return new Response("1.1.1.1", { status: 200 });
                    }
                    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        expect(methods).not.toContain("DELETE");
        expect(methods).not.toContain("PUT");
        expect(logs.some((line) => line.includes("跳过删除"))).toBe(true);

        expect(await lastSyncStatus(id)).toBe("no_change");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("伴生文件内容一致时不重复写入，但主文件更新仍记 success", async () => {
        await seedGitHubSettings();
        const { id, githubPath } = await insertSource("https://example.com/same-v6.txt");
        const companionPath = deriveCompanionPath(githubPath);
        const puts: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                const method = (init?.method ?? "GET").toUpperCase();
                if (url === "https://example.com/same-v6.txt") {
                    return new Response("1.1.1.1\n2606:4700:4700::1111", { status: 200 });
                }
                if (url === "https://api.github.com/repos/test-owner/test-repo") {
                    return new Response("{}", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
                    if (method === "PUT") {
                        puts.push(path);
                        return new Response("{}", { status: 200 });
                    }
                    // 同一个 URL 有两种 GET 语义：变更检测要 raw 正文，写前取 sha 要 JSON
                    const accept = String((init?.headers as Record<string, string> | undefined)?.["Accept"] ?? "");
                    if (accept.includes("raw")) {
                        if (path === githubPath) return new Response("9.9.9.9", { status: 200 });
                        if (path === companionPath) return new Response("2606:4700:4700::1111", { status: 200 });
                        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                    }
                    if (path === githubPath) {
                        return new Response(JSON.stringify({ sha: "main-sha" }), {
                            status: 200,
                            headers: { "Content-Type": "application/json" },
                        });
                    }
                    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        expect(puts).toEqual([githubPath]);
        expect(logs.some((line) => line.includes("IPv6 伴生文件内容无变化"))).toBe(true);

        expect(await lastSyncStatus(id)).toBe("success");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("伴生文件写入失败时整轮记 failed，下一轮按内容比对收敛 (issue #51)", async () => {
        await seedGitHubSettings();
        const { id, githubPath } = await insertSource("https://example.com/fail-v6.txt");
        const companionPath = deriveCompanionPath(githubPath);
        const puts: string[] = [];
        // 第一轮：主文件写成功、伴生文件 PUT 恒 500，同步应整轮失败
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                const method = (init?.method ?? "GET").toUpperCase();
                if (url === "https://example.com/fail-v6.txt") {
                    return new Response("2606:4700:4700::1111", { status: 200 });
                }
                if (url === "https://api.github.com/repos/test-owner/test-repo") {
                    return new Response("{}", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
                    if (method === "PUT") {
                        if (path === companionPath) {
                            return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
                        }
                        puts.push(path);
                        return new Response("{}", { status: 200 });
                    }
                    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        const logs = await captureLogs(async () => {
            await expect(syncSingleIpSource(id, env, false)).rejects.toThrow();
        });

        expect(logs.some((line) => line.includes("同步失败"))).toBe(true);
        const failed = await syncState(id);
        expect(failed.status).toBe("failed");
        expect(failed.error).toBeTruthy();

        // 第二轮：伴生文件已在远端存下同样的内容，主文件也一致 → 全链路无写入，状态收敛为 no_change
        expect(puts).toEqual([githubPath]);
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                if (url === "https://example.com/fail-v6.txt") {
                    return new Response("2606:4700:4700::1111", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
                    if (path === githubPath) return new Response("", { status: 200 });
                    if (path === companionPath) return new Response("2606:4700:4700::1111", { status: 200 });
                    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        await captureLogs(() => syncSingleIpSource(id, env, false));
        expect(await lastSyncStatus(id)).toBe("no_change");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });
});

// issue #55：GitHub 侧「成功但 0 条」按空内容处理并标 success —— 与「全部策略抛错」是两种语义。
// 这一组把方案 §15.1 要求的空结果行为钉死：能清空远端主文件，但绝不能把抓取失败也当成 0 条。
describe("IP 源空结果语义 (issue #55)", () => {
    async function seedGitHubSettings() {
        for (const [key, value] of [
            ["GITHUB_TOKEN", "test-token"],
            ["GITHUB_OWNER", "test-owner"],
            ["GITHUB_REPO", "test-repo"],
        ]) {
            await env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            )
                .bind(key, value)
                .run();
        }
    }

    // presetError：预置上一轮的非空 last_sync_error，用来真正验证「本轮成功后错误被清空」（AC1）
    async function insertSource(url: string, presetError?: string) {
        const githubPath = `ip-empty-${crypto.randomUUID()}.txt`;
        await env.WUYA.prepare(
            "INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy, parse_mode, last_sync_status, last_sync_error) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
            .bind(url, githubPath, "update", "direct_regex", "auto", presetError ? "failed" : null, presetError ?? null)
            .run();
        const row = (await env.WUYA.prepare("SELECT id FROM ip_sources WHERE github_path = ?")
            .bind(githubPath)
            .first()) as { id: number };
        return { id: row.id, githubPath };
    }

    async function syncState(id: number): Promise<{ status: string; error: string | null }> {
        const row = (await env.WUYA.prepare("SELECT last_sync_status, last_sync_error FROM ip_sources WHERE id = ?")
            .bind(id)
            .first()) as { last_sync_status: string; last_sync_error: string | null } | null;
        return { status: row?.last_sync_status ?? "", error: row?.last_sync_error ?? null };
    }

    async function captureLogs(run: () => Promise<unknown>): Promise<string[]> {
        const logs: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
            logs.push(String(msg));
        });
        try {
            await run();
        } finally {
            spy.mockRestore();
        }
        return logs;
    }

    it("三策略都返回 200 空正文：主文件写空内容并标 success", async () => {
        await seedGitHubSettings();
        // 上一轮失败过：本轮成功后 last_sync_error 必须被清空，不能留着陈旧错误
        const { id, githubPath } = await insertSource(
            "https://example.com/empty.txt",
            "上一轮: 所有抓取策略均未能从该URL获取到IP"
        );
        const puts: Array<{ path: string; content: string }> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                const method = (init?.method ?? "GET").toUpperCase();
                // 三个抓取策略（含 phantomjs / codetabs / jina）一律 200 空正文
                if (
                    url.startsWith("https://example.com/") ||
                    url.includes("codetabs") ||
                    url.includes("r.jina.ai") ||
                    url.startsWith("https://PhantomJsCloud.com")
                ) {
                    return new Response("<table><tbody></tbody></table>", { status: 200 });
                }
                if (url === "https://api.github.com/repos/test-owner/test-repo") {
                    return new Response("{}", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
                    if (method === "PUT") {
                        const body = JSON.parse(String(init?.body ?? "{}")) as { content: string };
                        puts.push({ path, content: Buffer.from(body.content, "base64").toString("utf8") });
                        return new Response("{}", { status: 200 });
                    }
                    // 同一个 URL 的两种 GET：变更检测要 raw 正文，写前取 sha 要 JSON
                    const accept = String((init?.headers as Record<string, string> | undefined)?.["Accept"] ?? "");
                    if (accept.includes("raw")) {
                        return path === githubPath
                            ? new Response("9.9.9.9", { status: 200 })
                            : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                    }
                    return path === githubPath
                        ? new Response(JSON.stringify({ sha: "main-sha" }), {
                              status: 200,
                              headers: { "Content-Type": "application/json" },
                          })
                        : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        await captureLogs(() => syncSingleIpSource(id, env, false));

        // 远端主文件原为 9.9.9.9，本轮写成空内容（§13.1 / §17.1 风险 7 已确认允许清空）
        expect(puts).toContainEqual({ path: githubPath, content: "" });
        expect(puts).toHaveLength(1);
        const state = await syncState(id);
        expect(state.status).toBe("success");
        expect(state.error).toBeNull();

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    // 验收 #55-②「纯 IPv6 → 主文件空 + 伴生写入 + success」由「IP 源主文件语义 (issue #50)」的
    // 「仅解析到 IPv6 时主文件写空内容，IPv6 写入伴生文件」用例覆盖（test/sync.test.ts:477），
    // 同一行为不在此重复一份——重复用例只会让一处断言漂移时两处都要改。

    it("全部策略抛错仍是 failed，错误文案保留类别前缀与逐策略摘要", async () => {
        await seedGitHubSettings();
        const { id } = await insertSource("https://example.com/boom.txt");
        const methods: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                const method = (init?.method ?? "GET").toUpperCase();
                if (url.startsWith("https://api.github.com/")) {
                    methods.push(method);
                    return new Response("{}", { status: 200 });
                }
                // 所有策略都失败：既没有拿到正文，也就不是「成功但 0 条」
                return new Response("boom", { status: 502 });
            })
        );

        await captureLogs(async () => {
            await expect(syncSingleIpSource(id, env, false)).rejects.toThrow(/所有抓取策略均未能从该URL获取到IP/);
        });

        const state = await syncState(id);
        expect(state.status).toBe("failed");
        expect(state.error).toContain("[HTTP 502]");
        expect(state.error).toContain("direct_regex");
        expect(state.error).toContain("phantomjs_cloud");
        // 抓取阶段就失败，根本不该发出任何 GitHub 写请求
        expect(methods).not.toContain("PUT");
        expect(methods).not.toContain("DELETE");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("混合情形（部分抛错 + 部分空正文）算「成功但 0 条」，会清空远端主文件", async () => {
        // 语义裁决（issue #55）：只要有一条策略成功取到正文却没解析出 IP，就按「成功但 0 条」处理，
        // 哪怕其它策略抛过错。注意：这条路径会把远端主文件写成空内容 —— 这是已确认接受的清空行为，
        // 不是 bug；想改成「失败优先」必须先改 fetchIpsForTarget 的分支口径并同步 DNS 侧。
        await seedGitHubSettings();
        const { id, githubPath } = await insertSource("https://example.com/mixed.txt");
        const puts: Array<{ path: string; content: string }> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                const method = (init?.method ?? "GET").toUpperCase();
                if (url === "https://example.com/mixed.txt") {
                    // 主策略拿到正文但页面无 IP
                    return new Response("no ips here", { status: 200 });
                }
                if (
                    url.startsWith("https://PhantomJsCloud.com") ||
                    url.includes("codetabs") ||
                    url.includes("r.jina.ai")
                ) {
                    return new Response("boom", { status: 502 });
                }
                if (url === "https://api.github.com/repos/test-owner/test-repo") {
                    return new Response("{}", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
                    if (method === "PUT") {
                        const body = JSON.parse(String(init?.body ?? "{}")) as { content: string };
                        puts.push({ path, content: Buffer.from(body.content, "base64").toString("utf8") });
                        return new Response("{}", { status: 200 });
                    }
                    const accept = String((init?.headers as Record<string, string> | undefined)?.["Accept"] ?? "");
                    if (accept.includes("raw")) {
                        return path === githubPath
                            ? new Response("1.1.1.1", { status: 200 })
                            : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                    }
                    return path === githubPath
                        ? new Response(JSON.stringify({ sha: "main-sha" }), {
                              status: 200,
                              headers: { "Content-Type": "application/json" },
                          })
                        : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        await captureLogs(() => syncSingleIpSource(id, env, false));

        expect(puts).toEqual([{ path: githubPath, content: "" }]);
        expect((await syncState(id)).status).toBe("success");

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });

    it("0 条时同步日志不出现空策略占位，也不误报回退", async () => {
        await seedGitHubSettings();
        const { id } = await insertSource("https://example.com/empty-log.txt");
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: unknown, init?: RequestInit) => {
                const url = String(typeof input === "string" ? input : (input as Request).url);
                const method = (init?.method ?? "GET").toUpperCase();
                if (url === "https://example.com/empty-log.txt") return new Response("no ips", { status: 200 });
                if (
                    url.startsWith("https://PhantomJsCloud.com") ||
                    url.includes("codetabs") ||
                    url.includes("r.jina.ai")
                ) {
                    return new Response("no ips", { status: 200 });
                }
                if (url === "https://api.github.com/repos/test-owner/test-repo") {
                    return new Response("{}", { status: 200 });
                }
                if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/contents/")) {
                    return method === "GET"
                        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
                        : new Response("{}", { status: 200 });
                }
                throw new Error(`未预期的请求: ${url}`);
            })
        );

        const logs = await captureLogs(() => syncSingleIpSource(id, env, false));

        const countLine = logs.find((line) => line.includes("成功获取"));
        expect(countLine).toBeDefined();
        // 0 个 IPv4 / 0 个 IPv6 仍是可读的成功行，但不许拼出「（抓取策略: ）」这种空占位
        expect(countLine).not.toContain("抓取策略");
        expect(countLine).not.toContain("已从");
        expect(countLine).toContain("0 个IPv4");
        // 0 条时必须有一句人话说明主文件被按空内容处理，避免管理员把「0 个」当成抓取坏了
        expect(logs.some((line) => line.includes("主文件按空内容处理"))).toBe(true);

        await env.WUYA.prepare("DELETE FROM ip_sources WHERE id = ?").bind(id).run();
    });
});

describe("syncSystemDomains (FIX-02: 错误日志替代静默)", () => {
    it("syncDomainLogic throw: D1 writes failed status, log identifies failing domain", async () => {
        // 插入一个启用系统域名，source_domain 设为 internal:hostmonit:CM
        // last_synced_records 设为非空：模拟"上次曾成功同步过"，这样上游失败返回 [] 时
        // 走 syncDomainLogic 的 lastRecords.length > 0 分支 → 抛"上次曾有记录" → D1 写入 failed
        // （FIX-15 后上游空 IP 不再崩溃，但与"上次成功"矛盾时仍应被标 failed）
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, last_synced_records, is_system, is_enabled) VALUES (?, ?, ?, ?, ?, 1, 1)"
        )
            .bind(
                "internal:hostmonit:CM",
                "sys-catch-test.example.com",
                "test-zone-id",
                0,
                JSON.stringify([{ type: "A", content: "1.2.3.4" }])
            )
            .run();

        // 让 fetch 抛错（无论谁尝试访问网络都会失败）—— 三网源获取失败 → resolveRecordsForDomain 返回 []
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("network boom");
            })
        );

        await syncSystemDomains(env, false);

        // FIX-02 验证点 1：D1 中应记录 failed 状态（syncDomainLogic 内 catch 写入）
        const row = (await env.WUYA.prepare(
            "SELECT last_sync_status, last_sync_error FROM domains WHERE target_domain = ?"
        )
            .bind("sys-catch-test.example.com")
            .first()) as { last_sync_status: string; last_sync_error: string } | null;

        expect(row).not.toBeNull();
        expect(row!.last_sync_status).toBe("failed");
        // 错误信息非空（含失败的同步上下文错误）
        expect(row!.last_sync_error).toBeTruthy();

        // FIX-02 验证点 2：syncSystemDomains 不因单个 domain 失败而整体 reject
        // 验证通过：上面 await 正常返回即为整体通过

        // 清理
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind("sys-catch-test.example.com").run();
    });
});

describe("syncDomainLogic JSON 兜底 (FIX-03)", () => {
    it("corrupt last_synced_records JSON: no SyntaxError, treated as empty array", async () => {
        // 插入一个上次记录被破坏的 domain
        // is_deep_resolve=1 + 不存在源 → DoH 返回空 → recordsToUpdate.length === 0
        // → 进入 lastRecords 分支 → JSON.parse('{broken-json') 损坏 → 期望 catch 兜底
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, last_synced_records, is_enabled) VALUES (?, ?, ?, 1, ?, 1)"
        )
            .bind("nonexistent-source.invalid", "json-corrupt.example.com", "test-zone-id", "{broken-json")
            .run();

        // stub fetch：所有 DoH 查询返回空 Answer
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("cloudflare-dns.com")) {
                    return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
                }
                return new Response("{}", { status: 200 });
            })
        );

        const row = (await env.WUYA.prepare("SELECT * FROM domains WHERE target_domain = ?")
            .bind("json-corrupt.example.com")
            .first()) as {
            id: number;
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
        };

        const logs: string[] = [];
        const log = (m: string) => {
            logs.push(m);
        };

        // 不应抛 SyntaxError
        await expect(syncDomainLogic(row, "test-cf-token", "test-zone-id", env.WUYA, log, {})).resolves.toBeUndefined();

        // 关键断言：日志中含"字段损坏"
        expect(logs.some((l) => l.includes("字段损坏"))).toBe(true);

        // 验证 D1 中 last_sync_status='no_change'（按空数组处理后走内容一致路径）
        const updated = (await env.WUYA.prepare("SELECT last_sync_status FROM domains WHERE id = ?")
            .bind(row.id)
            .first()) as { last_sync_status: string };
        expect(updated.last_sync_status).toBe("no_change");

        // 清理
        await env.WUYA.prepare("DELETE FROM domains WHERE target_domain = ?").bind("json-corrupt.example.com").run();
    });
});

describe("resolveRecordsForDomain (FIX-14)", () => {
    it("浅层克隆分支：源不是 CNAME 时抛错", async () => {
        // 使用 is_deep_resolve=0 + 源无 CNAME → 期望抛"必须是一个CNAME记录"
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("cloudflare-dns.com")) {
                    return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
                }
                return new Response("{}", { status: 200 });
            })
        );

        const domain: {
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
            id: number;
        } = {
            id: 999,
            source_domain: "no-cname-source.invalid",
            target_domain: "x.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 0,
        };

        await expect(resolveRecordsForDomain(domain, env.WUYA, () => {}, {})).rejects.toThrow(/必须是一个CNAME记录/);
    });

    it("internal:hostmonit:* 上下文命中缓存时不重复 fetch", async () => {
        // 预填 syncContext.threeNetworkIps 让快速路径生效
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("fetch should not be called when context cache hits");
            })
        );

        const domain: {
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
            id: number;
        } = {
            id: 999,
            source_domain: "internal:hostmonit:yd",
            target_domain: "x.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 1,
        };
        const syncContext: Record<string, unknown> = {
            threeNetworkIps: { yd: ["1.1.1.1"], dx: ["2.2.2.2"], lt: ["3.3.3.3"], source: "CloudFlareYes" },
        };
        const records = await resolveRecordsForDomain(domain, env.WUYA, () => {}, syncContext);
        expect(records).toEqual([{ type: "A", content: "1.1.1.1" }]);
    });

    it("internal:hostmonit:* 上游源返回 0 IP 时不崩溃，返回空数组（FIX-15）", async () => {
        // hostmonit HTML 表格无 <tr> → 解析得到空三网集合 → 触发 delete cache 分支
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("<html><body><table></table></body></html>", { status: 200 }))
        );

        const domain: {
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
            id: number;
        } = {
            id: 999,
            source_domain: "internal:hostmonit:yd",
            target_domain: "x.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 1,
        };

        const records = await resolveRecordsForDomain(domain, env.WUYA, () => {}, {});
        expect(records).toEqual([]);
    });

    it("internal:hostmonit:* fetch 抛错时保留上次成功缓存（FIX-16）", async () => {
        // 预填 syncContext.threeNetworkIps（模拟"上一次同步成功"），
        // 再让 fetch 抛错 → 期望不 delete 缓存，仍能返回旧 IP
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("network boom");
            })
        );

        const domain: {
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
            id: number;
        } = {
            id: 999,
            source_domain: "internal:hostmonit:yd",
            target_domain: "x.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 1,
        };

        const syncContext: Record<string, unknown> = {
            threeNetworkIps: { yd: ["9.9.9.9"], dx: ["8.8.8.8"], lt: ["7.7.7.7"], source: "CloudFlareYes" },
        };

        const records = await resolveRecordsForDomain(domain, env.WUYA, () => {}, syncContext);
        expect(records).toEqual([{ type: "A", content: "9.9.9.9" }]);
    });

    it("internal:hostmonit:* fetch 抛错且无旧缓存时向上抛错（FIX-16）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("network boom");
            })
        );

        const domain: {
            source_domain: string;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
            id: number;
        } = {
            id: 999,
            source_domain: "internal:hostmonit:yd",
            target_domain: "x.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 1,
        };

        await expect(resolveRecordsForDomain(domain, env.WUYA, () => {}, {})).rejects.toThrow(/network boom/);
    });
});

describe("processInChunks 短路行为 (P1-3)", () => {
    it("fulfilled 但非 2xx 立即抛错，短路后续批次", async () => {
        const calls: string[] = [];
        const items = ["a", "b", "c", "d", "e"];
        const processFn = async (item: string): Promise<Response> => {
            calls.push(item);
            if (item === "a") {
                return new Response(JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }), {
                    status: 401,
                    headers: { "Content-Type": "application/json" },
                });
            }
            return new Response("ok", { status: 200 });
        };
        const noopLog = () => {};
        // chunkSize=2 → 批次 1 (a,b) a 失败应抛错，批次 2 (c,d,e) 不应被调用
        await expect(processInChunks(items, 2, processFn, noopLog)).rejects.toThrow(/Cloudflare API 失败/);
        // 后续批次绝不应被处理
        expect(calls).not.toContain("c");
        expect(calls).not.toContain("d");
        expect(calls).not.toContain("e");
        // a 必须被调用一次
        expect(calls.filter((x) => x === "a")).toHaveLength(1);
    });

    it("所有项成功时主动消费 body 并返回响应数组", async () => {
        const items = [1, 2, 3];
        const processFn = async (n: number): Promise<Response> => new Response(`ok-${n}`, { status: 200 });
        const noopLog = () => {};
        const results = await processInChunks(items, 2, processFn, noopLog);
        expect(results).toHaveLength(3);
        // 每个 Response 的 body 已被消费（arrayBuffer 已读）
        for (const res of results) {
            expect(res.bodyUsed).toBe(true);
        }
    });

    it("rejected 的 promise 收集后聚合抛错", async () => {
        const items = ["x", "y"];
        const processFn = async (item: string): Promise<Response> => {
            if (item === "y") throw new Error("network boom");
            return new Response("ok", { status: 200 });
        };
        const noopLog = () => {};
        await expect(processInChunks(items, 5, processFn, noopLog)).rejects.toThrow(/network boom/);
    });
});

describe("updateCloudflareDns 编码与全量分页", () => {
    it("编码 name 参数并拉取全部分页", async () => {
        const domain = {
            id: 998,
            source_domain: "source.example.com",
            target_domain: "a&b.example.com",
            zone_id: "zone-pagination",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: null,
            is_enabled: 1,
            is_system: 0,
        };
        const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith("/dns_records") && (!init || init.method === undefined)) {
                const page = url.searchParams.get("page");
                return new Response(
                    JSON.stringify({
                        success: true,
                        result:
                            page === "1"
                                ? [{ id: "kept-record", type: "A", content: "192.0.2.1", proxied: false, ttl: 60 }]
                                : [{ id: "stale-page-2", type: "A", content: "192.0.2.9", proxied: false, ttl: 60 }],
                        result_info: { page: Number(page), total_pages: 2 },
                    }),
                    { status: 200 }
                );
            }
            if (init?.method === "DELETE") return new Response(JSON.stringify({ success: true }), { status: 200 });
            // issue #53：本次有删除，保留下来的 A 记录要 PATCH 刷新变更备注
            if (init?.method === "PATCH") return new Response(JSON.stringify({ success: true }), { status: 200 });
            throw new Error("意外的请求：" + String(input));
        });
        vi.stubGlobal("fetch", fetchMock);

        const logs: string[] = [];
        const result = await updateCloudflareDns(
            "token",
            "zone-pagination",
            domain,
            [{ type: "A", content: "192.0.2.1" }],
            (message) => logs.push(message)
        );
        expect(result).toBe("success");

        const listUrls = fetchMock.mock.calls
            .map(([input, init]) => ({ url: new URL(String(input)), method: init?.method }))
            .filter((call) => call.method === undefined)
            .map((call) => call.url);
        expect(listUrls).toHaveLength(2);
        expect(listUrls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
        for (const url of listUrls) expect(url.searchParams.get("name")).toBe("a&b.example.com");

        const deleteCalls = fetchMock.mock.calls.filter(
            ([input, init]) => new URL(String(input)).pathname.endsWith("/stale-page-2") && init?.method === "DELETE"
        );
        expect(deleteCalls).toHaveLength(1);

        // 本次既有删除也有新增，保留记录的备注必须刷新（issue #53 / 方案 §12.4）
        const patchCalls = fetchMock.mock.calls.filter(
            ([input, init]) => new URL(String(input)).pathname.endsWith("/kept-record") && init?.method === "PATCH"
        );
        expect(patchCalls).toHaveLength(1);
        expect(JSON.parse(String(patchCalls[0][1]?.body))).toEqual({ comment: expectedChangeComment() });
    });
});

describe("URL 类型目标端到端 (issue #52)", () => {
    /** 插入一条 URL 类型目标并返回整行 */
    async function insertUrlDomain(overrides: {
        target: string;
        url?: string;
        parse_mode?: string | null;
        parse_param?: string | null;
        fetch_strategy?: string | null;
        last_synced_records?: string | null;
        last_sync_status?: string | null;
    }) {
        const url = overrides.url ?? "https://example.com/ips.txt";
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, source_type, source_url, parse_mode, parse_param, fetch_strategy, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system, is_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 60, NULL, 0, 1)"
        )
            .bind(
                new URL(url).hostname,
                "url",
                url,
                overrides.parse_mode ?? "auto",
                overrides.parse_param ?? null,
                overrides.fetch_strategy ?? null,
                overrides.target,
                "test-zone-id"
            )
            .run();
        if (overrides.last_synced_records !== undefined || overrides.last_sync_status !== undefined) {
            await env.WUYA.prepare(
                "UPDATE domains SET last_synced_records = ?, last_sync_status = ? WHERE target_domain = ?"
            )
                .bind(overrides.last_synced_records ?? null, overrides.last_sync_status ?? null, overrides.target)
                .run();
        }
        return (await env.WUYA.prepare("SELECT * FROM domains WHERE target_domain = ?")
            .bind(overrides.target)
            .first()) as {
            id: number;
            source_domain: string;
            source_type: string | null;
            source_url: string | null;
            parse_mode: string | null;
            parse_param: string | null;
            fetch_strategy: string | null;
            target_domain: string;
            zone_id: string;
            is_deep_resolve: number;
            ttl: number;
            last_synced_records: string | null;
            is_enabled: number;
            is_system: number;
        };
    }

    /** 记录发往 Cloudflare API 的调用，列表接口按传入的现有记录返回 */
    function stubCfAndSource(sourceFn: (url: string) => Response | Promise<Response>, existing: unknown[] = []) {
        const calls: { url: string; method: string; body?: string }[] = [];
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (url.includes("api.cloudflare.com")) {
                const method = init?.method ?? "GET";
                calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
                if (method === "GET") {
                    return new Response(JSON.stringify({ success: true, result: existing }), { status: 200 });
                }
                return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
            }
            calls.push({ url, method: init?.method ?? "GET" });
            return await sourceFn(url);
        });
        vi.stubGlobal("fetch", fetchMock);
        return calls;
    }

    it("由 URL 正文生成 A 记录并写入 Cloudflare（数值升序）", async () => {
        const domain = await insertUrlDomain({ target: "url-a.example.com" });
        const calls = stubCfAndSource(() => new Response("3.3.3.3\n1.1.1.1\n10.0.0.1\n2.2.2.2", { status: 200 }));

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const row = (await env.WUYA.prepare("SELECT last_sync_status, last_synced_records FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_sync_status: string; last_synced_records: string };
        expect(row.last_sync_status).toBe("success");
        expect(JSON.parse(row.last_synced_records)).toEqual([
            { type: "A", content: "1.1.1.1" },
            { type: "A", content: "2.2.2.2" },
            { type: "A", content: "3.3.3.3" },
            { type: "A", content: "10.0.0.1" },
        ]);
        const posts = calls.filter((c) => c.method === "POST" && c.url.includes("api.cloudflare.com"));
        expect(posts).toHaveLength(4);
        const posted = posts.map((c) => JSON.parse(c.body as string)) as { content: string; type: string }[];
        expect(posted.every((p) => p.type === "A")).toBe(true);
        expect(posted.map((p) => p.content)).toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3", "10.0.0.1"]);
    });

    it("IPv4 与 IPv6 同时生成，IPv6 规范化后字典序排列", async () => {
        const domain = await insertUrlDomain({ target: "url-dual.example.com" });
        const calls = stubCfAndSource(
            () => new Response("2001:0db8:0000:0000:0000:0000:0000:0002\n2001:db8::1\n8.8.8.8", { status: 200 })
        );

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const row = (await env.WUYA.prepare("SELECT last_synced_records FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_synced_records: string };
        expect(JSON.parse(row.last_synced_records)).toEqual([
            { type: "A", content: "8.8.8.8" },
            { type: "AAAA", content: "2001:db8::1" },
            { type: "AAAA", content: "2001:db8::2" },
        ]);
        const posted = calls
            .filter((c) => c.method === "POST" && c.url.includes("api.cloudflare.com"))
            .map((c) => JSON.parse(c.body as string).type as string);
        expect(posted.sort()).toEqual(["A", "AAAA", "AAAA"]);
    });

    it("同批内相同 url + parse_mode + parse_param 只抓取一次", async () => {
        const domainA = await insertUrlDomain({ target: "url-share-a.example.com" });
        const domainB = await insertUrlDomain({ target: "url-share-b.example.com" });
        let sourceHits = 0;
        stubCfAndSource(() => {
            sourceHits++;
            return new Response("1.1.1.1", { status: 200 });
        });
        const syncContext = {};

        const recordsA = await resolveRecordsForDomain(domainA, env.WUYA, () => {}, syncContext);
        const recordsB = await resolveRecordsForDomain(domainB, env.WUYA, () => {}, syncContext);

        expect(sourceHits).toBe(1);
        expect(recordsA).toEqual([{ type: "A", content: "1.1.1.1" }]);
        expect(recordsB).toEqual(recordsA);
    });

    it("解析配置不同则各自抓取（缓存键含 parse_mode）", async () => {
        const domainA = await insertUrlDomain({ target: "url-key-a.example.com", parse_mode: "lines" });
        const domainB = await insertUrlDomain({ target: "url-key-b.example.com", parse_mode: "auto" });
        let sourceHits = 0;
        stubCfAndSource(() => {
            sourceHits++;
            return new Response("1.1.1.1", { status: 200 });
        });
        const syncContext = {};

        await resolveRecordsForDomain(domainA, env.WUYA, () => {}, syncContext);
        await resolveRecordsForDomain(domainB, env.WUYA, () => {}, syncContext);

        expect(sourceHits).toBe(2);
    });

    it("抓取全部失败时标记 failed 且不改动现有 DNS", async () => {
        const domain = await insertUrlDomain({ target: "url-fail.example.com" });
        const calls = stubCfAndSource(() => new Response("boom", { status: 500 }));

        await expect(syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {})).rejects.toThrow(
            /所有抓取策略均未能从该URL获取到IP/
        );

        const row = (await env.WUYA.prepare("SELECT last_sync_status, last_sync_error FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_sync_status: string; last_sync_error: string | null };
        expect(row.last_sync_status).toBe("failed");
        expect(row.last_sync_error).toBeTruthy();
        // 抓取阶段就失败，根本不该进入 Cloudflare 写回
        expect(calls.filter((c) => c.url.includes("api.cloudflare.com"))).toHaveLength(0);
    });

    it("取得正文但解析 0 条：上次无记录 → no_change", async () => {
        const domain = await insertUrlDomain({ target: "url-empty-new.example.com", last_synced_records: null });
        const calls = stubCfAndSource(() => new Response("这里没有任何 IP", { status: 200 }));

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const row = (await env.WUYA.prepare("SELECT last_sync_status FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_sync_status: string };
        expect(row.last_sync_status).toBe("no_change");
        expect(calls.filter((c) => c.url.includes("api.cloudflare.com"))).toHaveLength(0);
    });

    it("取得正文但解析 0 条：上次有记录 → failed 且保留旧记录", async () => {
        const previous = JSON.stringify([{ type: "A", content: "9.9.9.9" }]);
        const domain = await insertUrlDomain({
            target: "url-empty-old.example.com",
            last_synced_records: previous,
            last_sync_status: "success",
        });
        const calls = stubCfAndSource(() => new Response("这里没有任何 IP", { status: 200 }));

        await expect(syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {})).rejects.toThrow(
            /上次曾有记录/
        );

        const row = (await env.WUYA.prepare("SELECT last_sync_status, last_synced_records FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_sync_status: string; last_synced_records: string };
        expect(row.last_sync_status).toBe("failed");
        expect(row.last_synced_records).toBe(previous);
        expect(calls.filter((c) => c.url.includes("api.cloudflare.com"))).toHaveLength(0);
    });

    it("仅解析到 IPv6 时生成 AAAA 并删除旧 A", async () => {
        const domain = await insertUrlDomain({ target: "url-v6only.example.com" });
        const calls = stubCfAndSource(
            () => new Response("2001:db8::5", { status: 200 }),
            [{ id: "old-a", type: "A", content: "9.9.9.9", proxied: false, ttl: 60 }]
        );

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const deletes = calls.filter((c) => c.method === "DELETE");
        expect(deletes).toHaveLength(1);
        expect(deletes[0].url).toContain("old-a");
        const posts = calls.filter((c) => c.method === "POST" && c.url.includes("api.cloudflare.com"));
        expect(posts).toHaveLength(1);
        expect(JSON.parse(posts[0].body as string)).toMatchObject({ type: "AAAA", content: "2001:db8::5" });
    });

    it("策略回退命中后把实际生效策略持久化到 domains", async () => {
        const domain = await insertUrlDomain({ target: "url-fallback.example.com" });
        stubCfAndSource((url) => {
            // direct_regex 直连源站失败，jina_reader 命中
            if (url.includes("r.jina.ai")) return new Response("5.5.5.5", { status: 200 });
            return new Response("blocked", { status: 403 });
        });

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const row = (await env.WUYA.prepare("SELECT fetch_strategy FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { fetch_strategy: string | null };
        expect(row.fetch_strategy).toBe("jina_reader");
    });

    it("回退后下一轮优先使用已持久化策略", async () => {
        const domain = await insertUrlDomain({
            target: "url-fallback-priority.example.com",
            fetch_strategy: "jina_reader",
        });
        const attempted: string[] = [];
        stubCfAndSource((url) => {
            attempted.push(url);
            if (url.includes("r.jina.ai")) return new Response("5.5.5.5", { status: 200 });
            return new Response("blocked", { status: 403 });
        });

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        // 首轮只打一次：缓存策略优先且直接命中，不再尝试其它策略
        expect(attempted).toHaveLength(1);
        expect(attempted[0]).toContain("r.jina.ai");
    });

    it("一条策略抛错、另一条取得正文但 0 条时按 0 条分支处理（§13.1）", async () => {
        const domain = await insertUrlDomain({ target: "url-mixed-empty.example.com" });
        // direct_regex 抛 HTTP 500，其余策略都成功取回正文但不含任何 IP
        const calls = stubCfAndSource((url) => {
            if (url.includes("r.jina.ai") || url.includes("codetabs") || url.includes("PhantomJsCloud")) {
                return new Response("这个列表已经下架了", { status: 200 });
            }
            return new Response("boom", { status: 500 });
        });

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const row = (await env.WUYA.prepare("SELECT last_sync_status, last_sync_error FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_sync_status: string; last_sync_error: string | null };
        // 有策略真的取回了正文，只是里面没 IP —— 属于「成功但 0 条」，不该被其它策略的异常改判为抓取失败
        expect(row.last_sync_status).toBe("no_change");
        expect(row.last_sync_error).toBeNull();
        expect(calls.filter((c) => c.url.includes("api.cloudflare.com"))).toHaveLength(0);
    });

    it("同批缓存命中的目标也会把实际生效策略落库（验收 #6）", async () => {
        const domainA = await insertUrlDomain({ target: "url-cache-a.example.com" });
        const domainB = await insertUrlDomain({ target: "url-cache-b.example.com" });
        stubCfAndSource((url) => {
            if (url.includes("r.jina.ai")) return new Response("5.5.5.5", { status: 200 });
            return new Response("blocked", { status: 403 });
        });
        const syncContext = {};

        await resolveRecordsForDomain(domainA, env.WUYA, () => {}, syncContext);
        await resolveRecordsForDomain(domainB, env.WUYA, () => {}, syncContext);

        const rows = (await env.WUYA.prepare(
            "SELECT target_domain, fetch_strategy FROM domains WHERE target_domain IN (?, ?) ORDER BY target_domain"
        )
            .bind("url-cache-a.example.com", "url-cache-b.example.com")
            .all()) as { results: { target_domain: string; fetch_strategy: string | null }[] };
        // 抓取只发生在 A 上，B 命中缓存；但 B 也必须落库，否则下一轮它仍从空策略起试
        expect(rows.results.map((r) => r.fetch_strategy)).toEqual(["jina_reader", "jina_reader"]);
    });

    it("parse_mode 为 NULL 与 auto 视为同一抓取配置，只抓一次", async () => {
        const domainA = await insertUrlDomain({ target: "url-null-mode-a.example.com", parse_mode: null });
        const domainB = await insertUrlDomain({ target: "url-null-mode-b.example.com", parse_mode: "auto" });
        let sourceHits = 0;
        stubCfAndSource(() => {
            sourceHits++;
            return new Response("1.1.1.1", { status: 200 });
        });
        const syncContext = {};

        const recordsA = await resolveRecordsForDomain(domainA, env.WUYA, () => {}, syncContext);
        const recordsB = await resolveRecordsForDomain(domainB, env.WUYA, () => {}, syncContext);

        expect(sourceHits).toBe(1);
        expect(recordsB).toEqual(recordsA);
    });

    it("集成：URL 目标手动同步写入记录，二次同步内容一致时不产生任何写操作（§15.2）", async () => {
        const domain = await insertUrlDomain({ target: "url-e2e.example.com" });
        const remote: { id: string; type: string; content: string; proxied: boolean; ttl: number }[] = [];
        const calls: { url: string; method: string; body?: string }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                const method = init?.method ?? "GET";
                if (url.includes("api.cloudflare.com")) {
                    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
                    if (method === "GET") {
                        return new Response(JSON.stringify({ success: true, result: remote }), { status: 200 });
                    }
                    if (method === "POST") {
                        const body = JSON.parse(init?.body as string) as { type: string; content: string };
                        remote.push({
                            id: `rec-${remote.length + 1}`,
                            type: body.type,
                            content: body.content,
                            proxied: false,
                            ttl: 60,
                        });
                        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
                    }
                    return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
                }
                calls.push({ url, method });
                return new Response("2.2.2.2\n1.1.1.1", { status: 200 });
            })
        );

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const first = (await env.WUYA.prepare("SELECT last_sync_status, last_synced_records FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_sync_status: string; last_synced_records: string };
        expect(first.last_sync_status).toBe("success");
        expect(JSON.parse(first.last_synced_records)).toEqual([
            { type: "A", content: "1.1.1.1" },
            { type: "A", content: "2.2.2.2" },
        ]);

        // 二次同步：正文与远端记录都不变
        const fresh = (await env.WUYA.prepare("SELECT * FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as Parameters<typeof syncDomainLogic>[0];
        calls.length = 0;
        await syncDomainLogic(fresh, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const second = (await env.WUYA.prepare("SELECT last_sync_status, last_synced_records FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_sync_status: string; last_synced_records: string };
        expect(second.last_sync_status).toBe("no_change");
        expect(JSON.parse(second.last_synced_records)).toEqual(JSON.parse(first.last_synced_records));
        const writes = calls.filter((c) => c.url.includes("api.cloudflare.com") && c.method !== "GET");
        expect(writes).toEqual([]);
    });
});

describe("DNS 全来源截断与变更时间备注 (issue #53)", () => {
    /** 造一个 updateCloudflareDns 需要的 domain 字段集 */
    function dnsDomain(overrides: { target: string; ttl?: number }) {
        return {
            id: 1,
            source_domain: "src.example.com",
            target_domain: overrides.target,
            zone_id: "test-zone-id",
            is_deep_resolve: 0,
            ttl: overrides.ttl ?? 60,
            last_synced_records: null,
            is_enabled: 1,
            is_system: 0,
        } as Parameters<typeof updateCloudflareDns>[2];
    }

    /** 记录发往 CF 的调用；GET 返回 existing，其余按 responder 决定 */
    function stubCf(
        existing: unknown[],
        responder?: (method: string, url: string, body?: string) => Response | undefined
    ) {
        const calls: { url: string; method: string; body?: string }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                const method = init?.method ?? "GET";
                calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
                if (method === "GET") {
                    return new Response(JSON.stringify({ success: true, result: existing }), { status: 200 });
                }
                return (
                    responder?.(method, url, typeof init?.body === "string" ? init.body : undefined) ??
                    new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })
                );
            })
        );
        return calls;
    }

    it("备注格式为北京时间、精确到分钟", () => {
        // UTC 03:04 → 北京时间 11:04，同一天
        expect(formatChangeComment(new Date("2026-01-02T03:04:05Z"))).toBe("DNS Clone 变更于 2026-01-02 11:04");
        // UTC 前一日 16:30 → 北京时间次日 00:30，跨日进位必须正确
        expect(formatChangeComment(new Date("2026-01-01T16:30:00Z"))).toBe("DNS Clone 变更于 2026-01-02 00:30");
    });

    it("按类型各自截断，CNAME 不参与截断且顺序不变", () => {
        const records = [
            { type: "A", content: "1.1.1.1" },
            { type: "AAAA", content: "2001:db8::1" },
            { type: "A", content: "2.2.2.2" },
            { type: "A", content: "3.3.3.3" },
            { type: "AAAA", content: "2001:db8::2" },
        ];
        expect(limitIpRecords(records, 2)).toEqual([
            { type: "A", content: "1.1.1.1" },
            { type: "AAAA", content: "2001:db8::1" },
            { type: "A", content: "2.2.2.2" },
            { type: "AAAA", content: "2001:db8::2" },
        ]);
        // CNAME 原样穿过，不受上限影响
        const cnameRecords = [{ type: "CNAME", content: "cname-target.example.com" }];
        expect(limitIpRecords(cnameRecords, 1)).toEqual(cnameRecords);
        // 上限钳到至少 1，避免 0 或负数把记录集合清空
        expect(limitIpRecords(records, 0)).toHaveLength(2);
    });

    it("新增 A/AAAA 记录随创建请求写入备注，CNAME 不写", async () => {
        const calls = stubCf([]);
        await updateCloudflareDns(
            "token",
            "zone-id",
            dnsDomain({ target: "comment-post.example.com" }),
            [
                { type: "A", content: "1.1.1.1" },
                { type: "AAAA", content: "2001:db8::1" },
            ],
            () => {}
        );

        const posts = calls.filter((c) => c.method === "POST");
        expect(posts).toHaveLength(2);
        const expected = expectedChangeComment();
        expect(JSON.parse(posts[0].body as string)).toMatchObject({ type: "A", comment: expected });
        expect(JSON.parse(posts[1].body as string)).toMatchObject({ type: "AAAA", comment: expected });

        // CNAME 目标：创建请求不带 comment 字段
        const cnameCalls = stubCf([]);
        await updateCloudflareDns(
            "token",
            "zone-id",
            dnsDomain({ target: "comment-cname.example.com" }),
            [{ type: "CNAME", content: "cname-target.example.com" }],
            () => {}
        );
        const cnamePosts = cnameCalls.filter((c) => c.method === "POST");
        expect(cnamePosts).toHaveLength(1);
        expect(JSON.parse(cnamePosts[0].body as string)).not.toHaveProperty("comment");
    });

    it("本次有增删时刷新保留的 A/AAAA 记录备注（PATCH 早于 DELETE 与 POST）", async () => {
        const calls = stubCf([
            { id: "keep-a", type: "A", content: "1.1.1.1", proxied: false, ttl: 60, comment: "旧备注" },
            { id: "drop-a", type: "A", content: "9.9.9.9", proxied: false, ttl: 60 },
        ]);
        const result = await updateCloudflareDns(
            "token",
            "zone-id",
            dnsDomain({ target: "refresh.example.com" }),
            [
                { type: "A", content: "1.1.1.1" },
                { type: "A", content: "2.2.2.2" },
            ],
            () => {}
        );
        expect(result).toBe("success");

        const expected = expectedChangeComment();
        const patch = calls.filter((c) => c.method === "PATCH");
        expect(patch).toHaveLength(1);
        expect(patch[0].url).toContain("keep-a");
        expect(JSON.parse(patch[0].body as string)).toEqual({ comment: expected });

        // 顺序：备注先于集合变更，保证 PATCH 失败时记录集合不变（方案 §13.1）
        const order = calls.filter((c) => c.method !== "GET").map((c) => c.method);
        expect(order).toEqual(["PATCH", "DELETE", "POST"]);
    });

    it("记录集合未变时不产生任何 PATCH，既有备注保持不变", async () => {
        const calls = stubCf([
            {
                id: "keep-a",
                type: "A",
                content: "1.1.1.1",
                proxied: false,
                ttl: 60,
                comment: "DNS Clone 变更于 2020-01-01 00:00",
            },
        ]);
        const result = await updateCloudflareDns(
            "token",
            "zone-id",
            dnsDomain({ target: "nochange.example.com" }),
            [{ type: "A", content: "1.1.1.1" }],
            () => {}
        );
        expect(result).toBe("no_change");
        expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });

    it("同一分钟内已有同一备注时不重复 PATCH", async () => {
        const current = expectedChangeComment();
        const calls = stubCf([
            { id: "keep-a", type: "A", content: "1.1.1.1", proxied: false, ttl: 60, comment: current },
            { id: "drop-a", type: "A", content: "9.9.9.9", proxied: false, ttl: 60 },
        ]);
        await updateCloudflareDns(
            "token",
            "zone-id",
            dnsDomain({ target: "same-minute.example.com" }),
            [
                { type: "A", content: "1.1.1.1" },
                { type: "A", content: "2.2.2.2" },
            ],
            () => {}
        );
        expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    });

    it("备注 PATCH 失败时本次同步失败，且记录集合保持不变", async () => {
        const calls = stubCf(
            [
                { id: "keep-a", type: "A", content: "1.1.1.1", proxied: false, ttl: 60, comment: "旧备注" },
                { id: "drop-a", type: "A", content: "9.9.9.9", proxied: false, ttl: 60 },
            ],
            (method) =>
                method === "PATCH" ? new Response(JSON.stringify({ success: false }), { status: 500 }) : undefined
        );

        await expect(
            updateCloudflareDns(
                "token",
                "zone-id",
                dnsDomain({ target: "patch-fail.example.com" }),
                [
                    { type: "A", content: "1.1.1.1" },
                    { type: "A", content: "2.2.2.2" },
                ],
                () => {}
            )
        ).rejects.toThrow();

        // 关键：备注没写成之前不许动集合，DELETE/POST 一个都不能发出
        const mutations = calls.filter((c) => c.method === "DELETE" || c.method === "POST");
        expect(mutations).toEqual([]);
    });

    it("端到端：MAX_IPS_PER_TYPE 生效于 URL 来源的 A/AAAA", async () => {
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('MAX_IPS_PER_TYPE', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        await env.WUYA.batch([
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('CF_API_TOKEN', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ).bind("test-cf-token"),
            env.WUYA.prepare(
                "INSERT INTO settings (key, value) VALUES ('CF_ZONE_ID', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ).bind("test-zone-id"),
        ]);
        await env.WUYA.prepare(
            "INSERT INTO domains (source_domain, source_type, source_url, parse_mode, target_domain, zone_id, is_deep_resolve, ttl, is_system, is_enabled) VALUES (?, 'url', ?, 'auto', ?, ?, 0, 60, 0, 1)"
        )
            .bind("example.com", "https://example.com/ips.txt", "limit-e2e.example.com", "test-zone-id")
            .run();
        const domain = (await env.WUYA.prepare("SELECT * FROM domains WHERE target_domain = ?")
            .bind("limit-e2e.example.com")
            .first()) as Parameters<typeof syncDomainLogic>[0];

        // 源按数值升序解析：超出 2 条的 3.3.3.3 / 4.4.4.4 必须被截断
        const calls = stubCf([]);
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                if (url.includes("api.cloudflare.com")) {
                    calls.push({ url, method: init?.method ?? "GET" });
                    return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
                }
                return new Response("4.4.4.4\n1.1.1.1\n3.3.3.3\n2.2.2.2", { status: 200 });
            })
        );

        await syncDomainLogic(domain, "test-cf-token", "test-zone-id", env.WUYA, () => {}, {});

        const row = (await env.WUYA.prepare("SELECT last_sync_status, last_synced_records FROM domains WHERE id = ?")
            .bind(domain.id)
            .first()) as { last_sync_status: string; last_synced_records: string };
        expect(row.last_sync_status).toBe("success");
        expect(JSON.parse(row.last_synced_records)).toEqual([
            { type: "A", content: "1.1.1.1" },
            { type: "A", content: "2.2.2.2" },
        ]);
        expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);

        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").run();
        await env.WUYA.prepare("DELETE FROM domains WHERE id = ?").bind(domain.id).run();
    });

    it("批内上限复用：上下文已有值时不再回落到库里的设置", async () => {
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('MAX_IPS_PER_TYPE', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        const domain = {
            id: 777,
            source_domain: "internal:hostmonit:yd",
            target_domain: "reuse-context.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 1,
        } as Parameters<typeof resolveRecordsForDomain>[0];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("上下文已命中，不应发起 fetch");
            })
        );

        // 上下文上限 3 > 库里 1：结果保留 3 条，证明没有重复读库（§11.2）
        const syncContext = {
            threeNetworkIps: { yd: ["1.1.1.1", "2.2.2.2", "3.3.3.3"], dx: [], lt: [], source: "CloudFlareYes" },
            maxIpsPerType: 3,
        };
        const records = await resolveRecordsForDomain(domain, env.WUYA, () => {}, syncContext);
        expect(records).toHaveLength(3);

        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").run();
    });

    it("上下文未带上限时按库里的设置读取，不静默回退默认值", async () => {
        await env.WUYA.prepare(
            "INSERT INTO settings (key, value) VALUES ('MAX_IPS_PER_TYPE', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run();
        const domain = {
            id: 778,
            source_domain: "internal:hostmonit:yd",
            target_domain: "db-limit.example.com",
            zone_id: "test-zone",
            is_deep_resolve: 0,
            ttl: 60,
            last_synced_records: "[]",
            is_enabled: 1,
            is_system: 1,
        } as Parameters<typeof resolveRecordsForDomain>[0];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("三网缓存已命中，不应发起 fetch");
            })
        );

        // 库上限 1 远小于默认 20：若出口静默用默认值，这里会拿到 3 条
        const syncContext = {
            threeNetworkIps: { yd: ["1.1.1.1", "2.2.2.2", "3.3.3.3"], dx: [], lt: [], source: "CloudFlareYes" },
        };
        const records = await resolveRecordsForDomain(domain, env.WUYA, () => {}, syncContext);
        expect(records).toEqual([{ type: "A", content: "1.1.1.1" }]);

        await env.WUYA.prepare("DELETE FROM settings WHERE key = 'MAX_IPS_PER_TYPE'").run();
    });
});

describe("resolveRecursively 深度解析分支 (issue #54 判据 5)", () => {
    type DohTable = Record<string, { CNAME?: string[]; A?: string[]; AAAA?: string[] }>;

    /** 桩掉 Cloudflare DoH，返回实际查询过的 name/type 序列 */
    function stubDoh(table: DohTable): string[] {
        const queried: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                const u = new URL(url);
                const name = u.searchParams.get("name") ?? "";
                const type = u.searchParams.get("type") ?? "";
                queried.push(`${name}|${type}`);
                const answers = table[name]?.[type as "CNAME" | "A" | "AAAA"] ?? [];
                return new Response(JSON.stringify({ Answer: answers.map((data) => ({ data })) }), { status: 200 });
            })
        );
        return queried;
    }

    function collectLogs(): { logs: string[]; log: (msg: string) => void } {
        const logs: string[] = [];
        return { logs, log: (msg: string) => void logs.push(msg) };
    }

    it("沿 CNAME 链逐层追踪到最终 A/AAAA，并去掉目标末尾的点", async () => {
        const queried = stubDoh({
            "a.example.com": { CNAME: ["b.example.com."] },
            "b.example.com": { CNAME: ["c.example.com."] },
            "c.example.com": { A: ["1.2.3.4"], AAAA: ["2400:3200::1"] },
        });
        const { logs, log } = collectLogs();

        const records = await resolveRecursively("a.example.com", log);

        expect(records).toEqual([
            { type: "A", content: "1.2.3.4" },
            { type: "AAAA", content: "2400:3200::1" },
        ]);
        expect(queried).toEqual([
            "a.example.com|CNAME",
            "b.example.com|CNAME",
            "c.example.com|CNAME",
            "c.example.com|A",
            "c.example.com|AAAA",
        ]);
        // 深度逐层递增，且 CNAME 目标已剥离末尾点
        expect(logs).toContain("(深度 0) 发现CNAME -> b.example.com");
        expect(logs).toContain("(深度 1) 发现CNAME -> c.example.com");
        expect(logs).toContain("(深度 2) 未发现CNAME，查询最终IP for c.example.com");
    });

    it("子层无 CNAME 也无 IP 时回退克隆该 CNAME", async () => {
        stubDoh({ "a.example.com": { CNAME: ["b.example.com."] } });
        const { logs, log } = collectLogs();

        const records = await resolveRecursively("a.example.com", log);

        expect(records).toEqual([{ type: "CNAME", content: "b.example.com" }]);
        expect(logs).toContain("(深度 1) CNAME b.example.com 未解析到最终IP，将直接克隆此CNAME记录。");
    });

    it("CNAME 链超过 10 层时中止并记错误日志，不再继续查询", async () => {
        const table: DohTable = {};
        for (let i = 0; i < 11; i++) {
            table[`d${i}.example.com`] = { CNAME: [`d${i + 1}.example.com.`] };
        }
        const queried = stubDoh(table);
        const { logs, log } = collectLogs();

        const records = await resolveRecursively("d0.example.com", log);

        // 第 11 层（depth 11 > MAX_DEPTH）直接中止，未发起 DoH 查询
        expect(queried).toEqual(Array.from({ length: 11 }, (_, i) => `d${i}.example.com|CNAME`));
        expect(logs).toContain("错误：解析深度超过 10 层，可能存在CNAME循环。中止解析 d11.example.com。");
        // 中止信号为空 → 第 10 层回退克隆该 CNAME 并向上冒泡
        expect(records).toEqual([{ type: "CNAME", content: "d11.example.com" }]);
    });

    it("无 CNAME 时过滤掉非 IP 应答，A 与 AAAA 分类型返回", async () => {
        stubDoh({
            "plain.example.com": {
                A: ["2.2.2.2", "not-an-ip"],
                AAAA: ["2400:3200::1", "also-not-an-ip"],
            },
        });
        const { log } = collectLogs();

        const records = await resolveRecursively("plain.example.com", log);

        expect(records).toEqual([
            { type: "A", content: "2.2.2.2" },
            { type: "AAAA", content: "2400:3200::1" },
        ]);
    });
});
