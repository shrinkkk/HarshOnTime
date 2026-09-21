(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---- What kind of device and context is this? ----
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const platform = (isIos ? "iOS" : isAndroid ? "Android" : "Desktop") + (standalone ? " app" : " tab");

  // Storage marker: tells us whether Safari and the home-screen app share storage on iOS.
  if (!store.get("marker")) store.set("marker", JSON.stringify({ at: new Date().toISOString(), where: standalone ? "home-screen app" : "browser tab" }));
  const marker = JSON.parse(store.get("marker") || "{}");

  let key = store.get("spikeKey") || "";
  let subId = store.get("subId") || "";
  let swReg = null;

  const say = (el, text, kind) => { el.hidden = !text; el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); };
  const markDone = (sectionId, done) => { const s = $(sectionId); s.classList.toggle("done", done); s.querySelector(".tick").hidden = !done; };

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-spike-key": key, ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function b64urlToBytes(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  // ---- Step 1: install ----
  function renderInstall() {
    $("installIos").hidden = !(isIos && !standalone);
    $("installAndroid").hidden = !(isAndroid && !standalone);
    $("installOther").hidden = isIos || isAndroid || standalone;
    $("installDone").hidden = !standalone;
    markDone("stepInstall", standalone);
  }

  // ---- Step 2: passphrase ----
  async function checkKey(candidate) {
    key = candidate;
    try { await api("/api/check"); store.set("spikeKey", key); return true; }
    catch { key = ""; store.del("spikeKey"); return false; }
  }
  $("keyBtn").addEventListener("click", async () => {
    const v = $("keyInput").value.trim();
    if (!v) return say($("keyMsg"), "Type the passphrase first.", "bad");
    $("keyBtn").disabled = true;
    const ok = await checkKey(v);
    $("keyBtn").disabled = false;
    say($("keyMsg"), ok ? "" : "That passphrase didn't match. Check the spelling and try again.", "bad");
    renderAll();
  });

  // ---- Step 3: notifications ----
  $("pushBtn").addEventListener("click", async () => {
    const label = $("labelInput").value.trim();
    if (!label) return say($("pushMsg"), "Add your name and phone first so we can tell the results apart.", "bad");
    if (!pushSupported) {
      return say($("pushMsg"), isIos && !standalone
        ? "Safari tabs can't receive notifications on iPhone. Do step 1, then open HarshOnTime from the home-screen icon."
        : "This browser doesn't support web push.", "bad");
    }
    $("pushBtn").disabled = true;
    try {
      // Must be called directly from this tap, or iOS refuses to show the prompt.
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error(perm === "denied"
        ? "Notifications are blocked for HarshOnTime. Allow them in your phone's Settings > Notifications, then try again."
        : "No choice was made. Tap the button again and choose Allow.");
      const { vapidPublicKey } = await api("/api/config");
      swReg = swReg || (await navigator.serviceWorker.ready);
      const existing = await swReg.pushManager.getSubscription();
      const sub = existing || (await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(vapidPublicKey) }));
      const out = await api("/api/subscribe", { method: "POST", body: JSON.stringify({ label, platform, subscription: sub.toJSON() }) });
      subId = out.id; store.set("subId", subId); store.set("label", label);
      say($("pushMsg"), "Notifications are on for this phone.", "ok");
    } catch (e) {
      say($("pushMsg"), e.message || String(e), "bad");
    }
    $("pushBtn").disabled = false;
    renderAll();
  });

  $("offBtn").addEventListener("click", async () => {
    try {
      if (subId) await api("/api/unsubscribe", { method: "POST", body: JSON.stringify({ id: subId }) });
      const sub = swReg && (await swReg.pushManager.getSubscription());
      if (sub) await sub.unsubscribe();
    } catch {}
    subId = ""; store.del("subId");
    say($("pushMsg"), "This phone was removed from the test.", "ok");
    renderAll();
  });

  // ---- Step 4: send ----
  $("sendBtn").addEventListener("click", async () => {
    const delay = Number($("delaySel").value);
    const toMe = $("targetSel").value === "me";
    if (toMe && !subId) return say($("sendMsg"), "Turn on notifications on this phone first (step 3).", "bad");
    $("sendBtn").disabled = true;
    try {
      const who = store.get("label") || "Someone";
      await api("/api/send", { method: "POST", body: JSON.stringify({
        title: delay ? "Delayed test from " + who : "Test from " + who,
        body: delay ? "Scheduled " + delay + " min ago. Did this reach your locked phone?" : "If you can read this, push works on this phone.",
        targetSub: toMe ? subId : undefined, delayMinutes: delay }) });
      say($("sendMsg"), delay ? "Scheduled. Lock your phone and wait." : "Sent. It should arrive within a few seconds.", "ok");
      setTimeout(refresh, 2500);
    } catch (e) { say($("sendMsg"), e.message, "bad"); }
    $("sendBtn").disabled = false;
  });

  // ---- Results ----
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function cell(text, cls) { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; return td; }

  async function refresh() {
    if (!key || document.hidden) return;
    let data; try { data = await api("/api/status"); } catch { return; }

    $("pendingBox").textContent = data.pending.length
      ? "Waiting to send: " + data.pending.map((p) => "“" + p.title + "” at " + time(p.due_at)).join(", ")
      : "";

    const rb = $("resBody"); rb.textContent = "";
    if (!data.deliveries.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "Nothing sent yet."; rb.append(p); }
    const span = (text, cls) => { const s = document.createElement("span"); s.textContent = text; if (cls) s.className = cls; return s; };
    for (const d of data.deliveries) {
      const accepted = d.status >= 200 && d.status < 300;
      const stale = data.now - d.sent_at > 20 * 60000;
      const item = document.createElement("div"); item.className = "item";
      const who = document.createElement("b"); who.textContent = d.label;
      const l1 = document.createElement("div"); l1.className = "line"; l1.append(who, span(d.platform, "muted"));
      const l2 = document.createElement("div"); l2.className = "line";
      l2.append(span(d.title + ", " + time(d.sent_at), "muted"));
      if (!accepted) l2.append(span(d.status === 0 ? "Couldn't reach the push service" : "Push service refused it (" + d.status + ")" + (d.detail ? ": " + String(d.detail).slice(0, 80) : ""), "s-bad"));
      else if (d.received_at) l2.append(span("Arrived after " + Math.max(0, Math.round((d.received_at - d.sent_at) / 1000)) + " s", "s-ok"));
      else l2.append(span(stale ? "Accepted but never arrived" : "Accepted, not arrived yet", stale ? "s-bad" : "s-wait"));
      item.append(l1, l2); rb.append(item);
    }

    const sb = $("subsBody"); sb.textContent = "";
    if (!data.subs.length) { const tr = document.createElement("tr"); tr.append(cell("None yet.", "muted")); sb.append(tr); }
    for (const s of data.subs) { const tr = document.createElement("tr"); tr.append(cell(s.label + (s.id === subId ? " (this phone)" : "")), cell(s.platform)); sb.append(tr); }

    // If the server no longer knows this phone (push service said the subscription died), say so.
    if (subId && !data.subs.some((s) => s.id === subId)) {
      subId = ""; store.del("subId");
      say($("pushMsg"), "This phone's notification link stopped working and was removed. Turn notifications on again.", "bad");
      renderAll();
    }
  }

  // ---- Diagnostics ----
  async function renderDiag() {
    const sub = swReg ? await swReg.pushManager.getSubscription().catch(() => null) : null;
    const rows = [
      ["Device", platform],
      ["Opened from", standalone ? "Home-screen icon" : "Browser tab"],
      ["Push supported here", pushSupported ? "Yes" : "No"],
      ["Notification permission", "Notification" in window ? Notification.permission : "n/a"],
      ["Buttons on notifications", "Notification" in window && Notification.maxActions ? "Up to " + Notification.maxActions : "None"],
      ["Push service", sub ? new URL(sub.endpoint).host : "Not subscribed"],
      ["Storage first created", (marker.where || "?") + ", " + (marker.at || "?")],
      ["Browser", ua],
    ];
    const dl = $("diag"); dl.textContent = "";
    for (const [k, v] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); }
    return rows;
  }
  $("copyBtn").addEventListener("click", async () => {
    const rows = await renderDiag();
    const text = rows.map(([k, v]) => k + ": " + v).join("\n");
    try { await navigator.clipboard.writeText(text); $("copyBtn").textContent = "Copied"; } catch { $("copyBtn").textContent = "Couldn't copy. Take a screenshot instead."; }
  });

  function renderAll() {
    renderInstall();
    markDone("stepKey", !!key);
    $("keyInput").closest(".row").hidden = !!key;
    markDone("stepPush", !!subId);
    $("stepPush").classList.toggle("locked", !key);
    $("stepSend").classList.toggle("locked", !key);
    $("pushBtn").disabled = !key; $("sendBtn").disabled = !key;
    $("pushBtn").textContent = subId ? "Refresh this phone's notification link" : "Turn on notifications";
    $("offBtn").hidden = !subId;
    if (!$("labelInput").value) $("labelInput").value = store.get("label") || "";
    renderDiag(); refresh();
  }

  // Tapped a notification (or its button)? Show that it worked.
  const params = new URLSearchParams(location.search);
  if (params.has("push")) {
    const b = $("actionBanner"); b.hidden = false;
    b.textContent = params.get("action") ? "You tapped the “I'll do it” button on the notification. Buttons work on this phone." : "You opened this from a notification. Tapping works on this phone.";
    history.replaceState(null, "", "/");
  }

  (async () => {
    if ("serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("/sw.js"); swReg = await navigator.serviceWorker.ready; } catch {}
    }
    if (key && !(await checkKey(key))) key = "";
    renderAll();
    setInterval(refresh, 10000);
    document.addEventListener("visibilitychange", refresh);
  })();
})();
