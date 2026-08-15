// predeploy.cjs — 部署前校验：确保 database_id 占位符已替换为真实 D1 UUID
// 由 package.json#scripts.predeploy 调用

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "wrangler.toml");
const PLACEHOLDER = "REPLACE_WITH_YOUR_D1_ID";

let raw;
try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
} catch {
    console.error("❌ 找不到 wrangler.toml，请从仓库根目录运行 pnpm predeploy");
    process.exit(1);
}

if (raw.includes(PLACEHOLDER)) {
    console.error(
        "❌ wrangler.toml 中的 database_id 仍为占位符 " +
            `"${PLACEHOLDER}"。\n` +
            "   请先运行 wrangler d1 create 获取真实 D1 UUID，然后替换占位符。\n" +
            "   详见 README §CLI 部署指南。"
    );
    process.exit(1);
}

console.log("✅ database_id 已配置，可以部署。");
