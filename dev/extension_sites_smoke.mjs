// Smoke test: extension/ on real public video sites that are NOT in the manifest yet
// (no login, no DRM). Run: node dev/extension_sites_smoke.mjs <twitch|archive>
//   twitch  — a Twitch VOD (top-frame MSE player, blob: src); the newest VOD of the public
//             "twitch" channel is picked at run time (VODs expire), SITE_URL=<vod url> overrides
//   archive — archive.org Elephants Dream (the <video> lives in <play-av>'s open shadow root;
//             the player loads its media only on a real click, so warmup clicks it over CDP)
// The extension is copied to a fixed temp folder with the site added to both manifest
// content_scripts entries (and content.js pointed at WP_SERVER when set), then two tabs A and
// B in one Edge profile open the page, join a fresh room (Alice / Bob) and run checks a-h:
//   a) panel present on both tabs          b) both join
//   c) A pause -> B paused within 2 s      d) A play -> B playing
//   e) A seek to 30 s -> B within ±2 s     f) A rate 1.5 -> B 1.5 (still 1.5 after 3 s)
//   g) natural end: A and B play out the last seconds, no CMD:pause from either, B not paused early
//   h) 0 console errors from the extension
// Launcher + CDP helpers are copied from dev/extension_vimeo_smoke.mjs (kept standalone on
// purpose). Needs only the room server: WP_SERVER (default http://localhost:8080). Capped at 5 min.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SITE = process.argv[2];
const SITES = {
  twitch: {
    matches: ["https://www.twitch.tv/*"],
    host: "www.twitch.tv",
    url: null,
  },
  archive: {
    matches: ["https://archive.org/*"],
    host: "archive.org",
    url: "https://archive.org/details/ElephantsDream",
    click: true,
  },
};
if (!SITES[SITE]) {
  console.log(
    "usage: node dev/extension_sites_smoke.mjs <" +
      Object.keys(SITES).join("|") +
      ">",
  );
  process.exit(2);
}
const EDGE =
  process.env.EDGE ||
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SRC_EXT = path.resolve(import.meta.dirname, "../extension");
const EXT = path.join(os.tmpdir(), "wp-ext-sites-ext"); // patched copy, rebuilt each run
const SERVER = process.env.WP_SERVER || "http://localhost:8080";
const RUN_MS = 5 * 60 * 1000;
// twitch serves headless Edge's default "HeadlessEdg" UA a player that never loads media
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildExt() {
  fs.rmSync(EXT, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  fs.cpSync(SRC_EXT, EXT, { recursive: true });
  const mf = JSON.parse(
    fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"),
  );
  for (const cs of mf.content_scripts) cs.matches.push(...SITES[SITE].matches);
  fs.writeFileSync(
    path.join(EXT, "manifest.json"),
    JSON.stringify(mf, null, 2),
  );
  const cj = path.join(EXT, "content.js");
  fs.writeFileSync(
    cj,
    fs
      .readFileSync(cj, "utf8")
      .replace('"http://localhost:8080"', JSON.stringify(SERVER)),
  );
}

const BASE_FLAGS = [
  "--disable-gpu",
  "--autoplay-policy=no-user-gesture-required",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-component-update", // killed runs left ~9 GB of updater downloads in Temp
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--window-size=1366,900",
  `--user-agent=${UA}`,
];
// Edge blocks a ws://localhost socket opened from a public https page (LocalNetworkAccessChecks)
const LNA_FEATURE = "LocalNetworkAccessChecks";
const VARIANTS = [
  {
    name: "headless=new + --load-extension",
    extra: ["--headless=new"],
    features: [],
  },
  {
    name: "headless=new + --load-extension + --disable-features=DisableLoadExtensionCommandLineSwitch",
    extra: ["--headless=new"],
    features: ["DisableLoadExtensionCommandLineSwitch"],
  },
];

// ---------------- CDP (copied from dev/extension_vimeo_smoke.mjs) ----------------
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      } else this.listeners.forEach((fn) => fn(msg));
    };
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("ws error"));
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

let browser, proc, userDir;

