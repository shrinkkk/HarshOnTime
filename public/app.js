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

  // ---- Home ----
  function renderMemberList(container, members, me, { removable }) {
    container.textContent = "";
    for (const m of members) {
      const item = document.createElement("div"); item.className = "item";
      const name = document.createElement("span"); name.className = "name";
      name.textContent = m.nickname;
      if (m.id === me) { const you = document.createElement("span"); you.className = "you"; you.textContent = " (you)"; name.append(you); }
      item.append(name);
      if (removable) {
        const btn = document.createElement("button"); btn.className = "quiet";
        confirmButton(btn, m.id === me ? "Leave" : "Remove", "Tap to confirm", async () => {
          btn.disabled = true;
          try {
            await api("/api/members/" + encodeURIComponent(m.id) + "/remove", { method: "POST" });
            if (m.id === me) { clearIdentity(); history.replaceState(null, "", "/"); showStartChoices(); route(); }
            else await loadHome();
          } catch (e) { alert(e.message); btn.disabled = false; }
        });
        item.append(btn);
      }
      container.append(item);
    }
  }

  let lastMembers = [];

  async function loadHome() {
    let me;
    try { me = await api("/api/me"); }
    catch { clearIdentity(); route(); return; }
    groupName = me.group.name; nickname = me.member.nickname;
    store.set("groupName", groupName); store.set("nickname", nickname);
    lastMembers = me.members;
    $("homeGroupName").textContent = groupName;
    $("homeSub").textContent = me.members.length + " of 9 in the group";
    $("memberCount").textContent = me.members.length + "/9";
    $("settingsNickname").textContent = nickname;
    $("settingsGroupName").textContent = groupName;
    $("settingsSub").textContent = groupName;
    renderMemberList($("homeMembers"), me.members, me.member.id, { removable: false });
    renderMemberList($("settingsMembers"), me.members, me.member.id, { removable: true });
    $("inviteBtn").disabled = me.members.length >= 9;
  }

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

  $("settingsLink").addEventListener("click", (e) => { e.preventDefault(); show("screenSettings"); });
  $("backHomeLink").addEventListener("click", (e) => { e.preventDefault(); show("screenHome"); loadHome(); });

  // ---- Routing ----
  function route() {
    // An already-established identity always gets to Home; the install gate only blocks a fresh
    // create/join, since that is the moment a new device secret would otherwise be created in a
    // Safari tab whose storage may not carry over to the installed app.
    if (secret) { show("screenHome"); loadHome(); return; }
    if (needsInstallGate()) { show("screenInstall"); return; }
    show("screenWelcome");
    const hashToken = location.hash.replace(/^#/, "");
    if (hashToken) { showStartChoices(); previewToken(hashToken); }
    else showStartChoices();
  }

  // Registered unconditionally so it's ready before Phase 2 wires up push subscriptions.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  route();
  document.addEventListener("visibilitychange", () => { if (!document.hidden && secret && !$("screenHome").hidden) loadHome(); });
})();
