// deploy-argv.mjs — 生产部署参数解析（纯函数，无副作用）
// 单独成文件是为了能被测试直接 import：pnpm 透传分隔符 "--" 让 --dry-run 失效的那次真实发布事故
// （2026-11-16 实测推上生产）就出在这段逻辑上，而它此前零测试覆盖。
// 本文件不读文件、不读环境变量、不调用 process.exit，解析失败一律用返回值上报。

// 环境名会拼进 .env.<name> 与 wrangler.<name>.toml 的文件名，白名单挡掉路径穿越（如 --env ../../x）。
const ENV_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const PRINT_ARGS_FLAG = "--print-args";

function reject(message) {
    return { envName: null, wranglerArgs: [], printArgs: false, error: message };
}

function checkEnvName(raw) {
    if (!raw) return reject("--env 缺少环境名（用法：--env prod 或 --env=prod）。");
    if (!ENV_NAME_PATTERN.test(raw)) {
        return reject(`--env 的值 "${raw}" 含非法字符：只允许字母、数字、下划线与短横线。`);
    }
    return null;
}

/**
 * 解析 pnpm 之后的 argv（即 process.argv.slice(2)）。
 *
 * 规则：
 *   1) 裸 "--" 直接丢弃。pnpm run <script> -- <args> 会把分隔符原样放进 argv，而 wrangler 遇到 "--"
 *      即停止选项解析，其后的 --dry-run 退化成位置参数被忽略，命令变成真实发布。
 *   2) --env <name> / --env=<name> 由本脚本剥离，不透传给 wrangler（wrangler 原生 --env 选的是
 *      配置文件内的 [env.x] 段落，wrangler.<env>.toml 没有这种段落）。重复出现取最后一次。
 *   3) --print-args 剥离出来做干跑开关，调用方打印参数后退出，不触网。
 *   4) 其余参数原样透传（如 --dry-run --outdir）。
 *
 * @param {string[]} argv
 * @returns {{ envName: string | null, wranglerArgs: string[], printArgs: boolean, error: string | null }}
 */
export function parseDeployArgs(argv) {
    let envName = null;
    let printArgs = false;
    const wranglerArgs = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === "--") continue;

        if (arg === PRINT_ARGS_FLAG) {
            printArgs = true;
            continue;
        }

        const inline = arg.match(/^--env=(.*)$/);
        if (inline) {
            const invalid = checkEnvName(inline[1]);
            if (invalid) return invalid;
            envName = inline[1];
            continue;
        }

        if (arg === "--env") {
            const value = argv[i + 1];
            // 漏写环境名时下一个 token 常是别的选项，不能拿它当环境名去拼 .env.<flag>
            if (value === undefined || value.startsWith("--")) {
                return reject("--env 缺少环境名（用法：--env prod 或 --env=prod）。");
            }
            const invalid = checkEnvName(value);
            if (invalid) return invalid;
            envName = value;
            i += 1;
            continue;
        }

        wranglerArgs.push(arg);
    }

    return { envName, wranglerArgs, printArgs, error: null };
}
