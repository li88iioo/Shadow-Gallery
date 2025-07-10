const sqlite3 = require('sqlite3').verbose();
const { DB_FILE } = require('../config');
const logger = require('../config/logger');

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        logger.error(`无法连接或创建 SQLite 数据库: ${err.message}.`);
        process.exit(1);
    }
    logger.info('成功连接到 SQLite 数据库:', DB_FILE);
});

db.configure('busyTimeout', 5000);
// 性能优化 PRAGMA
try {
    db.run('PRAGMA synchronous = NORMAL;'); // 写入同步级别，兼顾安全和性能
    db.run('PRAGMA temp_store = MEMORY;'); // 临时表放内存
    db.run('PRAGMA cache_size = -8000;'); // 8MB 内存缓存
    db.run('PRAGMA journal_mode = WAL;'); // 已有，可保留
    db.run('PRAGMA mmap_size = 268435456;'); // 256MB 内存映射
    db.run('PRAGMA foreign_keys = ON;'); // 保证外键约束
    db.run('PRAGMA optimize;'); // 自动优化
} catch (e) { logger.warn('PRAGMA 优化参数设置失败:', e.message); }

const hasColumn = (table, column) => new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
        if (err) return reject(err);
        resolve(rows.some(row => row.name === column));
    });
});

const hasTable = (table) => new Promise((resolve, reject) => {
    db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table], (err, rows) => {
        if (err) return reject(err);
        resolve(rows.length > 0);
    });
});

const initializeDB = () => new Promise(async (resolve, reject) => {
    db.run('PRAGMA journal_mode = WAL;', (walErr) => {
        if (walErr) {
            logger.error(`[Main-Thread] 开启 WAL 模式失败: ${walErr.message}`);
        } else {
            logger.info('[Main-Thread] 成功开启 WAL 模式。');
        }
    });

    db.serialize(async () => {
        try {
            // 1. 创建 migrations 记录表
            await runAsync(`CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY, applied_at DATETIME NOT NULL)`);

            // 2. 定义所有迁移步骤
            const allMigrations = [
                {
                    key: 'create_items_table',
                    sql: `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, type TEXT NOT NULL, cover_path TEXT, last_viewed_at DATETIME)`
                },
                {
                    key: 'add_cover_path_column',
                    sql: `ALTER TABLE items ADD COLUMN cover_path TEXT`,
                    check: async () => !(await hasColumn('items', 'cover_path'))
                },
                {
                    key: 'add_last_viewed_at_column',
                    sql: `ALTER TABLE items ADD COLUMN last_viewed_at DATETIME`,
                    check: async () => !(await hasColumn('items', 'last_viewed_at'))
                },
                {
                    key: 'create_view_history_table',
                    sql: `CREATE TABLE IF NOT EXISTS view_history (user_id TEXT NOT NULL, item_path TEXT NOT NULL, viewed_at DATETIME NOT NULL, PRIMARY KEY (user_id, item_path))`
                },
                {
                    key: 'create_items_fts',
                    sql: `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(name, content='items', content_rowid='id', tokenize = "unicode61")`
                },
                {
                    key: 'create_trigger_items_ai',
                    sql: `CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid, name) VALUES (new.id, new.name); END;`
                },
                {
                    key: 'create_trigger_items_ad',
                    sql: `CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, name) VALUES ('delete', old.id, old.name); END;`
                },
                {
                    key: 'create_trigger_items_au',
                    sql: `CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, name) VALUES ('delete', old.id, old.name); INSERT INTO items_fts(rowid, name) VALUES (new.id, new.name); END;`
                },
                {
                    key: 'drop_idx_items_type',
                    sql: `DROP INDEX IF EXISTS idx_items_type`
                },
                {
                    key: 'create_idx_items_type_id',
                    sql: `CREATE INDEX IF NOT EXISTS idx_items_type_id ON items(type, id)`
                }
            ];

            // 3. 依次执行未完成的迁移
            for (const m of allMigrations) {
                const done = await dbAll("SELECT 1 FROM migrations WHERE key = ?", [m.key]);
                const needRun = m.check ? await m.check() : true;
                if (!done.length && needRun) {
                    await runAsync(m.sql);
                    await runAsync("INSERT INTO migrations (key, applied_at) VALUES (?, ?)", [m.key, new Date().toISOString()]);
                    logger.info(`[DB MIGRATION] 执行迁移: ${m.key}`);
                }
            }
            logger.info('所有数据库迁移已完成。');
            resolve();
        } catch (err) {
            logger.error('[DB MIGRATION] 迁移失败:', err.message);
            reject(err);
        }
    });
});

const runAsync = (sql, params = [], successMessage = '') => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        if (err) {
            logger.error(`数据库操作失败: ${sql}`, err.message);
            return reject(err);
        }
        if (successMessage) logger.info(successMessage);
        resolve(this);
    });
});

const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) {
    if (err) rej(err); else res(this);
}));

const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => {
    if (err) rej(err); else res(rows);
}));


module.exports = {
    db,
    initializeDB,
    dbRun,
    dbAll
};