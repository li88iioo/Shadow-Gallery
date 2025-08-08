// frontend/sw.js

// Cache versioning（与构建产物、策略相匹配）
const STATIC_CACHE_VERSION = 'static-v5';
const API_CACHE_VERSION = 'api-v2';
const MEDIA_CACHE_VERSION = 'media-v1';

// 仅缓存稳定核心；JS 使用 dist 入口，其他 chunk 运行时按策略缓存
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/output.css', // 更新为最终生成的 CSS 文件
  '/manifest.json',

  // --- JS 模块 ---
  '/js/dist/main.js',

  // --- 静态资源 (assets) ---
  '/assets/icon.svg',
  '/assets/broken-image.svg',
  '/assets/loading-placeholder.svg',

  // --- 外部资源 ---
  'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap'
];

// 检查响应是否适合缓存
function isCacheableResponse(response, request) {
  // 只缓存成功的响应
  if (!response.ok) return false;
  
  // 不缓存206 Partial Content响应（内网穿透常见问题）
  if (response.status === 206) return false;
  
  // 不缓存非GET请求
  if (request && request.method !== 'GET') return false;
  
  // 不缓存非基本或CORS响应
  if (response.type !== 'basic' && response.type !== 'cors') return false;
  
  return true;
}

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
  const hasAuth = request.headers && (request.headers.get('Authorization') || request.headers.get('authorization'));

  // 0. 前端构建产物（/js/dist/* 与 /output.css）：Cache First + SWR
  if (
    url.pathname.startsWith('/js/dist/') ||
    url.pathname === '/output.css'
  ) {
    event.respondWith(
      caches.open(STATIC_CACHE_VERSION).then(cache =>
        cache.match(request).then(cached => {
          const fetchPromise = fetch(request)
            .then(resp => {
              if (isCacheableResponse(resp, request)) cache.put(request, resp.clone());
              return resp;
            })
            .catch(() => cached || new Response('', { status: 503, statusText: 'Service Unavailable' }));
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // 1. /api/search 采用网络优先
  if (url.pathname.startsWith('/api/search')) {
    // 携带 Authorization 时不参与 SW 缓存，避免将私人响应写入共享缓存
    if (hasAuth) {
      event.respondWith(fetch(request));
      return;
    }
    event.respondWith(
      fetch(request)
        .then(response => {
          if (isCacheableResponse(response, request)) {
            const responseForCache = response.clone();
            return caches.open('api-search-v1')
              .then(cache => cache.put(request, responseForCache))
              .then(() => response);
          }
          return response;
        })
        .catch(() => caches.match(request).then(r => r || new Response('', { status: 503, statusText: 'Service Unavailable' })))
    );
    return;
  }

  // 2. /api/browse/ 采用网络优先，但更健壮的错误处理
  if (url.pathname.startsWith('/api/browse/')) {
    // 对于非GET请求（如POST /api/browse/viewed），直接转发不缓存
    if (request.method !== 'GET') {
      event.respondWith(
        fetch(request)
          .then(response => response)
          .catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }))
      );
      return;
    }
    if (hasAuth) {
      event.respondWith(fetch(request));
      return;
    }
    
    // 对于GET请求，采用网络优先策略
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          if (networkResponse.ok && isCacheableResponse(networkResponse, request)) {
            const responseForCache = networkResponse.clone();
            return caches.open(API_CACHE_VERSION)
              .then(cache => cache.put(request, responseForCache))
              .then(() => networkResponse);
          }
          return networkResponse;
        })
        .catch(error => {
          console.warn('Network request failed for browse API:', error);
          return caches.match(request).then(r => r || new Response('', { status: 503, statusText: 'Service Unavailable' }));
        })
    );
    return;
  }

  // 3. 其他 /api/ 采用缓存优先+后台更新（SWR，不包括 /api/search）
  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET') {
      event.respondWith(
        fetch(request)
          .then(response => response)
          .catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }))
      );
      return;
    }
    if (hasAuth) {
      // 携带 Authorization 的请求完全绕过缓存
      event.respondWith(fetch(request));
      return;
    }
    event.respondWith(
      caches.open(API_CACHE_VERSION).then(cache => {
        return cache.match(request).then(response => {
          const fetchPromise = fetch(request).then(networkResponse => {
            if (networkResponse.ok && isCacheableResponse(networkResponse, request)) {
              const responseForCache = networkResponse.clone();
              cache.put(request, responseForCache).catch(err => {
                console.warn('Failed to cache API response:', err);
              });
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
            if (networkResponse.ok && isCacheableResponse(networkResponse, request)) {
              const responseForCache = networkResponse.clone();
              cache.put(request, responseForCache).catch(err => {
                console.warn('Failed to cache media response:', err);
              });
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
          if (response.ok && isCacheableResponse(response, request)) {
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
          if (networkResponse.ok && isCacheableResponse(networkResponse, request)) {
            const responseForCache = networkResponse.clone();
            cache.put(request, responseForCache).catch(err => {
              console.warn('Failed to cache response:', err);
            });
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