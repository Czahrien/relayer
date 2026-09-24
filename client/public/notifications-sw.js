// Relayer's service worker. It exists only because Android Chrome shows page
// notifications through a service worker. It handles notification clicks by
// focusing the room's tab (or opening it), and does nothing else: no caching,
// no fetch handling, no push.

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const tab = windows.find((w) => w.url === url) ?? windows[0];
      if (tab) return tab.focus();
      if (url) return self.clients.openWindow(url);
    })(),
  );
});
