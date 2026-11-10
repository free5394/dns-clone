// vitest.config.ts — 阶段 F：vitest-pool-workers 测试配置
// 从 vitest/config 导入 defineProject，用于 multi-project 配置（R1 修订）
import { configDefaults, defineProject } from "vitest/config";
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
        // .agents/ 是 DSH worktree 的落地目录、.scratch/ 是本地临时产物目录，两者都被
        // .gitignore 忽略但仍在仓库树下；不排除会把同一批用例跑两遍（实测 27 → 54 个文件），
        // 也让残留 worktree 的失败测试冒充主仓失败。
        exclude: [...configDefaults.exclude, "**/.agents/**", "**/.scratch/**"],
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
            // 阈值按下表的实测基线（2026-11-08，D3 补测后）留约 2 个百分点余量，
            // 目的不是追求高覆盖，而是阻止覆盖率在不被察觉的情况下倒退：
            // 实测 statements 84.30 / branches 76.71 / functions 87.70 / lines 86.58。
            // 说明：src/ui/** 与 src/index.js 被 exclude，所以 templates.js 与 worker 入口不在覆盖范围内。
            thresholds: {
                lines: 84,
                functions: 85,
                statements: 82,
                branches: 74,
            },
        },
    },
});
