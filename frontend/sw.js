// Cache versioning
const STATIC_CACHE_VERSION = 'static-v2'; // Increased version to force update
const API_CACHE_VERSION = 'api-v1';
const MEDIA_CACHE_VERSION = 'media-v1'; // 新增的媒体缓存版本

const CORE_ASSETS = [
  '/',
  '/index.html',
  '/main.js',
  '/style.css',
  '/manifest.json',
  '/icon.svg',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap'
];

// 1. 安装 Service Worker，缓存核心资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE_VERSION)
      .then(cache => {
        console.log('Service Worker: 缓存核心资源');
        // For core assets, if any fail, the SW installation fails.
        return cache.addAll(CORE_ASSETS);
      })
      .then(() => self.skipWaiting()) // 立即激活新 Service Worker
  );
});

// 2. 激活 Service Worker，清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // 删除非当前版本的缓存
          if (cacheName !== STATIC_CACHE_VERSION && cacheName !== API_CACHE_VERSION && cacheName !== MEDIA_CACHE_VERSION) {
            console.log('Service Worker: 删除旧缓存:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) // 立即接管所有页面
  );
});

// 3. 拦截 fetch 请求，按类型采用不同缓存策略
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API 请求，采用 Stale-While-Revalidate 策略
  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET') {
      return event.respondWith(fetch(request)); // 非 GET 请求不缓存
    }
    event.respondWith(
      caches.open(API_CACHE_VERSION).then(cache => {
        return cache.match(request).then(response => {
          const fetchPromise = fetch(request).then(networkResponse => {
            // 只缓存成功的网络响应
            if (networkResponse.ok) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(error => {
            // 网络请求失败
            console.error('Service Worker: API fetch failed.', error);
          });
          return response || fetchPromise;
        });
      })
    );
  }
  // 静态媒体资源（图片/视频/缩略图），优先缓存
  else if (url.pathname.startsWith('/static/') || url.pathname.startsWith('/thumbs/')) {
    event.respondWith(
        caches.open(MEDIA_CACHE_VERSION).then(cache => {
            return cache.match(request).then(cachedResponse => {
                if (cachedResponse) {
                    // 有缓存直接返回
                    return cachedResponse;
                }
                // 无缓存则从网络获取并缓存
                return fetch(request).then(networkResponse => {
                    if (networkResponse.ok) {
                        cache.put(request, networkResponse.clone());
                    }
                    return networkResponse;
                }).catch(error => {
                    // 网络失败且无缓存
                    console.error('Fetch failed for media, and no cached response:', error);
                    throw error;
                });
            });
        })
    );
  }
  // 核心静态资源，优先缓存
  else if (CORE_ASSETS.some(asset => url.pathname.endsWith(asset.replace(/^\//, '')) || url.pathname === '/')) {
     event.respondWith(
        caches.match(request).then(cachedResponse => {
            return cachedResponse || fetch(request).then(response => {
                return caches.open(STATIC_CACHE_VERSION).then(cache => {
                    if(response.ok) {
                       cache.put(request, response.clone());
                    }
                    return response;
                });
            });
        })
     );
  }
  // 其他请求，采用 Stale-While-Revalidate 策略
  else {
    event.respondWith(
        caches.open(STATIC_CACHE_VERSION).then(cache => {
            return cache.match(request).then(response => {
                let fetchPromise = fetch(request).then(networkResponse => {
                    if (networkResponse.ok) {
                        cache.put(request, networkResponse.clone());
                    }
                    return networkResponse;
                });
                return response || fetchPromise;
            });
        })
    );
  }
});

// 4. 后台同步，处理离线请求
self.addEventListener('sync', event => {
    if (event.tag === 'sync-gallery-requests') {
        console.log('Service Worker: 后台同步触发');
        event.waitUntil(syncFailedRequests());
    }
});

function syncFailedRequests() {
    return openDb().then(db => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const requests = store.getAll();
        return new Promise(resolve => {
            requests.onsuccess = () => {
                const failedRequests = requests.result;
                const promises = failedRequests.map(req => {
                    if (req.type === 'search') {
                        return fetch(`/api/search?q=${encodeURIComponent(req.query)}`);
                    } else if (req.type === 'ai-caption') {
                        return fetch('/api/ai/generate', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(req.payload)
                        });
                    }
                });
                Promise.all(promises).then(() => {
                    const writeTx = db.transaction(STORE_NAME, 'readwrite');
                    writeTx.objectStore(STORE_NAME).clear();
                    resolve();
                });
            };
        });
    });
}

const DB_NAME = 'offline-requests-db';
const STORE_NAME = 'requests';

// 打开 IndexedDB 数据库
function openDb() {
    return new Promise((resolve, reject) => {
        const request = self.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { autoIncrement: true });
            }
        };
        request.onsuccess = event => resolve(event.target.result);
        request.onerror = event => reject(event.target.error);
    });
}

// 5. 监听手动刷新消息，清除 API 缓存
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'MANUAL_REFRESH') {
        console.log('Service Worker: 手动刷新 API 数据触发');
        event.waitUntil(
            caches.delete(API_CACHE_VERSION).then(() => {
                console.log('Service Worker: API 缓存已清除');
            })
        );
    }
});