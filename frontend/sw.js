// 缓存名称，版本号有助于更新缓存
const CACHE_NAME = 'shadow-gallery-cache-v1';
// 需要缓存的核心应用外壳文件
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/main.js',
  '/manifest.json',
  '/icon.svg',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;700&display=swap'
];

// 1. 安装 Service Worker
self.addEventListener('install', event => {
  // 执行安装步骤
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
          // 清理掉所有不等于当前版本名称的缓存
          return cacheName.startsWith('shadow-gallery-cache-') &&
                 cacheName !== CACHE_NAME;
        }).map(cacheName => {
          return caches.delete(cacheName);
        })
      );
    })
  );
});

// 3. 拦截网络请求
self.addEventListener('fetch', event => {
  const { request } = event;

  // 对于 API 请求，总是优先从网络获取，不缓存
  if (request.url.includes('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // 对于其他请求（应用外壳、图片等），采用 "缓存优先，网络回退" 策略
  event.respondWith(
    caches.match(request).then(cachedResponse => {
      // 如果缓存中有匹配的响应，则直接返回
      if (cachedResponse) {
        return cachedResponse;
      }

      // 如果缓存中没有，则从网络请求
      return fetch(request).then(response => {
        // 检查响应是否有效，且为需要缓存的类型
        if (!response || response.status !== 200 || (response.type !== 'basic' && !request.url.startsWith('http'))) {
          return response;
        }

        // 克隆响应，因为响应流只能被消费一次
        const responseToCache = response.clone();

        caches.open(CACHE_NAME)
          .then(cache => {
            cache.put(request, responseToCache);
          });

        return response;
      });
    })
  );
});
