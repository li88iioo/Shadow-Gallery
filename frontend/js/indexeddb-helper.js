// frontend/js/indexeddb-helper.js
const DB_NAME = 'gallery-history-db';
const STORE_NAME = 'viewed';

export function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'path' });
            }
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

export async function saveViewed(path, timestamp = Date.now(), synced = false) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ path, timestamp, synced });
    return tx.complete;
}

export async function getAllViewed() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    return new Promise(resolve => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

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
                if (!cursor.value.synced) unsynced.push(cursor.value);
                cursor.continue();
            } else {
                resolve(unsynced);
            }
        };
    });
}

export async function markAsSynced(path) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = await store.get(path);
    if (record) {
        record.synced = true;
        store.put(record);
    }
    return tx.complete;
} 