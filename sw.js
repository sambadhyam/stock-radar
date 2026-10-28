// sw.js — offline support.
// App code (HTML, JS, CSS) is network-first so updates show up straight away, with the cached copy
// used when offline or when the network takes longer than 3 seconds. Fonts and icons are cache-first.
// Engine API calls go to script.google.com (another origin) and are never touched here.
const VERSION = 'sr-0.7.0';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/app.css',
  'assets/fonts/anek-latin.woff',
  'assets/icons/favicon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable-512.png',
  'js/app.js',
  'js/util.js',
  'js/i18n.js',
  'js/state.js',
  'js/ui.js',
  'js/icons.js',
  'js/charts.js',
  'js/data.js',
  'js/api.js',
  'js/demo.js',
  'js/screens/home.js',
  'js/screens/alerts.js',
  'js/screens/scan.js',
  'js/screens/results.js',
  'js/screens/more.js',
  'js/screens/settings.js',
  'js/screens/connect.js',
  'js/screens/lab.js',
  'js/screens/portfolio.js',
  'js/screens/fundamentals.js',
  'js/screens/review.js',
  'js/screens/explore.js',
  'js/backtest.js',
  'js/bt-worker.js',
  'js/idb.js',
  'js/xlsx.js',
  'js/importers.js',
  'core/core.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function putInCache(req, res) {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(VERSION).then((cache) => cache.put(req, copy));
  }
  return res;
}

function networkFirst(req) {
  const network = fetch(req).then((res) => putInCache(req, res));
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  return Promise.race([network, timeout.then(() => caches.match(req, { ignoreSearch: true }))])
    .then((res) => res || network)
    .catch(() => caches.match(req, { ignoreSearch: true }))
    .then((res) => res || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
}

function cacheFirst(req) {
  return caches.match(req).then((hit) => hit || fetch(req).then((res) => putInCache(req, res)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isStatic = /\/assets\/(fonts|icons)\//.test(url.pathname);
  event.respondWith(isStatic ? cacheFirst(req) : networkFirst(req));
});
