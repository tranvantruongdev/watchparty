// Smoke test: extension/ (MV3) on a real public YouTube watch page (no login, no DRM, no capture).
// Two tabs A and B in one Edge profile load https://www.youtube.com/watch?v=aqz-KE-bpKQ
// (Big Buck Bunny, public), join the same fresh room through the panel (Alice / Bob) and run
// checks y1-y8. Launcher + CDP helpers are copied from dev/extension_e2e.mjs (kept standalone
// on purpose). Needs only the server on :8080 (npm run dev). Run: node dev/extension_youtube_smoke.mjs
// Whole run is capped at 5 minutes.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// the real payload, straight from the app's source (Node 24 strips the .ts types)
import { getBookmarklet } from "../src/utils/bookmarklet.ts";

const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const EXT = path.resolve(import.meta.dirname, "../extension");
const SERVER = "http://localhost:8080";
const YT_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const CANON = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const RUN_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_FLAGS = [
  "--disable-gpu",
  "--autoplay-policy=no-user-gesture-required",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];
// Edge 157 blocks a ws://localhost socket opened from a public https page
// (net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS) — the LNA feature has no prompt
// in headless. Headed users would get the "local network access" permission prompt.
// Always disabled here; variant.features are merged into the same --disable-features
// flag (a second --disable-features flag would override, not merge).
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

// ---------------- CDP (copied from dev/extension_e2e.mjs) ----------------
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

