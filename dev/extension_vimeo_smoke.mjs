// Smoke test: extension/ (MV3) on a real public Vimeo watch page (no login, no DRM, no capture).
// Two tabs A and B in one Edge profile load https://vimeo.com/76979871 (public, login-free),
// join the same fresh room through the panel (Alice / Bob) and run checks a-g:
//   a) panel present on both tabs          b) both join
//   c) A pause -> B paused within 2 s      d) A play -> B playing
//   e) A seek to 30 s -> B within ±2 s     f) A rate 1.5 -> B 1.5 (still 1.5 after 3 s)
//   g) 0 console errors from the extension
// Launcher + CDP helpers are copied from dev/extension_youtube_smoke.mjs (kept standalone
// on purpose). Needs only the server on :8080 (npm run dev). Run: node dev/extension_vimeo_smoke.mjs
// Capped at 5 minutes.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const SRC_EXT = path.resolve(import.meta.dirname, "../extension");
const SERVER = process.env.WP_SERVER || "http://localhost:8080";
// content.js bakes in http://localhost:8080: for another WP_SERVER, load a temp copy pointed at it
const EXT = (() => {
  if (SERVER === "http://localhost:8080") return SRC_EXT;
  const dir = path.join(os.tmpdir(), "wp-ext-vimeo-ext");
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
  fs.cpSync(SRC_EXT, dir, { recursive: true });
  const cj = path.join(dir, "content.js");
  fs.writeFileSync(
    cj,
    fs
      .readFileSync(cj, "utf8")
      .replace('"http://localhost:8080"', JSON.stringify(SERVER)),
  );
  return dir;
})();

const VIMEO_URL = "https://vimeo.com/76979871";
const CANON = "https://vimeo.com/76979871";
const RUN_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
];
// Edge blocks a ws://localhost socket opened from a public https page (LocalNetworkAccessChecks)
// and headless has no prompt for it. Always disabled here (the panel's own LNA status path is
// the youtube smoke's --lna phase).
const LNA_FEATURE = "LocalNetworkAccessChecks";
// launch variants tried in order until the extension's panel shows up
const VARIANTS = [
  { name: "headless=new + --load-extension", extra: ["--headless=new"], features: [] },
  {
    name: "headless=new + --load-extension + --disable-features=DisableLoadExtensionCommandLineSwitch",
    extra: ["--headless=new"],
    features: ["DisableLoadExtensionCommandLineSwitch"],
  },
  { name: "headed + --load-extension", extra: [], features: [] },
  {
    name: "headed + --load-extension + --disable-features=DisableLoadExtensionCommandLineSwitch",
    extra: [],
    features: ["DisableLoadExtensionCommandLineSwitch"],
  },
];

// ---------------- CDP (copied from dev/extension_youtube_smoke.mjs) ----------------
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
  // one fixed profile, wiped at each launch: a fresh mkdtemp per run piled up ~10 GB in Temp (2026-11-20)
  userDir = path.join(os.tmpdir(), "wp-vimeo-profile");
  fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
    // taskkill exists only on Windows; elsewhere a leftover browser kept node alive after the summary
    if (proc?.pid) process.platform === "win32" ? execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }) : proc.kill("SIGKILL");
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
    page.errors.push(`exception: ${d.exception?.description || d.text} @ ${d.url || ""}:${d.lineNumber}`);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const text = p.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (p.type === "error") page.errors.push(`console.error: ${text}`);
  } else if (msg.method === "Log.entryAdded") {
    if (p.entry.level === "error") page.errors.push(`log.error: ${p.entry.text} ${p.entry.url || ""}`);
  } else if (msg.method === "Page.javascriptDialogOpening") {
    // only our own panel confirm()s may be accepted ("Move everyone..." from Sync
    // everyone to me); anything else (a site dialog we did not invite) is DECLINED
    page.dialogs.push(p.message);
    const ours = /Move everyone/i.test(p.message || "");
    browser.send("Page.handleJavaScriptDialog", { accept: ours }, msg.sessionId).catch(() => {});
  }
}

