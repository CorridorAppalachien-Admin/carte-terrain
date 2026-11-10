// Garde l'application dans le téléphone pour l'utiliser hors ligne.
// Réseau d'abord (versions à jour quand il y a du signal), sinon la copie gardée.
const CACHE = 'carte-terrain-v1';
const FICHIERS = [
  './', 'index.html', 'style.css', 'app.js', 'geo.js', 'manifest.webmanifest',
  'icones/logo.png', 'icones/icone-192.png', 'icones/icone-512.png',
  'lib/leaflet.css', 'lib/leaflet.js', 'lib/proj4.js', 'lib/pdf-lib.min.js',
  'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Signal faible : on n'attend pas plus de 3 s avant de prendre la copie locale.
      const reponse = await Promise.race([
        fetch(e.request),
        new Promise((_, ko) => setTimeout(() => ko(new Error('délai')), 3000)),
      ]);
      if (reponse.ok && !url.search) cache.put(e.request, reponse.clone());
      return reponse;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
