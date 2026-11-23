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
  const SEEK_FLUSH_MS = 80; // seeked-triggered flush delay (a drag keeps re-arming it)
  const SITE_RESET_MS = 3000; // after a (re)load the site may reset playbackRate itself
  const DRIFT_TICK_S = 2; // slow-drift check cadence during playback
  const DRIFT_NUDGE_S = 0.75; // drifts smaller than this are left alone
  const DRIFT_SEEK_S = 5; // beyond this one silent seek beats a long nudge
  const DRIFT_OK_S = 0.3; // close enough: restore the room rate
  const MAX_CHAT = 200;
  const MAX_MEMBERS_SHOWN = 50; // roster names rendered; the rest collapse into "+N more"
  const MAX_TYPING = 20; // typing-peers entries kept; the oldest drops out
  // stickers (round 10A): a chat message whose whole text is [sticker:<id>] renders as
  // the emoji alone, large — the same list/ids the web app renders
  const STICKERS = { laugh: "😂", cry: "😭", wow: "😮", love: "😍", fire: "🔥", clap: "👏", scared: "😱", sleep: "😴", facepalm: "🤦", party: "🥳" };
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
  let waitingSince = 0; // when the current 'waiting' stall started (0 = none): the claim waits 1.5 s
  let gestureAt = 0; // last trusted pointerdown / held-button pointermove / keydown
  let members = null; // roster ids from the last 'roster' event; null = nothing received yet
  let collapsed = false;
  let unread = 0; // chat lines from others that arrived while the panel was collapsed
  let sync = null; // { host, tsMap, done } for the current connection
  let pendingHost = null; // joiner state waiting for a <video> to appear
  let remoteSeek = null; // { t, at }
  let seekEventCount = 0; // seeking/seeked events on the bound video (tick poll baseline)
  let seekTimer = null; // pending CMD:seek coalesce timer (a scrubber drag: send once it settles)
  let seenT = null; // video.currentTime at the last 1 s tick (eventless-jump detection)
  let seenAt = 0; // Date.now() of that tick
  let seenSeekEvt = 0;
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
  let adFreeAt = 0; // when adMode last flipped to no-ad (the ad tail gap window, D1)
  let adPullTimer = null; // the post-ad pull, sent once the ad tail gap has passed (R16C)
  let adStartUrl = null; // our title when the current ad started (a mid-ad hop, D2)
  let askedHost = false; // waiting for the REC:host reply to re-sync after an ad
  let extController = null; // member currently holding playback control (null = free)
  let lastCtlAsk = 0; // last CMD:askHost sent because someone else controls (1 s rate limit)
  let roomPos = null; // { t, at } — the room's expected position at wall-clock `at`
  let nudging = false; // our rate is a temporary drift-correction nudge over roomRate
  let nudgeBase = 0; // the roomRate the current nudge was computed from
  let nudgeRate = 0; // the nudged rate itself
  let driftCount = 0;
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
      .stickers { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
      .stickers[hidden] { display: none; }
      .stickers button { font-size: 16px; padding: 3px 0; }
      .log .sticker { font-size: 2.2em; }
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
        <div class="row">
          <input id="chatinput" placeholder="Message (Enter to send)" maxlength="500" autocomplete="off" />
          <button id="stickersBtn" title="Stickers" style="flex:0 0 36px">🙂</button>
        </div>
        <div class="stickers" id="stickers" hidden></div>
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
    stickersBtn: $("stickersBtn"),
    stickers: $("stickers"),
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

  // ---- sticker picker (round 10A) ----
  // Each button sends the same CMD:chat path as typed text; the room renders the tag.
  const closeStickers = () => {
    el.stickers.hidden = true;
  };
  for (const [id, emoji] of Object.entries(STICKERS)) {
    const b = document.createElement("button");
    b.textContent = emoji;
    b.dataset.sticker = id;
    b.title = "sticker:" + id;
    b.addEventListener("click", () => {
      typingStop(); // sending is not typing
      emit("CMD:chat", "[sticker:" + id + "]");
      closeStickers();
    });
    el.stickers.appendChild(b);
  }
  el.stickersBtn.addEventListener("click", () => {
    el.stickers.hidden = !el.stickers.hidden;
  });
  // Esc / click elsewhere closes the picker. keydown and clicks inside the panel are
  // stopped at the host (the Netflix shortcut guard), so the root listeners cover the
  // panel and the document listeners cover the page around it.
  const onStickerEsc = (e) => {
    if (e.key === "Escape") closeStickers();
  };
  root.addEventListener("keydown", onStickerEsc);
  document.addEventListener("keydown", onStickerEsc);
  const stickerClickAway = (e) => {
    if (el.stickers.hidden) return;
    const path = e.composedPath();
    if (path.includes(el.stickersBtn) || path.includes(el.stickers)) return;
    closeStickers();
  };
  root.addEventListener("click", stickerClickAway);
  document.addEventListener("click", stickerClickAway);

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
      members.slice(0, MAX_MEMBERS_SHOWN).forEach((id, i) => {
        if (i) el.members.appendChild(document.createTextNode(", "));
        const s = document.createElement("span");
        s.style.color = colorOf(id);
        s.textContent = nameOf(id) + (id === clientId ? " (you)" : "");
        el.members.appendChild(s);
      });
    if (members && members.length > MAX_MEMBERS_SHOWN)
      el.members.appendChild(
        document.createTextNode(" +" + (members.length - MAX_MEMBERS_SHOWN) + " more"),
      );
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
  // page.js posts through the page itself, so any page script can forge these: accept
  // only the known shape and a canonical title url that is either a supported streaming
  // title host over https (what page.js posts on the other supported sites — the e2e
  // simulates those posts from the dev page) or this page's own origin over http(s)
  // (what page.js posts here, e.g. the dev test page). Anything else, ≤300 chars, drops.
  const PAGE_URL_HOSTS = [
    "netflix.com",
    "youtube.com",
    "disneyplus.com",
    "primevideo.com",
    "amazon.com",
    "vimeo.com", // not on the server's relay list; kept so myUrl tracks a vimeo title
  ];
  const pageUrlOf = (d) => {
    if (!d || typeof d !== "object" || d.source !== "wp-ext-page" || d.type !== "siteUrl") return undefined;
    if (d.url === null) return null; // page.js's "not on a title" post
    if (typeof d.url !== "string" || d.url.length > 300) return undefined;
    try {
      const u = new URL(d.url);
      if (u.origin === location.origin) return d.url; // our own page, http(s) alike
      if (
        u.protocol === "https:" &&
        PAGE_URL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))
      )
        return d.url;
    } catch {
      // not a url: drop
    }
    return undefined;
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const url = pageUrlOf(e.data);
    if (url === undefined) return; // not our shape, or a url we do not accept: drop silently
    const prev = myUrl;
    myUrl = url;
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
    // same-site Follow means our own origin and http(s) only — a hostname compare
    // would navigate cross-port and a crafted scheme would navigate off the web
    const nav =
      u &&
      u.origin === location.origin &&
      (u.protocol === "https:" || (location.protocol === "http:" && u.protocol === "http:"));
    if (nav) location.href = followUrl;
    else el.followtext.textContent = "Open it on that site: " + followUrl;
  });
  el.followx.addEventListener("click", hideFollow);

  // a sticker is a chat message whose WHOLE text is [sticker:<id>] with a known id;
  // anything else (unknown id, text around the tag) stays plain text
  const stickerOf = (t) => {
    const m = /^\[sticker:([a-z]+)\]$/.exec(String(t || ""));
    return m && Object.hasOwn(STICKERS, m[1]) ? STICKERS[m[1]] : null;
  };

  function buildChatLine(m) {
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
      const st = stickerOf(m.msg);
      if (st) {
        line.appendChild(document.createTextNode(": "));
        const s = document.createElement("span");
        s.className = "sticker";
        s.textContent = st;
        line.appendChild(s);
      } else {
        line.appendChild(document.createTextNode(": " + (m.msg || "")));
      }
    }
    return line;
  }

  // full rebuild for history (re)places: chatinit on join/reconnect and name updates
  function renderChat() {
    el.log.textContent = "";
    for (const m of chat) el.log.appendChild(buildChatLine(m));
    el.log.scrollTop = el.log.scrollHeight;
  }

  function pushChat(m) {
    // append one node: no full rebuild per message; only stick to the bottom when the
    // user was already reading the last line
    const stick = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 1;
    chat.push(m);
    el.log.appendChild(buildChatLine(m));
    if (chat.length > MAX_CHAT) {
      chat = chat.slice(-MAX_CHAT);
      if (el.log.firstChild) el.log.removeChild(el.log.firstChild);
    }
    if (stick) el.log.scrollTop = el.log.scrollHeight;
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
  // A hidden tab's local play/pause/seek/rate changes are the site's or the browser's
  // (Chromium pauses a muted background video on hide and re-pauses every play
  // applied while hidden — broadcasting those re-paused the room on each resume), so
  // they stay local; remote applies are masked and drift correction fixes our
  // position. A Picture-in-Picture window is the user watching and controlling, so
  // it is never treated as hidden. ponytail: media keys used on a hidden tab without
  // PiP stay local too; tell them apart if users ask for it.
  const tabHidden = () =>
    document.visibilityState === "hidden" && !document.pictureInPictureElement;
  // youtube clears .ad-showing ~250 ms before the ad->content media swap (R15W D1):
  // a pause the ad end fires lands in that gap, adPlaying() is already false, and the
  // broadcast would pause the whole room mid-video. Local play/pause/seek broadcasts
  // stay local while the 1 s tick's ad state (adMode) still says ad and for AD_GAP_MS
  // after it flips to no-ad — the media swap itself arms the emptied window on top.
  // A trusted gesture made AFTER the tick's flip passes (R16G A): the user saw the
  // content resume and paused/scrubbed themselves, so their pause/seek is theirs, not
  // the ad's. The "Skip ad" click still stays blocked: its gesture always PREDATES the
  // flip (adFreeAt is set when the tick sees it) while the ad teardown fires the same
  // pause in the gap, so the gestureAt <= adFreeAt side keeps that pause local.
  const AD_GAP_MS = 1500;
  const adGapBlock = () =>
    adMode || (Date.now() - adFreeAt < AD_GAP_MS && gestureAt <= adFreeAt);
  function emit(ev, arg) {
    if (!socket || !socket.connected) return;
    // a buffering claim stays silent too, but rescinding one always goes out: a claim
    // sent just before an ad, rescinded during it, left the server pausing the room on
    // it and waiting for a false that never came (codex R17H)
    if ((roomMedia || adPlaying()) && (PLAYBACK.includes(ev) || (ev === "CMD:buffering" && arg))) return;
    emitCounts[ev] = (emitCounts[ev] || 0) + 1;
    host.dataset.emits = JSON.stringify(emitCounts);
    if (arg === undefined) socket.emit(ev);
    else socket.emit(ev, arg);
  }

  // ---- room position anchor (slow drift correction, round 8A) ----
  // The join handshake is the only consumer of the room's position: nothing compares
  // our currentTime with it during playback, so a decoder stall, a slow machine or a
  // site that swallowed time drifts us away silently and we stay drifted. Anchor the
  // room's expected position wherever the room's state is applied (host state, remote
  // seek, rate changes, play/pause) and extrapolate it with the room rate in between.
  const rebasePos = (t) => {
    roomPos = { t: Number(t), at: Date.now() };
  };
  // advance the anchor to right now (rate change, play/pause transition) in place
  const rebaseElapsed = () => {
    const e = expectedPos();
    rebasePos(e == null ? (video ? video.currentTime : 0) : e);
  };
  // the room's expected position now: the anchor advanced by the elapsed time at the
  // room rate, frozen while our video is paused (the room paused with us)
  const expectedPos = () => {
    if (!roomPos || !Number.isFinite(roomPos.t)) return null;
    return roomPos.t + (video && !video.paused ? (Date.now() - roomPos.at) / 1000 : 0) * roomRate;
  };

  // ---- apply remote -> local (each one masks the local event it will cause) ----
  function applyRate(r) {
    if (!video || Math.abs(video.playbackRate - r) < 1e-6) return;
    suppress("ratechange");
    video.playbackRate = r;
  }
  function applyPlay() {
    if (!video || !video.paused) return;
    rebaseElapsed(); // resume extrapolating from the frozen pause position
    suppress("play");
    video.play().catch(() => {
      setStatus("Press play yourself (the browser blocked autoplay)", "on");
    });
  }
  function applyPause() {
    if (!video || video.paused) return;
    rebaseElapsed(); // freeze the anchor where the room paused
    suppress("pause");
    video.pause();
  }
  function applySeek(t) {
    if (!video || !Number.isFinite(t)) return;
    // D3: a position from a member on a LONGER title must not run our media to its end
    // (the R15V audit: a 635 s seek on a 22 s title, then youtube autoplayed a third
    // title on us): clamp to just before our duration. No title gate: roomSiteUrl is
    // only the latest OTHER member's announcement, so in a split room (A+B on one title,
    // C on another) A and B would each look off-title and stop syncing with each other
    if (Number.isFinite(video.duration) && t > video.duration - 0.5) t = video.duration - 0.5;
    cancelSeek(); // a remote seek took over: the pending local broadcast is stale
    rebasePos(t); // the room moved here (remote seek or host state): new anchor
    if (Math.abs(video.currentTime - t) < SEEK_EPSILON) return;
    remoteSeek = { t, at: Date.now() };
    suppress("seeking", "seeked");
    // the Netflix player must be seeked from the page's own JS world (page.js); anywhere
    // else seek the element we are bound to — page.js picks its own largest light-DOM
    // video, which misses a player inside a shadow root (archive.org's <play-av>)
    if (location.hostname.endsWith("netflix.com"))
      window.postMessage({ source: "wp-ext", type: "seek", seconds: t }, "*");
    else video.currentTime = t;
  }

  // ---- local -> room ----
  // A title-change window (titleResetUntil, armed by onTitleChange) keeps the site's
  // own play/pause/seek noise after an in-page episode change from broadcasting:
  // a follower's autoplay must not drag the room to 0 — the room state comes via
  // CMD:askHost instead (or stays put when we moved ahead on our own).
  // A scrubber drag fires a seeking event per drag tick: schedule the broadcast and
  // send the CURRENT position once the drag settles (300 ms without a new seeking) or
  // when the seek completes ('seeked' — normal sites keep their old latency). The
  // gates are re-checked at send: a remote seek can arrive while ours is pending.
  const cancelSeek = () => {
    if (!seekTimer) return;
    clearTimeout(seekTimer);
    seekTimer = null;
  };
  const flushSeek = () => {
    cancelSeek();
    if (!joined || !video) return;
    // a remote apply cancels this timer synchronously; only an echo of a remote seek
    // that never reported landing is dropped here, a seek elsewhere still goes out
    if (
      remoteSeek &&
      Date.now() - remoteSeek.at < SEEK_TARGET_MS &&
      Math.abs(video.currentTime - remoteSeek.t) < 1
    )
      return;
    // no suppressed("seeking") gate: a flush timer alive inside a remote apply's suppress
    // window was armed by a user drag tick that landed there after the apply (applySeek
    // cancels any older timer), and its position is not the apply's echo — it must go out
    if (Date.now() < titleResetUntil) return;
    if (adGapBlock()) return; // the ad tail gap (D1): the drag's last tick may land there
    if (ctlBlocked()) return;
    const t = video.currentTime;
    emit("CMD:seek", t);
    rebasePos(t); // the room lined up on us: we are the anchor now
    seenT = t;
    if (nudging) {
      nudging = false;
      applyRate(roomRate);
    }
  };
  // A site's own play()/pause() loop (a twitch VOD at readyState 1 looped play -> waiting -> pause every
  // ~2 ms and the panel broadcast each turn: 3613 CMD:pause / 3124 CMD:play from one tab, 2026-11-22) is
  // not a person: past 4 gesture-less broadcasts in 1 s the rest stay local until the element has been
  // quiet 2 s (each further event while latched extends it). A trusted gesture's event always passes and
  // clears it — once per gesture: the loop's own events inside that gesture's 1 s window are counted again
  // (a click during a loop let all of them through: 200 play+pause in 1 s, codex R24A)
  let loopTimes = [];
  let loopUntil = 0;
  let gesturePassed = 0; // the gestureAt whose event already went through
  const siteLoop = () => {
    const now = Date.now();
    if (now - gestureAt < 1000 && gesturePassed !== gestureAt) {
      gesturePassed = gestureAt;
      loopTimes = [];
      loopUntil = 0;
      return false;
    }
    if (now < loopUntil) {
      loopUntil = now + 2000;
      return true;
    }
    loopTimes = loopTimes.filter((t) => now - t < 1000);
    loopTimes.push(now);
    if (loopTimes.length <= 4) return false;
    loopUntil = now + 2000;
    return true;
  };
  const onPlay = () => {
    if (tabHidden()) return; // the site/browser in a hidden tab, not the user
    if (suppressed("play") || !joined) return;
    if (Date.now() < titleResetUntil) return;
    if (adGapBlock()) return; // the ad tail gap (D1): the ad-end restart may land there
    if (ctlBlocked()) return;
    if (siteLoop()) return;
    cancelSeek(); // the play broadcast below already carries our position
    // line everyone up on our position before they start
    emit("CMD:seek", video.currentTime);
    emit("CMD:play");
    rebasePos(video.currentTime); // the room lines up on us: we are the anchor now
    if (nudging) {
      nudging = false; // the drift we were closing is now imposed on everyone
      applyRate(roomRate);
    }
  };
  const onPause = () => {
    if (tabHidden()) return; // the site/browser in a hidden tab, not the user
    // the end-of-media pause is the video finishing (R15W D4), not a user pause: the
    // room keeps playing (youtube autonav moves on ~8 s later, nobody resumes the room).
    // An MSE player can stop just short of its duration without ever setting ended (a
    // twitch VOD pauses itself ~0.08 s before it, readyState 2): the last second counts too
    if (video.ended || video.duration - video.currentTime < 1) return;
    if (suppressed("pause") || !joined) return;
    if (Date.now() < titleResetUntil) return;
    if (adGapBlock()) return; // the ad tail gap (D1): the ad's own end pause lands there
    if (ctlBlocked()) return;
    if (siteLoop()) return;
    emit("CMD:pause");
    rebaseElapsed(); // the room pauses with us: freeze the anchor here
  };
  // 'seeked' only fires once a seek COMPLETES; a player whose decode pipeline is not
  // running (vimeo's watch page <video> before/without a real start) never completes a
  // seek, so the local broadcast lives in onSeeking and this handler only does the
  // remote-apply landing bookkeeping.
  const onSeeked = () => {
    seekEventCount++;
    onBufferRecover(); // a seek that completed is not a stall: clear an armed 'waiting'
    if (
      remoteSeek &&
      Date.now() - remoteSeek.at < SEEK_TARGET_MS &&
      Math.abs(video.currentTime - remoteSeek.t) < 1
    ) {
      remoteSeek = null; // the applied remote seek landed: no longer in flight
    }
    // a seek that completes must not wait the full settle window (normal sites keep
    // their old latency), but a seekable file completes every drag tick too (measured:
    // a seeked after each 60 ms tick), so the flush itself is debounced — a still-
    // dragging user re-arms it on every tick and only the last position goes out
    if (seekTimer) {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(flushSeek, SEEK_FLUSH_MS);
    }
  };
  const onSeeking = () => {
    seekEventCount++;
    if (!joined) return;
    if (
      remoteSeek &&
      Date.now() - remoteSeek.at < SEEK_TARGET_MS &&
      Math.abs(video.currentTime - remoteSeek.t) < 1
    ) {
      remoteSeek = null; // the applied remote seek reached the element: no echo
      return;
    }
    // Inside a suppress window (remote apply, drift correction) a seek that is not the
    // echo stays local — a site moving the video on its own is not a room command —
    // unless the user is scrubbing right now (trusted pointer/key in the last 1 s): then
    // keep coalescing so the final drag position still goes out (flushSeek re-checks
    // the title/ctl gates at send, so skipping them here changes nothing)
    if (suppressed("seeking")) {
      if (Date.now() - gestureAt > 1000) return;
    } else {
      if (tabHidden()) return; // nobody scrubs in a hidden tab: the site moved the video
      if (Date.now() < titleResetUntil) return;
      if (ctlBlocked()) return;
    }
    cancelSeek(); // a newer drag tick replaces the position the old timer would send
    seekTimer = setTimeout(flushSeek, 300);
  };
  // A currentTime write on a <video> that never got media fires no events at all, so
  // the tick compares the position with the last one it saw: a jump no seek event and
  // no in-flight remote apply explains is a local seek the element swallowed.
  const checkSeekJump = () => {
    const t = video.currentTime;
    const hadEvents = seekEventCount !== seenSeekEvt;
    seenSeekEvt = seekEventCount;
    const prev = seenT;
    const dt = (Date.now() - seenAt) / 1000;
    seenT = t;
    seenAt = Date.now();
    if (prev == null || hadEvents || video.seeking) return;
    // scale by the real time since the last tick: a hidden tab runs this timer about once a minute
    const expected = video.paused ? 0 : video.playbackRate * dt;
    if (Math.abs(t - prev - expected) <= video.playbackRate + 2 * SEEK_EPSILON) return;
    if (remoteSeek && Date.now() - remoteSeek.at >= SEEK_TARGET_MS) remoteSeek = null; // never landed: stop masking local seeks
    if (remoteSeek) {
      if (Date.now() - remoteSeek.at < SEEK_TARGET_MS && Math.abs(t - remoteSeek.t) < 1)
        remoteSeek = null; // our own apply landed (the element gave no events)
      return;
    }
    if (suppressed("seeked") || Date.now() < titleResetUntil) return;
    if (tabHidden()) return; // a jump seen by a hidden tab is the site's/browser's, not a seek we drove
    if (ctlBlocked()) return;
    emit("CMD:seek", t);
    rebasePos(t);
    if (nudging) {
      nudging = false;
      applyRate(roomRate);
    }
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
    if (tabHidden()) return; // a hidden tab's rate change is the site's
    if (ctlBlocked()) return;
    rebaseElapsed(); // advance the anchor to now before it advances at the new rate
    roomRate = r;
    emit("CMD:playbackRate", r);
  };
  const markSiteReset = () => {
    siteResetUntil = Date.now() + SITE_RESET_MS;
    resetReapplied = false;
  };

  // A trusted user gesture (capture, so pointerdown precedes the video event the site's
  // own handler causes) says a human is acting NOW: the title-reset window exists for
  // the site's gesture-less restart after a src swap or title hop, so end it — a
  // play/pause the user makes inside the window must reach the room. The site's own
  // programmatic restart has no gesture and stays local. A click on "next episode"
  // still keeps the window: the URL change re-arms it AFTER the gesture. siteResetUntil
  // is deliberately NOT ended: its window also guards the site's default-rate restore
  // at load (round 15C), which a gesture must not un-guard into a room-wide broadcast.
  const endTitleReset = (e) => {
    if (!e.isTrusted) return;
    if (e.type === "keydown") {
      // typing is not a player action (R16G B): a keydown aimed at an editable target
      // — the page's chat box, or our own panel's inputs, whose open shadow root the
      // composed path pierces — must not end the window or refresh gestureAt. The
      // whole panel is skipped too: a key pressed on its buttons is panel UI, not a
      // player shortcut. pointerdown keeps ending the window for everything.
      const p = e.composedPath();
      if (p.includes(host)) return;
      // Text entry only: a <select> or an <input type="range"> can BE a player control
      // (keyboard seek), and its keys must keep reaching the room (R16J). Date/time
      // fields are typed into like text (R16N)
      const t = p[0];
      if (
        t &&
        ((t.tagName === "INPUT" &&
          /^(text|search|email|url|tel|password|number|date|time|month|week|datetime-local)$/.test(
            t.type,
          )) ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
    }
    titleResetUntil = 0;
    gestureAt = Date.now();
  };
  document.addEventListener("pointerdown", endTitleReset, true);
  document.addEventListener("keydown", endTitleReset, true);
  // a drag's ticks follow pointer moves with a button held: that keeps "the user is
  // scrubbing" fresh for onSeeking (no stuck flag if the release happens off-window)
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.isTrusted && e.buttons) gestureAt = Date.now();
    },
    true,
  );

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
      roomPos = null; // the anchor described the old title: no drift correction until a fresh room apply
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
  // 'waiting' only ARMS a stall — every seek fires 'waiting', so reporting on the event
  // floods CMD:buffering past the server's 5/s relay cap (a dropped false leaves the
  // claim stuck) and a 3.2 s load stall pauses the whole room. The 1 s tick below sends
  // the claim once the stall has lasted > 1.5 s and is still ongoing — the web app's
  // reportBuffering contract (App.tsx: bufferingSince > 1500 with raw = !paused &&
  // readyState < 3) that the server's buffer-pause grace assumes.
  const onWaiting = () => {
    if (!joined || roomMedia || adPlaying() || !video || video.paused) return;
    if (!waitingSince) waitingSince = Date.now();
  };
  // "my data is back" for a held claim (the web app's reportBuffering hold, App.tsx):
  // a buffered range covering currentTime reaching >= 3 s ahead. No readyState gate:
  // YouTube's player kept readyState 2 while paused with 120 s buffered, so the claim
  // was never released (R17G). Indexed loop: Edge's TimeRanges has no iterator.
  // Less than 3 s left in the clip: up to its end (a stall there could never reach 3 s
  // and held the room paused for good, codex R17H)
  const bufferedAhead = () => {
    if (!video || !video.buffered) return false;
    const t = video.currentTime;
    const need = Math.min(3, (video.duration || Infinity) - t - 0.25);
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= t + 0.5 && video.buffered.end(i) > t)
        return video.buffered.end(i) - t >= need;
    }
    return false;
  };
  const onBufferRecover = () => {
    // paused while holding the claim (the room's buffer auto-pause paused us on it):
    // a canplay/playing with < 3 s ahead is not "data back" — the server resumes
    // everyone on our false (bufferResume). Keep the claim and waitingSince armed so
    // the tick re-checks each second (R17D)
    if (
      buffering &&
      video &&
      video.paused &&
      !roomMedia &&
      !adPlaying() &&
      !bufferedAhead()
    )
      return;
    waitingSince = 0;
    reportBuffering(false);
  };

  const VIDEO_EVENTS = {
    play: onPlay,
    pause: onPause,
    seeking: onSeeking,
    seeked: onSeeked,
    ratechange: onRateChange,
    waiting: onWaiting,
    playing: onBufferRecover,
    canplay: onBufferRecover,
    loadstart: markSiteReset,
    // a same-element reload (YouTube SPA hop) resets playbackRate inside the load algorithm
    // with no ratechange (measured on youtube.com, round 15C), so put the room rate back here
    // a src swap on the same element (ad end, SPA hop) jumps currentTime with no seek events
    emptied: () => {
      seenT = null; // the media reset: the tick poll must not read the jump as a seek
      cancelSeek(); // a pending drag broadcast describes the old media
      markSiteReset();
      // the restart after a swap (autoplay fires a fresh 'play' at 0) must not drag
      // the room to the new media's start: same window a title hop arms
      titleResetUntil = Date.now() + SITE_RESET_MS;
    },
    loadedmetadata: () => {
      markSiteReset();
      if (joined && sync && sync.done && !adPlaying()) applyRate(roomRate);
    },
  };

  function bindVideo(v) {
    if (video) {
      for (const [type, fn] of Object.entries(VIDEO_EVENTS)) video.removeEventListener(type, fn);
    }
    cancelSeek(); // a pending drag broadcast belongs to the old element's position
    video = v;
    seenT = null; // a fresh element: the tick poll must not see a phantom jump
    seenSeekEvt = seekEventCount;
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

  // <video>s inside open shadow roots (web-component players such as archive.org's
  // <play-av>), our own panel skipped
  const shadowVideos = (root, out = []) => {
    for (const e of root.querySelectorAll("*")) {
      if (e.tagName === "VIDEO") out.push(e);
      if (e.shadowRoot && e !== host) shadowVideos(e.shadowRoot, out);
    }
    return out;
  };

  function findVideo() {
    return (
      pickVideo(document.querySelectorAll("video")) ||
      // ponytail: the deep walk runs only when the light DOM has no visible video, so a
      // light-DOM preview beside a shadow-root player still wins; merge both if one shows up
      pickVideo(shadowVideos(document))
    );
  }

  function pickVideo(list) {
    let best = null;
    let bestArea = -1;
    for (const v of list) {
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
    const ts = Number(h && h.videoTS);
    if (Number.isFinite(ts)) rebasePos(ts); // the room's stored position: new anchor
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
      rebasePos(video.currentTime); // we imposed our state: it is the room's now
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
    roomPos = null; // the next join re-anchors from the room state
    nudging = false;
    names = {};
    buffering = false;
    waitingSince = 0;
    members = null;
    typingPeers = {};
    typingActive = false;
    clearTimeout(typingOffTimer);
    typingOffTimer = null;
    roomSiteUrl = null;
    adMode = false;
    adFreeAt = 0;
    clearTimeout(adPullTimer);
    adPullTimer = null;
    askedHost = false;
    extController = null;
    hideFollow();
    renderTyping();
    renderMembers();
    renderControl();
    delete host.dataset.synced;
    delete host.dataset.room;
    delete host.dataset.lna;
    updateJoinButton();
    if (!silent) setStatus("Not connected");
  }

  // is the server we connect to local/private (the Local Network Access check applies)?
  function isLocalServer() {
    try {
      const h = new URL(SERVER).hostname.toLowerCase();
      if (h === "localhost" || h === "::1" || h === "[::1]" || h.endsWith(".local")) return true;
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
      if (!m) return false;
      const o = m.slice(1).map(Number);
      if (o.some((n) => n > 255)) return false;
      if (o[0] === 127 || o[0] === 10 || (o[0] === 192 && o[1] === 168)) return true;
      return o[0] === 172 && o[1] >= 16 && o[1] <= 31;
    } catch {
      return false;
    }
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
      seenT = null; // the video moved while we were away: not a seek to broadcast
      everConnected = true;
      sync = { host: null, tsMap: null, done: false };
      delete host.dataset.synced;
      delete host.dataset.lna;
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
      if (location.protocol === "https:" && isLocalServer()) {
        // the browser's Local Network Access check blocks a ws to a local/private server
        // from a public https page; headed builds show a permission prompt, headless
        // blocks silently. socket.io keeps retrying, so this is the way out once allowed.
        host.dataset.lna = "1";
        setStatus("Blocked by the browser's local network check — allow 'local network access' for this site (icon in the address bar), then press Join again", "err");
        return;
      }
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
      if (d.typing) {
        // cap the map: a fresh peer evicts the one waiting longest
        const ids = Object.keys(typingPeers);
        if (!typingPeers[d.id] && ids.length >= MAX_TYPING) delete typingPeers[ids[0]];
        typingPeers[d.id] = Date.now() + 6000; // safety timeout
      } else delete typingPeers[d.id];
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
    s.on("REC:play", () => {
      if (roomMedia || adPlaying()) return;
      // someone resumed while we still hold our stall claim (the pause consumed it on
      // the server): claim again, our data is not back — the web app does the same on
      // its REC:play (App.tsx), the room re-pauses if we are still short
      if (buffering) emit("CMD:buffering", true);
      applyPlay();
    });
    s.on("REC:pause", () => roomMedia || adPlaying() || applyPause());
    s.on("REC:seek", (t) => roomMedia || adPlaying() || applySeek(Number(t)));
    s.on("REC:playbackRate", (r) => {
      if (roomMedia || adPlaying()) return;
      r = Number(r);
      if (!Number.isFinite(r)) return;
      rebaseElapsed(); // advance the anchor to now before it advances at the new rate
      roomRate = r;
      applyRate(r);
      updateRates();
    });
  }

  function setRate(r) {
    if (ctlBlocked()) return;
    rebaseElapsed(); // advance the anchor to now before it advances at the new rate
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
    if (nudging) {
      nudging = false; // the room lines up on us: the drift correction is obsolete
      applyRate(roomRate);
    }
    emit("CMD:seek", video.currentTime);
    if (Math.abs(video.playbackRate - roomRate) > 1e-6) emit("CMD:playbackRate", video.playbackRate);
    emit(video.paused ? "CMD:pause" : "CMD:play");
    rebasePos(video.currentTime); // the room moved to us
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

  // ---- slow drift correction (round 8A) ----
  // Every 2 s of playback, compare our position with the extrapolated room anchor and
  // correct locally — never emitting: < 0.75 s stays untouched, up to 5 s rides a
  // temporary rate nudge (restored once within 0.3 s), beyond that one masked seek
  // (the same path a remote seek uses). The room never learns about our drift.
  const driftCheck = () => {
    delete host.dataset.drift;
    if (!joined || !video || video.paused || buffering || roomMedia || adPlaying()) return;
    if (members && members.length < 2) return; // alone: nothing to drift from
    if (Date.now() < siteResetUntil || Date.now() < titleResetUntil) return;
    if (askedHost) return; // a REC:host reply with fresh room state is already on the way
    if (video.seeking || (remoteSeek && Date.now() - remoteSeek.at < 2000)) return;
    const expected = expectedPos();
    if (expected == null || !Number.isFinite(video.currentTime)) return;
    const drift = video.currentTime - expected;
    host.dataset.drift = String(Math.round(drift * 10) / 10);
    if (Math.abs(drift) >= DRIFT_SEEK_S) {
      // too far to ride a rate nudge: one masked local seek to the expected position
      if (nudging) {
        nudging = false;
        applyRate(roomRate);
      }
      applySeek(expected);
      return;
    }
    if (Math.abs(drift) >= DRIFT_NUDGE_S) {
      // close the gap with a temporary rate bump, scaled to the gap (0.75 s -> 1.05x)
      if (!nudging || nudgeBase !== roomRate) {
        nudging = true;
        nudgeBase = roomRate;
        const f = Math.max(0.05, Math.min(Math.abs(drift) / 8, 0.5));
        nudgeRate = drift < 0 ? roomRate * (1 + f) : roomRate * (1 - f);
      }
      applyRate(nudgeRate);
      return;
    }
    if (nudging && Math.abs(drift) < DRIFT_OK_S) {
      nudging = false;
      applyRate(roomRate);
    }
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
        adStartUrl = myUrl;
        setStatus("Ad playing — sync paused", "err");
      } else {
        adFreeAt = Date.now(); // the ad tail gap: local playback broadcasts stay local (D1)
        if (myUrl !== adStartUrl) {
          // D2: we changed title during the ad (the title-change path skips while an ad
          // plays), so the room position belongs to the title we left: handle it as the
          // hop it was — onTitleChange pulls only when we landed on the room's title
          statusConnected();
          if (myUrl) onTitleChange(adStartUrl);
        } else {
          // the ad ended: pull the room state and apply it like a joiner would — but
          // only once the ad tail gap is over. Youtube clears .ad-showing ~250 ms
          // BEFORE the ad->content media swap (R15V audit), so a pull sent at this
          // flip can land inside that gap on the ad's media: applySeek clamps the
          // room position to the ad's duration - 0.5 and rebases the drift anchor
          // there, the swap then discards it, and drift correction pins us at the
          // ad's end while the room plays on (measured 44 s behind, no recovery).
          // At flip + AD_GAP_MS the swap, when there is one, has settled; an ad that
          // ends without a swap pulls 1.5 s late and gets the same room state. An ad
          // that started again inside the window skips the pull — its own end arms a
          // fresh one.
          adPullTimer = setTimeout(() => {
            adPullTimer = null;
            adFreeAt = 0; // consumed; the D1 gate ends here either way (flip + AD_GAP_MS)
            if (adPlaying() || !joined || askedHost || myUrl !== adStartUrl)
              return;
            askedHost = true;
            emit("CMD:askHost");
          }, AD_GAP_MS);
        }
      }
    }
    if (joined && video && Number.isFinite(video.currentTime)) {
      emit("CMD:ts", video.currentTime);
      checkSeekJump();
    } else seenT = null;
    // the armed 'waiting' becomes a buffering claim only once the stall is > 1.5 s old
    // and still ongoing (raw = !paused && readyState < 3, the web app's own check);
    // recoveries report false immediately via onBufferRecover, this is the 1 s tick
    if (waitingSince) {
      if (joined && video && !video.paused && !roomMedia && !adPlaying()) {
        if (video.readyState < 3) {
          if (Date.now() - waitingSince > 1500) reportBuffering(true);
        } else {
          waitingSince = 0;
          reportBuffering(false);
        }
      } else if (
        buffering &&
        joined &&
        video &&
        video.paused &&
        !roomMedia &&
        !adPlaying()
      ) {
        // paused by the room's buffer auto-pause on OUR claim: hold it — the server
        // resumes everyone on our "false" (bufferResume), so it must mean the data is
        // back (>= 3 s buffered ahead), not that the pause stopped the stall (R17D)
        if (bufferedAhead()) {
          waitingSince = 0;
          reportBuffering(false);
        }
      } else {
        waitingSince = 0; // paused without a held claim / room media / ad / left: gone
        // rescind the claim too: a claim that outlives its stall (the video paused
        // while we were reporting buffering, so no playing/canplay ever rescinds it)
        // sits in the server's buffer map and re-pauses the room on the next play
        reportBuffering(false);
      }
    }
    if (++driftCount % DRIFT_TICK_S === 0) driftCheck();
  }, 1000);
})();
