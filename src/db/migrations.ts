// migrations.ts — D1 数据库初始化与迁移
// 从 index.legacy.js 整体搬入（原 123-237 行）
// 修订 R2：不引入 schema_version 表，旧幂等逻辑完整保留（已部署实例不受影响）
// schema 演进留到阶段 F 测试体系就绪后

import { getSetting, setSetting, getCfApiSettings, queryAll } from './client.ts';
import { getZoneName } from '../util/cf.ts';

/** 初始化/迁移数据库：幂等，可重复执行 */
export async function initializeAndMigrateDatabase(env: { WUYA: D1Database }): Promise<void> {
    if (!env.WUYA) {
        throw new Error("未检测到 D1 数据库绑定 'WUYA'，请在 Worker 设置中配置。");
    }
    const db = env.WUYA;

    // P1-8 门控：上次迁移在 24h 内则跳过，避免每请求执行整套 DDL
    const lastMigratedAt = await getSetting(db, 'last_migrated_at');
    const isFresh = !lastMigratedAt;
    const isStale = isFresh || (Date.now() - new Date(lastMigratedAt).getTime()) > 24 * 60 * 60 * 1000;
    if (!isStale) return;

    const expectedSchemas: Record<string, string[]> = {
        settings: ['key TEXT PRIMARY KEY NOT NULL', 'value TEXT NOT NULL'],
        domains: [
            'id INTEGER PRIMARY KEY AUTOINCREMENT',
            'source_domain TEXT NOT NULL',
            'target_domain TEXT NOT NULL',
            'zone_id TEXT NOT NULL',
            'is_deep_resolve INTEGER NOT NULL DEFAULT 1',
            'ttl INTEGER NOT NULL DEFAULT 60',
            'notes TEXT',
            'last_synced_records TEXT DEFAULT \'[]\'',
            'last_synced_time TIMESTAMP',
            'last_sync_status TEXT DEFAULT \'pending\'',
            'last_sync_error TEXT',
            'is_enabled INTEGER DEFAULT 1 NOT NULL',
            'is_system INTEGER NOT NULL DEFAULT 0',
            'UNIQUE(target_domain)'
        ],
        sessions: ['token TEXT PRIMARY KEY NOT NULL', 'expires_at TIMESTAMP NOT NULL'],
        login_attempts: [
            'ip TEXT NOT NULL',
            'attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
            'success INTEGER NOT NULL DEFAULT 0',
        ],
        ip_sources: [
            'id INTEGER PRIMARY KEY AUTOINCREMENT',
            'url TEXT NOT NULL UNIQUE',
            'github_path TEXT NOT NULL UNIQUE',
            'commit_message TEXT NOT NULL',
            'fetch_strategy TEXT',
            'last_synced_time TIMESTAMP',
            'last_sync_status TEXT DEFAULT \'pending\'',
            'last_sync_error TEXT',
            'is_enabled INTEGER DEFAULT 1 NOT NULL'
        ]
    };

    const createStmts = Object.keys(expectedSchemas).map(tableName =>
        db.prepare(`CREATE TABLE IF NOT EXISTS ${tableName} (${expectedSchemas[tableName].join(', ')});`)
    );
    await db.batch(createStmts);

    for (const tableName in expectedSchemas) {
        const { results: existingColumns } = await db.prepare(`PRAGMA table_info(${tableName})`).all();
        const existingColumnNames = existingColumns.map(c => c.name);
        const expectedColumnDefs = expectedSchemas[tableName].filter(def => !def.startsWith('UNIQUE'));

        for (const columnDef of expectedColumnDefs) {
            const columnName = columnDef.split(' ')[0];
            if (!existingColumnNames.includes(columnName)) {
                // 显式抛错：迁移失败不可被吞，避免业务 SQL 运行时才暴露列缺失
                await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`).run();
            }
        }
    }

    const { token, zoneId } = await getCfApiSettings(db);
    if (!token || !zoneId) return;

    // 索引与清理：登录尝试表 + 索引（计划 FIX-05）
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at)").run();
    await db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 hour')").run();

    const invalidDomains = await queryAll<{ id: number; target_domain: string }>(
        db,
        "SELECT id, target_domain FROM domains WHERE target_domain LIKE '%.'"
    );
    if (invalidDomains.length > 0) {
        try {
            const zoneName = (await getZoneName(token, zoneId)).replace(/\.$/, '');
            const fixStmts = [];
            for (const domain of invalidDomains) {
                const prefix = domain.target_domain.replace(/\.+$/, '');
                const correctedDomain = (prefix === '' || prefix === '@') ? zoneName : `${prefix}.${zoneName}`;
                fixStmts.push(db.prepare("UPDATE domains SET target_domain = ? WHERE id = ?").bind(correctedDomain, domain.id));
            }
            await db.batch(fixStmts);
        } catch (e) {
            console.error("Failed to fix invalid domain entries:", e instanceof Error ? e.message : e);
        }
    }

    // 记录本次迁移时间，供下次门控使用
    await setSetting(db, 'last_migrated_at', new Date().toISOString());
}

/** 初始化默认数据（IP 源 + 系统域名），在配置 CF 凭据后调用 */
export async function ensureInitialData(db: D1Database, zoneId: string, zoneName: string): Promise<void> {
    if (!zoneId || !zoneName) return;

    await setSetting(db, 'THREE_NETWORK_SOURCE', (await getSetting(db, 'THREE_NETWORK_SOURCE')) || 'CloudFlareYes');

    interface InitialIpSource {
        url: string;
        path: string;
        msg: string;
        strategy: string;
    }
    const initialIpSources: InitialIpSource[] = [
        { url: 'https://ipdb.api.030101.xyz/?type=bestcf&country=true', path: '030101-bestcf.txt', msg: 'Update BestCF IPs from 030101.xyz', strategy: 'phantomjs_cloud' },
        { url: 'https://ipdb.api.030101.xyz/?type=bestproxy&country=true', path: '030101-bestproxy.txt', msg: 'Update BestProxy IPs from 030101.xyz', strategy: 'phantomjs_cloud' },
        { url: 'https://ip.164746.xyz', path: '164746.txt', msg: 'Update IPs from 164746.xyz', strategy: 'direct_regex' },
        { url: 'https://stock.hostmonit.com/CloudFlareYes', path: 'CloudFlareYes.txt', msg: 'Update CloudFlareYes IPs', strategy: 'phantomjs_cloud' },
        { url: 'https://ip.haogege.xyz', path: 'haogege.txt', msg: 'Update IPs from haogege.xyz', strategy: 'direct_regex' },
        { url: 'https://api.uouin.com/cloudflare.html', path: 'uouin-cloudflare.txt', msg: 'Update IPs from uouin.com', strategy: 'direct_regex' },
        { url: 'https://www.wetest.vip/page/cloudflare/address_v4.html', path: 'wetest-cloudflare-v4.txt', msg: 'Update Cloudflare v4 IPs from wetest.vip', strategy: 'direct_regex' },
        { url: 'https://www.wetest.vip/page/edgeone/address_v4.html', path: 'wetest-edgeone-v4.txt', msg: 'Update EdgeOne v4 IPs from wetest.vip', strategy: 'direct_regex' },
    ];
    const ipSourceStmts = initialIpSources.map(s =>
        db.prepare('INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO NOTHING')
          .bind(s.url, s.path, s.msg, s.strategy)
    );

    interface InitialDomain {
        source: string;
        prefix: string;
        notes: string;
        is_system: number;
        deep_resolve: number;
    }
    const initialDomains: InitialDomain[] = [
        { source: 'internal:hostmonit:yd', prefix: 'yd', notes: '移动', is_system: 1, deep_resolve: 1 },
        { source: 'internal:hostmonit:dx', prefix: 'dx', notes: '电信', is_system: 1, deep_resolve: 1 },
        { source: 'internal:hostmonit:lt', prefix: 'lt', notes: '联通', is_system: 1, deep_resolve: 1 },
        { source: 'snipaste1.speedip.eu.org', prefix: 'bp1', notes: 'bp1', is_system: 0, deep_resolve: 1 },
        { source: 'snipaste2.speedip.eu.org', prefix: 'bp2', notes: 'bp2', is_system: 0, deep_resolve: 1 },
        { source: 'snipaste3.speedip.eu.org', prefix: 'bp3', notes: 'bp3', is_system: 0, deep_resolve: 1 },
        { source: 'snipaste4.speedip.eu.org', prefix: 'bp4', notes: 'bp4', is_system: 0, deep_resolve: 1 },
        { source: 'snipaste5.speedip.eu.org', prefix: 'bp5', notes: 'bp5', is_system: 0, deep_resolve: 1 },
        { source: 'cf.090227.xyz', prefix: 'cm', notes: 'cm', is_system: 0, deep_resolve: 1 },
        { source: 'cf.877774.xyz', prefix: 'qms', notes: 'qms', is_system: 0, deep_resolve: 1 },
    ];
    const domainStmts = initialDomains.map(d => {
        const targetDomain = d.prefix === '@' ? zoneName : `${d.prefix}.${zoneName}`;
        return db.prepare('INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, notes, is_system) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(target_domain) DO NOTHING')
                 .bind(d.source, targetDomain, zoneId, d.deep_resolve, d.notes, d.is_system);
    });

    await db.batch([...ipSourceStmts, ...domainStmts]);
}
