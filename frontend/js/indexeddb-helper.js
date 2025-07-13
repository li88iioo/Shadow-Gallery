// frontend/js/indexeddb-helper.js

/**
 * IndexedDB 数据库助手模块
 * 负责管理用户访问历史的本地存储，支持离线记录和网络恢复后的同步
 */

const DB_NAME = 'gallery-history-db';  // 数据库名称
const STORE_NAME = 'viewed';           // 对象存储名称

/**
 * 打开或创建 IndexedDB 数据库
 * @returns {Promise<IDBDatabase>} 数据库实例
 */
export function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        
        // 数据库升级处理
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // 创建对象存储，使用 path 作为主键
                db.createObjectStore(STORE_NAME, { keyPath: 'path' });
            }
        };
        
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

/**
 * 保存访问记录到本地数据库
 * @param {string} path - 访问的路径
 * @param {number} timestamp - 访问时间戳（默认当前时间）
 * @param {boolean} synced - 是否已同步到服务器（默认false）
 * @returns {Promise} 事务完成Promise
 */
export async function saveViewed(path, timestamp = Date.now(), synced = false) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ path, timestamp, synced });
    return tx.complete;
}

/**
 * 获取所有访问记录
 * @returns {Promise<Array>} 访问记录数组
 */
export async function getAllViewed() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    return new Promise(resolve => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);  // 出错时返回空数组
    });
}

/**
 * 获取未同步的访问记录
 * 用于网络恢复后批量同步到服务器
 * @returns {Promise<Array>} 未同步的记录数组
 */
export async function getUnsyncedViewed() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    return new Promise(resolve => {
        const req = store.openCursor();
        const unsynced = [];
        
        req.onsuccess = e => {
            const cursor = e.target.result;
            if (cursor) {
                // 检查记录是否已同步
                if (!cursor.value.synced) {
                    unsynced.push(cursor.value);
                }
                cursor.continue();
            } else {
                resolve(unsynced);
            }
        };
    });
}

/**
 * 标记访问记录为已同步
 * 在成功同步到服务器后调用
 * @param {string} path - 要标记的路径
 * @returns {Promise} 事务完成Promise
 */
export async function markAsSynced(path) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    // 获取记录并更新同步状态
    const record = await store.get(path);
    if (record) {
        record.synced = true;
        store.put(record);
    }
    
    return tx.complete;
} 