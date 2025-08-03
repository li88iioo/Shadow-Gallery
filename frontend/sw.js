// frontend/sw.js

// Cache versioning
const STATIC_CACHE_VERSION = 'static-v4'; // 版本号已更新，强制浏览器更新缓存
const API_CACHE_VERSION = 'api-v1';
const MEDIA_CACHE_VERSION = 'media-v1';

// 核心资源列表已更新，以匹配新的目录结构
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/output.css', // 更新为最终生成的 CSS 文件
  '/manifest.json',

  // --- JS 模块 ---
  '/js/main.js',
  '/js/api.js',
  '/js/lazyload.js',
  '/js/masonry.js',
  '/js/modal.js',
  '/js/state.js',
  '/js/ui.js',
  '/js/utils.js',

  // --- 静态资源 (assets) ---
  '/assets/icon.svg',
  '/assets/broken-image.svg',
  '/assets/loading-placeholder.svg',

  // --- 外部资源 ---
  'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap'
];

// 1. 安装 Service Worker，缓存核心资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE_VERSION)
      .then(cache => {
        console.log('Service Worker: Caching core assets');
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
            console.log('Service Worker: Deleting old cache:', cacheName);
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

  // 1. /api/search 采用网络优先
  if (url.pathname.startsWith('/api/search')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const responseForCache = response.clone();
          return caches.open('api-search')
            .then(cache => cache.put(request, responseForCache))
            .then(() => response);
        })
        .catch(() => caches.match(request).then(r => r || new Response('', { status: 503, statusText: 'Service Unavailable' })))
    );
    return;
  }

  // 2. /api/browse/ 采用网络优先
  if (url.pathname.startsWith('/api/browse/')) {
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          if (networkResponse.ok) {
            const responseForCache = networkResponse.clone();
            return caches.open(API_CACHE_VERSION)
              .then(cache => cache.put(request, responseForCache))
              .then(() => networkResponse);
          }
          return networkResponse;
        })
        .catch(() => caches.match(request).then(r => r || new Response('', { status: 503, statusText: 'Service Unavailable' })))
    );
    return;
  }

  // 3. 其他 /api/ 采用缓存优先+后台更新（不包括 /api/search）
  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET') {
      event.respondWith(
        fetch(request)
          .then(response => response)
          .catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }))
      );
      return;
    }
    event.respondWith(
      caches.open(API_CACHE_VERSION).then(cache => {
        return cache.match(request).then(response => {
          const fetchPromise = fetch(request).then(networkResponse => {
            if (networkResponse.ok) {
              const responseForCache = networkResponse.clone();
              cache.put(request, responseForCache);
            }
            return networkResponse;
          }).catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }));
          return response || fetchPromise;
        });
      })
    );
    return;
  }

  // 4. 静态媒体资源
  if (url.pathname.startsWith('/static/') || url.pathname.startsWith('/thumbs/')) {
    event.respondWith(
      caches.open(MEDIA_CACHE_VERSION).then(cache => {
        return cache.match(request).then(cachedResponse => {
          if (cachedResponse) return cachedResponse;
          return fetch(request).then(networkResponse => {
            if (networkResponse.ok) {
              const responseForCache = networkResponse.clone();
              cache.put(request, responseForCache);
            }
            return networkResponse;
          }).catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }));
        });
      })
    );
    return;
  }

  // 5. 核心静态资源
  if (CORE_ASSETS.some(asset => url.pathname.endsWith(asset.replace(/^\//, '')) || url.pathname === '/')) {
    event.respondWith(
      caches.match(request).then(cachedResponse => {
        return cachedResponse || fetch(request).then(response => {
          if (response.ok) {
            const responseForCache = response.clone();
            return caches.open(STATIC_CACHE_VERSION)
              .then(cache => cache.put(request, responseForCache))
              .then(() => response);
          }
          return response;
        }).catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }));
      })
    );
    return;
  }

  // 6. 其他请求，Stale-While-Revalidate
  event.respondWith(
    caches.open(STATIC_CACHE_VERSION).then(cache => {
      return cache.match(request).then(response => {
        let fetchPromise = fetch(request).then(networkResponse => {
          if (networkResponse.ok) {
            const responseForCache = networkResponse.clone();
            cache.put(request, responseForCache);
          }
          return networkResponse;
        }).catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }));
        return response || fetchPromise;
      });
    })
  );
});


// 4. 后台同步，处理离线请求
self.addEventListener('sync', event => {
    if (event.tag === 'sync-gallery-requests') {
        console.log('Service Worker: Background sync triggered');
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
        console.log('Service Worker: Manual refresh for API data triggered');
        event.waitUntil(
            caches.delete(API_CACHE_VERSION).then(() => {
                console.log('Service Worker: API cache cleared');
            })
        );
    }
});