async function newPage(label, url = "about:blank") {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
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
  const r = await page.s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
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
// The panel is an open shadow root on #wpx-host; the harness reads it from the page world.
const PANEL = (body) =>
  `(() => { const h = document.getElementById('wpx-host'); if (!h) return null; const r = h.shadowRoot; ${body} })()`;
const hasPanel = (p) => ev(p, `!!document.getElementById('wpx-host')`);
const dset = (p, name) => ev(p, PANEL(`return h.dataset.${name};`));
// the Vimeo player (vimeo.com watch page and player.vimeo.com top-level) is a plain
// top-frame <video>; pick it the same way content.js does (largest visible), so a small
// preview video can never fool the harness
const PICK = `(() => { let best = null, bestArea = -1; for (const v of document.querySelectorAll('video')) { const r = v.getBoundingClientRect(); const a = r.width * r.height; if (a <= 0) continue; if (v.offsetParent === null && getComputedStyle(v).position !== 'fixed') continue; if (a > bestArea) { best = v; bestArea = a; } } return best; })()`;
const vstate = (p) =>
  ev(p, `(() => { const v = ${PICK}; return v ? { muted: v.muted, paused: v.paused, t: v.currentTime, r: v.playbackRate, dur: v.duration } : null; })()`);
const clickRate = (p, rate) =>
  ev(p, PANEL(`const b = [...r.querySelectorAll('#rates button')].find((x) => x.dataset.rate === '${rate}'); if (b) b.click(); return !!b;`));

async function joinRoom(p, roomUrl, name) {
  await ev(
    p,
    PANEL(`
      r.getElementById('room').value = ${JSON.stringify(roomUrl)};
      r.getElementById('name').value = ${JSON.stringify(name)};
      r.getElementById('join').click(); return true;`),
  );
  const ms = await waitFor(() => ev(p, PANEL(`return h.dataset.status === 'on' && !!h.dataset.synced;`)), 12000);
  return ms;
}

// mute every video on the page (autoplay then never needs a sound policy)
const muteAll = (p) => ev(p, `[...document.querySelectorAll('video')].forEach((v) => { v.muted = true; }); true`);
// page.js's canonical title url for the page we are on (test hook from page.js)
const canonNow = (p) => ev(p, `window.__wpExtPageCanon ? window.__wpExtPageCanon(location.href) : null`);

async function warmup(p) {
  await muteAll(p);
  await ev(p, `${PICK} && ${PICK}.play().catch(() => {}); true`);
  return waitFor(async () => (await vstate(p))?.paused === false, 8000, 150);
}

// land on the vimeo watch page: a cookie/consent banner is DECLINED ("Decline all" /
// "Only necessary cookies"), never accepted; returns { ok, ms, declines }
async function settleOnVimeo(p, label) {
  const t0 = Date.now();
  let declines = 0;
  while (Date.now() - t0 < 45000) {
    let st = null;
    try {
      st = await ev(p, `(() => ({ h: location.hostname, ready: document.readyState, v: !!document.querySelector('video') }))()`);
    } catch {
      await sleep(400);
      continue;
    }
    if ((st.h === "vimeo.com" || st.h === "www.vimeo.com") && st.ready === "complete" && st.v) {
      return { ok: true, ms: Date.now() - t0, declines };
    }
    let hit = false;
    try {
      hit = await ev(p, `(() => { const b = [...document.querySelectorAll('button')].find((e) =>
        /^(decline( all)?|reject( all)?|only necessary cookies|necessary cookies only)$/i.test((e.textContent || "").trim()));
        if (b && b.offsetParent !== null) { b.click(); return true; } return false; })()`);
    } catch {}
    if (hit) {
      declines++;
      console.log(`${label}: consent banner -> clicked a decline button (#${declines})`);
      await sleep(1500);
      continue;
    }
    await sleep(500);
  }
  return { ok: false, ms: Date.now() - t0, declines };
}

// The server rate-limits POST /createRoom to 30/hour per IP with a FIXED window, and the
// same dev server serves every harness on this machine: retry until the window rolls over
// instead of failing the whole run on a 429.
async function createRoom() {
  for (let i = 0; i < 6; i++) {
    const r = await (await fetch(SERVER + "/createRoom", { method: "POST" })).json().catch(() => ({}));
    const name = String(r.name || "").replace(/^\//, "");
    if (name) return name;
    if (!i) console.log(`createRoom: ${r.error || "no name"} — retrying every 20 s (30/hour per IP, fixed window)`);
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
  console.log("\nGLOBAL TIMEOUT (5 min) — killing the browser, printing results so far");
  exitCode = 1;
  finish();
}, RUN_MS);

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY [vimeo]: ${results.length - failed.length}/${results.length} PASS` + (failed.length ? "  FAILED: " + failed.map((f) => f.label).join(" | ") : ""));
  killEdge();
  process.exit(exitCode || (failed.length ? 1 : 0));
}

// ---------------- main ----------------
async function main() {
  // room first (fail fast here rather than after a browser launch when the server is rate-limiting)
  const roomName = await createRoom();
  const roomUrl = SERVER + "/watch/" + roomName;
  console.log("room:", roomUrl);
  // 0. launch, find a variant where the extension loads on vimeo.com
  let used = null;
  let browserVer;
  let A;
  for (const variant of VARIANTS) {
    try {
      browserVer = await launch(variant);
    } catch (e) {
      console.log(`launch failed (${variant.name}): ${e.message}`);
      killEdge();
      continue;
    }
    A = await newPage("A", VIMEO_URL);
    const settle = await settleOnVimeo(A, "A");
    console.log(`variant "${variant.name}" -> watch page ${settle.ok ? "settled" : "NOT settled"} in ${settle.ms} ms (declines=${settle.declines})`);
    const ms = settle.ok ? await waitFor(() => hasPanel(A), 10000, 200) : null;
    if (settle.ok && ms !== null) {
      used = variant;
      break;
    }
    killEdge();
    pages.clear();
  }
  if (!used) {
    check("a. panel present on both tabs", false, "no launch variant produced the panel on the vimeo watch page (the video may be down)");
    exitCode = 1;
    return finish();
  }
  console.log("browser:", browserVer, "| working flags:", used.name);

  // 1. tab B on the same watch page
  const B = await newPage("B", VIMEO_URL);
  const settleB = await settleOnVimeo(B, "B");
  console.log(`B settled=${settleB.ok} in ${settleB.ms} ms (declines=${settleB.declines})`);
  const bPanel = settleB.ok ? await waitFor(() => hasPanel(B), 10000, 200) : null;

  // a) panel present on both tabs
  check("a. panel present on both tabs", bPanel !== null, `A panel ok; B ${bPanel !== null ? "ok" : `no panel within 10 s (settle=${settleB.ok})`}`);

  // b) both join the same fresh room
  const ja = await joinRoom(A, roomUrl, "Alice");
  const jb = await joinRoom(B, roomUrl, "Bob");
  check("b. both joined the room", ja !== null && jb !== null, `A joined after ${ja ?? "never"} ms (room='${await dset(A, "room")}') | B after ${jb ?? "never"} ms (synced='${await dset(B, "synced")}')`);
  console.log(`page.js canon: A=${JSON.stringify(await canonNow(A))} B=${JSON.stringify(await canonNow(B))} (expected ${JSON.stringify(CANON)})`);

  // warmup: both must be playing before c) means anything
  await sleep(3000); // let the joiner sync + the 3 s site-reset window settle
  const wa = await warmup(A);
  const wb = await warmup(B);
  console.log(`warmup: A playing=${wa !== null} B playing=${wb !== null} (A ${JSON.stringify(await vstate(A))} | B ${JSON.stringify(await vstate(B))})`);
  if (wb === null) console.log("NOTE: warmup did not get B playing, c) may pass trivially (B already paused)");

  // c) A pause -> B paused within 2 s
  const pa0 = await vstate(A);
  await ev(A, `${PICK}.pause(); true`);
  const c = await waitFor(async () => (await vstate(B))?.paused === true, 2000, 60);
  check("c. A pause -> B paused within 2 s", c !== null, `A was ${JSON.stringify(pa0)}; B paused after ${c ?? "NEVER"} ms`);

  // d) A play -> B playing
  await ev(A, `${PICK}.play().catch(() => {}); true`);
  const d = await waitFor(async () => (await vstate(B))?.paused === false, 2000, 60);
  check("d. A play -> B playing", d !== null, `B playing after ${d ?? "NEVER"} ms`);

  // e) A seeks to 30 s -> B within ±2 s
  const durA = (await vstate(A))?.dur || 0;
  const target = durA >= 40 ? 30 : Math.max(1, Math.round(durA * 0.4));
  if (target !== 30) console.log(`NOTE: video duration ${Math.round(durA)} s < 40 s -> seeking to ${target} s instead of 30 s`);
  await sleep(1000); // let the play settle before seeking
  await ev(A, `${PICK}.currentTime = ${target}; true`);
  const e = await waitFor(async () => Math.abs(((await vstate(B))?.t ?? NaN) - target) <= 2, 4000, 80);
  check(`e. A seek to ${target} s -> B within ±2 s`, e !== null, `A t=${(await vstate(A))?.t}; B t=${(await vstate(B))?.t} within ±2 s after ${e ?? "NEVER"} ms`);

  // f) A rate 1.5 -> B 1.5, and it stays (a site that resets its own rate would flip back)
  const clicked = await clickRate(A, "1.5");
  const hit = await waitFor(async () => Math.abs(((await vstate(B))?.r ?? NaN) - 1.5) < 0.05, 2000, 60);
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
  check("f. A rate 1.5 -> B 1.5", clicked && stable, `clicked=${clicked}; B hit 1.5 after ${hit ?? "NEVER"} ms; B rates over 3 s: ${rates.join(",")} (A rate now ${(await vstate(A))?.r})`);
  await clickRate(A, "1"); // cleanup: leave the room at 1x

  // g) console errors from the extension vs vimeo's own
  const EXT_ERR = /chrome-extension:\/\/|\/content\.js|\/page\.js|\[wp-ext\]|wp-ext-page/i;
  let gOk = true;
  const gDetail = [];
  for (const [tag, p] of [["A", A], ["B", B]]) {
    const ext = p.errors.filter((x) => EXT_ERR.test(x));
    if (ext.length) gOk = false;
    gDetail.push(`${tag}: ${ext.length} extension error(s)` + (ext.length ? " — " + ext.slice(0, 5).join(" ;; ") : "") + ` (${p.errors.length} raw page error(s), site noise excluded)` + (p.dialogs.length ? ` | dialogs seen: ${JSON.stringify(p.dialogs)}` : ""));
  }
  check("g. 0 console errors from the extension", gOk, gDetail.join(" | "));

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
