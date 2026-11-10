// load-deploy-env.cjs — pnpm deploy 前置：解析 --env，注入对应 .env 文件后 spawn wrangler deploy
// 零依赖、跨平台（Windows + POSIX），只服务 wrangler CLI 认证，与 Worker 运行时无关。
//
// --env 语义（本脚本拦截，不透传 wrangler）：
//   pnpm run deploy                  → 旧行为：读 .env，wrangler 自动发现 wrangler.toml
//   pnpm run deploy --env prod       → 读 .env.prod，并注入 --config wrangler.prod.toml
//   pnpm run deploy:prod             → 等价于 deploy --env prod（package.json 内置 --env prod）
//   --env 由本脚本剥离：wrangler 原生 --env 选的是配置文件内 [env.x] 段落，
//   wrangler.<env>.toml 没有这种段落，透传必报错。其余参数原样透传给 wrangler deploy
//   （如 --dry-run --outdir），供发布前验证。

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
// 通过 require.resolve 拿 wrangler 包根，避免直接 spawn pnpm shim：
//   1) Windows child_process 不补 .cmd/.ps1 后缀，spawnSync("wrangler") → ENOENT
//   2) 即使显式指向 .cmd，spawnSync 在 Windows 下不带 shell:true 也不允许直接执行 .cmd（CVE-2024-27980）
//   3) 改用 node 调用 wrangler 的 JS 入口，零 shim、零 shell 介入，token 中的 & $ 等不会被 shell 转义
const WRANGLER_ENTRY = require.resolve("wrangler", { paths: [ROOT] });
const NODE_BIN = process.execPath; // 当前 node 解释器路径
const KEY_TOKEN = "CLOUDFLARE_API_TOKEN";

// 解析并剥离 --env <name> / --env=<name>，出现多次时取最后一次
// （deploy:prod 内置的 --env prod 与显式重复传入结果一致）。
function parseEnv(argv) {
    let envName = null;
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.match(/^--env=(.+)$/);
        if (eq) {
            envName = eq[1];
            continue;
        }
        if (arg === "--env") {
            const value = argv[++i];
            if (value === undefined) {
                console.error("❌ --env 缺少值（用法：--env prod 或 --env=prod）。");
                process.exit(1);
            }
            envName = value;
            continue;
        }
        rest.push(arg);
    }
    return { envName, wranglerArgs: rest };
}

// 朴素的 .env 解析：KEY=VALUE，忽略空行与 # 注释，去掉两端成对引号
// 不支持 export 前缀 / \\ 转义 / 多行值 —— 本项目 token 不含特殊字符，足够
function loadDotenv(filePath) {
    if (!fs.existsSync(filePath)) return; // 无 .env 不报错，由 token 检查统一处理
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

const { envName, wranglerArgs } = parseEnv(process.argv.slice(2));

const envFile = envName ? `.env.${envName}` : ".env";
const ENV_PATH = path.join(ROOT, envFile);

if (envName) {
    // 显式指定环境时凭据与配置都必须就位：缺失即报错，不回退 .env / wrangler.toml，
    // 避免静默把默认（占位符）配置发上目标环境。
    if (!fs.existsSync(ENV_PATH)) {
        console.error(
            `❌ 未找到 ${envFile}。\n   指定 --env ${envName} 需要显式凭据文件：复制 .env.example 为 ${envFile} 并填入对应账号的 CLOUDFLARE_API_TOKEN。`
        );
        process.exit(1);
    }
    const configPath = path.join(ROOT, `wrangler.${envName}.toml`);
    if (!fs.existsSync(configPath)) {
        console.error(
            `❌ 未找到配置文件 wrangler.${envName}.toml。\n   指定 --env ${envName} 需要该配置文件（不入库，本机维护真实 database_id；模板见提交态 wrangler.toml）。`
        );
        process.exit(1);
    }
    // 绝对路径注入，脚本从任意 cwd 调用都正确；配置内相对路径按配置文件所在目录（仓库根）解析
    wranglerArgs.unshift("--config", configPath);
}

loadDotenv(ENV_PATH);

if (!process.env[KEY_TOKEN]) {
    console.error(
        `❌ 未检测到 CLOUDFLARE_API_TOKEN。\n` +
            `   请在项目根 ${envFile} 中写入账号级 Token（模板：.env.example）。\n` +
            `   获取：CF Dashboard → 我的个人资料 → API Tokens → Create Token → Edit Cloudflare Workers。\n` +
            `   缺失时不静默回退浏览器 OAuth。`
    );
    process.exit(1);
}

// 不传 shell:true：避免 PowerShell / Git Bash 对 token 中的 & $ 等做 shell 转义
const result = spawnSync(NODE_BIN, [WRANGLER_ENTRY, "deploy", ...wranglerArgs], {
    stdio: "inherit",
    env: process.env,
});

// spawnSync 在二进制不存在时 status=null、error.code=ENOENT，stdio:'inherit' 不会把这些打到终端
// 主动打印出来，避免"ELIFECYCLE Command failed with exit code 1"但看不到任何错信息的盲区
if (result.error) {
    console.error(`❌ 无法执行 ${NODE_BIN} ${WRANGLER_ENTRY}：${result.error.message}`);
    if (result.error.code === "ENOENT") {
        console.error(
            "   请先运行 pnpm install 生成 wrangler 安装（scripts/load-deploy-env.cjs 依赖 require.resolve('wrangler')）。"
        );
    }
    process.exit(1);
}

process.exit(result.status ?? 1);
