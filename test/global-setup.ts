// global-setup.ts — 阶段 F：全局预检（Node 侧，worker 外执行一次，Q14 决策）
// 真正的迁移应用与种子数据在 setupFiles（apply-migrations.ts，可访问 cloudflare:test env）中完成；
// 这里只做一次文件级预检，提前暴露配置错误。
import { readdirSync } from "node:fs";
import { join } from "node:path";

export default function () {
    const dir = join(__dirname, "..", "src", "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    if (files.length === 0) {
        throw new Error("未找到 D1 迁移文件（src/db/migrations/*.sql），无法运行测试。");
    }
    console.log(`[global-setup] 检测到 ${files.length} 个 D1 迁移文件: ${files.join(", ")}`);
}
