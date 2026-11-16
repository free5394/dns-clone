// deploy-argv.d.mts — scripts/lib/deploy-argv.mjs 的手写类型声明
// 该 .mjs 在 workerd 内的测试里被 import，测试类型检查需要这份声明（tsc 不推断 .mjs）。

export interface ParsedDeployArgs {
    /** 要注入的环境名；null 表示读取默认 .env */
    envName: string | null;
    /** 原样透传给 wrangler deploy 的参数 */
    wranglerArgs: string[];
    /** 是否处于干跑模式（--print-args） */
    printArgs: boolean;
    /** 解析过程中值得提示但不足以中止的情况（如 --env 重复） */
    warnings: string[];
    /** 解析失败的中文说明；null 表示解析成功 */
    error: string | null;
}

export function parseDeployArgs(argv: string[]): ParsedDeployArgs;
