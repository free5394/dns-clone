// vitest.node.config.ts — Node 环境测试项目：只收 scripts/ 下的进程级接线用例。
// 为什么另开：workerd 项目（vitest.config.ts）拿不到 node:fs / node:child_process，而被测对象是
// 「子进程怎么被启动、参数怎么被剥接、缺文件怎么退出」；这两个项目由 package.json 的
// test / test:coverage 依次执行。
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/node/**/*.test.ts"],
        exclude: [...configDefaults.exclude, "**/.agents/**", "**/.scratch/**"],
        // 用例以子进程方式跑 scripts/ 下的脚本，脚本不在模块图里；不显式声明，改了脚本 watch 也不会重跑
        forceRerunTriggers: ["**/scripts/**", "**/test/node/**"],
    },
});
