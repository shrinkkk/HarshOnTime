// Service worker: receives pushes, shows them, reports arrival back to the server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "HarshOnTime", body: event.data ? event.data.text() : "" }; }

  const options = {
    body: data.body || "",
    tag: data.tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };
  // Buttons only where the platform draws them (Chrome: 2, Safari: none).
  const maxActions = (self.Notification && self.Notification.maxActions) || 0;
  if (maxActions > 0 && Array.isArray(data.actions)) options.actions = data.actions.slice(0, maxActions);

  // iOS drops subscriptions that receive a push without showing a notification,
  // so showing it is unconditional and the receipt is never allowed to break it.
  const show = self.registration.showNotification(data.title || "HarshOnTime", options);
  const receipt = data.pushId && data.subId
    ? fetch("/api/receipt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pushId: data.pushId, subId: data.subId }) }).catch(() => {})
    : Promise.resolve();
  event.waitUntil(Promise.all([show, receipt]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = (event.notification.data && event.notification.data.url) || "/";
  if (event.action) url += (url.includes("?") ? "&" : "?") + "action=" + encodeURIComponent(event.action);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { await c.focus(); if ("navigate" in c) { try { await c.navigate(url); } catch {} } return; }
    }
    await self.clients.openWindow(url);
  })());
});
