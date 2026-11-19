// WatchParty Sync - panel extras, loaded after content.js in both loaders (isolated world
// for the extension, page world for the bookmarklet). Adds to the existing panel without
// touching content.js: drag the panel by its .head, a hide-chat button in .head,
// persistence for both, and window.__wpUi.reset().
(() => {
  "use strict";
  if (window.__wpUi) return;

  // same storage choice as content.js: chrome.storage.local for the extension,
  // localStorage "wpx:" keys for the bookmarklet
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

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  let host = null;
  let root = null;
  let panel = null;
  let head = null;
  let chatBtn = null;
  let placed = false; // inline left/top set (dragged or restored); false = content.js top/right default
  let drag = null; // { x, y, left, top, w, h, moved }

  function applyPos(left, top) {
    host.style.left = Math.round(left) + "px";
    host.style.top = Math.round(top) + "px";
    host.style.right = "auto";
    placed = true;
  }

  function savePos() {
    const r = host.getBoundingClientRect();
    store.set({ pos: { left: Math.round(r.left), top: Math.round(r.top) } });
  }

  // keep the panel on screen: after a drag, a restore saved on a larger window, a window resize
  function reclamp() {
    if (!placed) return;
    const r = host.getBoundingClientRect();
    const left = clamp(r.left, 0, window.innerWidth - r.width);
    const top = clamp(r.top, 0, window.innerHeight - r.height);
    if (left !== r.left || top !== r.top) {
      applyPos(left, top);
      savePos();
    }
  }

  function reset() {
    if (!host) return;
    placed = false;
    host.style.left = "";
    host.style.top = "12px";
    host.style.right = "12px";
    store.set({ pos: null });
  }

  function onDown(e) {
    if (e.button !== 0 || e.target.closest("button")) return;
    const r = host.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, moved: false };
    // capture so the drag keeps tracking when the cursor leaves the panel; content.js stops
    // event propagation at the host, so without it a move outside would never reach us
    try {
      head.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone: the window listeners below still track the drag
    }
    e.preventDefault();
  }
  function onMove(e) {
    if (!drag) return;
    applyPos(
      clamp(drag.left + e.clientX - drag.x, 0, window.innerWidth - drag.w),
      clamp(drag.top + e.clientY - drag.y, 0, window.innerHeight - drag.h),
    );
    drag.moved = true;
  }
  function onUp() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) savePos();
  }

  function setNoChat(hide) {
    panel.classList.toggle("nochat", hide);
    chatBtn.classList.toggle("active", hide);
    store.set({ nochat: hide });
  }

  function init(h) {
    host = h;
    root = h.shadowRoot;
    panel = root.getElementById("panel");
    head = root.querySelector(".head");
    const toggleBtn = root.getElementById("toggle");
    if (!panel || !head || !toggleBtn) return;

    // position the buttons as one cluster at the right (head is space-between for 2 children)
    const style = document.createElement("style");
    style.textContent = `
      .head { touch-action: none; user-select: none; cursor: move; }
      .head > span { margin-right: auto; }
      .head button + button { margin-left: 4px; }
      .panel.nochat .log, .panel.nochat #chatinput { display: none !important; }
    `;
    root.appendChild(style);

    chatBtn = document.createElement("button");
    chatBtn.id = "chatx";
    chatBtn.type = "button";
    chatBtn.textContent = "💬";
    chatBtn.title = "Show / hide chat";
    head.insertBefore(chatBtn, toggleBtn);
    chatBtn.addEventListener("click", () => setNoChat(!panel.classList.contains("nochat")));

    head.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    // outside the host these events are not stopped by content.js's host-level
    // stopPropagation, so they are the fallback when pointer capture is not active
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("resize", reclamp);

    store.get(["pos", "nochat"]).then((saved) => {
      if (!host.isConnected) return;
      if (saved.nochat) setNoChat(true);
      const p = saved.pos;
      if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
        applyPos(
          clamp(p.left, 0, window.innerWidth - host.offsetWidth),
          clamp(p.top, 0, window.innerHeight - host.offsetHeight),
        );
      }
    });
  }

  window.__wpUi = { reset };

  // content.js may run before or after us; poll until its panel exists
  const t0 = Date.now();
  const iv = setInterval(() => {
    const h = document.getElementById("wpx-host");
    if (h && h.shadowRoot && h.shadowRoot.getElementById("panel")) {
      clearInterval(iv);
      init(h);
    } else if (Date.now() - t0 > 30000) {
      clearInterval(iv);
    }
  }, 100);
})();
