const SHELL = ["/", "/app", "/guest.css", "/guest.js", "/design-tokens.css", "/manifest.webmanifest", "/icons/guest-180.png", "/icons/guest-192.png", "/icons/guest-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("pinball-guest-v1").then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin") || url.pathname.startsWith("/ws")) return;
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open("pinball-guest-v1").then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});
