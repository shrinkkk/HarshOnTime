// Service worker: receives pushes, shows them, reports arrival back to the server, and tells any
// open page to refresh. No caching: the app is tiny and always wants fresh data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "HarshOnTime", body: event.data ? event.data.text() : "" }; }

  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };
  // renotify (buzz again when a newer push replaces one with the same tag) is only legal with a tag.
  if (data.tag) { options.tag = data.tag; options.renotify = true; }
  // Buttons only where the platform draws them (Chrome: 2, Safari: none).
  const maxActions = (self.Notification && self.Notification.maxActions) || 0;
  if (maxActions > 0 && Array.isArray(data.actions)) options.actions = data.actions.slice(0, maxActions);

  // iOS drops subscriptions that receive a push without showing a notification,
  // so showing it is unconditional and nothing else here is allowed to break it.
  const show = self.registration.showNotification(data.title || "HarshOnTime", options);
  const receipt = data.subId
    ? fetch("/api/receipt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pushId: data.pushId, subId: data.subId }) }).catch(() => {})
    : Promise.resolve();
  const wake = self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then((all) => all.forEach((c) => c.postMessage({ type: "push", url: data.url || "/" })))
    .catch(() => {});
  event.waitUntil(Promise.all([show, receipt, wake]));
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

// The browser can silently replace a subscription. The page can't help (it may not be open), so
// re-subscribe here and tell the server, proving ownership with the old endpoint.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    if (!old || !old.options) return;
    const sub = event.newSubscription || (await self.registration.pushManager.subscribe(old.options));
    const j = sub.toJSON();
    await fetch("/api/subscriptions/rotate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldEndpoint: old.endpoint, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, platform: "rotated" }),
    }).catch(() => {});
  })());
});
