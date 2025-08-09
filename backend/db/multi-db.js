const sqlite3 = require('sqlite3').verbose();
const { 
    DB_FILE, 
    SETTINGS_DB_FILE, 
    HISTORY_DB_FILE, 
    INDEX_DB_FILE 
} = require('../config');
const logger = require('../config/logger');

// 可通过环境变量调整 SQLite PRAGMA 与参数（提供合理默认值）
const SQLITE_JOURNAL_MODE = (process.env.SQLITE_JOURNAL_MODE || 'WAL').toUpperCase();
const SQLITE_SYNCHRONOUS = (process.env.SQLITE_SYNCHRONOUS || 'NORMAL').toUpperCase();
const SQLITE_TEMP_STORE = (process.env.SQLITE_TEMP_STORE || 'MEMORY').toUpperCase();
const SQLITE_CACHE_SIZE = Number.isFinite(parseInt(process.env.SQLITE_CACHE_SIZE, 10)) ? parseInt(process.env.SQLITE_CACHE_SIZE, 10) : -8000; // 负值=KB
const SQLITE_MMAP_SIZE = Number.isFinite(parseInt(process.env.SQLITE_MMAP_SIZE, 10)) ? parseInt(process.env.SQLITE_MMAP_SIZE, 10) : 268435456; // 256MB
const SQLITE_BUSY_TIMEOUT = Number.isFinite(parseInt(process.env.SQLITE_BUSY_TIMEOUT, 10)) ? parseInt(process.env.SQLITE_BUSY_TIMEOUT, 10) : 10000; // ms

// 数据库连接池
const dbConnections = {};

// 创建数据库连接的通用函数
const createDBConnection = (dbPath, dbName) => {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                logger.error(`无法连接或创建 ${dbName} 数据库: ${err.message}`);
                reject(err);
                return;
            }
            logger.info(`成功连接到 ${dbName} 数据库:`, dbPath);
            
            // 配置数据库参数
            db.configure('busyTimeout', SQLITE_BUSY_TIMEOUT); // 增加超时时间
            
            // 性能优化 PRAGMA（可通过环境变量覆盖默认值）
            try {
                db.run(`PRAGMA synchronous = ${SQLITE_SYNCHRONOUS};`);
                db.run(`PRAGMA temp_store = ${SQLITE_TEMP_STORE};`);
                db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE};`);
                db.run(`PRAGMA journal_mode = ${SQLITE_JOURNAL_MODE};`);
                db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE};`);
                db.run('PRAGMA foreign_keys = ON;');
                db.run('PRAGMA optimize;');
            } catch (e) {
                logger.warn(`${dbName} PRAGMA 优化参数设置失败:`, e.message);
            }
            
            resolve(db);
        });
    });
};

// 初始化所有数据库连接
const initializeConnections = async () => {
    try {
        // 主数据库（图片/视频索引）
        dbConnections.main = await createDBConnection(DB_FILE, '主数据库');
        
        // 设置数据库
        dbConnections.settings = await createDBConnection(SETTINGS_DB_FILE, '设置数据库');
        
        // 历史记录数据库
        dbConnections.history = await createDBConnection(HISTORY_DB_FILE, '历史记录数据库');
        
        // 索引数据库
        dbConnections.index = await createDBConnection(INDEX_DB_FILE, '索引数据库');

        logger.info('所有数据库连接已初始化完成');
        return dbConnections;
    } catch (error) {
        logger.error('初始化数据库连接失败:', error.message);
        throw error;
    }
};

// 获取指定数据库连接
const getDB = (dbType = 'main') => {
    if (!dbConnections[dbType]) {
        throw new Error(`数据库连接 ${dbType} 不存在`);
    }
    return dbConnections[dbType];
};

// 关闭所有数据库连接
const closeAllConnections = () => {
    return Promise.all(
        Object.entries(dbConnections).map(([name, db]) => {
            return new Promise((resolve) => {
                db.close((err) => {
                    if (err) {
                        logger.error(`关闭 ${name} 数据库连接失败:`, err.message);
                    } else {
                        logger.info(`成功关闭 ${name} 数据库连接`);
                    }
                    resolve();
                });
            });
        })
    );
};

// 通用数据库操作函数
const runAsync = (dbType, sql, params = [], successMessage = '') => {
    const db = getDB(dbType);
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                logger.error(`[${dbType}] 数据库操作失败: ${sql}`, err.message);
                return reject(err);
            }
            if (successMessage) logger.info(`[${dbType}] ${successMessage}`);
            resolve(this);
        });
    });
};

const dbRun = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

const dbAll = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

const dbGet = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

// 检查表和列是否存在
const hasColumn = (dbType, table, column) => {
    const db = getDB(dbType);
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table})`, (err, rows) => {
            if (err) return reject(err);
            resolve(rows.some(row => row.name === column));
        });
    });
};

const hasTable = (dbType, table) => {
    const db = getDB(dbType);
    return new Promise((resolve, reject) => {
        db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table], (err, rows) => {
            if (err) return reject(err);
            resolve(rows.length > 0);
        });
    });
};

module.exports = {
    initializeConnections,
    getDB,
    closeAllConnections,
    runAsync,
    dbRun,
    dbAll,
    dbGet,
    hasColumn,
    hasTable,
    dbConnections
}; 