// deploy-argv.test.ts — 生产部署参数解析的回归防线
// 事故背景：pnpm 把分隔符 "--" 原样透传给 wrangler，wrangler 停止选项解析后 --dry-run 退化成位置参数
// 被忽略，2026-11-16 因此把新版本推上了生产。下面每个用例对应那次事故的一种形态。
import { describe, expect, it } from "vitest";
import { parseDeployArgs } from "../scripts/lib/deploy-argv.mjs";

describe("parseDeployArgs 参数解析", () => {
    it("无参数时使用默认 .env，透传参数为空", () => {
        expect(parseDeployArgs([])).toEqual({ envName: null, wranglerArgs: [], printArgs: false, error: null });
    });

    it("丢弃 pnpm 透传的 -- 分隔符，保住其后的 --dry-run", () => {
        expect(parseDeployArgs(["--", "--dry-run"])).toEqual({
            envName: null,
            wranglerArgs: ["--dry-run"],
            printArgs: false,
            error: null,
        });
    });

    it("--env prod 与 -- 同时出现时剥离 --env 并保留发布参数", () => {
        expect(parseDeployArgs(["--env", "prod", "--", "--dry-run", "--outdir", "out"])).toEqual({
            envName: "prod",
            wranglerArgs: ["--dry-run", "--outdir", "out"],
            printArgs: false,
            error: null,
        });
    });

    it("支持 --env=prod 等号写法", () => {
        expect(parseDeployArgs(["--env=prod", "--dry-run"])).toEqual({
            envName: "prod",
            wranglerArgs: ["--dry-run"],
            printArgs: false,
            error: null,
        });
    });

    it("--env 缺少值时返回错误，不把后面的选项当环境名", () => {
        const result = parseDeployArgs(["--env", "--dry-run"]);
        expect(result.error).toContain("--env 缺少环境名");
        expect(result.wranglerArgs).toEqual([]);
    });

    it("--env 位于末尾缺少值时返回错误", () => {
        expect(parseDeployArgs(["--env"]).error).toContain("--env 缺少环境名");
    });

    it("--env= 空值返回错误", () => {
        expect(parseDeployArgs(["--env="]).error).toContain("--env 缺少环境名");
    });

    it("--env 值含路径分隔符时拒绝（防路径穿越）", () => {
        expect(parseDeployArgs(["--env", "../../etc"]).error).toContain("含非法字符");
    });

    it("重复 --env 取最后一次", () => {
        expect(parseDeployArgs(["--env", "dev", "--env", "prod"]).envName).toBe("prod");
    });

    it("--print-args 被剥离出透传参数，并置干跑标记", () => {
        expect(parseDeployArgs(["--env", "prod", "--print-args", "--dry-run"])).toEqual({
            envName: "prod",
            wranglerArgs: ["--dry-run"],
            printArgs: true,
            error: null,
        });
    });
});
