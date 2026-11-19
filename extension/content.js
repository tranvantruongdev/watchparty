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
  // youtube marks its ad player this way; while it shows, the ad owns the video
  // and sync stays out of the way (no local emits, no remote applies)
  const AD_SEL = "#movie_player.ad-showing, .html5-video-player.ad-showing";

  // One identity per page load. A second socket with the same clientId kicks the first,
  // so it is never shared between tabs and never stored.
  const clientId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const sessionId = crypto.randomUUID().replace(/-/g, "");

  // ---- state ----
  let socket = null;
  let joined = false; // socket connected
  let everConnected = false; // this socket connected at least once (auto-reconnect, not a first attempt)
  let video = null;
  let roomRate = 1;
  let names = {};
  let chat = [];
  let buffering = false; // last CMD:buffering state we reported (true = asked the room to pause)
  let members = null; // roster ids from the last 'roster' event; null = nothing received yet
  let collapsed = false;
  let unread = 0; // chat lines from others that arrived while the panel was collapsed
  let sync = null; // { host, tsMap, done } for the current connection
  let pendingHost = null; // joiner state waiting for a <video> to appear
  let remoteSeek = null; // { t, at }
  let siteResetUntil = 0;
  let resetReapplied = false;
  let typingPeers = {}; // id -> expiry (REC:typing true; 6 s safety timeout)
  let typingActive = false; // we sent CMD:typing true and no false yet
  let typingLastTrue = 0;
  let typingOffTimer = null;
  let myUrl = null; // the title url page.js last posted (null = not on a title)
  let announcedUrl = null; // last url we announced to the room
  let roomSiteUrl = null; // latest title url another member announced (what we would follow)
  let titleResetUntil = 0; // after an in-page title change the site's own play/pause/seek resets stay local
  let titleSyncAt = 0; // last CMD:askHost sent for a title change (2 s rate limit)
  let titleSyncUntil = 0; // poll deadline for the new episode's video to become ready
  let followUrl = null; // url the follow bar points at while shown
  let adMode = false; // an ad was showing at the last 1 s check (drives status + re-sync)
  let askedHost = false; // waiting for the REC:host reply to re-sync after an ad
  let extController = null; // member currently holding playback control (null = free)
  let lastCtlAsk = 0; // last CMD:askHost sent because someone else controls (1 s rate limit)
  const until = { play: 0, pause: 0, seeked: 0, ratechange: 0 };
  const emitCounts = {};

  // #wpx=<room> deep link: read once at script start, before the site's router can strip the hash
  const hashRoom = (() => {
    const m = /[#&]wpx=([^&]+)/.exec(location.hash || "");
    return m ? parseRoom(m[1]) : "";
  })();

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
      .ctl { font-size: 11px; color: #ffd88a; min-height: 14px; }
      .status { font-size: 12px; color: #aab; min-height: 16px; }
      .log { flex: 1; min-height: 110px; max-height: 260px; overflow-y: auto; background: #1b1b21;
        border: 1px solid #33333c; border-radius: 6px; padding: 6px; font-size: 12px; line-height: 1.4; }
      .log .sys { color: #98a; font-style: italic; }
      .log .who { color: #9db0ff; font-weight: 600; }
      .log .ts { color: #66728a; font-size: 10px; font-style: normal; }
      .log div { margin-bottom: 3px; word-wrap: anywhere; }
      .members { font-size: 11px; color: #8892a8; min-height: 14px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .follow { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #ffd88a;
        background: #3a3226; border: 1px solid #665533; border-radius: 6px; padding: 4px 6px; }
      .follow[hidden] { display: none; }
      .follow span { flex: 1; word-wrap: anywhere; }
      .typing { font-size: 11px; color: #98a; min-height: 14px; font-style: italic; }
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
        <span><span class="dot" id="dot"></span>WatchParty<span id="unread"></span></span>
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
        <div class="follow" id="follow" hidden>
          <span id="followtext"></span>
          <button id="followgo">Follow</button>
          <button id="followx" title="Dismiss">&times;</button>
        </div>
        <div class="rates" id="rates"></div>
        <button id="ctl" title="Only the controller can play, pause, seek and change speed">Take control</button>
        <div class="ctl" id="ctltext"></div>
        <div class="row">
          <button id="synctome" title="Move everyone to your position, speed and play state">Sync everyone to me</button>
          <button id="copyinvite" hidden title="Copy a link that opens this page with the room prefilled">Copy invite</button>
        </div>
        <div class="rx" id="rx"></div>
        <div class="log" id="log"></div>
        <div class="typing" id="typing"></div>
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
    follow: $("follow"),
    followtext: $("followtext"),
    followgo: $("followgo"),
    followx: $("followx"),
    typing: $("typing"),
    rates: $("rates"),
    ctl: $("ctl"),
    ctltext: $("ctltext"),
    unread: $("unread"),
    synctome: $("synctome"),
    copyinvite: $("copyinvite"),
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
    el.copyinvite.hidden = !socket;
  }

  function renderUnread() {
    host.dataset.unread = String(unread);
    el.unread.textContent = unread ? " • " + unread : "";
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

  // viewer-local "HH:MM" for a chat line's timestamp (server ISO string, or our own)
  const hhmm = (ts) => {
    const d = ts ? new Date(ts) : null;
    return d && !isNaN(d) ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  };

  const nameOf = (id) => names[id] || (id ? String(id).slice(0, 6) : "?");

  // stable per-member colour from the clientId (readable shades on the dark panel;
  // the .who CSS default is deliberately not in the list so an applied colour always
  // differs from it)
  const COLORS = ["#7fd4a8", "#ffd88a", "#ff9db0", "#c9a7ff", "#8ad8f0", "#f0b98a", "#a8e07f", "#ff8ad8", "#d4d47f", "#f0a0f0"];
  const colorOf = (id) => {
    const s = String(id || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  };

  function renderMembers() {
    el.members.textContent = members ? members.length + " watching: " : "";
    if (members)
      members.forEach((id, i) => {
        if (i) el.members.appendChild(document.createTextNode(", "));
        const s = document.createElement("span");
        s.style.color = colorOf(id);
        s.textContent = nameOf(id) + (id === clientId ? " (you)" : "");
        el.members.appendChild(s);
      });
  }

  // ---- one person drives (CMD:extControl / REC:extControl) ----
  // Status line that knows the control mode: while another member drives, the
  // playback state is theirs, so the panel says so instead of "Connected to ..."
  function statusConnected() {
    if (joined && extController && extController !== clientId) {
      setStatus("Only " + nameOf(extController) + " controls playback", "on");
    } else {
      setStatus("Connected to " + (host.dataset.room || ""), "on");
    }
  }

  function renderControl() {
    const other = Boolean(joined && extController && extController !== clientId);
    el.ctl.disabled = other;
    el.ctl.textContent = extController === clientId ? "Release control" : "Take control";
    el.ctl.classList.toggle("active", extController === clientId);
    el.ctltext.textContent = other ? nameOf(extController) + " controls playback" : "";
    host.dataset.controller = extController || "";
    if (other || el.status.textContent.startsWith("Only ")) statusConnected();
  }

  // A local playback change while someone else drives would be dropped by the server
  // anyway: undo it by re-applying the room state (same flow as the post-ad re-sync),
  // rate-limited to one CMD:askHost per second. While an ad owns the video nothing
  // is undone either — the ad-end re-sync pulls the room state again
  const ctlBlocked = () => {
    if (!joined || adPlaying() || !extController || extController === clientId) return false;
    if (Date.now() - lastCtlAsk > 1000) {
      lastCtlAsk = Date.now();
      askedHost = true;
      emit("CMD:askHost");
    }
    return true;
  };

  // ---- typing indicator ----
  function renderTyping() {
    const now = Date.now();
    for (const id of Object.keys(typingPeers)) if (typingPeers[id] <= now) delete typingPeers[id];
    const live = Object.keys(typingPeers);
    host.dataset.typing = live.join(",");
    el.typing.textContent =
      live.length === 1
        ? nameOf(live[0]) + " is typing…"
        : live.length === 2
          ? live.map(nameOf).join(" and ") + " are typing…"
          : live.length > 2
            ? live.length + " people are typing…"
            : "";
  }

  const typingStop = () => {
    clearTimeout(typingOffTimer);
    typingOffTimer = null;
    if (!typingActive) return;
    typingActive = false;
    emit("CMD:typing", false);
  };
  const onTypeInput = () => {
    if (!joined) return;
    const now = Date.now();
    if (!typingActive || now - typingLastTrue >= 2000) {
      typingActive = true;
      typingLastTrue = now;
      emit("CMD:typing", true);
    }
    clearTimeout(typingOffTimer);
    typingOffTimer = setTimeout(typingStop, 3000); // false 3 s after the last keystroke
  };

  // ---- follow the episode (page.js announces the title via wp-ext-page messages) ----
  function hideFollow() {
    followUrl = null;
    el.follow.hidden = true;
    delete host.dataset.follow;
  }
  function showFollow(id, url) {
    followUrl = url;
    el.followtext.textContent = nameOf(id) + " is watching another title";
    el.follow.hidden = false;
    host.dataset.follow = url;
  }
  function announceUrl() {
    if (!joined || roomMedia || !myUrl || myUrl === announcedUrl) return;
    announcedUrl = myUrl;
    emit("CMD:siteUrl", myUrl);
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "wp-ext-page" || d.type !== "siteUrl") return;
    const prev = myUrl;
    myUrl = typeof d.url === "string" && d.url ? d.url : null;
    announceUrl();
    if (myUrl && myUrl === roomSiteUrl) hideFollow(); // we caught up with the room
    // an in-page title change (next episode): the new video starts at the site's own
    // defaults and the element may swap without loadstart, so arm the site-reset
    // window here too; when the room is on this title, pull the room state like a joiner
    if (myUrl && myUrl !== prev && joined && !roomMedia && !adPlaying()) onTitleChange(prev);
  });
  el.followgo.addEventListener("click", () => {
    if (!followUrl) return;
    let u = null;
    try {
      u = new URL(followUrl);
    } catch {
      // not a parseable url: never navigate on one
    }
    if (u && u.hostname === location.hostname) location.href = followUrl;
    else el.followtext.textContent = "Open it on that site: " + followUrl;
  });
  el.followx.addEventListener("click", hideFollow);

  function renderChat() {
    el.log.textContent = "";
    for (const m of chat) {
      const who = nameOf(m.id);
      const line = document.createElement("div");
      const ts = hhmm(m.timestamp);
      if (ts) {
        const t = document.createElement("span");
        t.className = "ts";
        t.textContent = ts;
        line.appendChild(t);
        line.appendChild(document.createTextNode(" "));
      }
      if (m.sysJoin || m.sysLeave) {
        // Resolved at render time: the name may arrive (REC:nameMap) after the notice
        line.className = "sys";
        line.appendChild(
          document.createTextNode(m.sysJoin ? nameOf(m.sysJoin) + " joined" : nameOf(m.sysLeave) + " left"),
        );
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
        line.appendChild(document.createTextNode(who + " " + text));
      } else {
        const w = document.createElement("span");
        w.className = "who";
        w.style.color = colorOf(m.id);
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

  // local-only notices: stamped with the local clock when created (rendering can
  // happen later, when the name arrives via REC:nameMap)
  const pushSys = (id, left) =>
    pushChat(
      left
        ? { sysLeave: id, timestamp: new Date().toISOString() }
        : { sysJoin: id, timestamp: new Date().toISOString() },
    );

  // ---- socket helpers ----
  // The web app applies REC:play/pause/seek/playbackRate to whatever the room is playing
  // (a YouTube video, a screen share...), so only sync while the room has no media of its own.
  // While a youtube ad shows, the ad owns the video: playback sync (incl. ts and buffering)
  // stays silent in both directions; chat, names, reactions and typing keep flowing.
  let roomMedia = "";
  const PLAYBACK = ["CMD:play", "CMD:pause", "CMD:seek", "CMD:playbackRate", "CMD:ts"];
  const adPlaying = () => !!document.querySelector(AD_SEL);
  function emit(ev, arg) {
    if (!socket || !socket.connected) return;
    if ((roomMedia || adPlaying()) && (PLAYBACK.includes(ev) || ev === "CMD:buffering")) return;
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
  // A title-change window (titleResetUntil, armed by onTitleChange) keeps the site's
  // own play/pause/seek noise after an in-page episode change from broadcasting:
  // a follower's autoplay must not drag the room to 0 — the room state comes via
  // CMD:askHost instead (or stays put when we moved ahead on our own).
  const onPlay = () => {
    if (suppressed("play") || !joined) return;
    if (Date.now() < titleResetUntil) return;
    if (ctlBlocked()) return;
    // line everyone up on our position before they start
    emit("CMD:seek", video.currentTime);
    emit("CMD:play");
  };
  const onPause = () => {
    if (suppressed("pause") || !joined) return;
    if (Date.now() < titleResetUntil) return;
    if (ctlBlocked()) return;
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
    if (Date.now() < titleResetUntil) return;
    if (ctlBlocked()) return;
    emit("CMD:seek", video.currentTime);
  };
  const onRateChange = () => {
    updateRates();
    if (adPlaying()) return;
    const r = video.playbackRate;
    if (Math.abs(r - roomRate) < 1e-6) return;
    // Right after a (re)load the site may put its own default rate back. That is not
    // somebody choosing a speed: restore the room rate once instead of broadcasting it.
    // (Checked before the suppress mask: a rate that disagrees with the room is never
    // one of our own applies — those always set the room rate first — so a site reset
    // landing inside the suppress window must still be undone.)
    if (Date.now() < siteResetUntil && !resetReapplied) {
      resetReapplied = true;
      applyRate(roomRate);
      return;
    }
    if (suppressed("ratechange") || !joined) return;
    if (ctlBlocked()) return;
    roomRate = r;
    emit("CMD:playbackRate", r);
  };
  const markSiteReset = () => {
    siteResetUntil = Date.now() + SITE_RESET_MS;
    resetReapplied = false;
  };

  // In-page title change (myUrl moved to a new non-null title while joined): the site
  // starts the next episode at its own defaults (rate 1, position 0) and may swap the
  // video element without firing loadstart/emptied, so the site-reset window is armed
  // here too — but only for title->title hops (a null->title move is the connect-time
  // re-post or a browse->watch nav, where a fresh element fires loadstart anyway).
  // When the room is already on this title (I followed it), pull the room state like a
  // joiner once the new video is ready; when I moved ahead on my own, nothing beyond
  // the announce (already sent) and the kept rate.
  function onTitleChange(prev) {
    if (prev) {
      markSiteReset();
      titleResetUntil = Date.now() + SITE_RESET_MS;
    }
    if (myUrl !== roomSiteUrl) return; // not the room's title: nothing to pull
    if (Date.now() - titleSyncAt < 2000) return; // one room pull per title hop
    titleSyncUntil = Date.now() + 5000;
    pollTitleReady();
  }
  function pollTitleReady() {
    if (!joined || roomMedia || adPlaying()) return;
    if (myUrl !== roomSiteUrl || Date.now() > titleSyncUntil) return;
    if (!video || video.readyState < 1) {
      setTimeout(pollTitleReady, 300);
      return;
    }
    titleSyncAt = Date.now();
    askedHost = true;
    emit("CMD:askHost"); // the REC:host reply applies via applyHostState (post-ad path)
  }

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
    if (!joined || roomMedia || adPlaying() || !video || video.paused) return;
    reportBuffering(true);
  };
  const onBufferRecover = () => {
    if (roomMedia || adPlaying()) return;
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
      // tiny hover previews / hidden nodes must never win: skip zero-size and
      // invisible videos (a fixed-position video has no offsetParent); among the
      // rest the largest wins, so a 160x90 preview loses to the real player
      if (area <= 0) continue;
      if (v.offsetParent === null && getComputedStyle(v).position !== "fixed") continue;
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function refreshVideo() {
    const best = findVideo();
    if (best === video) return;
    // no visible candidate at all (a site briefly hiding the player): keep ours
    // instead of unbinding and dropping events for a poll cycle
    if (!best && video && video.isConnected) return;
    bindVideo(best);
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
    everConnected = false;
    host.dataset.conn = "off";
    sync = null;
    pendingHost = null;
    names = {};
    buffering = false;
    members = null;
    typingPeers = {};
    typingActive = false;
    clearTimeout(typingOffTimer);
    typingOffTimer = null;
    roomSiteUrl = null;
    adMode = false;
    askedHost = false;
    extController = null;
    hideFollow();
    renderTyping();
    renderMembers();
    renderControl();
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
    unread = 0;
    renderUnread();
    renderChat();
    setStatus("Connecting...");
    host.dataset.conn = "off";
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
      everConnected = true;
      sync = { host: null, tsMap: null, done: false };
      delete host.dataset.synced;
      host.dataset.conn = "on";
      setStatus("Connected to " + room, "on");
      emit("CMD:name", name);
      // announce the title we are on (fresh room session), and ask page.js to
      // re-post in case its earlier siteUrl message came before we listened
      announcedUrl = null;
      announceUrl();
      window.postMessage({ source: "wp-ext", type: "getSiteUrl" }, "*");
    });
    s.on("connect_error", (err) => {
      joined = false;
      if (everConnected) {
        // a working connection dropped and the retry failed: socket.io keeps trying,
        // so show progress instead of an error dead end
        host.dataset.conn = "reconnecting";
        setStatus("Reconnecting…");
        return;
      }
      host.dataset.conn = "off";
      setStatus("Cannot connect: " + (err && err.message ? err.message : err), "err");
    });
    s.on("disconnect", (reason) => {
      joined = false;
      // the only reason socket.io does not retry on its own ("kicked" above tears the
      // panel down first): every other drop auto-reconnects
      if (reason === "io server disconnect") {
        host.dataset.conn = "off";
        setStatus("Disconnected (" + reason + ")", "err");
        return;
      }
      host.dataset.conn = "reconnecting";
      setStatus("Reconnecting…");
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
      if (!adPlaying()) statusConnected();
      if (!sync) return;
      sync.host = h;
      if (askedHost) {
        // the reply to our post-ad CMD:askHost: apply the room state like a joiner
        askedHost = false;
        applyHostState(h);
      }
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
      renderControl(); // the controller's name may have arrived with it
    });
    s.on("REC:extControl", (d) => {
      extController = d && typeof d.id === "string" && d.id ? d.id : null;
      renderControl();
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
    s.on("REC:typing", (d) => {
      if (!d || typeof d.id !== "string" || !d.id) return;
      if (d.typing) typingPeers[d.id] = Date.now() + 6000; // safety timeout
      else delete typingPeers[d.id];
      renderTyping();
    });
    s.on("REC:siteUrl", (d) => {
      if (!d || typeof d.id !== "string" || typeof d.url !== "string") return;
      if (d.id === clientId) {
        // our own announcement echoed back: nothing to follow, and the room's "latest
        // url" stays whatever another member announced last (it decides whether a
        // title change of ours counts as following the room)
        if (myUrl === d.url) hideFollow();
        return;
      }
      roomSiteUrl = d.url;
      if (d.url === myUrl) hideFollow(); // they caught up with us
      else showFollow(d.id, d.url);
    });
    s.on("chatinit", (arr) => {
      chat = Array.isArray(arr) ? arr.slice(-MAX_CHAT) : [];
      renderChat();
    });
    s.on("REC:chat", (m) => {
      if (!m) return;
      pushChat(m);
      // unread badge: real chat from someone else while the panel is closed
      // (cmd and system lines are activity notes, reactions never come through chat)
      if (collapsed && !m.cmd && !m.sysJoin && !m.sysLeave && m.id && m.id !== clientId) {
        unread++;
        renderUnread();
      }
    });
    s.on("REC:play", () => roomMedia || adPlaying() || applyPlay());
    s.on("REC:pause", () => roomMedia || adPlaying() || applyPause());
    s.on("REC:seek", (t) => roomMedia || adPlaying() || applySeek(Number(t)));
    s.on("REC:playbackRate", (r) => {
      if (roomMedia || adPlaying()) return;
      r = Number(r);
      if (!Number.isFinite(r)) return;
      roomRate = r;
      applyRate(r);
      updateRates();
    });
  }

  function setRate(r) {
    if (ctlBlocked()) return;
    roomRate = r;
    applyRate(r);
    emit("CMD:playbackRate", r);
    updateRates();
  }

  // ---- panel wiring ----
  el.ctl.addEventListener("click", () => {
    if (!joined) return;
    emit("CMD:extControl", extController === clientId ? false : true);
  });
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
  el.chatinput.addEventListener("input", onTypeInput);
  el.chatinput.addEventListener("blur", typingStop);
  el.chatinput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const text = el.chatinput.value.trim();
    if (!text) return;
    typingStop(); // sending is not typing
    emit("CMD:chat", text);
    el.chatinput.value = "";
  });
  el.synctome.addEventListener("click", () => {
    if (!joined || roomMedia || adPlaying() || !video) return;
    if (ctlBlocked()) return;
    if (!confirm("Move everyone to your position?")) return;
    emit("CMD:seek", video.currentTime);
    if (Math.abs(video.playbackRate - roomRate) > 1e-6) emit("CMD:playbackRate", video.playbackRate);
    emit(video.paused ? "CMD:pause" : "CMD:play");
  });
  el.copyinvite.addEventListener("click", () => {
    const link = location.origin + location.pathname + "#wpx=" + (host.dataset.room || parseRoom(el.room.value));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(
        () => setStatus("Invite link copied", "on"),
        () => setStatus("Copy failed — link: " + link, "err"),
      );
    } else {
      setStatus("Copy failed — link: " + link, "err");
    }
  });
  el.toggle.addEventListener("click", () => setCollapsed(!collapsed));
  function setCollapsed(c) {
    collapsed = c;
    el.panel.classList.toggle("collapsed", c);
    el.toggle.innerHTML = c ? "+" : "&ndash;";
    store.set({ collapsed: c });
    if (!c && unread) {
      unread = 0;
      renderUnread();
    }
  }

  // bookmarklet: the link names the room it was made in, which beats an older saved room;
  // fill it in, never auto-join. The #wpx= hash beats both and may auto-join below.
  function prefillRoom() {
    if (hashRoom) el.room.value = hashRoom;
    else if (window.__wpRoom) el.room.value = String(window.__wpRoom);
  }
  // clicking the bookmarklet again lands here instead of building a second panel
  window.__wpExtShow = () => {
    placeHost();
    setCollapsed(false);
    prefillRoom();
  };

  // ---- start ----
  placeHost();
  renderUnread();
  renderControl();
  store.get(["room", "name", "collapsed"]).then((saved) => {
    if (saved.room) el.room.value = saved.room;
    prefillRoom();
    el.name.value = saved.name || "Viewer-" + Math.floor(1000 + Math.random() * 9000);
    if (saved.collapsed) setCollapsed(true);
    // deep link: join right away when we know who we are, otherwise ask for the name
    if (hashRoom && saved.name) join();
    else if (hashRoom) el.name.focus();
  });
  refreshVideo();
  updateRates();

  setInterval(() => {
    // a site re-render can drop our node; put it back
    if (!host.isConnected) placeHost();
    refreshVideo();
    updateRates();
    renderTyping(); // prune typing entries whose 6 s safety timeout ran out
    const inAd = joined && adPlaying();
    if (inAd !== adMode) {
      adMode = inAd;
      if (inAd) {
        setStatus("Ad playing — sync paused", "err");
      } else {
        // the ad ended: pull the room state and apply it like a joiner would
        askedHost = true;
        emit("CMD:askHost");
      }
    }
    if (joined && video && Number.isFinite(video.currentTime)) {
      emit("CMD:ts", video.currentTime);
    }
  }, 1000);
})();
