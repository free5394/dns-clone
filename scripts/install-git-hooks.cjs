// install-git-hooks.cjs — 让本仓库的 .githooks/ 成为 git 的钩子目录
// 由 package.json#scripts.prepare 调用（pnpm install 时自动执行）
//
// 为什么用 core.hooksPath 而不是 husky / simple-git-hooks：AGENTS.md 禁止新增依赖，
// 而 prepare 是零依赖的自动安装路径。
//
// 已知限制：pnpm 在 "Already up to date" 时不跑 prepare，所以已有 node_modules 的老 clone
// 需要 `pnpm install --force` 或手工执行下面的 git config 命令。这条恢复命令写在 AGENTS.md。

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

// 不在 git 工作树里（如 npm 包安装场景）就静默跳过，不能让 install 失败
if (!fs.existsSync(path.join(ROOT, ".git"))) {
    process.exit(0);
}

try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: ROOT, stdio: "inherit" });
} catch (e) {
    // 钩子装不上不应该阻断安装，但要让用户看见原因
    console.error("⚠️  自动配置 git 钩子失败，提交前的本地门禁不会生效。");
    console.error("   可手动执行：git config core.hooksPath .githooks");
    console.error(e instanceof Error ? e.message : e);
}
