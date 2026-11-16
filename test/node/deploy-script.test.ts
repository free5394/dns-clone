// test/node/deploy-script.test.ts — Node 环境用例：覆盖 scripts/load-deploy-env.mjs 的进程级接线
// 被测对象是子进程行为：参数剥接、凭据与配置文件的存在性检查、干跑退出、token 门控顺序。
// 夹具走 DEPLOY_ROOT 指向临时目录，绝不读写仓库根的 .env.prod / wrangler.prod.toml。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "load-deploy-env.mjs");

let fixtureRoot = "";

function writeFixtureFile(name: string, content: string): void {
    fs.writeFileSync(path.join(fixtureRoot, name), content, "utf-8");
}

interface RunResult {
    status: number | null;
    output: string;
}

/** DEPLOY_ROOT 把脚本眼里的仓库根指向夹具目录；子进程环境里剥掉真实 token */
function runScript(args: string[], options: { withToken?: boolean } = {}): RunResult {
    const env: NodeJS.ProcessEnv = { ...process.env, DEPLOY_ROOT: fixtureRoot };
    delete env.CLOUDFLARE_API_TOKEN;
    // wrangler 的启动横幅可被 WRANGLER_HIDE_BANNER 关掉，留着会让「是否真起过 wrangler」的断言恒真
    delete env.WRANGLER_HIDE_BANNER;
    if (options.withToken) env.CLOUDFLARE_API_TOKEN = "fixture-token";
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
        cwd: fixtureRoot,
        env,
        encoding: "utf-8",
        timeout: 20000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** 从干跑输出里取回 wrangler 实际会收到的参数数组 */
function parsePrintedArgs(output: string): string[] {
    const line = output.split(/\r?\n/).find((row) => row.trim().startsWith('["deploy"') && row.trim().endsWith("]"));
    if (!line) throw new Error(`干跑输出里没有参数行：${output}`);
    return JSON.parse(line) as string[];
}

beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-env-fixture-"));
    writeFixtureFile(".env.fixture", "CLOUDFLARE_API_TOKEN=fixture-token\n");
    writeFixtureFile(".env.notoken", "# 故意不含 token：用于验证干跑先于 token 检查\n");
    // 配置文件的存在性检查在 token 检查之前，所以 token 用例也要把这个文件摆好
    writeFixtureFile("wrangler.notoken.toml", 'name = "notoken"\n');
    writeFixtureFile("wrangler.fixture.toml", 'name = "fixture"\nmain = "src/index.ts"\n');
});

afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("部署脚本接线（Node 环境）", () => {
    it("干跑只回显参数，不启动 wrangler", () => {
        const result = runScript(["--env", "fixture", "--print-args"]);
        expect(result.status).toBe(0);
        expect(result.output).toContain("[干跑]");
        const args = parsePrintedArgs(result.output);
        expect(args[0]).toBe("deploy");
        // 精确比对整份参数数组：既证明 --config 与配置路径就位，也证明 --env 的「值」没被当位置参数漏出
        // （纯函数层跳过 --env 值的那一步是回归面，只断言 flag 被剥离盖不住它）
        expect(args).toEqual(["deploy", "--config", path.join(fixtureRoot, "wrangler.fixture.toml")]);
        // 干跑不能真起 wrangler：启动横幅与真实构建输出都是「起过」的证据
        expect(result.output).not.toContain("wrangler 4.");
        expect(result.output).not.toContain("Total Upload");
    });

    // 2026-11-16 误发布事故的原始形状：pnpm 把裸分隔符原样交给脚本，wrangler 随后停止解析选项，
    // --dry-run 退化成位置参数被忽略。这条用例把事故形态钉在进程级，避免只靠纯函数用例兜底。
    it("裸分隔符被剥离，其后的 --dry-run 仍到达 wrangler", () => {
        const result = runScript(["--env", "fixture", "--print-args", "--", "--dry-run"]);
        expect(result.status).toBe(0);
        const args = parsePrintedArgs(result.output);
        expect(args).toContain("--dry-run");
        expect(args).not.toContain("--");
    });

    it("缺少凭据文件时按文件名报错退出", () => {
        const result = runScript(["--env", "absent", "--print-args"]);
        expect(result.status).toBe(1);
        expect(result.output).toContain("未找到 .env.absent");
    });

    it("缺少配置文件时单独报错，不回退默认配置", () => {
        writeFixtureFile(".env.noconfig", "CLOUDFLARE_API_TOKEN=fixture-token\n");
        const result = runScript(["--env", "noconfig", "--print-args"]);
        expect(result.status).toBe(1);
        expect(result.output).toContain("未找到配置文件 wrangler.noconfig.toml");
    });

    it("干跑先于 token 检查：无 token 也返回 0", () => {
        const result = runScript(["--env", "notoken", "--print-args"]);
        expect(result.status).toBe(0);
        expect(result.output).toContain("[干跑]");
    });

    it("无 token 且非干跑时退出 1，且不启动 wrangler", () => {
        const result = runScript(["--env", "notoken"]);
        expect(result.status).toBe(1);
        expect(result.output).toContain("未检测到 CLOUDFLARE_API_TOKEN");
        expect(result.output).not.toContain("wrangler 4.");
    });

    it("重复 --env 走 stderr 告警但以最后一次为准、不阻断", () => {
        const result = runScript(["--env", "absent", "--env", "fixture", "--print-args"]);
        expect(result.status).toBe(0);
        expect(result.output).toContain("重复出现");
        expect(parsePrintedArgs(result.output)).toContain(path.join(fixtureRoot, "wrangler.fixture.toml"));
    });
});
