// load-deploy-env.mjs — pnpm deploy 前置：解析参数、注入对应 .env 文件，然后 spawn wrangler deploy
// 零依赖、跨平台（Windows + POSIX），只服务 wrangler CLI 认证，与 Worker 运行时无关。
//
// 参数语义（--env 与 --print-args 由本脚本剥离，不透传 wrangler）：
//   pnpm run deploy                   → 旧行为：读 .env，wrangler 自动发现 wrangler.toml
//   pnpm run deploy --env prod        → 读 .env.prod，并注入 --config wrangler.prod.toml
//   pnpm run deploy:prod              → 等价于 deploy --env prod（package.json 内置 --env prod）
//   pnpm run deploy:prod --print-args → 干跑：回显 wrangler 会收到的参数后退出，不触网、不要 token
//   --env 由本脚本剥离：wrangler 原生 --env 选的是配置文件内 [env.x] 段落，wrangler.<env>.toml
//   没有这种段落，透传必报错。其余参数原样透传给 wrangler deploy（如 --dry-run --outdir）。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { parseDeployArgs } from "./lib/deploy-argv.mjs";

// ROOT 默认是仓库根；DEPLOY_ROOT 只服务于自动化测试，把夹具目录当根，避免用例往仓库根写假的
// .env.<name> / wrangler.<name>.toml。wrangler 入口始终从脚本所在仓库解析，跟随夹具目录会解析失败。
const SCRIPT_ROOT = path.join(import.meta.dirname, "..");
const ROOT = process.env.DEPLOY_ROOT ? path.resolve(process.env.DEPLOY_ROOT) : SCRIPT_ROOT;
const require = createRequire(import.meta.url);

// 通过 require.resolve 拿 wrangler 包根，避免直接 spawn pnpm shim：
//   1) Windows child_process 不补 .cmd/.ps1 后缀，spawnSync("wrangler") → ENOENT
//   2) 即使显式指向 .cmd，spawnSync 在 Windows 下不带 shell:true 也不允许直接执行 .cmd（CVE-2024-27980）
//   3) 改用 node 调用 wrangler 的 JS 入口，零 shim、零 shell 介入，token 中的 & $ 等不会被 shell 转义
const WRANGLER_ENTRY = require.resolve("wrangler", { paths: [SCRIPT_ROOT] });
const NODE_BIN = process.execPath; // 当前 node 解释器路径
const KEY_TOKEN = "CLOUDFLARE_API_TOKEN";

// 回显用：绝对路径折叠成仓库相对路径，含空格等特殊字符的项加 JSON 引号，避免被误读成两个参数
function quoteArg(arg) {
    // 只折叠仓库内路径：仓库外的 --outdir（如 C:\tmp\x）折成 ../../tmp/x 会误导事故复盘
    const relative = path.relative(ROOT, arg);
    const shown = path.isAbsolute(arg) && !relative.startsWith("..") ? relative : arg;
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(shown) ? shown : JSON.stringify(shown);
}

// 朴素的 .env 解析：KEY=VALUE，忽略空行与 # 注释，去掉两端成对引号
// 键名只认大写（与 .env.example 一致）：POSIX 的 process.env 精确匹配键名，
// 若放行小写键会写进一个后续永远读不到的小写变量，登录态看起来「配置了却不生效」。
// 不支持 export 前缀 / 反斜杠转义 / 多行值 —— 本项目 token 不含特殊字符，足够
function loadDotenv(filePath) {
    if (!fs.existsSync(filePath)) return; // 无 .env 不报错，由 token 检查统一处理
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const [, key, value] = m;
        const val = value.replace(/^['"]|['"]$/g, "");
        // 不覆盖已存在的 shell 环境变量；保持「显式 > 文件」的优先级
        if (process.env[key] === undefined) process.env[key] = val;
    }
}

const parsed = parseDeployArgs(process.argv.slice(2));
if (parsed.error) {
    console.error(`❌ ${parsed.error}`);
    process.exit(1);
}
const { envName, wranglerArgs, printArgs } = parsed;

// 不足以中止但会让部署目标偏离预期的情况（如 --env 重复），必须留痕
for (const warning of parsed.warnings) {
    console.error(`⚠️  ${warning}`);
}

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

// 干跑：只回显 wrangler 实际会收到的参数，不触网、不需要有效 token。
// 必须显式传 --print-args 才触发（旧实现用环境变量 DEPLOY_PRINT_ARGS=1，遗留就会把真实发布
// 静默变成 no-op）。横幅与内容都走 stderr，让「没发布」在日志里一眼可辨。
if (printArgs) {
    console.error("[干跑] 未执行发布。wrangler 将收到的参数：");
    console.error(JSON.stringify(["deploy", ...wranglerArgs]));
    process.exit(0);
}

if (!process.env[KEY_TOKEN]) {
    console.error(
        `❌ 未检测到 CLOUDFLARE_API_TOKEN。\n` +
            `   请在项目根 ${envFile} 中写入账号级 Token（模板：.env.example）。\n` +
            `   获取：CF Dashboard → 我的个人资料 → API Tokens → Create Token → Edit Cloudflare Workers。\n` +
            `   缺失时不静默回退浏览器 OAuth。`
    );
    process.exit(1);
}

// 回显实际命令：2026-11-16 的误发布事故里，多出来的 "--" 只体现在这一行参数上，
// 打出来才能当场看出 --dry-run 是否真的在参数里。
console.log(`→ 实际执行：wrangler ${["deploy", ...wranglerArgs].map(quoteArg).join(" ")}`);

// 不传 shell:true：避免 PowerShell / Git Bash 对 token 中的 & $ 等做 shell 转义
const result = spawnSync(NODE_BIN, [WRANGLER_ENTRY, "deploy", ...wranglerArgs], {
    stdio: "inherit",
    env: process.env,
});

// spawnSync 在二进制不存在时 status=null、error.code=ENOENT，stdio:'inherit' 不会把这些打到终端
// 主动打印出来，避免「ELIFECYCLE Command failed with exit code 1」但看不到任何错信息的盲区
if (result.error) {
    console.error(`❌ 无法执行 ${NODE_BIN} ${WRANGLER_ENTRY}：${result.error.message}`);
    if (result.error.code === "ENOENT") {
        console.error(
            "   请先运行 pnpm install 生成 wrangler 安装（scripts/load-deploy-env.mjs 依赖 require.resolve('wrangler')）。"
        );
    }
    process.exit(1);
}

// 被信号中断（如 Ctrl-C）时 status 为 null，统一 exit(1) 会把「用户主动中止」记成失败。
if (result.signal) {
    try {
        process.kill(process.pid, result.signal);
    } catch {
        process.exit(1);
    }
}

process.exit(result.status ?? 1);