async function launch(variant) {
  // one fixed profile per site, wiped at each launch (a fresh mkdtemp per run filled Temp)
  userDir = path.join(os.tmpdir(), `wp-ext-${SITE}-profile`);
  fs.rmSync(userDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  const port = 9900 + Math.floor(Math.random() * 500);
  const feats = [LNA_FEATURE, ...(variant.features || [])];
  const args = [
    `--user-data-dir=${userDir}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    `--disable-features=${feats.join(",")}`,
    ...BASE_FLAGS,
    ...variant.extra,
    "about:blank",
  ];
  proc = spawn(EDGE, args, { stdio: "ignore" });
  let ver;
  for (let i = 0; i < 100; i++) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!ver) throw new Error("debug port never came up");
  browser = new Cdp(ver.webSocketDebuggerUrl);
  await browser.open();
  browser.listeners.push(onEvent);
  return ver.Browser;
}

function killEdge() {
  try {
    if (proc?.pid)
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
  } catch {}
  try {
    browser?.ws.close();
  } catch {}
}

// ---------------- pages ----------------
const pages = new Map(); // sessionId -> page
function onEvent(msg) {
  const page = pages.get(msg.sessionId);
  if (!page) return;
  const p = msg.params;
  if (msg.method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails;
    page.errors.push(
      `exception: ${d.exception?.description || d.text} @ ${d.url || ""}:${d.lineNumber}`,
    );
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const text = p.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (p.type === "error") page.errors.push(`console.error: ${text}`);
  } else if (msg.method === "Log.entryAdded") {
    if (p.entry.level === "error")
      page.errors.push(`log.error: ${p.entry.text} ${p.entry.url || ""}`);
  } else if (msg.method === "Page.javascriptDialogOpening") {
    page.dialogs.push(p.message);
    browser
      .send("Page.handleJavaScriptDialog", { accept: false }, msg.sessionId)
      .catch(() => {});
  }
}

async function newPage(label, url = "about:blank") {
  const { targetId } = await browser.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await browser.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const page = { label, targetId, sessionId, errors: [], dialogs: [] };
  pages.set(sessionId, page);
  const s = (m, p) => browser.send(m, p, sessionId);
  await s("Runtime.enable");
  await s("Log.enable");
  await s("Page.enable");
  await s("Emulation.setFocusEmulationEnabled", { enabled: true });
  if (url !== "about:blank") await s("Page.navigate", { url });
  page.s = s;
  return page;
}

async function ev(page, expression) {
  const r = await page.s("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      "eval failed: " +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text),
    );
  return r.result.value;
}

async function waitFor(fn, timeoutMs, intervalMs = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let ok = false;
    try {
      ok = await fn();
    } catch {}
    if (ok) return Date.now() - t0;
    await sleep(intervalMs);
  }
  return null;
}

// ---------------- panel / video helpers ----------------
const PANEL = (body) =>
  `(() => { const h = document.getElementById('wpx-host'); if (!h) return null; const r = h.shadowRoot; ${body} })()`;
const hasPanel = (p) => ev(p, `!!document.getElementById('wpx-host')`);
const dset = (p, name) => ev(p, PANEL(`return h.dataset.${name};`));
// the largest visible <video>, open shadow roots included (archive.org's player is one),
// our own panel's shadow root skipped
const PICK = `(() => { const all = []; const walk = (r) => { for (const e of r.querySelectorAll('*')) { if (e.tagName === 'VIDEO') all.push(e); if (e.shadowRoot && e.id !== 'wpx-host') walk(e.shadowRoot); } }; walk(document); let best = null, bestArea = -1; for (const v of all) { const r = v.getBoundingClientRect(); const a = r.width * r.height; if (a <= 0) continue; if (v.offsetParent === null && getComputedStyle(v).position !== 'fixed') continue; if (a > bestArea) { best = v; bestArea = a; } } return best; })()`;
const vstate = (p) =>
  ev(
    p,
    `(() => { const v = ${PICK}; return v ? { muted: v.muted, paused: v.paused, ended: v.ended, rs: v.readyState, t: v.currentTime, r: v.playbackRate, dur: v.duration } : null; })()`,
  );
const clickRate = (p, rate) =>
  ev(
    p,
    PANEL(
      `const b = [...r.querySelectorAll('#rates button')].find((x) => x.dataset.rate === '${rate}'); if (b) b.click(); return !!b;`,
    ),
  );
const emits = async (p) => JSON.parse((await dset(p, "emits")) || "{}");

async function joinRoom(p, roomUrl, name) {
  await ev(
    p,
    PANEL(`
      r.getElementById('room').value = ${JSON.stringify(roomUrl)};
      r.getElementById('name').value = ${JSON.stringify(name)};
      r.getElementById('join').click(); return true;`),
  );
  return waitFor(
    () =>
      ev(p, PANEL(`return h.dataset.status === 'on' && !!h.dataset.synced;`)),
    12000,
  );
}

const muteAll = (p) =>
  ev(
    p,
    `(() => { const v = ${PICK}; if (v) v.muted = true; [...document.querySelectorAll('video')].forEach((x) => { x.muted = true; }); return true; })()`,
  );

// trusted click at the player's centre (a real user starting the video)
async function clickVideo(p) {
  const b = await ev(
    p,
    `(() => { const v = ${PICK}; v.scrollIntoView({ block: 'center' }); const r = v.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.s("Input.dispatchMouseEvent", {
      type,
      x: b.x,
      y: b.y,
      button: "left",
      clickCount: 1,
    });
}

// playing = not paused, media loaded and the clock moving
// click: start a click-to-load player (archive.org) with a real click, before joining —
// a room play applied to its element before that click leaves it "playing" with no media
async function warmup(p, click) {
  await muteAll(p);
  if (click) await clickVideo(p);
  else
    await ev(
      p,
      `(() => { const v = ${PICK}; if (v) v.play().catch(() => {}); return true; })()`,
    );
  const ok = await waitFor(
    async () => {
      const s = await vstate(p);
      return s && !s.paused && Number.isFinite(s.dur) && s.t > 0.3;
    },
    15000,
    150,
  );
  await muteAll(p); // a click-started player may have swapped its media in
  return ok;
}

// land on the site page with a video present; a cookie banner is DECLINED, never accepted
async function settle(p, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    let st = null;
    try {
      st = await ev(
        p,
        `(() => { const v = ${PICK}; return { h: location.hostname, ready: document.readyState, v: !!v }; })()`,
      );
    } catch {
      await sleep(400);
      continue;
    }
    if (st.h === SITES[SITE].host && st.ready === "complete" && st.v)
      return { ok: true, ms: Date.now() - t0 };
    try {
      const hit = await ev(
        p,
        `(() => { const b = [...document.querySelectorAll('button')].find((e) =>
        /^(decline( all)?|reject( all)?|only necessary cookies|necessary cookies only)$/i.test((e.textContent || "").trim()));
        if (b && b.offsetParent !== null) { b.click(); return true; } return false; })()`,
      );
      if (hit) console.log(`${label}: consent banner -> clicked decline`);
    } catch {}
    await sleep(500);
  }
  return { ok: false, ms: Date.now() - t0 };
}

// newest VOD of the public "twitch" channel (VODs expire, a fixed id would rot)
async function twitchVod(p) {
  await p.s("Page.navigate", {
    url: "https://www.twitch.tv/twitch/videos?filter=archives&sort=time",
  });
  let url = null;
  await waitFor(
    async () => {
      url = await ev(
        p,
        `(() => { const a = [...document.querySelectorAll('a[href]')].map((x) => x.href).find((h) => /\\/videos\\/\\d+/.test(h)); return a ? a.replace(/\\?.*$/, '') : null; })()`,
      );
      return !!url;
    },
    30000,
    500,
  );
  return url;
}

async function createRoom() {
  for (let i = 0; i < 6; i++) {
    const r = await (
      await fetch(SERVER + "/createRoom", { method: "POST" })
    )
      .json()
      .catch(() => ({}));
    const name = String(r.name || "").replace(/^\//, "");
    if (name) return name;
    if (!i)
      console.log(
        `createRoom: ${r.error || "no name"} — retrying every 20 s (30/hour per IP, fixed window)`,
      );
    await sleep(20000);
  }
  throw new Error("createRoom kept failing (rate-limited?)");
}

// ---------------- results ----------------
let results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail ?? ""}`);
}
let exitCode = 0;
let finished = false;
const timer = setTimeout(() => {
  console.log(
    "\nGLOBAL TIMEOUT (5 min) — killing the browser, printing results so far",
  );
  exitCode = 1;
  finish();
}, RUN_MS);

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nSUMMARY [${SITE}]: ${results.length - failed.length}/${results.length} PASS` +
      (failed.length
        ? "  FAILED: " + failed.map((f) => f.label).join(" | ")
        : ""),
  );
  killEdge();
  process.exit(exitCode || (failed.length ? 1 : 0));
}

// ---------------- main ----------------
async function main() {
  const roomName = await createRoom();
  const roomUrl = SERVER + "/watch/" + roomName;
  console.log("room:", roomUrl);
  buildExt();
  let used = null;
  let browserVer;
  let A;
  let url = process.env.SITE_URL || SITES[SITE].url;
  for (const variant of VARIANTS) {
    try {
      browserVer = await launch(variant);
    } catch (e) {
      console.log(`launch failed (${variant.name}): ${e.message}`);
      killEdge();
      continue;
    }
    A = await newPage("A");
    if (!url) url = await twitchVod(A);
    if (!url) {
      check(
        "a. panel present on both tabs",
        false,
        "no VOD link found on the twitch channel page",
      );
      exitCode = 1;
      return finish();
    }
    await A.s("Page.navigate", { url });
    const st = await settle(A, "A");
    console.log(
      `variant "${variant.name}" -> ${url} ${st.ok ? "settled" : "NOT settled"} in ${st.ms} ms`,
    );
    const ms = st.ok ? await waitFor(() => hasPanel(A), 10000, 200) : null;
    if (st.ok && ms !== null) {
      used = variant;
      break;
    }
    killEdge();
    pages.clear();
  }
  if (!used) {
    check(
      "a. panel present on both tabs",
      false,
      "no launch variant produced the panel with a video on the page",
    );
    exitCode = 1;
    return finish();
  }
  console.log("browser:", browserVer, "| working flags:", used.name);

  const B = await newPage("B", url);
  const stB = await settle(B, "B");
  const bPanel = stB.ok ? await waitFor(() => hasPanel(B), 10000, 200) : null;
  check(
    "a. panel present on both tabs",
    bPanel !== null,
    `A ok; B ${bPanel !== null ? "ok" : `no panel (settle=${stB.ok})`}`,
  );

  if (SITES[SITE].click)
    console.log(
      `pre-join click start: A ${(await warmup(A, true)) !== null} B ${(await warmup(B, true)) !== null}`,
    );
  const ja = await joinRoom(A, roomUrl, "Alice");
  const jb = await joinRoom(B, roomUrl, "Bob");
  check(
    "b. both joined the room",
    ja !== null && jb !== null,
    `A after ${ja ?? "never"} ms | B after ${jb ?? "never"} ms (synced='${await dset(B, "synced")}')`,
  );

  await sleep(3000); // joiner sync + the 3 s site-reset window
  // page-world video event trace (printed when g fails), re-armed on a swapped element
  const TRACE = `(() => { const v = ${PICK}; if (!v || v.__wpTrace) return; v.__wpTrace = 1; window.__tr = window.__tr || []; const T0 = window.__tr0 = window.__tr0 || Date.now(); for (const e of ['play','pause','seeking','seeked','waiting','playing','ended','emptied','ratechange']) v.addEventListener(e, () => { window.__tr.push(((Date.now() - T0) / 1000).toFixed(2) + ' ' + e + ' t=' + v.currentTime.toFixed(2) + ' p=' + (v.paused ? 1 : 0) + ' rs=' + v.readyState + ' E=' + (() => { const m = JSON.parse(document.getElementById('wpx-host')?.dataset.emits || '{}'); return (m['CMD:pause'] || 0) + '/' + (m['CMD:play'] || 0); })() + ' vis=' + document.visibilityState); if (window.__tr.length > 1500) window.__tr.length = 1500; }); })()`;
  await ev(A, TRACE);
  await ev(B, TRACE);
  const wa = await warmup(A);
  const wb = await warmup(B);
  console.log(
    `warmup: A playing=${wa !== null} B playing=${wb !== null} (A ${JSON.stringify(await vstate(A))} | B ${JSON.stringify(await vstate(B))})`,
  );

  // c) pause
  await ev(A, `${PICK}.pause(); true`);
  const c = await waitFor(
    async () => (await vstate(B))?.paused === true,
    2000,
    60,
  );
  check(
    "c. A pause -> B paused within 2 s",
    c !== null,
    `B paused after ${c ?? "NEVER"} ms (B ${JSON.stringify(await vstate(B))})`,
  );

  // a play/pause storm would overwrite the trace ring buffer by the end: dump it here too
  if (c === null)
    console.log(
      `after c: B emits ${await dset(B, "emits")}\n  B trace:\n  ` +
        ((await ev(B, "window.__tr || []")) || []).slice(-60).join("\n  "),
    );

  // d) play
  await ev(A, `${PICK}.play().catch(() => {}); true`);
  const d = await waitFor(
    async () => (await vstate(B))?.paused === false,
    2000,
    60,
  );
  check(
    "d. A play -> B playing",
    d !== null,
    `B playing after ${d ?? "NEVER"} ms`,
  );

  // f) rate
  const clicked = await clickRate(A, "1.5");
  const hit = await waitFor(
    async () => Math.abs(((await vstate(B))?.r ?? NaN) - 1.5) < 0.05,
    2000,
    60,
  );
  const rates = [];
  let stable = hit !== null;
  if (stable) {
    for (let i = 0; i < 3; i++) {
      await sleep(1000);
      const r = (await vstate(B))?.r;
      rates.push(r);
      if (Math.abs((r ?? 0) - 1.5) >= 0.05) stable = false;
    }
  }
  check(
    "f. A rate 1.5 -> B 1.5",
    clicked && stable,
    `B hit 1.5 after ${hit ?? "NEVER"} ms; B rates over 3 s: ${rates.join(",")} (A rate ${(await vstate(A))?.r})`,
  );
  await clickRate(A, "1");

  // e) seek (after f: a seek on a slow progressive file can re-buffer B, and the drift
  // catch-up that follows nudges B's rate by design)
  await sleep(1000);
  await ev(A, `${PICK}.currentTime = 30; true`);
  const e = await waitFor(
    async () => Math.abs(((await vstate(B))?.t ?? NaN) - 30) <= 2,
    4000,
    80,
  );
  check(
    "e. A seek to 30 s -> B within ±2 s",
    e !== null,
    `A t=${(await vstate(A))?.t}; B t=${(await vstate(B))?.t} after ${e ?? "NEVER"} ms`,
  );

  await sleep(500);

  // g) natural end: A seeks to dur-10, both play out; the end pause must not reach the room
  const dur = (await vstate(A))?.dur;
  let gOk = false;
  let gDetail = `duration ${dur}`;
  if (Number.isFinite(dur) && dur > 60) {
    await ev(A, `${PICK}.currentTime = ${dur - 10}; true`);
    await waitFor(
      async () => Math.abs(((await vstate(B))?.t ?? NaN) - (dur - 10)) <= 2,
      4000,
      80,
    );
    // a far seek on a slow progressive file (archive.org) can stall past the server's
    // buffer-pause grace, which pauses the room by design and never resumes it: press
    // play on A once both have data, the way a member would
    const both = await waitFor(
      async () => {
        const a = await vstate(A);
        const b = await vstate(B);
        if (!a || !b || a.rs < 3 || b.rs < 3) return false;
        if (a.paused) await ev(A, `${PICK}.play().catch(() => {}); true`);
        return !a.paused && !b.paused;
      },
      15000,
      300,
    );
    if (both === null)
      console.log(
        `g: after the seek A ${JSON.stringify(await vstate(A))} | B ${JSON.stringify(await vstate(B))}`,
      );
    await sleep(1000);
    const pA0 = (await emits(A))["CMD:pause"] || 0;
    const pB0 = (await emits(B))["CMD:pause"] || 0;
    // B's furthest position on this title: a site that moves on to its next item
    // (archive.org playlists) leaves the element at 0 on the next file
    let bMax = 0;
    const endA = await waitFor(
      async () => {
        const b = await vstate(B);
        if (b && Math.abs(b.dur - dur) < 1) bMax = Math.max(bMax, b.t);
        const s = await vstate(A);
        return s?.ended || (s && s.t >= dur - 0.3);
      },
      15000,
      200,
    );
    for (let i = 0; i < 10; i++) {
      const b = await vstate(B);
      if (b && Math.abs(b.dur - dur) < 1) bMax = Math.max(bMax, b.t);
      await sleep(200);
    }
    await sleep(1000);
    const sA = await vstate(A);
    const sB = await vstate(B);
    const pA1 = (await emits(A))["CMD:pause"] || 0;
    const pB1 = (await emits(B))["CMD:pause"] || 0;
    const bAtEnd = bMax >= dur - 1.5 || !!sB?.ended;
    gOk = endA !== null && pA1 === pA0 && pB1 === pB0 && bAtEnd;
    gDetail = `A reached end after ${endA ?? "NEVER"} ms; CMD:pause A ${pA0}->${pA1} B ${pB0}->${pB1}; B furthest ${bMax.toFixed(2)} of ${dur}; A ${JSON.stringify(sA)} | B ${JSON.stringify(sB)}; urls A=${await ev(A, "location.pathname")} B=${await ev(B, "location.pathname")}`;
  }
  check("g. natural end: no pause broadcast, B plays to the end", gOk, gDetail);
  if (results.some((r) => !r.ok))
    for (const [tag, p] of [
      ["A", A],
      ["B", B],
    ])
      console.log(
        `trace ${tag}:\n  ` +
          ((await ev(p, "window.__tr || []")) || []).slice(-45).join("\n  "),
      );

  // h) console errors from the extension vs the site's own
  const EXT_ERR =
    /chrome-extension:\/\/|\/content\.js|\/page\.js|\[wp-ext\]|wp-ext-page/i;
  // archive.org probes chrome-extension://invalid/ twice per load with no extension at all
  const SITE_NOISE = /chrome-extension:\/\/invalid\//;
  let hOk = true;
  const hDetail = [];
  for (const [tag, p] of [
    ["A", A],
    ["B", B],
  ]) {
    const ext = p.errors.filter((x) => EXT_ERR.test(x) && !SITE_NOISE.test(x));
    if (ext.length) hOk = false;
    hDetail.push(
      `${tag}: ${ext.length} extension error(s)` +
        (ext.length ? " — " + ext.slice(0, 5).join(" ;; ") : "") +
        ` (${p.errors.length} raw page error(s))` +
        (p.dialogs.length ? ` | dialogs: ${JSON.stringify(p.dialogs)}` : ""),
    );
  }
  check("h. 0 console errors from the extension", hOk, hDetail.join(" | "));
  console.log(
    `emits: A ${await dset(A, "emits")} | B ${await dset(B, "emits")}`,
  );
  for (const [tag, p] of [
    ["A", A],
    ["B", B],
  ]) {
    const tr = (await ev(p, "window.__tr || []")) || [];
    const i = tr.findIndex((x) => Number((/ E=(\d+)/.exec(x) || [])[1]) >= 20);
    if (i >= 0)
      console.log(
        `STORM ${tag} (trace ${tr.length} entries, onset #${i}):\n  ` +
          tr.slice(Math.max(0, i - 40), i + 40).join("\n  "),
      );
  }
  finish();
}

main().then(
  () => finish(),
  (e) => {
    console.log("FATAL:", e?.message || e);
    exitCode = 1;
    finish();
  },
);
