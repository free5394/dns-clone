// vitest.config.ts — 阶段 F：vitest-pool-workers 测试配置
// 从 vitest/config 导入 defineProject，用于 multi-project 配置（R1 修订）
import { defineProject } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";

const migrationsPath = path.join(import.meta.dirname, "src/db/migrations");
const migrations = await readD1Migrations(migrationsPath);

export default defineProject({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        }),
    ],
    test: {
        globalSetup: ["./test/global-setup.ts"],
        setupFiles: ["./test/apply-migrations.ts"],
        // Q14 决策：单 worker 串行（避免 D1 SQLite 多进程锁）+ 文件级并行
        maxWorkers: 1,
        fileParallelism: true,
        coverage: {
            // workerd 运行时没有 node:inspector，v8 provider 无法工作，
            // Cloudflare 官方要求使用 istanbul 插桩式覆盖率。
            provider: "istanbul",
            reporter: ["text", "html", "lcov"],
            include: ["src/**/*.ts"],
            exclude: ["src/ui/**", "src/index.js"],
            // 阈值按下表的实测基线（2026-11-05，含 test/fetch.test.ts 后）留约 2 个百分点余量，
            // 目的不是追求高覆盖，而是阻止覆盖率在不被察觉的情况下倒退：
            // 实测 statements 80.15 / branches 71.56 / functions 85.53 / lines 83.44。
            // 说明：src/ui/** 与 src/index.js 被 exclude，所以 templates.js 与 worker 入口不在覆盖范围内。
            thresholds: {
                lines: 81,
                functions: 83,
                statements: 78,
                branches: 69,
            },
        },
    },
});
