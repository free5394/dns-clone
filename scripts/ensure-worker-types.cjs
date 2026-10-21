// ensure-worker-types.cjs — typecheck 前置：worker-configuration.d.ts 缺失时自动补生成
// 由 package.json#scripts.pretypecheck 调用（pnpm 12 会在 typecheck 前自动执行 pretypecheck）
//
// 为什么需要它：worker-configuration.d.ts 是 `wrangler types` 的生成物，且在 .gitignore 里。
// 新 clone 上它不存在，`tsc --noEmit` 会冒出几十行 "Cannot find name 'D1Database'"，全部指向正常源码。
// 本会话的 CI 首跑失败（a1a8eec）就是这个坑，当时只修了 CI，知识没进入本机。

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const TYPES_PATH = path.join(__dirname, "..", "worker-configuration.d.ts");

if (fs.existsSync(TYPES_PATH)) {
    // 已存在就什么都不做：cf-typegen 要 3 秒且每次重写 626KB，日常 typecheck 只有 0.3–0.5 秒，
    // 无条件生成会让最常见的操作慢一个数量级。
    process.exit(0);
}

console.log("worker-configuration.d.ts 不存在，先生成运行时类型（wrangler types）...");
try {
    // 经 shell 调 pnpm：Windows 上 pnpm 只有 pnpm.cmd / pnpm.ps1 而没有裸可执行文件，
    // execFileSync 不查 PATHEXT，会直接 `spawnSync pnpm ENOENT`（实测 exit=1）。
    execSync("pnpm cf-typegen", { stdio: "inherit", cwd: path.join(__dirname, "..") });
} catch (e) {
    console.error("❌ 生成 worker-configuration.d.ts 失败，请手动运行 pnpm cf-typegen 排查。");
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
}
