// predeploy.cjs — 部署前校验：确保 wrangler.toml 中 database_id 的哨兵值已替换
// 由 package.json#scripts.predeploy 调用

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "wrangler.toml");
// FIX-20: 哨兵值（sentinel）是"未配置"的约定标记，见 GLOSSARY.md。
// 只判定它本身与空值，不判定取值"看起来像什么"：D1 的 database_id 在 wrangler schema 里是裸 string
// （无 pattern 约束，且允许缺省由自动供给回写），格式与存在性交给 wrangler / Cloudflare，本地再猜格式只会误伤合法值。
const SENTINEL = "REPLACE_WITH_YOUR_D1_ID";

let raw;
try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
} catch {
    console.error("❌ 找不到 wrangler.toml，请从仓库根目录运行 pnpm predeploy");
    process.exit(1);
}

// FIX-20: 按值判定，而不是对整个文件做 includes()。
// 旧实现 includes(SENTINEL) 会命中文件头说明注释里的哨兵串，用户把 database_id 换成真实值后依旧永久误报失败。
// 这里按行扫描 TOML 子集：跳过注释行、跟踪当前表名、只取 key = value 的字面量（零依赖）。
// 承诺的子集：非注释行上的 key = "值" / '值' / 裸值，行尾 # 注释被排除；不处理多行字符串与转义写法。
function readD1Entries(text) {
    const entries = [];
    let entry = null; // 当前 [[d1_databases]] 条目
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue; // 整行注释不参与判断

        const header = trimmed.replace(/\s+#.*$/, "").match(/^\[\[?([^\]]+)\]\]?$/);
        if (header) {
            const table = header[1].trim();
            // 顶层 [[d1_databases]] 与 [[env.<name>.d1_databases]] 都要校验
            const isD1 = table === "d1_databases" || table.endsWith(".d1_databases");
            entry = isD1 ? { binding: "", database_id: "" } : null;
            if (entry) entries.push(entry);
            continue;
        }
        if (!entry) continue;

        const kv = trimmed.match(/^([A-Za-z_][\w-]*)\s*=\s*(.+)$/);
        if (!kv) continue;
        const [, key, rhs] = kv;
        if (key !== "binding" && key !== "database_id") continue;
        // 只取引号内的字面量（裸值也接受），行尾的 # 注释天然被排除
        const value = rhs.match(/^\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/);
        entry[key] = value ? (value[1] ?? value[2] ?? value[3]) : "";
    }
    return entries;
}

const entries = readD1Entries(raw);

if (entries.length === 0) {
    console.error("❌ wrangler.toml 中找不到 [[d1_databases]] 配置，无法校验 database_id。");
    process.exit(1);
}

// FIX-20: 失败信息只报 binding 名与原因类别，不回显字段值（避免 ID 进 CI 日志，且哨兵值本身无信息量）
const labels = entries.map(({ binding }) => binding || "未命名 binding");
const unreplaced = [];
const missing = [];
for (const [i, { database_id: id }] of entries.entries()) {
    if (!id) missing.push(labels[i]);
    else if (id.trim().toUpperCase() === SENTINEL) unreplaced.push(labels[i]);
}

if (unreplaced.length > 0 || missing.length > 0) {
    const problems = [];
    if (unreplaced.length > 0) {
        problems.push(`- ${unreplaced.join("、")}：database_id 仍是未替换的占位符。`);
    }
    if (missing.length > 0) {
        problems.push(`- ${missing.join("、")}：database_id 缺失或为空。`);
    }
    console.error(
        "❌ wrangler.toml 中的 database_id 未就绪：\n" +
            problems.join("\n") +
            "\n   请先运行 wrangler d1 create 获取真实 D1 ID，然后替换 database_id。\n" +
            "   详见 README §CLI 部署指南。"
    );
    process.exit(1);
}

console.log(`✅ database_id 已就绪（${labels.join(", ")}），可以部署。`);
