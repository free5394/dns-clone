// apply-migrations.ts — 阶段 F：每个测试文件执行前应用 D1 迁移并注入测试账号
// 官方模式：顶层 await（setup 文件运行在 per-test-file 存储隔离之外，可能执行多次；
// applyD1Migrations 只应用未应用的迁移，因此重复执行安全）
import { env, applyD1Migrations } from "cloudflare:test";
import { hashPassword } from "../src/util/auth.ts";

// TEST_MIGRATIONS 是 vitest.config.ts 经 miniflare bindings 注入的 D1Migration[] 绑定
const migrations = (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
await applyD1Migrations(env.WUYA, migrations);

// 生成测试账号种子数据：登录所需的 ADMIN_PASSWORD_HASH + PASSWORD_SALT
// 使用固定的测试 salt，确保多次运行幂等且断言可定位
const TEST_SALT = "test-salt";
const hash = await hashPassword("test-password-123", TEST_SALT);
await env.WUYA.batch([
    env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?)").bind(hash),
    env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('PASSWORD_SALT', ?)").bind(TEST_SALT),
    // GitHub 设置（供 ip_sources 同步测试使用，值均为测试占位）
    env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('GITHUB_TOKEN', ?)").bind("ghp_test_token"),
    env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('GITHUB_OWNER', ?)").bind("test-owner"),
    env.WUYA.prepare("INSERT INTO settings (key, value) VALUES ('GITHUB_REPO', ?)").bind("test-repo"),
]);
