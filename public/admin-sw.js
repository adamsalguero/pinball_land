const SHELL = ["/admin", "/control.css", "/admin.css", "/control.js", "/design-tokens.css", "/admin.webmanifest", "/icons/admin-180.png", "/icons/admin-192.png", "/icons/admin-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("pinball-admin-v1").then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return;
  if (!url.pathname.startsWith("/admin") && !SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open("pinball-admin-v1").then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/admin")))
  );
});
