-- 0001_initial.sql — 初始 schema（阶段 F 新增，供 vitest-pool-workers applyD1Migrations 使用）
-- 注意：与 src/db/migrations.ts 中 initializeAndMigrateDatabase 的 expectedSchemas 保持一致。
-- 生产环境的实际建表由 initializeAndMigrateDatabase 的幂等 DDL 完成（R2：不引入 schema_version 表）。

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_domain TEXT NOT NULL,
    target_domain TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    is_deep_resolve INTEGER NOT NULL DEFAULT 1,
    ttl INTEGER NOT NULL DEFAULT 60,
    notes TEXT,
    last_synced_records TEXT DEFAULT '[]',
    last_synced_time TIMESTAMP,
    last_sync_status TEXT DEFAULT 'pending',
    last_sync_error TEXT,
    is_enabled INTEGER DEFAULT 1 NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    UNIQUE(target_domain)
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY NOT NULL,
    expires_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT NOT NULL,
    attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at);

CREATE TABLE IF NOT EXISTS ip_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    github_path TEXT NOT NULL UNIQUE,
    commit_message TEXT NOT NULL,
    fetch_strategy TEXT,
    last_synced_time TIMESTAMP,
    last_sync_status TEXT DEFAULT 'pending',
    last_sync_error TEXT,
    is_enabled INTEGER DEFAULT 1 NOT NULL
);
