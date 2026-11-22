/* Service worker: stores every file below on first visit so the app works with no
 * connection. Change CACHE whenever any file below changes, so that phones
 * pick up the new version.
 *
 * Books of the Bible (bible/<CODE>.json) are not listed: the app keeps each one in
 * its own cache, BIBLE, the first time it is opened. BIBLE is named after the
 * version in bible/index.json (tools/verify.py checks they match), so books kept on
 * a phone survive app updates and are replaced only when the Bible files change.
 * Cross-reference files (tsk/<CODE>.json) are kept the same way, in TSK. */
const CACHE = 'teach-us-to-pray-v18';
const BIBLE = 'teach-us-to-pray-bible-8679a735ef';
const TSK = 'teach-us-to-pray-tsk-e0305c51f1';
const FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'lang/en.json',
  'scripture/en-web.json',
  'bible/index.json',
  'tsk/index.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE && n !== BIBLE && n !== TSK).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request))
  );
});
