// reset-local-admin.mjs — 本地 D1 管理员密码重置
//
// 场景：`pnpm dev` 起本地 Worker 后忘了管理员密码。PBKDF2 不可逆，只能重置。
// 默认：删掉 ADMIN_PASSWORD_HASH / PASSWORD_SALT 两行 → 刷新页面回到初始化页重设。
// 加 --password <明文>：直接把新哈希写进库，刷新即可登录（密码 8–1024 字符）。
// 只读写 .wrangler/state/v3/d1 下的本地库，不碰远端；写前默认先备份到 .scratch/backup/。
//
// 用法：
//   pnpm reset:local-admin                       # 回到初始化页
//   pnpm reset:local-admin --password <新密码>    # 直接写入新密码
//   pnpm reset:local-admin --no-backup           # 跳过备份（不推荐）
//   pnpm reset:local-admin --help

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    buildResetStatements,
    generateSalt,
    hashPassword,
    isValidPassword,
    pickLocalDatabase,
} from "./reset-local-admin-lib.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const D1_STATE_DIR = path.join(ROOT, ".wrangler", "state", "v3", "d1");
const BACKUP_DIR = path.join(ROOT, ".scratch", "backup");

const USAGE = `本地管理员密码重置（只作用于 .wrangler/state/v3/d1 下的本地库）

用法：
  pnpm reset:local-admin                      删除密码两行，刷新页面回到初始化页重设
  pnpm reset:local-admin --password <新密码>   直接写入新密码（8–1024 字符），刷新即可登录
  pnpm reset:local-admin --no-backup          跳过写前备份
  pnpm reset:local-admin --help               显示本帮助

注意：脚本会清空 sessions（旧登录态失效）与 login_attempts（避免刚重置就被限流挡门外）。`;

/** 解析命令行参数；--password 后必须紧跟值 */
function parseArgs(argv) {
    const options = { password: null, backup: true, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--no-backup") {
            options.backup = false;
        } else if (arg === "--password") {
            const value = argv[i + 1];
            if (value === undefined) throw new Error("--password 后面缺少密码值。");
            options.password = value;
            i++;
        } else if (arg.startsWith("--password=")) {
            options.password = arg.slice("--password=".length);
        } else {
            throw new Error(`无法识别的参数：${arg}`);
        }
    }
    return options;
}

/** 读出目录里每个 sqlite 文件的表名；读不了（被锁/结构不同）返回 null 由上层跳过 */
function listTables(file) {
    let db = null;
    try {
        db = new DatabaseSync(file, { readOnly: true });
        return db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((row) => row.name);
    } catch {
        return null;
    } finally {
        db?.close();
    }
}

/** 收集 .wrangler/state/v3/d1/<object>/*.sqlite 候选 */
function collectCandidates() {
    if (!fs.existsSync(D1_STATE_DIR)) {
        throw new Error(
            `未找到本地 D1 状态目录：${path.relative(ROOT, D1_STATE_DIR)}，请先在仓库根目录运行一次 pnpm dev。`
        );
    }
    const candidates = [];
    for (const dirent of fs.readdirSync(D1_STATE_DIR, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const dir = path.join(D1_STATE_DIR, dirent.name);
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith(".sqlite")) continue;
            const full = path.join(dir, name);
            const tables = listTables(full);
            if (tables) candidates.push({ path: full, tables });
        }
    }
    return candidates;
}

/** 写前备份（VACUUM INTO 产出单文件快照，不会带走 WAL 残留） */
function backupDatabase(file) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const target = path.join(BACKUP_DIR, `${stamp}-${path.basename(file)}`);
    const db = new DatabaseSync(file);
    try {
        db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    } finally {
        db.close();
    }
    return target;
}

/** 在单个事务里执行语句串：中途失败整体回滚，不留「新盐配旧哈希」的半坏状态 */
function applyStatements(file, statements) {
    const db = new DatabaseSync(file);
    try {
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const sql of statements) db.exec(sql);
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/SQLITE_BUSY|database is locked/i.test(message)) {
            throw new Error("本地库正被 pnpm dev 占用，请先停掉 dev server 再重试。", { cause: error });
        }
        throw error;
    } finally {
        db.close();
    }
}

/** 读回现状，用于给出可核对的结论 */
function readPasswordState(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const hash = db.prepare("SELECT value FROM settings WHERE key = 'ADMIN_PASSWORD_HASH'").get();
        const salt = db.prepare("SELECT value FROM settings WHERE key = 'PASSWORD_SALT'").get();
        const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
        const attempts = db.prepare("SELECT COUNT(*) AS n FROM login_attempts").get();
        return { hash: hash?.value ?? null, salt: salt?.value ?? null, sessions: sessions.n, attempts: attempts.n };
    } finally {
        db.close();
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(USAGE);
        return;
    }

    let hash = null;
    let salt = null;
    if (options.password !== null) {
        if (!isValidPassword(options.password)) {
            throw new Error("--password 长度必须在 8 到 1024 个字符之间。");
        }
        salt = generateSalt();
        hash = await hashPassword(options.password, salt);
    }

    const target = pickLocalDatabase(collectCandidates());
    console.log(`✅ 目标库：${path.relative(ROOT, target)}`);

    if (options.backup) {
        console.log(`✅ 已备份：${path.relative(ROOT, backupDatabase(target))}`);
    }

    applyStatements(target, buildResetStatements({ hash, salt }));

    const state = readPasswordState(target);
    console.log(`✅ 密码哈希：${hash ? "已写入新哈希" : "已删除（等待初始化页重设）"}`);
    console.log(`✅ 已清空会话 ${state.sessions} 条、失败记录 ${state.attempts} 条`);
    if (hash) {
        console.log("👉 刷新 http://localhost:8787/admin，用刚设置的密码登录。");
    } else {
        console.log("👉 刷新 http://localhost:8787，页面会回到初始化页，设置新密码即可登录。");
    }
}

main().catch((error) => {
    console.error(`❌ 重置失败：${error instanceof Error ? error.message : error}`);
    if (error instanceof Error && error.stack && process.env.DEBUG) console.error(error.stack);
    process.exit(1);
});
