// vitest.config.ts — 阶段 F：vitest-pool-workers 测试配置
// 从 vitest/config 导入 defineProject，用于 multi-project 配置（R1 修订）
import { defineProject } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
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
            // 阶段 2 起始阈值：FIX-10 落地后逐步提升
            thresholds: {
                lines: 0,
                functions: 0,
                statements: 0,
                branches: 0,
            },
        },
    },
});
