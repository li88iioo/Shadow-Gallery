// 缓存名称，版本号有助于更新缓存
const CACHE_NAME = 'shadow-gallery'; // 更新版本号
// 需要缓存的核心应用外壳文件
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/main.js',
  '/output.css', // 缓存本地构建的CSS
  '/manifest.json',
  '/icon.svg',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap'
];

// 1. 安装 Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(URLS_TO_CACHE);
      })
  );
});

// 2. 激活 Service Worker，并清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(cacheName => {
          return cacheName.startsWith('shadow-gallery-cache-') &&
                 cacheName !== CACHE_NAME;
        }).map(cacheName => {
          console.log('Deleting old cache:', cacheName);
          return caches.delete(cacheName);
        })
      );
    })
  );
});

// 3. 拦截网络请求 - Stale-While-Revalidate 策略
self.addEventListener('fetch', event => {
  const { request } = event;

  // 对于 API 和 静态资源(图片/视频) 请求, 总是优先从网络获取，不缓存
  if (request.url.includes('/api/') || request.url.includes('/static/')) {
    event.respondWith(fetch(request));
    return;
  }

  // 对于应用核心文件，采用 Stale-While-Revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(request).then(cachedResponse => {
        const fetchPromise = fetch(request).then(networkResponse => {
          // 如果请求成功，则更新缓存
          if (networkResponse && networkResponse.status === 200) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        });

        // 如果缓存中存在，则立即返回缓存的响应 (Stale)
        // 同时，后台会发起网络请求更新缓存 (Revalidate)
        return cachedResponse || fetchPromise;
      });
    })
  );
});

