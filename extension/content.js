// WatchParty Sync - content script (isolated world).
// Joins an existing WatchParty room over socket.io and keeps this tab's <video> in sync
// (play / pause / seek / playback speed) with everyone else in the room. No video data
// is relayed: every person streams from their own account.
(() => {
  "use strict";
  if (window.__wpExt) return;
  window.__wpExt = true;

  // The bookmarklet (src/utils/bookmarklet.ts) runs this same file in the page's own world
  // and sets window.__wpServer / window.__wpRoom first; the extension never does.
  const SERVER = window.__wpServer || "http://localhost:8080";
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const SUPPRESS_MS = 700; // ignore the local events our own remote-apply causes
  const SEEK_TARGET_MS = 5000; // a remote seek can finish (seeked) long after we asked
  const SEEK_EPSILON = 0.5; // no point seeking when already this close
  const SITE_RESET_MS = 3000; // after a (re)load the site may reset playbackRate itself
  const MAX_CHAT = 200;

  // One identity per page load. A second socket with the same clientId kicks the first,
  // so it is never shared between tabs and never stored.
  const clientId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const sessionId = crypto.randomUUID().replace(/-/g, "");

  // ---- state ----
  let socket = null;
  let joined = false; // socket connected
  let video = null;
  let roomRate = 1;
  let names = {};
  let chat = [];
  let buffering = false; // last CMD:buffering state we reported (true = asked the room to pause)
  let members = null; // roster ids from the last 'roster' event; null = nothing received yet
  let collapsed = false;
  let sync = null; // { host, tsMap, done } for the current connection
  let pendingHost = null; // joiner state waiting for a <video> to appear
  let remoteSeek = null; // { t, at }
  let siteResetUntil = 0;
  let resetReapplied = false;
  const until = { play: 0, pause: 0, seeked: 0, ratechange: 0 };
  const emitCounts = {};

  // chrome.storage only exists for an installed extension; the bookmarklet (page world)
  // falls back to localStorage under a "wpx:" prefix.
  const useChromeStore = typeof chrome !== "undefined" && !!chrome.storage;
  const store = {
    get: (keys) =>
      new Promise((resolve) => {
        if (!useChromeStore) {
          const r = {};
          for (const k of keys) {
            try {
              const raw = localStorage.getItem("wpx:" + k);
              if (raw !== null) r[k] = JSON.parse(raw);
            } catch {
              // storage blocked or value not ours: treat as unset
            }
          }
          resolve(r);
          return;
        }
        try {
          chrome.storage.local.get(keys, (r) => resolve(r || {}));
        } catch {
          resolve({});
        }
      }),
    set: (obj) => {
      if (!useChromeStore) {
        for (const [k, v] of Object.entries(obj)) {
          try {
            localStorage.setItem("wpx:" + k, JSON.stringify(v));
          } catch {
            // storage blocked
          }
        }
        return;
      }
      try {
        chrome.storage.local.set(obj);
      } catch {
        // extension reloaded under a live tab: nothing to persist to
      }
    },
  };

  const suppress = (...kinds) => {
    const t = Date.now() + SUPPRESS_MS;
    kinds.forEach((k) => (until[k] = t));
  };
  const suppressed = (kind) => Date.now() < until[kind];

  // ---- panel ----
  const host = document.createElement("div");
  host.id = "wpx-host";
  host.style.cssText =
    "all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
      .panel { width: 280px; max-height: 80vh; display: flex; flex-direction: column; gap: 8px;
        background: rgba(20,20,24,0.94); color: #eee; border: 1px solid #3a3a44; border-radius: 10px;
        padding: 10px; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,0.5); }
      .panel.collapsed .body { display: none; }
      .head { display: flex; align-items: center; justify-content: space-between; font-weight: 600; }
      .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #777; margin-right: 6px; }
      .dot.on { background: #3ddc84; }
      .dot.err { background: #ff5a5a; }
      .body { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
      input { width: 100%; background: #2a2a32; color: #eee; border: 1px solid #44444f; border-radius: 6px;
        padding: 6px 8px; font-size: 13px; outline: none; }
      input:focus { border-color: #7a8cff; }
      button { cursor: pointer; background: #34343e; color: #eee; border: 1px solid #4a4a56; border-radius: 6px;
        padding: 5px 8px; font-size: 12px; }
      button:hover { background: #44444f; }
      button.primary { background: #4b5bd6; border-color: #6b7bff; }
      button.active { background: #4b5bd6; border-color: #8c9aff; font-weight: 600; }
      .row { display: flex; gap: 6px; }
      .row > * { flex: 1; }
      .rates { display: flex; gap: 4px; }
      .rates button { flex: 1; padding: 5px 0; }
      .status { font-size: 12px; color: #aab; min-height: 16px; }
      .log { flex: 1; min-height: 110px; max-height: 260px; overflow-y: auto; background: #1b1b21;
        border: 1px solid #33333c; border-radius: 6px; padding: 6px; font-size: 12px; line-height: 1.4; }
      .log .sys { color: #98a; font-style: italic; }
      .log .who { color: #9db0ff; font-weight: 600; }
      .log div { margin-bottom: 3px; word-wrap: anywhere; }
      .members { font-size: 11px; color: #8892a8; min-height: 14px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .rx { display: flex; gap: 4px; }
      .rx button { flex: 1; padding: 4px 0; font-size: 15px; }
      #floats { position: fixed; right: 20px; bottom: 30vh; display: flex; flex-direction: column;
        align-items: flex-end; gap: 4px; pointer-events: none; }
      #floats .float { font-size: 26px; color: #fff; text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7);
        animation: wpx-float 2.5s ease-out forwards; }
      @keyframes wpx-float {
        0% { transform: translateY(0); opacity: 0; }
        12% { opacity: 1; }
        75% { opacity: 1; }
        100% { transform: translateY(-140px); opacity: 0; }
      }
    </style>
    <div class="panel" id="panel">
      <div class="head">
        <span><span class="dot" id="dot"></span>WatchParty</span>
        <button id="toggle" title="Collapse / expand">&ndash;</button>
      </div>
      <div class="body">
        <input id="room" placeholder="Room URL or name" spellcheck="false" autocomplete="off" />
        <div class="row">
          <input id="name" placeholder="Your name" maxlength="50" spellcheck="false" autocomplete="off" />
          <button id="join" class="primary" style="flex:0 0 70px">Join</button>
        </div>
        <div class="status" id="status">Not connected</div>
        <div class="members" id="members"></div>
        <div class="rates" id="rates"></div>
        <div class="rx" id="rx"></div>
        <div class="log" id="log"></div>
        <input id="chatinput" placeholder="Message (Enter to send)" maxlength="500" autocomplete="off" />
      </div>
    </div>
    <div id="floats"></div>`;
  const $ = (id) => root.getElementById(id);
  const el = {
    panel: $("panel"),
    dot: $("dot"),
    toggle: $("toggle"),
    room: $("room"),
    name: $("name"),
    join: $("join"),
    status: $("status"),
    members: $("members"),
    rates: $("rates"),
    rx: $("rx"),
    log: $("log"),
    chatinput: $("chatinput"),
    floats: $("floats"),
  };

  RATES.forEach((r) => {
    const b = document.createElement("button");
    b.textContent = r + "x";
    b.dataset.rate = String(r);
    b.addEventListener("click", () => setRate(r));
    el.rates.appendChild(b);
  });

  // Same list the server validates (FLOAT_REACTIONS in server/room.ts)
  ["😂", "❤️", "😮", "😢", "👏", "🔥"].forEach((emoji) => {
    const b = document.createElement("button");
    b.textContent = emoji;
    b.title = "React " + emoji;
    b.addEventListener("click", () => emit("CMD:floatReaction", emoji));
    el.rx.appendChild(b);
  });

  // Netflix binds player shortcuts (space, f, m, arrows) and click-to-pause on its container,
  // and in fullscreen the panel lives inside that container: keep our events to ourselves.
  [
    "click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup",
    "keydown", "keyup", "keypress", "wheel", "contextmenu",
  ].forEach((type) => host.addEventListener(type, (e) => e.stopPropagation()));

  function placeHost() {
    const fs = document.fullscreenElement;
    const target =
      fs && fs.tagName !== "VIDEO" && fs.tagName !== "IFRAME"
        ? fs
        : document.body || document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
  }
  document.addEventListener("fullscreenchange", placeHost);

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.dot.className = "dot" + (kind === "on" ? " on" : kind === "err" ? " err" : "");
    host.dataset.status = kind || "idle";
  }

  function updateJoinButton() {
    el.join.textContent = socket ? "Leave" : "Join";
  }

  function updateRates() {
    const cur = video ? video.playbackRate : roomRate;
    el.rates.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", Math.abs(Number(b.dataset.rate) - cur) < 0.001);
    });
    host.dataset.rate = String(cur);
  }

  const fmtTime = (s) => {
    const n = Math.max(0, Math.floor(Number(s)));
    if (!Number.isFinite(n)) return String(s);
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const sec = String(n % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };

  const nameOf = (id) => names[id] || (id ? String(id).slice(0, 6) : "?");

  function renderMembers() {
    el.members.textContent = members
      ? members.length + " watching: " + members.map(nameOf).join(", ")
      : "";
  }

  function renderChat() {
    el.log.textContent = "";
    for (const m of chat) {
      const who = nameOf(m.id);
      const line = document.createElement("div");
      if (m.sysJoin || m.sysLeave) {
        // Resolved at render time: the name may arrive (REC:nameMap) after the notice
        line.className = "sys";
        line.textContent = m.sysJoin
          ? nameOf(m.sysJoin) + " joined"
          : nameOf(m.sysLeave) + " left";
      } else if (m.cmd) {
        const text =
          {
            play: "played",
            pause: "paused",
            seek: "seeked to " + fmtTime(m.msg),
            playbackRate: "set speed " + m.msg + "x",
            host: "started a video",
          }[m.cmd] || m.cmd;
        line.className = "sys";
        line.textContent = who + " " + text;
      } else {
        const w = document.createElement("span");
        w.className = "who";
        w.textContent = who;
        line.appendChild(w);
        line.appendChild(document.createTextNode(": " + (m.msg || "")));
      }
      el.log.appendChild(line);
    }
    el.log.scrollTop = el.log.scrollHeight;
  }

  function pushChat(m) {
    chat.push(m);
    if (chat.length > MAX_CHAT) chat = chat.slice(-MAX_CHAT);
    renderChat();
  }

  const pushSys = (id, left) => pushChat(left ? { sysLeave: id } : { sysJoin: id });

  // ---- socket helpers ----
  // The web app applies REC:play/pause/seek/playbackRate to whatever the room is playing
  // (a YouTube video, a screen share...), so only sync while the room has no media of its own.
  let roomMedia = "";
  const PLAYBACK = ["CMD:play", "CMD:pause", "CMD:seek", "CMD:playbackRate", "CMD:ts"];
  function emit(ev, arg) {
    if (!socket || !socket.connected) return;
    if (roomMedia && PLAYBACK.includes(ev)) return;
    emitCounts[ev] = (emitCounts[ev] || 0) + 1;
    host.dataset.emits = JSON.stringify(emitCounts);
    if (arg === undefined) socket.emit(ev);
    else socket.emit(ev, arg);
  }

  // ---- apply remote -> local (each one masks the local event it will cause) ----
  function applyRate(r) {
    if (!video || Math.abs(video.playbackRate - r) < 1e-6) return;
    suppress("ratechange");
    video.playbackRate = r;
  }
  function applyPlay() {
    if (!video || !video.paused) return;
    suppress("play");
    video.play().catch(() => {
      setStatus("Press play yourself (the browser blocked autoplay)", "on");
    });
  }
  function applyPause() {
    if (!video || video.paused) return;
    suppress("pause");
    video.pause();
  }
  function applySeek(t) {
    if (!video || !Number.isFinite(t)) return;
    if (Math.abs(video.currentTime - t) < SEEK_EPSILON) return;
    remoteSeek = { t, at: Date.now() };
    suppress("seeked");
    // the Netflix player must be seeked from the page's own JS world (page.js)
    window.postMessage({ source: "wp-ext", type: "seek", seconds: t }, "*");
  }

  // ---- local -> room ----
  const onPlay = () => {
    if (suppressed("play") || !joined) return;
    // line everyone up on our position before they start
    emit("CMD:seek", video.currentTime);
    emit("CMD:play");
  };
  const onPause = () => {
    if (suppressed("pause") || !joined) return;
    emit("CMD:pause");
  };
  const onSeeked = () => {
    if (suppressed("seeked") || !joined) return;
    if (
      remoteSeek &&
      Date.now() - remoteSeek.at < SEEK_TARGET_MS &&
      Math.abs(video.currentTime - remoteSeek.t) < 1
    ) {
      return;
    }
    emit("CMD:seek", video.currentTime);
  };
  const onRateChange = () => {
    updateRates();
    if (suppressed("ratechange") || !joined) return;
    const r = video.playbackRate;
    if (Math.abs(r - roomRate) < 1e-6) return;
    // Right after a (re)load the site may put its own default rate back. That is not
    // somebody choosing a speed: restore the room rate once instead of broadcasting it.
    if (Date.now() < siteResetUntil && !resetReapplied) {
      resetReapplied = true;
      applyRate(roomRate);
      return;
    }
    roomRate = r;
    emit("CMD:playbackRate", r);
  };
  const markSiteReset = () => {
    siteResetUntil = Date.now() + SITE_RESET_MS;
    resetReapplied = false;
  };

  // Buffering wait: a stall while the room plays asks the server to pause everyone
  // (setBuffering takes a plain boolean; its armBufferPause adds a ~2.5 s grace before
  // REC:pause, so short blips never pause the room). Only on change; a remote REC:pause
  // cannot loop back into a CMD:pause because applyPause masks the local 'pause' event,
  // and a 'waiting' while paused is ignored, so the resume cannot ping-pong either.
  const reportBuffering = (on) => {
    if (on === buffering) return;
    buffering = on;
    emit("CMD:buffering", on);
  };
  const onWaiting = () => {
    if (!joined || roomMedia || !video || video.paused) return;
    reportBuffering(true);
  };
  const onBufferRecover = () => {
    if (roomMedia) return;
    reportBuffering(false);
  };

  const VIDEO_EVENTS = {
    play: onPlay,
    pause: onPause,
    seeked: onSeeked,
    ratechange: onRateChange,
    waiting: onWaiting,
    playing: onBufferRecover,
    canplay: onBufferRecover,
    loadstart: markSiteReset,
    loadedmetadata: markSiteReset,
    emptied: markSiteReset,
  };

  function bindVideo(v) {
    if (video) {
      for (const [type, fn] of Object.entries(VIDEO_EVENTS)) video.removeEventListener(type, fn);
    }
    video = v;
    if (!video) return;
    for (const [type, fn] of Object.entries(VIDEO_EVENTS)) video.addEventListener(type, fn);
    markSiteReset();
    if (sync && sync.done) applyRate(roomRate); // a swapped element starts at the site's default
    if (pendingHost) {
      const h = pendingHost;
      pendingHost = null;
      applyHostState(h);
    }
    updateRates();
  }

  function findVideo() {
    let best = null;
    let bestArea = -1;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function refreshVideo() {
    const best = findVideo();
    if (best !== video || (video && !video.isConnected)) bindVideo(best);
  }

  // ---- joining a room ----
  function parseRoom(input) {
    const s = String(input || "").trim();
    if (!s) return "";
    let name;
    const m = s.match(/\/watch\/([^/?#\s]+)/i);
    if (m) name = m[1];
    else if (/^https?:\/\//i.test(s)) {
      try {
        name = new URL(s).pathname.split("/").filter(Boolean)[0] || "";
      } catch {
        return "";
      }
    } else name = s.replace(/^\/+/, "").split(/[/?#\s]/)[0];
    try {
      name = decodeURIComponent(name);
    } catch {
      return "";
    }
    return /^[\w.~-]+$/.test(name) ? name : "";
  }

  function applyHostState(h) {
    if (!video) {
      pendingHost = h;
      return;
    }
    roomRate = Number(h.playbackRate) || 1;
    applyRate(roomRate);
    applySeek(Number(h.videoTS));
    if (h.paused) applyPause();
    else applyPlay();
  }

  function maybeSync() {
    if (!sync || sync.done || !sync.host || !sync.tsMap) return;
    sync.done = true;
    const others = Object.keys(sync.tsMap).filter((id) => id !== clientId);
    if (others.length) {
      applyHostState(sync.host);
    } else if (video) {
      // Nobody else is watching, so the room's stored state (a new room starts "playing"
      // at 0:00) is stale: keep ours and push it, so the next joiner lands where we are
      // instead of being told to play.
      const h = sync.host;
      roomRate = video.playbackRate;
      if (Math.abs(roomRate - (Number(h.playbackRate) || 1)) > 1e-6) emit("CMD:playbackRate", roomRate);
      if (Math.abs(video.currentTime - Number(h.videoTS)) > 1) emit("CMD:seek", video.currentTime);
      if (video.paused !== Boolean(h.paused)) emit(video.paused ? "CMD:pause" : "CMD:play");
    }
    host.dataset.synced = others.length ? "joiner" : "alone";
    // make the next joiner see us right away instead of after the first 1 s tick
    if (video && Number.isFinite(video.currentTime)) emit("CMD:ts", video.currentTime);
    updateRates();
  }

  function leave(silent) {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    socket = null;
    joined = false;
    sync = null;
    pendingHost = null;
    names = {};
    buffering = false;
    members = null;
    renderMembers();
    delete host.dataset.synced;
    delete host.dataset.room;
    updateJoinButton();
    if (!silent) setStatus("Not connected");
  }

  function join() {
    const room = parseRoom(el.room.value);
    if (!room) {
      setStatus("Enter a room URL or name", "err");
      return;
    }
    const name = el.name.value.trim().slice(0, 50) || "Viewer";
    store.set({ room: el.room.value.trim(), name });
    leave(true);
    chat = [];
    renderChat();
    setStatus("Connecting...");
    host.dataset.room = room;
    const s = io(SERVER + "/" + room, {
      transports: ["websocket"],
      query: { clientId, pageId, password: "", shard: "", roomId: room },
      auth: { sessionId },
    });
    socket = s;
    updateJoinButton();

    s.on("connect", () => {
      joined = true;
      sync = { host: null, tsMap: null, done: false };
      delete host.dataset.synced;
      setStatus("Connected to " + room, "on");
      emit("CMD:name", name);
    });
    s.on("connect_error", (err) => {
      joined = false;
      setStatus("Cannot connect: " + (err && err.message ? err.message : err), "err");
    });
    s.on("disconnect", (reason) => {
      joined = false;
      setStatus("Disconnected (" + reason + ")", "err");
    });
    s.on("kicked", () => {
      leave(true);
      setStatus("Disconnected: this identity joined from somewhere else", "err");
    });
    s.on("REC:host", (h) => {
      roomMedia = (h && h.video) || "";
      if (roomMedia) {
        setStatus("This room is playing something else - use an empty room", "err");
        return;
      }
      setStatus("Connected to " + room, "on");
      if (!sync) return;
      sync.host = h;
      maybeSync();
    });
    s.on("REC:tsMap", (m) => {
      if (!sync) return;
      sync.tsMap = m || {};
      maybeSync();
    });
    s.on("REC:nameMap", (m) => {
      names = m || {};
      renderChat();
      renderMembers();
    });
    s.on("roster", (list) => {
      const ids = (Array.isArray(list) ? list : [])
        .map((u) => u && u.id)
        .filter((id) => typeof id === "string" && id);
      if (members) {
        // Notices only for changes after our own initial roster (local only, never emitted)
        for (const id of ids) if (!members.includes(id)) pushSys(id, false);
        for (const id of members) if (!ids.includes(id)) pushSys(id, true);
      }
      members = ids;
      renderMembers();
    });
    s.on("REC:floatReaction", (d) => {
      if (!d || typeof d.value !== "string" || !d.value) return;
      const f = document.createElement("div");
      f.className = "float";
      f.textContent = d.value + " " + nameOf(d.user);
      el.floats.appendChild(f);
      setTimeout(() => f.remove(), 2500);
    });
    s.on("chatinit", (arr) => {
      chat = Array.isArray(arr) ? arr.slice(-MAX_CHAT) : [];
      renderChat();
    });
    s.on("REC:chat", (m) => m && pushChat(m));
    s.on("REC:play", () => roomMedia || applyPlay());
    s.on("REC:pause", () => roomMedia || applyPause());
    s.on("REC:seek", (t) => roomMedia || applySeek(Number(t)));
    s.on("REC:playbackRate", (r) => {
      if (roomMedia) return;
      r = Number(r);
      if (!Number.isFinite(r)) return;
      roomRate = r;
      applyRate(r);
      updateRates();
    });
  }

  function setRate(r) {
    roomRate = r;
    applyRate(r);
    emit("CMD:playbackRate", r);
    updateRates();
  }

  // ---- panel wiring ----
  el.join.addEventListener("click", () => (socket ? leave(false) : join()));
  el.room.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !socket) join();
  });
  el.name.addEventListener("change", () => {
    const name = el.name.value.trim().slice(0, 50);
    if (!name) return;
    store.set({ name });
    emit("CMD:name", name);
  });
  el.chatinput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const text = el.chatinput.value.trim();
    if (!text) return;
    emit("CMD:chat", text);
    el.chatinput.value = "";
  });
  el.toggle.addEventListener("click", () => setCollapsed(!collapsed));
  function setCollapsed(c) {
    collapsed = c;
    el.panel.classList.toggle("collapsed", c);
    el.toggle.innerHTML = c ? "+" : "&ndash;";
    store.set({ collapsed: c });
  }

  // bookmarklet: the link names the room it was made in, which beats an older saved room;
  // fill it in, never auto-join
  function prefillRoom() {
    if (window.__wpRoom) el.room.value = String(window.__wpRoom);
  }
  // clicking the bookmarklet again lands here instead of building a second panel
  window.__wpExtShow = () => {
    placeHost();
    setCollapsed(false);
    prefillRoom();
  };

  // ---- start ----
  placeHost();
  store.get(["room", "name", "collapsed"]).then((saved) => {
    if (saved.room) el.room.value = saved.room;
    prefillRoom();
    el.name.value = saved.name || "Viewer-" + Math.floor(1000 + Math.random() * 9000);
    if (saved.collapsed) setCollapsed(true);
  });
  refreshVideo();
  updateRates();

  setInterval(() => {
    // a site re-render can drop our node; put it back
    if (!host.isConnected) placeHost();
    refreshVideo();
    updateRates();
    if (joined && video && Number.isFinite(video.currentTime)) {
      emit("CMD:ts", video.currentTime);
    }
  }, 1000);
})();
