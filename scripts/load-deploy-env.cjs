// load-deploy-env.cjs — pnpm deploy 前置：把项目根 .env 注入 process.env 后 spawn wrangler deploy
// 零依赖、跨平台（Windows + POSIX），只服务 wrangler CLI 认证，与 Worker 运行时无关。

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ENV_PATH = path.join(__dirname, "..", ".env");
// 通过 require.resolve 拿 wrangler 包根，避免直接 spawn pnpm shim：
//   1) Windows child_process 不补 .cmd/.ps1 后缀，spawnSync("wrangler") → ENOENT
//   2) 即使显式指向 .cmd，spawnSync 在 Windows 下不带 shell:true 也不允许直接执行 .cmd（CVE-2024-27980）
//   3) 改用 node 调用 wrangler 的 JS 入口，零 shim、零 shell 介入，token 中的 & $ 等不会被 shell 转义
const WRANGLER_ENTRY = require.resolve("wrangler", { paths: [path.join(__dirname, "..")] });
const NODE_BIN = process.execPath; // 当前 node 解释器路径
const KEY_TOKEN = "CLOUDFLARE_API_TOKEN";

// 朴素的 .env 解析：KEY=VALUE，忽略空行与 # 注释，去掉两端成对引号
// 不支持 export 前缀 / \\ 转义 / 多行值 —— 本项目 token 不含特殊字符，足够
function loadDotenv(filePath) {
    if (!fs.existsSync(filePath)) return;                  // 无 .env 不报错，由 token 检查统一处理
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
        if (!m) continue;
        const [, key, value] = m;
        const val = value.replace(/^['"]|['"]$/g, "");
        // 不覆盖已存在的 shell 环境变量；保持"显式 > 文件"的优先级
        if (process.env[key] === undefined) process.env[key] = val;
    }
}

loadDotenv(ENV_PATH);

if (!process.env[KEY_TOKEN]) {
    console.error(
        "❌ 未检测到 CLOUDFLARE_API_TOKEN。\n" +
            "   请在项目根 .env 中写入账号级 Token（模板：.env.example）。\n" +
            "   获取：CF Dashboard → 我的个人资料 → API Tokens → Create Token → Edit Cloudflare Workers。\n" +
            "   缺失时不静默回退浏览器 OAuth。"
    );
    process.exit(1);
}

// 不传 shell:true：避免 PowerShell / Git Bash 对 token 中的 & $ 等做 shell 转义
const result = spawnSync(NODE_BIN, [WRANGLER_ENTRY, "deploy"], {
    stdio: "inherit",
    env: process.env,
});

// spawnSync 在二进制不存在时 status=null、error.code=ENOENT，stdio:'inherit' 不会把这些打到终端
// 主动打印出来，避免"ELIFECYCLE Command failed with exit code 1"但看不到任何错信息的盲区
if (result.error) {
    console.error(`❌ 无法执行 ${NODE_BIN} ${WRANGLER_ENTRY}：${result.error.message}`);
    if (result.error.code === "ENOENT") {
        console.error("   请先运行 pnpm install 生成 wrangler 安装（scripts/load-deploy-env.cjs 依赖 require.resolve('wrangler')）。");
    }
    process.exit(1);
}

process.exit(result.status ?? 1);