// blockLna=true (the default run) disables LocalNetworkAccessChecks so the localhost
// socket works; --lna passes false to keep the check ON (the socket is then blocked — the point).
// loadExt=false (--bookmarklet phase) launches Edge WITHOUT the extension.
async function launch(variant, blockLna = true, loadExt = true) {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "wpyt-"));
  const port = 9900 + Math.floor(Math.random() * 500);
  const feats = blockLna ? [LNA_FEATURE, ...(variant.features || [])] : variant.features || [];
  const args = [
    `--user-data-dir=${userDir}`,
    `--remote-debugging-port=${port}`,
    ...(loadExt ? [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`] : ["--disable-extensions"]),
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
    if (proc?.pid) execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
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
const MAINV = `(document.querySelector('#movie_player video') || document.querySelector('video'))`;
const vstate = (p) =>
  ev(p, `(() => { const v = ${MAINV}; return v ? { muted: v.muted, paused: v.paused, t: v.currentTime, r: v.playbackRate } : null; })()`);
const emits = (p) => ev(p, PANEL(`return JSON.parse(h.dataset.emits || '{}');`));
const statusText = (p) => ev(p, PANEL(`return r.getElementById('status').textContent;`));
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

// mute every video on the page (autoplay then never needs sound policy)
const muteAll = (p) => ev(p, `[...document.querySelectorAll('video')].forEach((v) => { v.muted = true; }); true`);
// collect the siteUrl messages page.js posts (source wp-ext-page), then ask it to re-post
const collectSiteUrls = (p) =>
  ev(p, `(() => { if (window.__wpUrls) return 'kept'; window.__wpUrls = [];
    window.addEventListener('message', (e) => { if (e.source === window && e.data && e.data.source === 'wp-ext-page' && e.data.type === 'siteUrl' && typeof e.data.url === 'string' && e.data.url) window.__wpUrls.push(e.data.url); });
    window.postMessage({ source: 'wp-ext', type: 'getSiteUrl' }, '*'); return 'ok'; })()`);

const BODY_TXT = `(document.body && document.body.innerText) || ''`;
// errors attributable to the extension (same filter as the y8 check)
const EXT_ERR = /chrome-extension:\/\/|\/content\.js|\/page\.js|\[wp-ext\]|wp-ext-page/i;
// land on the watch page: a cookie/consent wall (own host or embedded dialog) is DECLINED
// ("Reject all"), never accepted; returns { ok, bot, ms, rejects }
async function settleOnWatch(p, label) {
  const t0 = Date.now();
  let rejects = 0;
  while (Date.now() - t0 < 45000) {
    let st = null;
    try {
      st = await ev(
        p,
        `(() => ({ h: location.hostname, ready: document.readyState,
          wall: /Before you continue|Trước khi tiếp tục|Sign in to continue to YouTube/i.test(${BODY_TXT}),
          bot: /not a bot|không phải là robot|Sign in to confirm|Đăng nhập để xác nhận/i.test(${BODY_TXT}) }))()`,
      );
    } catch {
      await sleep(400);
      continue;
    }
    if (st.h.endsWith("youtube.com") && !st.h.includes("consent") && !st.wall && st.ready === "complete") {
      return { ok: true, bot: st.bot, ms: Date.now() - t0, rejects };
    }
    let hit = false;
    try {
      hit = await ev(
        p,
        `(() => { const b = [...document.querySelectorAll('button, input[type="submit"]')].find((e) =>
          /Reject all|Từ chối tất cả/i.test((e.textContent || "") + (e.getAttribute("aria-label") || "") + (e.value || "")));
          if (b) { b.click(); return true; } return false; })()`,
      );
    } catch {}
    if (hit) {
      rejects++;
      console.log(`${label}: consent wall -> clicked "Reject all" (#${rejects})`);
      await sleep(1500);
      continue;
    }
    await sleep(500);
  }
  return { ok: false, bot: false, ms: Date.now() - t0, rejects };
}

// ---------------- results ----------------
let results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail ?? ""}`);
}
let exitCode = 0;
let finished = false;
let summaryTag = "extension-youtube";
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
  console.log(`\nSUMMARY [${summaryTag}]: ${results.length - failed.length}/${results.length} PASS` + (failed.length ? "  FAILED: " + failed.map((f) => f.label).join(" | ") : ""));
  killEdge();
  process.exit(exitCode || (failed.length ? 1 : 0));
}

// ---------------- --lna phase ----------------
// Round 12A: with LocalNetworkAccessChecks ON (no disable flag), the panel's socket to the
// local server is blocked on the public https page. The panel must say so (status names the
// local network check, dataset.lna=1) instead of the bare "Cannot connect" dead end.
// Run: node dev/extension_youtube_smoke.mjs --lna
async function runLna() {
  // launch variants as usual but WITHOUT disabling the LNA feature
  let A = null;
  for (const variant of VARIANTS) {
    try {
      await launch(variant, false);
    } catch (e) {
      console.log(`launch failed (${variant.name}): ${e.message}`);
      killEdge();
      continue;
    }
    A = await newPage("A", YT_URL);
    const settle = await settleOnWatch(A, "A");
    console.log(`variant "${variant.name}" -> watch page ${settle.ok ? "settled" : "NOT settled"} in ${settle.ms} ms`);
    const ms = settle.ok ? await waitFor(() => hasPanel(A), 10000, 200) : null;
    if (settle.ok && ms !== null) break;
    killEdge();
    pages.clear();
    A = null;
  }
  if (!A) {
    check("z1. blocked socket on https -> the panel names the local network check (lna=1)", false, "no launch variant produced the panel");
    exitCode = 1;
    return finish();
  }

  const rr = await (await fetch(SERVER + "/createRoom", { method: "POST" })).json();
  const roomName = String(rr.name || "").replace(/^\//, "");
  const roomUrl = SERVER + "/watch/" + roomName;
  console.log("room:", roomUrl, "(the socket to the local server is expected to be blocked)");

  await ev(
    A,
    PANEL(`
      r.getElementById('room').value = ${JSON.stringify(roomUrl)};
      r.getElementById('name').value = 'Alice';
      r.getElementById('join').click(); return true;`),
  );
  const ms1 = await waitFor(
    async () => (await dset(A, "lna")) === "1" && /local network/i.test(await statusText(A)),
    10000,
    100,
  );
  check(
    "z1. blocked socket on https -> the panel names the local network check (lna=1)",
    ms1 !== null,
    `dataset.lna=${await dset(A, "lna")} status='${await statusText(A)}' after ${ms1 ?? "NEVER"} ms`,
  );

  // z2: no extension-attributed errors besides the blocked-socket noise itself
  const SOCKET_NOISE = /local network|websocket|ERR_BLOCKED|WebSocket connection/i;
  const ext = A.errors.filter((e) => EXT_ERR.test(e) && !SOCKET_NOISE.test(e));
  check(
    "z2. no extension console errors besides the blocked-socket errors",
    ext.length === 0,
    ext.length ? ext.slice(0, 8).join(" ;; ") : `${A.errors.length} raw error(s), all blocked-socket/site noise`,
  );
  finish();
}

// ---------------- --bookmarklet phase ----------------
// Round 13A: the bookmarklet from src/utils/bookmarklet.ts getBookmarklet(serverOrigin,
// roomName) on the same real YouTube watch page, in Edge WITHOUT the extension. YouTube
// serves CSP with an enforced `require-trusted-types-for 'script'` and script-src
// allowlists (https-only hosts + a nonce/'strict-dynamic' policy), so the loader's
// <script src=http://localhost:8080/…> injection is expected to be blocked by design.
// The payload is imported straight from bookmarklet.ts (Node strips its types; the
// InviteModal wiring that ships it is the e2e's bm0 checks — :8080 only serves a build).
// It is run in A and B the same way dev/extension_e2e.mjs bookmarklet mode does
// (Runtime.evaluate of the javascript: body) and asserts the honest outcome — either the
// scripts load and sync works, or the bookmarklet fails VISIBLY (alert naming the site's
// security policy) with no half-loaded state and the exact console reason.
// Run: node dev/extension_youtube_smoke.mjs --bookmarklet
const runBm = (p, BM) => ev(p, BM + "; true");
async function runBmPhase() {
  summaryTag = "bookmarklet-youtube";
  // room first, then the payload with that room's name baked in (like the InviteModal does)
  const rr = await (await fetch(SERVER + "/createRoom", { method: "POST" })).json();
  const roomName = String(rr.name || "").replace(/^\//, "");
  const roomUrl = SERVER + "/watch/" + roomName;
  console.log("room:", roomUrl);
  const BM = getBookmarklet(SERVER, roomName).replace(/^javascript:/, "");
  check("bm1. bookmarklet payload built from src/utils/bookmarklet.ts", BM.startsWith("(function(o,r){") && BM.includes(JSON.stringify(SERVER)) && BM.includes(JSON.stringify(roomName)), `${BM.length} chars; __wpServer=${JSON.stringify(SERVER)} __wpRoom=${JSON.stringify(roomName)}`);

  // launch Edge WITHOUT the extension (LNA checks still disabled — round 12A owns that gate)
  let launched = false;
  for (const variant of VARIANTS) {
    try {
      await launch(variant, true, false);
      launched = true;
      console.log(`launched "${variant.name}" without the extension`);
      break;
    } catch (e) {
      console.log(`launch failed (${variant.name}): ${e.message}`);
      killEdge();
    }
  }
  if (!launched) {
    check("bm2. bookmarklet run on A and B ends in the designed outcome", false, "no launch variant worked");
    exitCode = 1;
    return finish();
  }

  // A and B on the watch page (no extension: the bookmarklet is the only loader)
  const tab = {};
  for (const tag of ["A", "B"]) {
    const p = await newPage(tag, YT_URL);
    const settle = await settleOnWatch(p, tag);
    console.log(`${tag} settled=${settle.ok} in ${settle.ms} ms (rejects=${settle.rejects}${settle.bot ? ", BOT-WALL TEXT PRESENT" : ""})`);
    tab[tag] = settle.ok ? p : null;
  }
  if (!tab.A || !tab.B) {
    check("bm2. bookmarklet run on A and B ends in the designed outcome", false, "YouTube never settled the watch page in one of the tabs");
    exitCode = 1;
    return finish();
  }

  // run the bookmarklet in both, exactly like the e2e's bookmarklet mode does
  const outcome = {};
  for (const tag of ["A", "B"]) {
    const p = tab[tag];
    let evalErr = null;
    try {
      await runBm(p, BM);
    } catch (e) {
      evalErr = e.message;
    }
    const panelMs = await waitFor(() => hasPanel(p), 8000, 200);
    const globals = await ev(p, `(() => ({ ext: window.__wpExt ?? null, server: window.__wpServer ?? null, io: typeof window.io, extScripts: Array.from(document.scripts).filter((s) => /\\/extension\\//.test(s.src || "")).length }))()`);
    outcome[tag] = { evalErr, panel: panelMs !== null, globals };
    console.log(`${tag}: evalErr=${JSON.stringify(evalErr)} panel=${panelMs !== null} globals=${JSON.stringify(globals)}`);
  }

  // measured round 13A: youtube.com enforces require-trusted-types-for 'script' and serves
  // https-only script-src allowlists ('strict-dynamic'), so the loader's <script src=
  // http://localhost:8080/…> injection is blocked by design — Trusted Types throws on the
  // first s.src assignment, and even a TrustedScriptURL policy could not pass the script-src
  // check. The designed outcome to assert: NO working sync, the failure is VISIBLE (the
  // fixed security-policy alert), nothing half-loaded, and the console names the reason.
  check("bm2. the bookmarklet does not produce a panel on YouTube (no sync can start)", !outcome.A.panel && !outcome.B.panel, `panel A=${outcome.A.panel} B=${outcome.B.panel}`);
  const MSG = /WatchParty Sync can't load on this site \(its security policy blocks scripts\)/i;
  check(
    "bm3. the failure is visible: the loader alerts the fixed security-policy message in both tabs",
    tab.A.dialogs.some((m) => MSG.test(m || "")) && tab.B.dialogs.some((m) => MSG.test(m || "")),
    `dialogs A=${JSON.stringify(tab.A.dialogs)} B=${JSON.stringify(tab.B.dialogs)}`,
  );
  check(
    "bm4. no half-loaded state: no /extension/ script element or global survived in either tab",
    outcome.A.globals.ext === null && outcome.A.globals.extScripts === 0 && outcome.B.globals.ext === null && outcome.B.globals.extScripts === 0,
    `globals A=${JSON.stringify(outcome.A.globals)} B=${JSON.stringify(outcome.B.globals)}`,
  );
  check(
    "bm5. the console names the exact reason (TrustedScriptURL required, action blocked)",
    tab.A.errors.some((e) => /TrustedScriptURL/i.test(e)) && tab.B.errors.some((e) => /TrustedScriptURL/i.test(e)),
    `A: ${tab.A.errors.slice(0, 2).join(" ;; ") || "(no errors)"} | B: ${tab.B.errors.slice(0, 2).join(" ;; ") || "(no errors)"}`,
  );
  finish();
}

// ---------------- main ----------------
async function main() {
  if (process.argv.includes("--lna")) return runLna();
  if (process.argv.includes("--bookmarklet")) return runBmPhase();
  // 0. launch, find a variant where the extension loads on YouTube
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
    A = await newPage("A", YT_URL);
    const settle = await settleOnWatch(A, "A");
    console.log(`variant "${variant.name}" -> watch page ${settle.ok ? "settled" : "NOT settled"} in ${settle.ms} ms (rejects=${settle.rejects}${settle.bot ? ", BOT-WALL TEXT PRESENT" : ""})`);
    const ms = settle.ok ? await waitFor(() => hasPanel(A), 10000, 200) : null;
    if (settle.ok && ms !== null) {
      used = variant;
      break;
    }
    killEdge();
    pages.clear();
  }
  if (!used) {
    check("0. extension loaded on YouTube (panel present)", false, "no launch variant produced the panel; YouTube may be walling playback");
    exitCode = 1;
    return finish();
  }
  console.log("browser:", browserVer, "| working flags:", used.name);
  check("0. extension loaded on YouTube (panel present)", true, "");
  check("0b. page.js (MAIN world) loaded", await ev(A, `window.__wpExtPage === true`));

  // 1. tab B on the same watch page, then room creation through the server API
  const B = await newPage("B", YT_URL);
  const settleB = await settleOnWatch(B, "B");
  console.log(`B settled=${settleB.ok} in ${settleB.ms} ms (rejects=${settleB.rejects}${settleB.bot ? ", BOT-WALL TEXT PRESENT" : ""})`);
  const bPanel = settleB.ok ? await waitFor(() => hasPanel(B), 10000, 200) : null;
  if (bPanel === null) {
    check("1. tab B on the watch page with the panel", false, "B never got the panel");
    exitCode = 1;
    return finish();
  }
  check("1. tab B on the watch page with the panel", true, "");

  const rr = await (await fetch(SERVER + "/createRoom", { method: "POST" })).json();
  const roomName = String(rr.name || "").replace(/^\//, "");
  const roomUrl = SERVER + "/watch/" + roomName;
  console.log("room:", roomUrl);

  // 2. land both tabs on the player, mute, siteUrl collector
  for (const [tag, p] of [["A", A], ["B", B]]) {
    const vms = await waitFor(() => ev(p, `${MAINV} && ${MAINV}.readyState >= 1`), 25000, 200);
    await muteAll(p);
    console.log(`collector ${tag}:`, await collectSiteUrls(p), `| main video ready after ${vms ?? "NEVER"} ms`);
    if (vms === null) {
      const bot = await ev(p, `/not a bot|không phải là robot|Sign in to confirm|Đăng nhập để xác nhận/i.test(${BODY_TXT})`);
      if (bot) {
        check("2. main player video present on " + tag, false, "SIGN-IN WALL BLOCKING PLAYBACK ('sign in to confirm you are not a bot') — stopping as instructed, nothing was signed in");
        exitCode = 1;
        return finish();
      }
    }
    check("2. main player video present on " + tag, vms !== null, vms === null ? "no #movie_player video within 25 s" : "");
  }

  // 3. join the same fresh room in both panels
  const ja = await joinRoom(A, roomUrl, "Alice");
  const jb = await joinRoom(B, roomUrl, "Bob");
  check("3. A (Alice) joined", ja !== null, `${ja ?? "never"} ms; room='${await dset(A, "room")}'`);
  check("3b. B (Bob) joined", jb !== null, `${jb ?? "never"} ms; synced=${await dset(B, "synced")}`);

  // ad sampler: polls both tabs while the sync checks run (y6)
  let stopAds = false;
  const ADQ = `!!document.querySelector('#movie_player.ad-showing, .html5-video-player.ad-showing')`;
  const ad = { A: null, B: null, statusA: "", statusB: "", emA0: null, emA1: null, emB0: null, emB1: null };
  const adLoop = (async () => {
    while (!stopAds) {
      for (const [tag, p] of [["A", A], ["B", B]]) {
        try {
          const on = await ev(p, ADQ);
          if (on && !ad[tag]) {
            ad[tag] = Date.now();
            ad["status" + tag] = await statusText(p);
            ad["em" + tag + "0"] = await emits(p);
          } else if (!on && ad[tag] && ad["em" + tag + "0"] && !ad["em" + tag + "1"]) {
            ad["em" + tag + "1"] = await emits(p);
          }
        } catch {}
      }
      await sleep(1000);
    }
  })();

  await sleep(5000); // let the site-reset window (3 s) and the initial sync settle
  await muteAll(A);
  await muteAll(B);

  // warmup: both must be playing before y2's pause means anything
  await ev(A, `${MAINV}.play().catch(() => {}); true`);
  const wa = await waitFor(async () => (await vstate(A))?.paused === false, 4000, 100);
  const wb = await waitFor(async () => (await vstate(B))?.paused === false, 4000, 100);
  console.log(`warmup: A playing=${wa !== null} B playing=${wb !== null} (A ${JSON.stringify(await vstate(A))} | B ${JSON.stringify(await vstate(B))})`);

  // y1: connected + content.js picked the main player video, not a preview.
  // Discriminator: set the MAIN video's rate on A from the page world. If content.js
  // bound that element, its ratechange fires -> CMD:playbackRate -> B applies 1.1 to
  // ITS main video. If it bound a preview, neither moves.
  const stA = await dset(A, "status");
  const stB = await dset(B, "status");
  check("y1a. both panels connected", stA === "on" && stB === "on", `A status=${stA} conn=${await dset(A, "conn")} | B status=${stB} conn=${await dset(B, "conn")}`);
  const mainOnA = await ev(A, `!!document.querySelector('#movie_player video')`);
  await ev(A, `${MAINV}.playbackRate = 1.1; true`);
  const sawA = await waitFor(async () => Math.abs(Number(await dset(A, "rate")) - 1.1) < 0.05, 3000, 150);
  const sawB = await waitFor(async () => Math.abs((await vstate(B))?.r - 1.1) < 0.05, 3000, 150);
  check(
    "y1b. content.js picked the main player video (#movie_player video), not a preview",
    mainOnA && sawA !== null && sawB !== null,
    `#movie_player video exists=${mainOnA}; A dataset.rate mirrored 1.1 after ${sawA ?? "NEVER"} ms; B's main video rate hit 1.1 after ${sawB ?? "NEVER"} ms`,
  );
  await clickRate(A, "1"); // restore the room to 1x before the next checks
  const back = await waitFor(async () => Math.abs((await vstate(B))?.r - 1) < 0.05, 3000, 100);
  console.log(`restore 1x: ${back !== null ? "ok" : "FAILED"} (B rate now ${(await vstate(B))?.r})`);

  // y2: A pauses -> B pauses within 2 s
  if (wb === null) console.log("NOTE: warmup did not get B playing, y2 may pass trivially (B already paused)");
  const t2 = Date.now();
  const pa0 = await vstate(A);
  await ev(A, `${MAINV}.pause(); true`);
  const b2 = await waitFor(async () => (await vstate(B))?.paused === true, 2000, 60);
  check("y2. A pauses -> B pauses within 2 s", b2 !== null, `A was ${JSON.stringify(pa0)}; B paused after ${b2 ?? "NEVER"} ms`);

  // y3: A seeks to 120 -> B within ±1.5 s of 120 within 3 s
  await ev(A, `${MAINV}.currentTime = 120; true`);
  const b3 = await waitFor(async () => Math.abs((await vstate(B))?.t - 120) <= 1.5, 3000, 80);
  check("y3. A seeks to 120 -> B within ±1.5 s of 120 within 3 s", b3 !== null, `B t=${(await vstate(B))?.t} after ${b3 ?? "NEVER"} ms`);

  // y4: A clicks the panel's 1.5x -> B at 1.5 within 2 s and stays 1.5 for 5 s
  const c4 = await clickRate(A, "1.5");
  const b4 = await waitFor(async () => Math.abs((await vstate(B))?.r - 1.5) < 0.05, 2000, 60);
  let stable = b4 !== null;
  const samples = [];
  if (stable) {
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const s = await vstate(B);
      samples.push(s?.r);
      if (Math.abs((s?.r ?? 0) - 1.5) >= 0.05) stable = false;
    }
  }
  check("y4. A clicks 1.5x -> B at 1.5 within 2 s and stays 1.5 for 5 s", c4 && stable, `clicked=${c4}; B hit 1.5 after ${b4 ?? "NEVER"} ms; B rates over 5 s: ${samples.join(",")} (A rate now ${(await vstate(A))?.r})`);

  // y5: A plays -> B plays within 2 s; after 10 s of playing |A - B| < 1 s
  await ev(A, `${MAINV}.play().catch(() => {}); true`);
  const b5 = await waitFor(async () => (await vstate(B))?.paused === false, 2000, 60);
  let diff = null;
  const diffs = [];
  if (b5 !== null) {
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const sa = await vstate(A);
      const sb = await vstate(B);
      if (sa && sb && !sb.paused) diffs.push(Math.round(Math.abs(sa.t - sb.t) * 100) / 100);
    }
    diff = diffs[diffs.length - 1];
  }
  check("y5. A plays -> B plays within 2 s; after 10 s |A - B| < 1 s", b5 !== null && diff !== null && diff < 1, `B playing after ${b5 ?? "NEVER"} ms; |A-B| samples: ${diffs.join(",")} (rate ${(await vstate(B))?.r})`);

  await clickRate(A, "1"); // cleanup: leave the room at 1x
  stopAds = true;
  await adLoop;
  console.log(`final states: A ${JSON.stringify(await vstate(A))} | B ${JSON.stringify(await vstate(B))}`);

  // y6: ad report
  const sawAd = ad.A || ad.B;
  if (!sawAd) {
    check("y6. ad guard: no ad showed on either tab during the run", true, "no #movie_player.ad-showing observed (Big Buck Bunny on the Blender channel is unmonetised)");
  } else {
    const parts = [];
    let ok = true;
    for (const tag of ["A", "B"]) {
      if (!ad[tag]) continue;
      const emEnd = ad["em" + tag + "1"] || (await emits(tag === "A" ? A : B));
      const keys = ["CMD:play", "CMD:pause", "CMD:seek", "CMD:playbackRate", "CMD:ts", "CMD:buffering"];
      const delta = {};
      for (const k of keys) {
        const n = (emEnd[k] || 0) - (ad["em" + tag + "0"][k] || 0);
        if (n) delta[k] = n;
      }
      const handled = /Ad playing/i.test(ad["status" + tag]) && Object.keys(delta).length === 0;
      if (!handled) ok = false;
      parts.push(`${tag}: status='${ad["status" + tag]}' emit delta=${JSON.stringify(delta)}`);
    }
    check("y6. ad guard: while an ad showed the status said Ad playing and playback emits stopped", ok, parts.join(" ;; "));
  }

  // y7: canonical url posted by page.js
  const y7 = {};
  for (const [tag, p] of [["A", A], ["B", B]]) {
    const urls = (await ev(p, `window.__wpUrls || []`)) || [];
    const canonNow = await ev(p, `window.__wpExtPageCanon ? window.__wpExtPageCanon(location.href) : null`);
    y7[tag] = { last: urls[urls.length - 1] || null, n: urls.length, canonNow };
  }
  check(
    "y7. page.js posted the canonical url https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    y7.A.last === CANON && y7.B.last === CANON && y7.A.canonNow === CANON && y7.B.canonNow === CANON,
    JSON.stringify(y7),
  );

  // y8: console errors from the extension vs YouTube's own
  for (const [tag, p] of [["A", A], ["B", B]]) {
    const ext = p.errors.filter((e) => EXT_ERR.test(e));
    const yt = p.errors.filter((e) => !EXT_ERR.test(e));
    check(`y8. no console errors from the extension on ${tag}`, ext.length === 0, ext.length ? ext.slice(0, 8).join(" ;; ") : "0 extension errors");
    console.log(`${tag}: ${yt.length} youtube/tab errors` + (yt.length ? " (examples: " + yt.slice(0, 5).join(" ;; ").slice(0, 600) + "…)" : "") + (p.dialogs.length ? ` | dialogs seen: ${JSON.stringify(p.dialogs)}` : ""));
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
