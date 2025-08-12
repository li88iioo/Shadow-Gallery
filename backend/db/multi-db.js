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
const QUERY_TIMEOUT = process.env.SQLITE_QUERY_TIMEOUT ? parseInt(process.env.SQLITE_QUERY_TIMEOUT, 10) : 15000; // 15 seconds default

/**
 * 为 Promise 添加超时功能
 * @param {Promise} promise - 要执行的 Promise
 * @param {number} ms - 超时毫秒数
 * @param {object} queryInfo - 查询信息，用于日志记录
 * @returns {Promise} - 带超时的 Promise
 */
const withTimeout = (promise, ms, queryInfo) => {
    const timeout = new Promise((_, reject) => {
        const id = setTimeout(() => {
            clearTimeout(id);
            const error = new Error(`Query timed out after ${ms}ms. Query: ${queryInfo.sql}`);
            error.code = 'SQLITE_TIMEOUT';
            reject(error);
        }, ms);
    });
    return Promise.race([promise, timeout]);
};

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
            
            db.configure('busyTimeout', SQLITE_BUSY_TIMEOUT);
            
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
        dbConnections.main = await createDBConnection(DB_FILE, '主数据库');
        dbConnections.settings = await createDBConnection(SETTINGS_DB_FILE, '设置数据库');
        dbConnections.history = await createDBConnection(HISTORY_DB_FILE, '历史记录数据库');
        dbConnections.index = await createDBConnection(INDEX_DB_FILE, '索引数据库');

        // 仅做连接级别配置，避免在此处创建/索引业务表，防止多 Worker 并发下的竞态
        try {
            // 保留位置：如需极早期建表，请使用迁移或服务启动后的 ensureCoreTables()，不要在此处建表
        } catch (e) {
            logger.warn('初始化关键表/索引失败（忽略）:', e && e.message);
        }

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
    const promise = new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                logger.error(`[${dbType}] 数据库操作失败: ${sql}`, err.message);
                return reject(err);
            }
            if (successMessage) logger.info(`[${dbType}] ${successMessage}`);
            resolve(this);
        });
    });
    return withTimeout(promise, QUERY_TIMEOUT, { sql });
};

const dbRun = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    const promise = new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
    return withTimeout(promise, QUERY_TIMEOUT, { sql });
};

const dbAll = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    const promise = new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
    return withTimeout(promise, QUERY_TIMEOUT, { sql });
};

const dbGet = (dbType, sql, params = []) => {
    const db = getDB(dbType);
    const promise = new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
    return withTimeout(promise, QUERY_TIMEOUT, { sql });
};

// 检查表和列是否存在
const hasColumn = (dbType, table, column) => {
    const sql = `PRAGMA table_info(${table})`;
    const promise = new Promise((resolve, reject) => {
        getDB(dbType).all(sql, (err, rows) => {
            if (err) return reject(err);
            resolve(rows.some(row => row.name === column));
        });
    });
    return withTimeout(promise, QUERY_TIMEOUT, { sql });
};

const hasTable = (dbType, table) => {
    const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name=?`;
    const promise = new Promise((resolve, reject) => {
        getDB(dbType).all(sql, [table], (err, rows) => {
            if (err) return reject(err);
            resolve(rows.length > 0);
        });
    });
    return withTimeout(promise, QUERY_TIMEOUT, { sql });
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