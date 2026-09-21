(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---- Device context (carried over from the Phase 0 spike) ----
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  let secret = store.get("deviceSecret") || "";
  let groupName = store.get("groupName") || "";
  let nickname = store.get("nickname") || "";

  const say = (el, text, kind) => { el.hidden = !text; el.textContent = text || ""; el.className = "msg" + (kind ? " " + kind : ""); };

  async function api(path, opts = {}) {
    const headers = { "content-type": "application/json", ...(opts.headers || {}) };
    if (secret) headers.authorization = "Bearer " + secret;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function setIdentity(out) {
    secret = out.deviceSecret; groupName = out.group.name; nickname = out.member.nickname;
    store.set("deviceSecret", secret); store.set("groupName", groupName); store.set("nickname", nickname);
  }
  function clearIdentity() {
    secret = ""; groupName = ""; nickname = "";
    store.del("deviceSecret"); store.del("groupName"); store.del("nickname");
  }

  // ---- Screen switching ----
  const screens = ["screenInstall", "screenWelcome", "screenHome", "screenSettings"];
  function show(id) { for (const s of screens) $(s).hidden = s !== id; }

  function needsInstallGate() { return isIos && !standalone; }

  // ---- Double-tap confirm helper for destructive actions ----
  function confirmButton(btn, label, confirmLabel, onConfirm) {
    let armed = false, timer = null;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (!armed) {
        armed = true; btn.textContent = confirmLabel;
        timer = setTimeout(() => { armed = false; btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer); armed = false; btn.textContent = label;
      onConfirm();
    });
  }

  // ---- Welcome / create / join ----
  let pendingToken = "";

  let creatorAnswer = ""; // kept only in memory, sent again with the create call

  function showStartChoices() {
    $("joinPreview").hidden = true; $("joinInvalid").hidden = true; $("startChoices").hidden = false;
    $("creatorGate").hidden = true; $("createForm").hidden = true; $("joinCodeForm").hidden = true;
  }
  $("showCreateBtn").addEventListener("click", () => { $("creatorGate").hidden = false; $("createForm").hidden = true; $("joinCodeForm").hidden = true; });
  $("showJoinBtn").addEventListener("click", () => { $("joinCodeForm").hidden = false; $("creatorGate").hidden = true; $("createForm").hidden = true; });

  $("creatorCheckBtn").addEventListener("click", async () => {
    const answer = $("creatorAnswer").value.trim();
    if (!answer) return say($("creatorMsg"), "You have to actually say it.", "bad");
    $("creatorCheckBtn").disabled = true;
    try {
      await api("/api/groups/check", { method: "POST", body: JSON.stringify({ answer }) });
      creatorAnswer = answer;
      say($("creatorMsg"), "Correct. Obviously.", "ok");
      $("createForm").hidden = false;
      $("createGroupName").focus();
    } catch (e) { say($("creatorMsg"), e.message, "bad"); }
    $("creatorCheckBtn").disabled = false;
  });
  $("startOverBtn").addEventListener("click", () => { history.replaceState(null, "", "/"); showStartChoices(); });
  $("notMeBtn").addEventListener("click", () => { history.replaceState(null, "", "/"); showStartChoices(); });

  $("createBtn").addEventListener("click", async () => {
    const groupNameVal = $("createGroupName").value.trim();
    const nick = $("createNickname").value.trim();
    if (!groupNameVal) return say($("createMsg"), "Give the group a name.", "bad");
    if (nick.length < 2) return say($("createMsg"), "Nicknames are 2-20 characters.", "bad");
    $("createBtn").disabled = true;
    try {
      const out = await api("/api/groups", { method: "POST", body: JSON.stringify({ groupName: groupNameVal, nickname: nick, answer: creatorAnswer }) });
      setIdentity(out);
      route();
    } catch (e) { say($("createMsg"), e.message, "bad"); }
    $("createBtn").disabled = false;
  });

  async function previewToken(token) {
    pendingToken = token;
    let preview;
    try { preview = await api("/api/invites/" + encodeURIComponent(token)); }
    catch (e) { preview = { valid: false, reason: e.message }; }
    $("startChoices").hidden = true;
    if (preview.valid) {
      $("joinInvalid").hidden = true; $("joinPreview").hidden = false;
      $("joinGroupName").textContent = preview.groupName;
    } else {
      $("joinPreview").hidden = true; $("joinInvalid").hidden = false;
      $("joinInvalidReason").textContent = preview.reason || "That invite doesn't work anymore.";
    }
  }

  $("checkCodeBtn").addEventListener("click", () => {
    const v = $("codeInput").value.trim();
    if (!v) return say($("codeMsg"), "Paste or type the invite code.", "bad");
    say($("codeMsg"), "", null);
    previewToken(v);
  });

  $("joinBtn").addEventListener("click", async () => {
    const nick = $("joinNickname").value.trim();
    if (nick.length < 2) return say($("joinMsg"), "Nicknames are 2-20 characters.", "bad");
    $("joinBtn").disabled = true;
    try {
      const out = await api("/api/join", { method: "POST", body: JSON.stringify({ token: pendingToken, nickname: nick }) });
      setIdentity(out);
      history.replaceState(null, "", "/");
      route();
    } catch (e) { say($("joinMsg"), e.message, "bad"); }
    $("joinBtn").disabled = false;
  });

  // ---- Formatting ----
  const KIND_LABEL = { breakfast: "breakfast", lunch: "lunch", snacks: "snacks", dinner: "dinner", sutta: "sutta", campus: "campus" };
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
  function dayLabel(ms) {
    const d = new Date(ms), t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t) / 86400000);
    return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
  }
  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60); if (m < 60) return m + "m ago";
    const h = Math.round(m / 60); if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  // ---- Push subscription ----
  let vapidKey = "";
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  function b64ToU8(s) {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  // Returns "granted" | "denied" | "default" | "unsupported" | "no-key". Only prompts when interactive.
  async function ensurePush(interactive) {
    if (!pushSupported) return "unsupported";
    if (!vapidKey) return "no-key";
    let perm = Notification.permission;
    if (perm !== "granted") {
      if (!interactive) return perm;
      perm = await Notification.requestPermission();
      if (perm !== "granted") return perm;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(vapidKey) });
    const j = sub.toJSON();
    await api("/api/subscriptions", { method: "POST", body: JSON.stringify({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, platform: isIos ? "ios" : /Android/.test(ua) ? "android" : "desktop" }) });
    return "granted";
  }
  function describePush(state) {
    if (state === "granted") return "Notifications are on for this device.";
    if (state === "denied") return "Notifications are blocked. Allow them for this app in your phone's settings, then come back.";
    if (state === "unsupported") return isIos && !standalone ? "On iPhone, notifications only work from the home-screen icon." : "This browser can't do push notifications.";
    if (state === "no-key") return "Couldn't load the push key. Try again.";
    return "Notifications are off.";
  }
  let pushState = "default";
  async function refreshPush(interactive) {
    try { pushState = await ensurePush(interactive); }
    catch (e) { pushState = "error:" + e.message; }
    const on = pushState === "granted";
    $("notifNudge").hidden = on || pushState === "unsupported";
    $("pushStatus").textContent = pushState.startsWith("error:") ? "Couldn't turn on notifications: " + pushState.slice(6) : describePush(pushState);
    $("enablePushBtn2").hidden = on;
    $("testPushBtn").hidden = !on;
    return on;
  }
  async function enablePushClick(msgEl) {
    say(msgEl, "", null);
    const on = await refreshPush(true);
    if (!on) say(msgEl, describePush(pushState), "bad");
    else { say(msgEl, "Done. Sending a test push...", "ok"); testPush(msgEl); }
  }
  async function testPush(msgEl) {
    try {
      const r = await api("/api/push/test", { method: "POST" });
      if (r.subscriptions === 0) say(msgEl, "This device isn't subscribed yet.", "bad");
      else if (r.delivered === r.subscriptions) say(msgEl, "Sent. It should show up on this device in a moment.", "ok");
      else say(msgEl, "The push service didn't accept it: " + r.results.map((x) => x.status + " " + (x.detail || "")).join("; "), "bad");
    } catch (e) { say(msgEl, e.message, "bad"); }
  }
  $("enablePushBtn").addEventListener("click", () => enablePushClick($("notifNudgeMsg")));
  $("enablePushBtn2").addEventListener("click", () => enablePushClick($("pushMsg")));
  $("testPushBtn").addEventListener("click", () => { say($("pushMsg"), "Sending...", null); testPush($("pushMsg")); });

  // ---- Home ----
  let home = null; // last /api/home payload
  let pendingDeepLink = null; // { wakeup, action } from a notification tap

  function renderMemberList(container, members, me, { removable, health }) {
    container.textContent = "";
    for (const m of members) {
      const item = el("div", "item");
      const name = el("span", "name", m.nickname);
      if (m.id === me) name.append(el("span", "you", " (you)"));
      if (health) {
        let meta, cls = "";
        if (m.subscriptions === 0) { meta = "no notifications yet"; cls = "bad"; }
        else if (m.pushError) { meta = "push failing: " + m.pushError.slice(0, 40); cls = "bad"; }
        else if (m.pushOkAt) { meta = "push OK " + ago(m.pushOkAt); cls = "ok"; }
        else meta = "subscribed, no push received yet";
        name.append(el("span", "meta " + cls, meta));
      }
      item.append(name);
      if (!removable) item.append(el("span", "when", m.lastSeenAt ? "seen " + ago(m.lastSeenAt) : ""));
      if (removable) {
        const btn = el("button", "quiet");
        confirmButton(btn, m.id === me ? "Leave" : "Remove", "Tap to confirm", async () => {
          btn.disabled = true;
          try {
            await api("/api/members/" + encodeURIComponent(m.id) + "/remove", { method: "POST" });
            if (m.id === me) { clearIdentity(); history.replaceState(null, "", "/"); showStartChoices(); route(); }
            else { await loadHome(); show("screenSettings"); }
          } catch (e) { say($("leaveMsg"), e.message, "bad"); btn.disabled = false; }
        });
        item.append(btn);
      }
      container.append(item);
    }
  }

  function renderWakeups(list, meId) {
    const box = $("wakeList"); box.textContent = "";
    $("wakeEmpty").hidden = list.length > 0;
    const live = list.filter((w) => w.status === "upcoming" || w.status === "claimed");
    $("wakeSub").textContent = live.length ? live.length + " pending" : "";
    const mineLive = live.some((w) => w.requesterId === meId);
    $("askWakeBtn").hidden = mineLive;
    if (mineLive) $("wakeForm").hidden = true;
    for (const w of list) {
      const mine = w.requesterId === meId;
      const card = el("div", "wake" + (mine ? " mine" : ""));
      card.dataset.id = w.id;
      const top = el("div", "top");
      top.append(el("span", "time", fmtTime(w.wakeAt)), el("span", "day", dayLabel(w.wakeAt)), el("span", "who", mine ? "you" : w.requester));
      card.append(top);
      if (w.note) card.append(el("div", "note", w.note));
      if (w.audience && home) {
        const names = home.members.filter((m) => w.audience.includes(m.id)).map((m) => (m.id === meId ? "you" : m.nickname));
        card.append(el("div", "note", "Asked: " + (names.join(", ") || "specific people")));
      }
      let statusText, cls;
      if (w.status === "awake") { statusText = (mine ? "You're" : w.requester + " is") + " awake" + (w.claimer ? " — thanks to " + w.claimer : ""); cls = "grey"; }
      else if (w.status === "expired") { statusText = "Expired — no word from " + (mine ? "you" : w.requester); cls = "grey"; }
      else if (w.status === "claimed") { statusText = "🟢 " + (w.claimedBy === meId ? "You're" : w.claimer + " is") + " waking " + (mine ? "you" : w.requester); cls = "green"; }
      else if (w.unclaimed) { statusText = "🔴 Unclaimed — nobody's got this yet"; cls = "red"; }
      else { statusText = "Upcoming — nobody's claimed it yet"; cls = ""; }
      card.append(el("div", "status " + cls, statusText));

      const actions = el("div", "row");
      const canClaim = !mine && w.status === "upcoming";
      const canAwake = mine && (w.status === "upcoming" || w.status === "claimed");
      const canCancel = mine && (w.status === "upcoming" || w.status === "claimed") && w.wakeAt > Date.now();
      if (canClaim) actions.append(actionButton("I'll wake " + w.requester, "big", () => wakeupAction(w.id, "claim", card)));
      if (canAwake) actions.append(actionButton("I'm awake", "big", () => wakeupAction(w.id, "awake", card)));
      if (canCancel) { const b = el("button", "quiet"); confirmButton(b, "Cancel this wake-up", "Tap again to cancel", () => wakeupAction(w.id, "cancel", card)); actions.append(b); }
      if (actions.childElementCount) card.append(actions);
      const cardMsg = el("p", "msg", ""); cardMsg.hidden = true; card.append(cardMsg);
      box.append(card);
    }
  }
  function actionButton(label, cls, fn) { const b = el("button", cls, label); b.addEventListener("click", () => { b.disabled = true; fn().finally(() => { b.disabled = false; }); }); return b; }
  async function wakeupAction(id, action, card) {
    const msg = card ? card.querySelector(".msg") : null;
    try {
      await api("/api/wakeups/" + encodeURIComponent(id) + "/" + action, { method: "POST" });
      await loadHome();
    } catch (e) {
      if (msg) say(msg, e.message, "bad"); else alert(e.message);
      loadHome();
    }
  }

  function renderFeed(events) {
    const box = $("feed"); box.textContent = "";
    $("feedEmpty").hidden = events.length > 0;
    for (const e of events) {
      const item = el("div", "feeditem");
      const line = el("div", "line"); line.append(el("span", "text", e.text), el("span", "when", ago(e.at))); item.append(line);
      if (e.plan) {
        const p = e.plan;
        if (p.canReply) {
          const row = el("div", "rsvp");
          const mk = (status, label) => {
            const b = el("button", "quiet" + (p.mine === status ? " on " + status : ""), label);
            b.addEventListener("click", async () => {
              const next = p.mine === status ? null : status; // tapping your current answer clears it
              for (const x of row.querySelectorAll("button")) x.disabled = true;
              try { await api("/api/activities/" + encodeURIComponent(p.id) + "/rsvp", { method: "POST", body: JSON.stringify({ status: next }) }); }
              catch (err) { alert(err.message); }
              loadHome();
            });
            return b;
          };
          row.append(mk("in", "In"), mk("out", "Out"));
          item.append(row);
        }
        if (p.in.length || p.out.length) {
          const who = el("div", "who");
          if (p.in.length) { const b = el("b", "", "In: "); who.append(b, document.createTextNode(p.in.join(", "))); }
          if (p.out.length) who.append(document.createTextNode((p.in.length ? "  ·  " : "") + "Out: " + p.out.join(", ")));
          item.append(who);
        }
      }
      box.append(item);
    }
  }

  async function loadHome() {
    let data;
    try { data = await api("/api/home"); }
    catch (e) {
      if (/Not signed in/.test(e.message)) { clearIdentity(); route(); }
      return;
    }
    home = data;
    vapidKey = data.vapidPublicKey || vapidKey;
    groupName = data.group.name; nickname = data.member.nickname;
    store.set("groupName", groupName); store.set("nickname", nickname);
    $("homeGroupName").textContent = groupName;
    $("homeSub").textContent = data.members.length + " of 9 in the group";
    $("memberCount").textContent = data.members.length + "/9";
    $("settingsNickname").textContent = nickname;
    $("settingsGroupName").textContent = groupName;
    $("settingsSub").textContent = groupName;
    renderWakeups(data.wakeups || [], data.member.id);
    renderFeed(data.events || []);
    renderMemberList($("homeMembers"), data.members, data.member.id, { removable: false, health: true });
    renderMemberList($("settingsMembers"), data.members, data.member.id, { removable: true, health: false });
    $("inviteBtn").disabled = data.members.length >= 9;

    if (pendingDeepLink) {
      const link = pendingDeepLink; pendingDeepLink = null;
      const card = $("wakeList").querySelector('[data-id="' + link.wakeup + '"]');
      if (card) { card.classList.add("flash"); card.scrollIntoView({ block: "center", behavior: "smooth" }); setTimeout(() => card.classList.remove("flash"), 3000); }
      if (link.action === "claim" || link.action === "awake") await wakeupAction(link.wakeup, link.action, card);
    }
  }

  // ---- "Send to specific people" picker. Resolves with member ids, or null if dismissed. ----
  let pickResolve = null;
  function openPicker(title) {
    return new Promise((resolve) => {
      pickResolve = resolve;
      $("pickTitle").textContent = title;
      const list = $("pickList"); list.textContent = "";
      const others = (home ? home.members : []).filter((m) => m.id !== home.member.id);
      if (!others.length) list.append(el("p", "muted", "Nobody else in the group yet."));
      for (const m of others) {
        const label = el("label", "tog"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = m.id;
        label.append(cb, document.createTextNode(" " + m.nickname)); list.append(label);
      }
      $("pickSendBtn").disabled = !others.length;
      $("pickModal").hidden = false;
    });
  }
  function closePicker(result) { $("pickModal").hidden = true; const r = pickResolve; pickResolve = null; if (r) r(result); }
  $("pickAllBtn").addEventListener("click", () => { for (const cb of $("pickList").querySelectorAll("input")) cb.checked = true; });
  $("pickNoneBtn").addEventListener("click", () => { for (const cb of $("pickList").querySelectorAll("input")) cb.checked = false; });
  $("pickCancelBtn").addEventListener("click", () => closePicker(null));
  $("pickModal").addEventListener("click", (e) => { if (e.target === $("pickModal")) closePicker(null); });
  $("pickSendBtn").addEventListener("click", () => {
    const ids = [...$("pickList").querySelectorAll("input:checked")].map((cb) => cb.value);
    if (!ids.length) { $("pickTitle").textContent = "Pick at least one person"; return; }
    closePicker(ids);
  });

  // Wake-up form
  function defaultWakeTime() {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d;
  }
  $("askWakeBtn").addEventListener("click", () => {
    const d = defaultWakeTime();
    $("wakeDay").value = d.getDate() === new Date().getDate() ? "today" : "tomorrow";
    $("wakeTime").value = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    $("wakeNote").value = "";
    say($("wakeMsg"), "", null);
    $("wakeForm").hidden = false; $("askWakeBtn").hidden = true;
    $("wakeTime").focus();
  });
  $("wakeFormCloseBtn").addEventListener("click", () => { $("wakeForm").hidden = true; $("askWakeBtn").hidden = false; });
  async function submitWakeup(toSome) {
    const [hh, mm] = ($("wakeTime").value || "").split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return say($("wakeMsg"), "Pick a time.", "bad");
    const d = new Date(); d.setHours(hh, mm, 0, 0);
    if ($("wakeDay").value === "tomorrow") d.setDate(d.getDate() + 1);
    let to = null;
    if (toSome) { to = await openPicker("Who should wake you?"); if (!to) return; }
    $("wakeCreateBtn").disabled = true; $("wakeCreateSomeBtn").disabled = true;
    try {
      await api("/api/wakeups", { method: "POST", body: JSON.stringify({ wakeAt: d.getTime(), note: $("wakeNote").value, to }) });
      $("wakeForm").hidden = true;
      await loadHome();
    } catch (e) { say($("wakeMsg"), e.message, "bad"); }
    $("wakeCreateBtn").disabled = false; $("wakeCreateSomeBtn").disabled = false;
  }
  $("wakeCreateBtn").addEventListener("click", () => submitWakeup(false));
  $("wakeCreateSomeBtn").addEventListener("click", () => submitWakeup(true));

  // Quick actions (five buttons + a free-text custom plan)
  let pendingKind = "", pendingText = "";
  $("actGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-kind]"); if (!btn) return;
    pendingKind = btn.dataset.kind; pendingText = "";
    $("actConfirmText").textContent = "Say you want to go for " + KIND_LABEL[pendingKind] + "?";
    $("actConfirm").hidden = false; say($("actMsg"), "", null);
  });
  $("customPlanBtn").addEventListener("click", () => {
    const t = $("customPlanText").value.trim();
    if (!t) { say($("actMsg"), "Type something first.", "bad"); $("customPlanText").focus(); return; }
    pendingKind = "custom"; pendingText = t;
    $("actConfirmText").textContent = "Send \u201c" + t + "\u201d?";
    $("actConfirm").hidden = false; say($("actMsg"), "", null);
  });
  $("customPlanText").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("customPlanBtn").click(); } });
  $("actCancelBtn").addEventListener("click", () => { $("actConfirm").hidden = true; });
  async function sendActivity(toSome) {
    let to = null;
    if (toSome) { to = await openPicker("Send this to who?"); if (!to) return; }
    $("actSendBtn").disabled = true; $("actSendSomeBtn").disabled = true;
    try {
      await api("/api/activities", { method: "POST", body: JSON.stringify({ kind: pendingKind, text: pendingText, to }) });
      $("actConfirm").hidden = true;
      if (pendingKind === "custom") $("customPlanText").value = "";
      say($("actMsg"), to ? "Sent to " + to.length + (to.length === 1 ? " person." : " people.") : "Sent to everyone.", "ok");
      setTimeout(() => say($("actMsg"), "", null), 4000);
      loadHome();
    } catch (e) { say($("actMsg"), e.message, "bad"); }
    $("actSendBtn").disabled = false; $("actSendSomeBtn").disabled = false;
  }
  $("actSendBtn").addEventListener("click", () => sendActivity(false));
  $("actSendSomeBtn").addEventListener("click", () => sendActivity(true));

  $("inviteBtn").addEventListener("click", async () => {
    $("inviteBtn").disabled = true;
    try {
      const out = await api("/api/invites", { method: "POST" });
      $("inviteResult").hidden = false;
      $("inviteCode").textContent = out.code;
      $("inviteLink").textContent = out.url;
      $("shareInviteBtn").hidden = !navigator.share;
      $("copyInviteBtn").onclick = async () => {
        try { await navigator.clipboard.writeText(out.url); $("copyInviteBtn").textContent = "Copied"; }
        catch { $("copyInviteBtn").textContent = "Couldn't copy — select the link above."; }
      };
      $("shareInviteBtn").onclick = () => navigator.share({ title: "Join " + groupName + " on HarshOnTime", url: out.url }).catch(() => {});
    } catch (e) { alert(e.message); }
    $("inviteBtn").disabled = false;
  });

  // ---- Settings / preferences ----
  let prefs = null;
  function muteOptions(select, current) {
    select.textContent = "";
    const add = (v, t) => select.append(new Option(t, v));
    if (current) add("keep", "Muted until " + dayLabel(current).toLowerCase() + " " + fmtTime(current));
    add("", current ? "Unmute" : "Not muted");
    add("1h", "For 1 hour");
    add("tomorrow8", "Until tomorrow 8 AM");
    add("custom", "Until a time I pick…");
    select.value = current ? "keep" : "";
  }
  function muteValue(select, customInput, current) {
    const v = select.value;
    if (v === "keep") return current;
    if (v === "") return null;
    if (v === "1h") return Date.now() + 3600 * 1000;
    if (v === "tomorrow8") { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); }
    const t = new Date(customInput.value).getTime();
    if (!Number.isFinite(t)) throw new Error("Pick a time to mute until.");
    return t;
  }
  function wireCustom(select, input) { select.addEventListener("change", () => { input.hidden = select.value !== "custom"; if (!input.hidden && !input.value) { const d = new Date(Date.now() + 3600e3); d.setSeconds(0, 0); input.value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); } }); }
  wireCustom($("pWakeMute"), $("pWakeMuteCustom")); wireCustom($("pActMute"), $("pActMuteCustom"));

  function renderMuteChecks(container, scope) {
    container.textContent = "";
    const others = (home ? home.members : []).filter((m) => m.id !== home.member.id);
    if (!others.length) { container.append(el("p", "muted", "Nobody else here yet.")); return; }
    for (const m of others) {
      const label = el("label", "tog"); const cb = document.createElement("input"); cb.type = "checkbox"; cb.dataset.member = m.id; cb.dataset.scope = scope;
      cb.checked = prefs.mutes.some((x) => x.memberId === m.id && x.scope === scope);
      label.append(cb, document.createTextNode(" " + m.nickname)); container.append(label);
    }
  }
  async function loadSettings() {
    say($("prefsMsg"), "", null); say($("pushMsg"), "", null);
    try { prefs = await api("/api/prefs"); } catch (e) { say($("prefsMsg"), e.message, "bad"); return; }
    $("pWakeOn").checked = prefs.wakeupsEnabled;
    muteOptions($("pWakeMute"), prefs.wakeupsMutedUntil); $("pWakeMuteCustom").hidden = true;
    muteOptions($("pActMute"), prefs.activitiesMutedUntil); $("pActMuteCustom").hidden = true;
    for (const cb of $("pKinds").querySelectorAll("input")) cb.checked = !!prefs.kinds[cb.dataset.kind];
    renderMuteChecks($("pWakeMutes"), "wakeups"); renderMuteChecks($("pActMutes"), "activities");
  }
  $("savePrefsBtn").addEventListener("click", async () => {
    $("savePrefsBtn").disabled = true;
    try {
      const kinds = {}; for (const cb of $("pKinds").querySelectorAll("input")) kinds[cb.dataset.kind] = cb.checked;
      const mutes = [...document.querySelectorAll("#pWakeMutes input:checked, #pActMutes input:checked")].map((cb) => ({ memberId: cb.dataset.member, scope: cb.dataset.scope }));
      const bodyObj = {
        wakeupsEnabled: $("pWakeOn").checked,
        wakeupsMutedUntil: muteValue($("pWakeMute"), $("pWakeMuteCustom"), prefs.wakeupsMutedUntil),
        activitiesMutedUntil: muteValue($("pActMute"), $("pActMuteCustom"), prefs.activitiesMutedUntil),
        kinds, mutes,
      };
      prefs = await api("/api/prefs", { method: "PUT", body: JSON.stringify(bodyObj) });
      await loadSettings();
      say($("prefsMsg"), "Saved.", "ok");
    } catch (e) { say($("prefsMsg"), e.message, "bad"); }
    $("savePrefsBtn").disabled = false;
  });

  confirmButton($("leaveBtn"), "Leave this group", "Tap again to leave", async () => {
    $("leaveBtn").disabled = true;
    try {
      await api("/api/members/" + encodeURIComponent(home.member.id) + "/remove", { method: "POST" });
      clearIdentity(); history.replaceState(null, "", "/"); showStartChoices(); route();
    } catch (e) { say($("leaveMsg"), e.message, "bad"); }
    $("leaveBtn").disabled = false;
  });

  $("settingsLink").addEventListener("click", (e) => { e.preventDefault(); show("screenSettings"); loadSettings(); refreshPush(false); window.scrollTo(0, 0); });
  $("backHomeLink").addEventListener("click", (e) => { e.preventDefault(); show("screenHome"); loadHome(); window.scrollTo(0, 0); });

  // ---- Routing ----
  function route() {
    // An already-established identity always gets to Home; the install gate only blocks a fresh
    // create/join, since that is the moment a new device secret would otherwise be created in a
    // Safari tab whose storage may not carry over to the installed app.
    if (secret) {
      const q = new URLSearchParams(location.search);
      if (q.get("wakeup")) pendingDeepLink = { wakeup: q.get("wakeup"), action: q.get("action") || "" };
      if (location.search) history.replaceState(null, "", "/");
      show("screenHome");
      loadHome().then(() => refreshPush(false));
      return;
    }
    if (needsInstallGate()) { show("screenInstall"); return; }
    show("screenWelcome");
    const hashToken = location.hash.replace(/^#/, "");
    if (hashToken) { showStartChoices(); previewToken(hashToken); }
    else showStartChoices();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "push" && secret && !$("screenHome").hidden) loadHome();
    });
  }

  route();
  const homeVisible = () => !document.hidden && secret && !$("screenHome").hidden;
  document.addEventListener("visibilitychange", () => { if (homeVisible()) { loadHome(); refreshPush(false); } });
  window.addEventListener("online", () => { if (homeVisible()) loadHome(); });
  setInterval(() => { if (homeVisible()) loadHome(); }, 15000);
})();
