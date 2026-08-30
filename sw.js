// Bubble Battle — Service Worker
// Задача: сделать сайт устанавливаемым как приложение (PWA) и дать ему
// пережить кратковременную потерю сети, но НИКОГДА не отдавать
// устаревшую версию игры, если сервер доступен — поэтому стратегия
// "network-first" (сеть в приоритете, кэш — только запасной вариант).

const CACHE_VERSION = 'bubble-battle-v2';
const APP_SHELL = [
    '/',
    '/index.html',
    '/app.js',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Никогда не трогаем socket.io / websocket-трафик и не-GET запросы —
    // это живое соединение с сервером, кэш здесь только всё сломает.
    if (req.method !== 'GET' || req.url.includes('/socket.io/')) return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                const copy = res.clone();
                caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
                return res;
            })
            .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
});
