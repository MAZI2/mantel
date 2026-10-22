/* Family Calendar service worker.
 *
 * Purpose: a wall display that keeps showing the schedule when the network drops,
 * instead of going blank. Everything else is deliberately conservative.
 *
 * THE RULE THAT MATTERS: this app updates itself by polling /api/version and
 * hard-reloading when the version changes. A service worker that caches either
 * that endpoint or index.html would silently break the update mechanism and
 * strand every screen in the house on an old build. So:
 *
 *   - /api/version is never touched. It always goes to the network.
 *   - navigations are network-first, cache only as an offline fallback.
 *   - hashed assets are immutable and safe to cache forever.
 */

// Taken from the ?v= on the registration URL (see main.tsx). A fixed constant
// would mean the activate cleanup never fires, so every release's content-hashed
// assets would pile up in the cache forever until the browser evicted the whole
// origin -- taking the offline copy with it.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const SHELL_CACHE = `famcal-shell-${VERSION}`
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(['/'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      for (const key of keys.filter((k) => k.startsWith('famcal-'))) {
        if (key !== SHELL_CACHE) {
          await caches.delete(key)
          continue
        }
        // Earlier releases stored private photos alongside public assets.
        const cache = await caches.open(key)
        for (const request of await cache.keys()) {
          if (new URL(request.url).pathname.startsWith('/api/')) await cache.delete(request)
        }
      }
    })
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Profiles and certificate identities can change on the same browser. Private
  // responses must always be authorized afresh, including photo downloads.
  if (url.pathname.startsWith('/api/')) return

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE))
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE))
  }
})

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch (err) {
    const hit = await cache.match(request)
    if (hit) return hit
    // A navigation with nothing cached still needs *something* back.
    if (request.mode === 'navigate') {
      const shell = await cache.match('/')
      if (shell) return shell
    }
    throw err
  }
}
