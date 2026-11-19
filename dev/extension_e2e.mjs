// e2e for extension/ (MV3 extension + bookmarklet): drives Edge over raw CDP, no npm deps. Node 24.
// Needs the server on :8080 (npm run dev) and Vite on :5173 (npm run ui). Run: node dev/extension_e2e.mjs
// EDGE=<path to msedge/chrome> overrides the browser.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const EXT = path.resolve(import.meta.dirname, "../extension");
const VITE = "http://localhost:5173";
const TEST_URL = VITE + "/dev/extension_test.html";
const SERVER_ORIGIN = "http://localhost:8080";
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
// launch variants tried in order until the extension's panel shows up
const VARIANTS = [
  { name: "headless=new + --load-extension", extra: ["--headless=new"] },
  {
    name: "headless=new + --load-extension + --disable-features=DisableLoadExtensionCommandLineSwitch",
    extra: ["--headless=new", "--disable-features=DisableLoadExtensionCommandLineSwitch"],
  },
  { name: "headed + --load-extension", extra: [] },
  {
    name: "headed + --load-extension + --disable-features=DisableLoadExtensionCommandLineSwitch",
    extra: ["--disable-features=DisableLoadExtensionCommandLineSwitch"],
  },
];

// ---------------- CDP ----------------
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

let MODE = "extension"; // "extension" | "bookmarklet"
async function launch(variant) {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "wpext-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const args = [
    `--user-data-dir=${userDir}`,
    `--remote-debugging-port=${port}`,
    ...(MODE === "extension" ? [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`] : ["--disable-extensions"]),
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
    else if (p.type === "warning") page.warnings.push(text);
  } else if (msg.method === "Log.entryAdded") {
    if (p.entry.level === "error") page.errors.push(`log.error: ${p.entry.text} ${p.entry.url || ""}`);
  } else if (msg.method === "Runtime.executionContextCreated") {
    const c = p.context;
    page.contexts.push(`${c.name}|${c.auxData?.type}|${c.origin}`);
    page.ctxById.set(c.id, c);
  } else if (msg.method === "Page.javascriptDialogOpening") {
    // confirm() from the panel (isolated world in extension mode, page world in
    // bookmarklet mode) opens a real dialog and blocks its renderer until answered
    page.lastDialog = p.message;
    browser.send("Page.handleJavaScriptDialog", { accept: true }, msg.sessionId).catch(() => {});
  }
}

async function newPage(label, url = "about:blank") {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const page = { label, targetId, sessionId, errors: [], warnings: [], contexts: [], ctxById: new Map() };
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

// eval in the world content.js runs in: the extension's isolated world, or the page's
// own world for the bookmarklet (no isolated context exists there)
async function isolatedEval(p, expression) {
  const ctx = [...p.ctxById.values()].find((c) => c.auxData && c.auxData.type === "isolated");
  const r = await p.s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(ctx ? { contextId: ctx.id } : {}) });
  if (r.exceptionDetails) throw new Error("isolated eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
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

// ---------------- panel / video helpers (the panel is an open shadow root) ----------------
const PANEL = (body) =>
  `(() => { const h = document.getElementById('wpx-host'); if (!h) return null; const r = h.shadowRoot; ${body} })()`;
const hasPanel = (p) => ev(p, `!!document.getElementById('wpx-host')`);
const vstate = (p) =>
  ev(p, `(() => { const v = document.querySelector('video'); return v ? { paused: v.paused, t: v.currentTime, r: v.playbackRate } : null; })()`);
const emits = (p) => ev(p, PANEL(`return JSON.parse(h.dataset.emits || '{}');`));
const logText = (p) => ev(p, PANEL(`return r.getElementById('log').textContent;`));
const sysLines = (p) => ev(p, PANEL(`return r.querySelectorAll('#log .sys').length;`));
// round 5A: HH:MM chat-stamp helpers (minute-of-day, wraparound-safe ±slack)
const hhmmOf = (s) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const nearNow = (got, slack = 1) => {
  if (got === null) return false;
  const d = new Date();
  const diff = Math.abs(got - (d.getHours() * 60 + d.getMinutes()));
  return Math.min(diff, 1440 - diff) <= slack;
};
const nowHHMM = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

let BM = null; // bookmarklet code (javascript: prefix stripped), bookmarklet mode only
const runBookmarklet = (p) => ev(p, BM + "; true");
// bookmarklet mode: the room field must already hold the room (prefilled from __wpRoom), do not type it
async function joinRoom(p, roomUrl, name) {
  await ev(
    p,
    PANEL(`
      ${MODE === "extension" ? `r.getElementById('room').value = ${JSON.stringify(roomUrl)};` : ""}
      r.getElementById('name').value = ${JSON.stringify(name)};
      r.getElementById('join').click(); return true;`),
  );
  const ms = await waitFor(() => ev(p, PANEL(`return h.dataset.status === 'on' && !!h.dataset.synced;`)), 8000);
  return ms;
}

// ---------------- results ----------------
let results = [];
function check(label, ok, detail) {
  label = `[${MODE}] ${label}`;
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail ?? ""}`);
}
const nonTs = (before, after) => {
  const d = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === "CMD:ts") continue;
    const n = (after[k] || 0) - (before[k] || 0);
    if (n) d[k] = n;
  }
  return d;
};

// ---------------- main ----------------
async function main() {
  // 0. launch, find a variant where the extension loads
  let used = null;
  let browserVer;
  let A;
  if (MODE === "extension") {
    for (const variant of VARIANTS) {
      try {
        browserVer = await launch(variant);
      } catch (e) {
        console.log(`launch failed (${variant.name}): ${e.message}`);
        killEdge();
        continue;
      }
      A = await newPage("A", TEST_URL);
      const ms = await waitFor(() => hasPanel(A), 8000, 200);
      console.log(`variant "${variant.name}" -> extension panel ${ms === null ? "NOT found" : "found after " + ms + " ms"}`);
      if (ms !== null) {
        used = variant;
        break;
      }
      killEdge();
      pages.clear();
    }
    if (!used) {
      console.log("FAIL  extension never loaded in any launch variant");
      process.exitCode = 1;
      return;
    }
    console.log("browser:", browserVer, "| working flags:", used.name);
    check("0. extension loaded (panel present)", true, `contexts on A: ${[...new Set(A.contexts)].join(" ; ")}`);
    check("0b. page.js (MAIN world) loaded", await ev(A, `window.__wpExtPage === true`));
  } else {
    used = { name: "headless=new, --disable-extensions" };
    browserVer = await launch({ extra: ["--headless=new"] });
    console.log("browser:", browserVer, "| flags:", used.name);
  }

  // 1. create a room by clicking "New Room" on the home page; this tab then acts as the web room
  const W = await newPage("web", VITE + "/");
  const homeMs = await waitFor(
    () => ev(W, `!!Array.from(document.querySelectorAll('button')).find(b => /New Room/.test(b.textContent))`),
    15000,
    200,
  );
  if (homeMs === null) throw new Error("home page has no New Room button");
  await ev(W, `Array.from(document.querySelectorAll('button')).find(b => /New Room/.test(b.textContent)).click(); true`);
  const roomMs = await waitFor(() => ev(W, `location.pathname.startsWith('/watch/')`), 15000, 200);
  if (roomMs === null) throw new Error("room not created");
  const roomUrl = await ev(W, `location.href`);
  const roomName = roomUrl.split("/watch/")[1];
  console.log("room:", roomUrl);
  await waitFor(() => ev(W, `document.readyState === 'complete'`), 5000);
  await sleep(1500);

  // bookmarklet mode: read the link from the real InviteModal, then run it in A and B
  if (MODE === "bookmarklet") {
    await ev(W, `document.querySelector('button[aria-label="Invite friends"]').click(); true`);
    const lm = await waitFor(() => ev(W, `!!Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'WatchParty Sync')`), 8000, 200);
    const href = await ev(W, `(Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'WatchParty Sync') || {}).getAttribute?.('href') || ''`);
    const text = await ev(W, `document.querySelector('[role=dialog]')?.innerText || ''`);
    check("bm0a. InviteModal shows the 'WatchParty Sync' link with a javascript: href", lm !== null && href.startsWith("javascript:"), `href length ${href.length} chars; modal text: ${JSON.stringify(text.slice(text.indexOf("Watch Netflix")))}`);
    console.log("   bookmarklet href:", href);
    // clicking it inside WatchParty must do nothing: no navigation, no bookmarklet
    // payload injected (the payload's scripts all come from <server>/extension/ —
    // counting those, not every <script>: the Vite dev app lazy-loads chunks and
    // once measured one landed inside this window and broke the count)
    const extScripts = `(Array.from(document.scripts).filter((s) => /\\/extension\\//.test(s.src || '')).length)`;
    const before = await ev(W, `location.href + '|' + ${extScripts} + '|' + (typeof window.__wpExt)`);
    const total0 = await ev(W, `document.scripts.length`);
    await ev(W, `Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'WatchParty Sync').click(); true`);
    await sleep(700);
    const after = await ev(W, `location.href + '|' + ${extScripts} + '|' + (typeof window.__wpExt) + '|' + (window.__wpServer === undefined)`);
    const total1 = await ev(W, `document.scripts.length`);
    check("bm0b. clicking the link inside the room page does nothing (url, no /extension/ <script>, no globals)", after === before + "|true", `before=${before} after=${after}; total <script> count ${total0} -> ${total1} (vite chunks excluded)`);
    BM = decodeURIComponent(href.replace(/^javascript:/, ""));
    await ev(W, `document.querySelector('button[aria-label="Close"]')?.click(); true`);
  }
  const startPanel = async (p) => {
    if (MODE === "bookmarklet") {
      await waitFor(() => ev(p, `document.readyState === 'complete'`), 8000);
      await runBookmarklet(p);
    }
    return waitFor(() => hasPanel(p), 8000, 200);
  };
  if (MODE === "bookmarklet") {
    A = await newPage("A", TEST_URL);
    const ams = await startPanel(A);
    check("0. bookmarklet ran in A (panel present)", ams !== null, `after ${ams} ms; window.io is ${await ev(A, `typeof window.io`)}`);
    check("0b. page.js (MAIN world) loaded + content.js guard set", await ev(A, `window.__wpExtPage === true && window.__wpExt === true && typeof window.__wpExtShow === 'function'`));
  }

  // 2. tabs A and B join through the panel
  const B = await newPage("B", TEST_URL);
  await startPanel(B);
  if (MODE === "bookmarklet") {
    const roomA = await ev(A, PANEL(`return r.getElementById('room').value;`));
    const roomB = await ev(B, PANEL(`return r.getElementById('room').value;`));
    const keys = await ev(A, `Object.keys(localStorage).join(',')`);
    check("bm2a. room field prefilled from __wpRoom in A and B (not auto-joined)", roomA === roomName && roomB === roomName && (await ev(A, PANEL(`return h.dataset.status || 'idle';`))) === "idle", `A='${roomA}' B='${roomB}' room='${roomName}'; status A=${await ev(A, PANEL(`return h.dataset.status || 'idle';`))}; localStorage keys before join: [${keys}]`);
  }
  console.log("A joined in", await joinRoom(A, roomUrl, "Alice"), "ms; synced =", await ev(A, PANEL(`return h.dataset.synced;`)));
  console.log("B joined in", await joinRoom(B, roomUrl, "Bob"), "ms; synced =", await ev(B, PANEL(`return h.dataset.synced;`)));
  await waitFor(() => vstate(A).then((s) => s && true), 5000);
  await sleep(1500);
  {
    const sa = await vstate(A), sb = await vstate(B);
    const synB = await ev(B, PANEL(`return h.dataset.synced;`));
    check("2. B joining right after A (A paused at 0) does not start playback", sa.paused && sb.paused && sb.t < 0.5, `B synced=${synB}; A ${JSON.stringify(sa)} B ${JSON.stringify(sb)}`);
  }

  if (MODE === "bookmarklet") {
    // running it a second time: collapse the panel first, the 2nd click must expand it, still one host, still connected
    await ev(A, PANEL(`r.getElementById('toggle').click(); return true;`));
    const collapsedBefore = await ev(A, PANEL(`return r.getElementById('panel').classList.contains('collapsed');`));
    const scriptsBefore = await ev(A, `document.scripts.length`);
    await runBookmarklet(A);
    await sleep(800);
    const hosts = await ev(A, `document.querySelectorAll('#wpx-host').length`);
    const collapsedAfter = await ev(A, PANEL(`return r.getElementById('panel').classList.contains('collapsed');`));
    const scriptsAfter = await ev(A, `document.scripts.length`);
    const st = await ev(A, PANEL(`return h.dataset.status;`));
    check("bm2b. running the bookmarklet again in the same tab: exactly one #wpx-host, panel re-expanded, no extra <script>, still connected", hosts === 1 && collapsedBefore === true && collapsedAfter === false && scriptsAfter === scriptsBefore && st === "on", `hosts=${hosts} collapsed ${collapsedBefore}->${collapsedAfter} <script> count ${scriptsBefore}->${scriptsAfter} status=${st}`);
    const ls = await ev(A, `JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('wpx:')).map(k => [k, localStorage.getItem(k)])))`);
    check("bm2c. room/name persisted in localStorage under wpx: keys", ls.includes('"wpx:room"') && ls.includes('"wpx:name"') && ls.includes(roomName) && /Alice|Bob/.test(ls), ls + " (A and B share one origin, so the last joiner's name wins)");
  }

  // a. play
  await ev(A, `document.querySelector('video').play().then(() => true)`);
  let ms = await waitFor(async () => (await vstate(B)).paused === false, 2000);
  check("a. A plays -> B playing within 2 s", ms !== null, `B playing after ${ms} ms; B state ${JSON.stringify(await vstate(B))}`);

  // b. pause
  await sleep(1200);
  await ev(A, `document.querySelector('video').pause(); true`);
  ms = await waitFor(async () => (await vstate(B)).paused === true, 2000);
  check("b. A pauses -> B paused", ms !== null, `B paused after ${ms} ms; A ${JSON.stringify(await vstate(A))} B ${JSON.stringify(await vstate(B))}`);

  // c. seek
  await sleep(700);
  await ev(A, `document.querySelector('video').currentTime = 30; true`);
  ms = await waitFor(async () => Math.abs((await vstate(B)).t - 30) < 1, 3000);
  const bt = (await vstate(B)).t;
  check("c. A seeks to 30 s -> B within 1 s of 30", ms !== null, `B currentTime=${bt.toFixed(2)} after ${ms} ms`);

  // d. speed, both directions
  await sleep(800);
  await ev(A, PANEL(`r.querySelector('#rates button[data-rate="1.5"]').click(); return true;`));
  ms = await waitFor(async () => (await vstate(B)).r === 1.5, 2000);
  const hl = await ev(A, PANEL(`return r.querySelector('#rates button.active')?.dataset.rate;`));
  check("d1. A clicks 1.5x -> B playbackRate === 1.5", ms !== null, `B rate=${(await vstate(B)).r} after ${ms} ms; A highlighted button=${hl}`);
  await sleep(1200);
  await ev(B, `document.querySelector('video').playbackRate = 0.75; true`);
  ms = await waitFor(async () => (await vstate(A)).r === 0.75, 2000);
  const hlA = await ev(A, PANEL(`return r.querySelector('#rates button.active')?.dataset.rate;`));
  check("d2. B sets playbackRate 0.75 (not via panel) -> A === 0.75", ms !== null, `A rate=${(await vstate(A)).r} after ${ms} ms; A highlighted=${hlA}`);

  // e. chat
  await sleep(500);
  await ev(
    A,
    PANEL(`const i = r.getElementById('chatinput'); i.value = 'hello from A';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })); return true;`),
  );
  const inB = await waitFor(async () => (await logText(B)).includes("Alice: hello from A"), 3000);
  const inWeb = await waitFor(async () => ev(W, `document.body.textContent.includes('hello from A')`), 5000);
  check("e1. chat 'hello from A' appears in B's panel as 'Alice: ...'", inB !== null, `after ${inB} ms`);
  check("e2. chat appears in the WatchParty web room tab", inWeb !== null, `after ${inWeb} ms`);
  console.log("   B panel log:\n   " + (await ev(B, PANEL(`return Array.from(r.querySelectorAll('#log div')).map(d => d.textContent).join('\\n   ');`))));

  // p1a (round 5A): the room chat line from A carries a HH:MM stamp within ±1 min of the local clock
  {
    const line = await ev(B, PANEL(`return Array.from(r.querySelectorAll('#log div')).map((d) => d.textContent).find((t) => t.includes('Alice: hello from A')) || '';`));
    check(
      "p1a. Alice's chat line in B starts with a HH:MM stamp within ±1 min of the local clock",
      nearNow(hhmmOf(line)),
      `line='${line}' now=${nowHHMM()}`,
    );
  }

  // f. idle windows
  await sleep(1500);
  let a0 = await emits(A), b0 = await emits(B);
  let sa0 = await sysLines(A), sb0 = await sysLines(B);
  await sleep(5000);
  let a1 = await emits(A), b1 = await emits(B);
  let sa1 = await sysLines(A), sb1 = await sysLines(B);
  const da = nonTs(a0, a1), db = nonTs(b0, b1);
  const tsA = (a1["CMD:ts"] || 0) - (a0["CMD:ts"] || 0), tsB = (b1["CMD:ts"] || 0) - (b0["CMD:ts"] || 0);
  check(
    "f1. paused idle 5 s: 0 CMD emits besides CMD:ts, no new system chat lines",
    !Object.keys(da).length && !Object.keys(db).length && sa1 === sa0 && sb1 === sb0,
    `A non-ts=${JSON.stringify(da)} B non-ts=${JSON.stringify(db)} ts A=${tsA} B=${tsB}; sys lines A ${sa0}->${sa1} B ${sb0}->${sb1}`,
  );

  // f2. same while playing (ping-pong would show here)
  await ev(A, `document.querySelector('video').play().then(() => true)`);
  await waitFor(async () => (await vstate(B)).paused === false, 2000);
  await sleep(1800);
  a0 = await emits(A); b0 = await emits(B); sa0 = await sysLines(A); sb0 = await sysLines(B);
  await sleep(5000);
  a1 = await emits(A); b1 = await emits(B); sa1 = await sysLines(A); sb1 = await sysLines(B);
  const da2 = nonTs(a0, a1), db2 = nonTs(b0, b1);
  const sA = await vstate(A), sB = await vstate(B);
  check(
    "f2. playing idle 5 s: 0 CMD emits besides CMD:ts, no new system chat lines",
    !Object.keys(da2).length && !Object.keys(db2).length && sa1 === sa0 && sb1 === sb0,
    `A non-ts=${JSON.stringify(da2)} B non-ts=${JSON.stringify(db2)}; sys lines A ${sa0}->${sa1} B ${sb0}->${sb1}; A t=${sA.t.toFixed(2)} B t=${sB.t.toFixed(2)} (playing both: ${!sA.paused && !sB.paused})`,
  );

  // back to "A paused at 30 s, rate 0.75"
  await ev(A, `document.querySelector('video').pause(); true`);
  await waitFor(async () => (await vstate(B)).paused === true, 2000);
  await sleep(800);
  await ev(A, `document.querySelector('video').currentTime = 30; true`);
  await waitFor(async () => Math.abs((await vstate(B)).t - 30) < 1, 3000);
  await sleep(1500);
  console.log("   before g: A", JSON.stringify(await vstate(A)), "B", JSON.stringify(await vstate(B)));

  // g. late joiner
  const C = await newPage("C", TEST_URL);
  await startPanel(C);
  const jms = await joinRoom(C, roomUrl, "Carol");
  const synced = await ev(C, PANEL(`return h.dataset.synced;`));
  ms = await waitFor(async () => {
    const s = await vstate(C);
    return s && Math.abs(s.t - 30) < 1.5 && s.paused && s.r === 0.75;
  }, 6000);
  const cs = await vstate(C);
  check(
    "g. late joiner C lands near 30 s, paused, rate 0.75",
    ms !== null,
    `C ${JSON.stringify(cs)} (joined in ${jms} ms, synced=${synced}, settled after ${ms} ms)`,
  );
  // C must not have disturbed A and B
  await sleep(2000);
  const sA2 = await vstate(A), sB2 = await vstate(B);
  check("g2. A and B undisturbed by the join (paused, ~30 s, 0.75)", sA2.paused && sB2.paused && sA2.r === 0.75 && sB2.r === 0.75 && Math.abs(sA2.t - 30) < 1.5 && Math.abs(sB2.t - 30) < 1.5, `A ${JSON.stringify(sA2)} B ${JSON.stringify(sB2)}`);

  // ---------------- j. member list, buffering wait, reactions ----------------
  // j2a: C joined in step g, so A's log already holds the notice; the member line
  // includes the web room tab's own member too (it is a connected socket)
  {
    const memB = await ev(B, PANEL(`return r.getElementById('members').textContent;`));
    const mMatch = /^(\d+) watching: (.*)$/.exec(memB || "");
    const listed = mMatch ? mMatch[2].split(", ").length : -1;
    const aChat = (await emits(A))["CMD:chat"] || 0;
    const aLog = await logText(A);
    check(
      "j2a. member line 'N watching: names' (includes Alice); 'Carol joined' in A's log; local-only (A's CMD:chat count unchanged)",
      !!mMatch && Number(mMatch[1]) === listed && memB.includes("Alice") && aLog.includes("Carol joined") && aChat === 1,
      `B members='${memB}' (names listed=${listed}); A log has 'Carol joined'=${aLog.includes("Carol joined")}; A CMD:chat=${aChat}`,
    );
  }

  // p2 (round 5A): per-member colours. Alice's .who colour is the same in B's and C's
  // panel (stable across tabs), B's chat names carry no "(you)", and B's members line
  // marks its own name "Bob (you)" in B's own colour (which differs from Alice's).
  {
    const whoOf = (p) =>
      ev(p, PANEL(`const w = r.querySelector('#log .who'); return w ? { color: getComputedStyle(w).color, inline: w.style.color, text: w.textContent } : null;`));
    const bWho = await whoOf(B), cWho = await whoOf(C);
    const memSpans = await ev(B, PANEL(`return Array.from(r.querySelectorAll('#members span')).map((s) => ({ color: getComputedStyle(s).color, text: s.textContent }));`));
    const you = (memSpans || []).find((s) => s.text.includes("(you)"));
    check(
      "p2. Alice's .who colour in B === her colour in C (inline style set); B's members line shows 'Bob (you)'; chat .who has no '(you)' suffix",
      bWho && cWho && bWho.inline && bWho.text === "Alice" && cWho.text === "Alice" && bWho.color === cWho.color
        && you && you.text === "Bob (you)" && !!you.color, // ponytail: random clientIds can share one of ~10 colours, so no !== check
      `B .who=${JSON.stringify(bWho)}; C .who=${JSON.stringify(cWho)}; B member spans=${JSON.stringify(memSpans)}`,
    );
  }

  // j1: a 'waiting' while the room plays reports CMD:buffering true; the server's
  // armBufferPause grace is 2.5 s, so B pauses ~2.6 s after the report (4 s window)
  await ev(A, `document.querySelector('video').play().then(() => true)`);
  ms = await waitFor(async () => (await vstate(B)).paused === false, 2000);
  await sleep(600);
  const j0a = await emits(A);
  await ev(A, `document.querySelector('video').dispatchEvent(new Event('waiting')); true`);
  const jTrueMs = await waitFor(async () => ((await emits(A))["CMD:buffering"] || 0) === (j0a["CMD:buffering"] || 0) + 1, 1500);
  ms = await waitFor(async () => (await vstate(B)).paused === true, 4000);
  check(
    "j1a. A 'waiting' while playing -> CMD:buffering true -> server auto-pauses the room -> B paused",
    jTrueMs !== null && ms !== null,
    `true emitted after ${jTrueMs} ms; B paused after ${ms} ms (2.5 s server grace); A ${JSON.stringify(await vstate(A))}`,
  );
  await ev(A, `document.querySelector('video').dispatchEvent(new Event('playing')); true`);
  const jEmits = await ev(A, PANEL(`return h.dataset.emits;`));
  const jRecover = ((await emits(A))["CMD:buffering"] || 0) === (j0a["CMD:buffering"] || 0) + 2;
  const jIdleA = await emits(A);
  const j0b = await emits(B);
  const s0a = await sysLines(A), s0b = await sysLines(B);
  await sleep(5000);
  const jda = nonTs(jIdleA, await emits(A)), jdb = nonTs(j0b, await emits(B));
  const s1a = await sysLines(A), s1b = await sysLines(B);
  check(
    "j1b. A 'playing' -> CMD:buffering false in the emit counter; 5 s idle after: 0 non-ts emits (no ping-pong), no new notices",
    jRecover && !Object.keys(jda).length && !Object.keys(jdb).length && s1a === s0a && s1b === s0b,
    `A emits=${jEmits}; idle diffs A=${JSON.stringify(jda)} B=${JSON.stringify(jdb)}; sys lines A ${s0a}->${s1a} B ${s0b}->${s1b}`,
  );

  // j2b: C clicks Leave -> 'Carol left' notice in A's log, still local-only
  const cLeft = await ev(C, PANEL(`r.getElementById('join').click(); return true;`));
  ms = await waitFor(async () => (await logText(A)).includes("Carol left"), 4000);
  const aChat2 = (await emits(A))["CMD:chat"] || 0;
  check(
    "j2b. C clicks Leave -> 'Carol left' in A's log; still local-only (A's CMD:chat count unchanged)",
    cLeft && ms !== null && aChat2 === 1,
    `leave clicked=${cLeft}; notice after ${ms} ms; A CMD:chat=${aChat2}; C status='${await ev(C, PANEL(`return h.dataset.status;`))}'`,
  );

  // p1b (round 5A): locally created join/leave lines are stamped with the local clock;
  // 'Carol left' just happened (±1 min), 'Carol joined' only needs the HH:MM shape
  {
    const sys = await ev(A, PANEL(`return Array.from(r.querySelectorAll('#log .sys')).map((d) => d.textContent);`));
    const joinL = sys.find((t) => t.includes("Carol joined")) || "";
    const leftL = sys.find((t) => t.includes("Carol left")) || "";
    check(
      "p1b. local join/leave lines carry a HH:MM stamp; 'Carol left' is within ±1 min of the local clock",
      nearNow(hhmmOf(leftL)) && /^\d{1,2}:\d{2}/.test(joinL),
      `join='${joinL}' left='${leftL}' now=${nowHHMM()}`,
    );
  }

  // j3: reactions. A's panel relays via the server to everyone, so B and the web
  // room tab (floatReactionLayer) must both show the floating emoji
  const r0 = await emits(A);
  await ev(A, PANEL(`r.querySelectorAll('#rx button')[5].click(); return true;`));
  const bFloatMs = await waitFor(async () => (await ev(B, PANEL(`return r.getElementById('floats').textContent;`))).includes("🔥"), 1500);
  const wFloatMs = await waitFor(async () => (await ev(W, `(() => { const l = document.querySelector('[class*="floatReactionLayer"]'); return l ? l.textContent : ''; })()`)).includes("🔥"), 2500);
  const rCount = (await emits(A))["CMD:floatReaction"] || 0;
  check(
    "j3a. A clicks 🔥 -> CMD:floatReaction sent; B shows a floating 🔥; the web room's reaction layer shows it too",
    rCount === (r0["CMD:floatReaction"] || 0) + 1 && bFloatMs !== null && wFloatMs !== null,
    `B float after ${bFloatMs} ms; web floatReactionLayer after ${wFloatMs} ms; A CMD:floatReaction=${rCount}`,
  );
  const goneMs = await waitFor(async () => !(await ev(B, PANEL(`return r.getElementById('floats').textContent;`))).includes("🔥"), 4000, 100);
  check("j3b. B's floating 🔥 is removed after ~2.5 s", goneMs !== null && goneMs > 1200, `removed ${goneMs} ms after detection (animation 2.5 s)`);
  // reverse direction: the web app reacts -> the extension panels show it
  const wClicked = await ev(W, `(() => { const b = document.querySelector('button[aria-label="React 🔥"]'); if (!b) return false; b.click(); return true; })()`);
  const a2Ms = await waitFor(async () => (await ev(A, PANEL(`return r.getElementById('floats').textContent;`))).includes("🔥"), 2500);
  const b2Ms = await waitFor(async () => (await ev(B, PANEL(`return r.getElementById('floats').textContent;`))).includes("🔥"), 2500);
  check(
    "j3c. the web app reacts -> A and B panels show a floating 🔥",
    wClicked && a2Ms !== null && b2Ms !== null,
    `web React button clicked=${wClicked}; A float after ${a2Ms} ms; B float after ${b2Ms} ms`,
  );

  // ---------------- k. round 2B: unread badge, sync-to-me, #wpx deep link ----------------
  const MEDIA = VITE + "/dev/extension_test.webm";
  const inputSel = `input[placeholder^="Enter video file URL"]`;
  const statusOf = (p) => ev(p, PANEL(`return { text: r.getElementById('status').textContent, ds: h.dataset.status };`));
  const sendChat = async (p, text) =>
    ev(p, PANEL(`const i = r.getElementById('chatinput'); i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })); return true;`));

  // k1: unread badge. A collapses; 2 chats + 1 reaction from B -> unread '2' in the header,
  // expand clears it. C has left the room (j2b), W sends no chat.
  {
    await ev(A, PANEL(`r.getElementById('toggle').click(); return true;`));
    const collapsedA = await ev(A, PANEL(`return r.getElementById('panel').classList.contains('collapsed');`));
    const u0 = await ev(A, PANEL(`return h.dataset.unread;`));
    await sendChat(B, "unread one");
    await sleep(400);
    await sendChat(B, "unread two");
    await sleep(300);
    await ev(B, PANEL(`r.querySelectorAll('#rx button')[2].click(); return true;`)); // reaction must not count
    const grewMs = await waitFor(() => ev(A, PANEL(`return h.dataset.unread === '2';`)), 4000);
    const badge = await ev(A, PANEL(`return r.getElementById('unread').textContent;`));
    await ev(A, PANEL(`r.getElementById('toggle').click(); return true;`));
    const u1 = await ev(A, PANEL(`return h.dataset.unread;`));
    const badge1 = await ev(A, PANEL(`return r.getElementById('unread').textContent;`));
    check(
      "k1. collapsed A gets 2 chats + 1 reaction from B -> unread '2' shown in the header; expanding clears to '0' and hides the badge",
      collapsedA && u0 === "0" && grewMs !== null && badge === " • 2" && u1 === "0" && badge1 === "",
      `collapsed=${collapsedA} start='${u0}' reached '2' after ${grewMs} ms, badge='${badge}'; after expand='${u1}' badge='${badge1}'`,
    );
  }

  // k2: "Sync everyone to me". Real drift needs the room-media gate: while the web tab hosts
  // a video the panels' playback emits are blocked, so B can drift to ~12 s playing @1.25
  // while A and C sit paused at 40. After the clear, B's click moves A and C for real.
  {
    const cBack = await joinRoom(C, roomUrl, "Carol"); // C left in j2b
    await ev(A, `document.querySelector('video').pause(); true`);
    await waitFor(async () => (await vstate(B)).paused === true, 2500);
    await sleep(400);
    await ev(A, `document.querySelector('video').currentTime = 40; true`);
    const at40 = await waitFor(
      async () => Math.abs((await vstate(C)).t - 40) < 1.5 && Math.abs((await vstate(B)).t - 40) < 1.5,
      3000,
    );
    // host media through the web UI (same flow as step i)
    await ev(W, `document.querySelector(${JSON.stringify(inputSel)}).focus(); true`);
    await sleep(300);
    await W.s("Input.insertText", { text: MEDIA });
    await sleep(300);
    for (const type of ["keyDown", "keyUp"]) {
      await W.s("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined });
    }
    const busyMs = await waitFor(async () => {
      const a = await statusOf(A), b = await statusOf(B), c = await statusOf(C);
      return a.ds === "err" && b.ds === "err" && c.ds === "err";
    }, 8000);
    // B drifts silently behind the gate: 1.25x playing from 9 s
    await ev(B, `(() => { const v = document.querySelector('video'); v.playbackRate = 1.25; v.currentTime = 9; return v.play().then(() => true); })()`);
    await sleep(500);
    await ev(W, `(() => { const b = document.querySelector('button[aria-label="Clear"]'); if (!b) return false; b.click(); return true; })()`);
    const clearMs = await waitFor(async () => {
      const a = await statusOf(A), b = await statusOf(B), c = await statusOf(C);
      return a.text === `Connected to ${roomName}` && a.ds === "on" && b.text === `Connected to ${roomName}` && c.text === `Connected to ${roomName}`;
    }, 8000);
    // B's gated rate change never reached the room; make the room rate 1.25 through the panel
    await ev(B, PANEL(`r.querySelector('#rates button[data-rate="1.25"]').click(); return true;`));
    const rateMs = await waitFor(async () => (await vstate(A)).r === 1.25 && (await vstate(C)).r === 1.25, 3000);
    const s0 = await emits(B);
    let clickErr = null;
    try {
      await Promise.race([
        ev(B, PANEL(`r.getElementById('synctome').click(); return true;`)),
        sleep(6000).then(() => { throw new Error("confirm() never returned (dialog not handled?)"); }),
      ]);
    } catch (e) {
      clickErr = e.message;
    }
    const landedMs = await waitFor(async () => {
      const a = await vstate(A), c = await vstate(C), b = await vstate(B);
      return a && c && b && !a.paused && !c.paused && a.r === 1.25 && c.r === 1.25
        && Math.abs(a.t - b.t) < 1 && Math.abs(c.t - b.t) < 1;
    }, 6000);
    const dS = nonTs(s0, await emits(B));
    const aFin = await vstate(A), cFin = await vstate(C), bFin = await vstate(B);
    check(
      "k2. B (playing ~12 s @1.25 behind the media gate) clicks Sync-to-me: dialog accepted, only CMD:seek+CMD:play sent, A and C land within 1 s of B playing @1.25",
      at40 !== null && busyMs !== null && clearMs !== null && rateMs !== null && clickErr === null
        && B.lastDialog === "Move everyone to your position?"
        && landedMs !== null && dS["CMD:seek"] === 1 && dS["CMD:play"] === 1 && !dS["CMD:playbackRate"] && !dS["CMD:pause"],
      `C rejoined=${!!cBack}; all at 40 paused=${at40 !== null}; gate on=${busyMs !== null} cleared=${clearMs !== null} room rate 1.25=${rateMs !== null}; dialog='${B.lastDialog}' clickErr=${clickErr || "none"}; B emit diff=${JSON.stringify(dS)}; landed after ${landedMs} ms; A=${JSON.stringify(aFin)} B=${JSON.stringify(bFin)} C=${JSON.stringify(cFin)}`,
    );
  }

  // k3: #wpx=<room> deep link + Copy invite. A new tab opens with the hash; the panel must
  // prefill the room and auto-join on the saved name without the e2e clicking Join.
  {
    // the k2 clear wiped videoTS/tsMap and armed the server's 1 s preventTSUpdate window
    // (which ate B's seek); give the members' 1 s CMD:ts ticks time to refill the room
    // state, so D3 joins as a joiner instead of the "alone" member that imposes its state
    await sleep(2500);
    const D3 = await newPage("deep", TEST_URL + "#wpx=" + roomName);
    if (MODE === "bookmarklet") {
      await waitFor(() => ev(D3, `document.readyState === 'complete'`), 8000);
      await runBookmarklet(D3);
    }
    const panelMs = await waitFor(() => hasPanel(D3), 8000, 200);
    const joinMs = await waitFor(
      () => ev(D3, PANEL(`return h.dataset.status === 'on' && h.dataset.room === ${JSON.stringify(roomName)};`)),
      12000,
      200,
    );
    const fieldVal = await ev(D3, PANEL(`return r.getElementById('room').value;`));
    const syncedD3 = () => ev(D3, PANEL(`return h.dataset.synced || 'NEVER';`));
    const landMs = await waitFor(async () => {
      const s = await vstate(D3), a = await vstate(A);
      return s && a && !s.paused && s.r === 1.25 && Math.abs(s.t - a.t) < 3;
    }, 12000);
    // stub clipboard in the world content.js runs in (isolated for the extension, page for the bookmarklet)
    const stubOk = await isolatedEval(D3, `
      (() => { const hook = (t) => { window.__wpxLink = t; return Promise.resolve(); };
        try { navigator.clipboard.writeText = hook; return "assign"; }
        catch { try { Object.defineProperty(navigator, "clipboard", { value: { writeText: hook }, configurable: true }); return "define"; } catch { return "no"; } } })()`);
    let copyErr = null, link = "", status = "";
    try {
      await ev(D3, PANEL(`r.getElementById('copyinvite').click(); return true;`));
      await sleep(300);
      link = await isolatedEval(D3, `window.__wpxLink || ''`);
      status = await ev(D3, PANEL(`return r.getElementById('status').textContent;`));
    } catch (e) {
      copyErr = e.message;
    }
    const expected = TEST_URL + "#wpx=" + roomName;
    check(
      "k3. #wpx=<room> prefills the room field, auto-joins on the saved name, lands at the room position; Copy invite yields <origin><path>#wpx=<room>",
      panelMs !== null && joinMs !== null && fieldVal === roomName && landMs !== null && copyErr === null && link === expected,
      `panel=${panelMs}ms auto-join=${joinMs}ms field='${fieldVal}' landed=${landMs !== null} synced='${await syncedD3()}' D3=${JSON.stringify(await vstate(D3))} A=${JSON.stringify(await vstate(A))}; clipboard stub=${stubOk} link='${link}' expected='${expected}' status='${status}' copyErr=${copyErr || "none"}`,
    );
  }

  // ---------------- m. round 3B: typing indicator + follow the episode ----------------
  const N111 = "https://www.netflix.com/watch/111";
  const N222 = "https://www.netflix.com/watch/222";
  const N333 = "https://www.netflix.com/watch/333";
  const N999 = "https://www.netflix.com/watch/999";
  const barOf = (p) =>
    ev(p, PANEL(`const f = r.getElementById('follow');
      return { shown: !f.hidden, text: f.textContent, url: h.dataset.follow || '', typing: h.dataset.typing || '' };`));
  const postSite = (p, url) =>
    ev(p, `window.postMessage({ source: "wp-ext-page", type: "siteUrl", url: ${JSON.stringify(url)} }, "*"); true`);
  const typeChar = (p, n) =>
    ev(p, PANEL(`const i = r.getElementById('chatinput'); i.value = 'x'.repeat(${n});
      i.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return true;`));
  const bTypingEmpty = async (p) => !(await ev(p, PANEL(`return h.dataset.typing || '';`)));

  // m1: typing. A types 20 chars over ~3 s: B shows 'Alice is typing…' within 1 s with
  // dataset.typing = A's id; at most one CMD:typing true per 2 s (2 trues + 1 false = 3
  // emits); the indicator clears ~3 s after the last keystroke. A types again and sends:
  // the false rides the send and clears B's line at once.
  {
    const t0 = await emits(A);
    await typeChar(A, 1);
    const showMs = await waitFor(async () => (await ev(B, PANEL(`return r.getElementById('typing').textContent;`))) === "Alice is typing…", 1000);
    const bTyping1 = await ev(B, PANEL(`return h.dataset.typing || '';`));
    await ev(A, `(async () => {
      const i = document.getElementById('wpx-host').shadowRoot.getElementById('chatinput');
      for (let c = 2; c <= 20; c++) {
        i.value = 'x'.repeat(c);
        i.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        await new Promise((res) => setTimeout(res, 150));
      }
      return true; })()`);
    const clearMs = await waitFor(() => bTypingEmpty(B), 5000);
    const t1 = await emits(A);
    const dTyping = (t1["CMD:typing"] || 0) - (t0["CMD:typing"] || 0);
    const t2 = await emits(A);
    await typeChar(A, 1);
    await typeChar(A, 2);
    const show2Ms = await waitFor(async () => (await ev(B, PANEL(`return r.getElementById('typing').textContent;`))) === "Alice is typing…", 1500);
    const bTyping2 = await ev(B, PANEL(`return h.dataset.typing || '';`));
    await sendChat(A, "m1 done typing");
    const clear2Ms = await waitFor(() => bTypingEmpty(B), 1500);
    check(
      "m1. A types -> B shows 'Alice is typing…' within 1 s (dataset.typing = A's id); 20 chars over ~3 s = 2 true + 1 false; clears ~3 s after the last keystroke; typing then sending clears immediately",
      showMs !== null && !!bTyping1 && clearMs !== null && dTyping === 3
        && show2Ms !== null && !!bTyping2 && clear2Ms !== null,
      `shown after ${showMs} ms (typing='${bTyping1}'); emit delta=${dTyping} (2 true + 1 false); cleared after ${clearMs} ms; re-shown after ${show2Ms} ms (typing='${bTyping2}'); cleared after send in ${clear2Ms} ms`,
    );
  }

  // m2: follow bar. A simulated page post emits CMD:siteUrl exactly once; B (whose page
  // posted /watch/222) shows the bar for 111; duplicate post = no re-announce; dismiss;
  // 333 re-shows it; B posting 333 itself hides its own bar.
  {
    const u0a = await emits(A), u0b = await emits(B);
    await postSite(B, N222); // B announces 222; A shows a bar (not asserted)
    await sleep(400);
    const s0a = await emits(A);
    await postSite(A, N111);
    const annMs = await waitFor(async () => ((await emits(A))["CMD:siteUrl"] || 0) === (s0a["CMD:siteUrl"] || 0) + 1, 2000);
    const barShown = await waitFor(async () => { const b = await barOf(B); return b.shown && b.url === N111; }, 2500);
    const barB = barShown !== null ? await barOf(B) : null;
    await postSite(A, N111); // same url again: must not announce
    await sleep(700);
    const aCnt1 = (await emits(A))["CMD:siteUrl"] || 0;
    check(
      "m2a. A's page posts netflix /watch/111 -> A emits CMD:siteUrl once; B shows the Follow bar with dataset.follow=…/watch/111; re-posting the same url does not announce again",
      annMs !== null && barB !== null && aCnt1 === (s0a["CMD:siteUrl"] || 0) + 1,
      `announced after ${annMs} ms; B bar shown=${barB !== null} url='${barB ? barB.url : ""}' text='${barB ? barB.text.replace(N111, "…") : ""}'; A CMD:siteUrl ${s0a["CMD:siteUrl"] || 0} -> ${aCnt1}`,
    );
    await ev(B, PANEL(`r.getElementById('followx').click(); return true;`));
    const dismissed = await barOf(B);
    check("m2b. B dismisses the bar -> hidden, dataset.follow cleared", !dismissed.shown && dismissed.url === "", `bar=${JSON.stringify(dismissed)}`);

    const s1a = await emits(A);
    await postSite(A, N333);
    const barShown333 = await waitFor(async () => { const b = await barOf(B); return b.shown && b.url === N333; }, 2500);
    const bar333 = barShown333 !== null ? await barOf(B) : null;
    check("m2c. A posts /watch/333 -> B's bar shows again with 333", bar333 !== null, `B bar=${JSON.stringify(bar333)}; A CMD:siteUrl ${s1a["CMD:siteUrl"] || 0} -> ${(await emits(A))["CMD:siteUrl"] || 0}`);
    await postSite(B, N333);
    const hiddenMs = await waitFor(async () => { const b = await barOf(B); return !b.shown ? b : null; }, 2500);
    const bCnt = (await emits(B))["CMD:siteUrl"] || 0;
    check(
      "m2d. B's page posts /watch/333 -> B announces it (2nd url overall) and its own bar hides",
      hiddenMs !== null && bCnt === (u0b["CMD:siteUrl"] || 0) + 2 && bar333 !== null,
      `B bar hidden after ${hiddenMs} ms; B CMD:siteUrl ${u0b["CMD:siteUrl"] || 0} -> ${bCnt} (222 + 333)`,
    );
    const endA = (await emits(A))["CMD:siteUrl"] || 0;
    await postSite(A, N333);
    await sleep(700);
    check(
      "m2e. no ping-pong: re-posting A's current url (333) announces nothing",
      ((await emits(A))["CMD:siteUrl"] || 0) === endA,
      `A CMD:siteUrl ${endA} -> ${(await emits(A))["CMD:siteUrl"] || 0}`,
    );
  }

  // m3: late joiner. C leaves and rejoins: the connect hands it the room's stored url
  // (…/333 announced by Bob) and C shows the bar; C's page then posts /watch/999, C
  // announces it once and its bar hides (its own echo confirms the room caught up).
  {
    await ev(C, PANEL(`r.getElementById('join').click(); return true;`)); // leave first
    await waitFor(async () => (await statusOf(C)).ds !== "on", 4000);
    const joinMs = await joinRoom(C, roomUrl, "Carol");
    const cShown = await waitFor(async () => { const b = await barOf(C); return b.shown && b.url === N333; }, 4000);
    const cBar = cShown !== null ? await barOf(C) : null;
    const c0 = await emits(C);
    await postSite(C, N999);
    const cAnn = await waitFor(async () => ((await emits(C))["CMD:siteUrl"] || 0) === (c0["CMD:siteUrl"] || 0) + 1, 2000);
    const cHidden = await waitFor(async () => { const b = await barOf(C); return !b.shown ? b : null; }, 2500);
    check(
      "m3. late joiner C gets the stored url (…/333) on connect and shows the bar; posting its own /watch/999 announces once and hides the bar",
      joinMs !== null && cBar !== null && cAnn !== null && cHidden !== null,
      `rejoined in ${joinMs} ms; bar=${JSON.stringify(cBar)}; announced after ${cAnn} ms; bar hidden after ${cHidden} ms`,
    );
  }

  // m4: Follow on B (dev page on localhost) must NOT navigate to a netflix url and must
  // show the open-it text instead. B's bar currently points at Carol's /watch/999 (m3).
  {
    const barShown4 = await waitFor(async () => { const b = await barOf(B); return b.shown && b.url === N999; }, 3000);
    const barB4 = barShown4 !== null ? await barOf(B) : null;
    const locBefore = await ev(B, `location.href`);
    await ev(B, PANEL(`r.getElementById('followgo').click(); return true;`));
    await sleep(600);
    const locAfter = await ev(B, `location.href`);
    const after = await barOf(B);
    check(
      "m4. Follow on B (localhost ≠ netflix.com) does not navigate; shows 'Open it on that site: <url>'",
      barB4 !== null && locAfter === locBefore && after.shown && after.text.includes("Open it on that site") && after.text.includes(N999),
      `bar before=${JSON.stringify(barB4)}; location ${locBefore === locAfter ? "unchanged" : "NAVIGATED to " + locAfter}; bar after='${after.text.replace(N999, "…")}' follow='${after.url}'`,
    );
  }

  // ---------------- n. round 4A: youtube ad guard, src-swap rate, preview videos ----------------
  const fullDiff = (x, y) => {
    const d = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if ((y[k] || 0) !== (x[k] || 0)) d[k] = (y[k] || 0) - (x[k] || 0);
    return d;
  };

  // n1: a simulated youtube ad (the ad-showing marker div) on A must silence A's
  // playback sync in both directions; removing it re-syncs A from the room.
  {
    // normalize: room rate 1, everyone paused at 30
    await ev(B, PANEL(`r.querySelector('#rates button[data-rate="1"]').click(); return true;`));
    await waitFor(async () => (await vstate(A)).r === 1, 3000);
    await ev(A, `document.querySelector('video').pause(); true`);
    await waitFor(async () => (await vstate(B)).paused === true, 2500);
    await sleep(500);
    await ev(A, `document.querySelector('video').currentTime = 30; true`);
    await waitFor(async () => Math.abs((await vstate(B)).t - 30) < 1, 3000);
    await sleep(800);
    const added = await ev(A, `(() => { const d = document.createElement('div'); d.id = 'movie_player'; d.className = 'ad-showing'; document.body.appendChild(d); return true; })()`);
    const adMs = await waitFor(async () => (await statusOf(A)).text === "Ad playing — sync paused", 2500);
    const e0 = await emits(A);
    await ev(B, `document.querySelector('video').play().then(() => true)`);
    await sleep(1500);
    const aDuringPlay = await vstate(A);
    await ev(B, `document.querySelector('video').currentTime = 45; true`);
    await waitFor(async () => Math.abs((await vstate(B)).t - 45) < 1, 3000);
    await sleep(700);
    const aDuringSeek = await vstate(A);
    await ev(B, `document.querySelector('video').pause(); true`);
    await sleep(1000);
    const dA = fullDiff(e0, await emits(A));
    check(
      "n1a. ad-showing on A -> status 'Ad playing — sync paused'; B's play/seek/pause reach nothing: A stays paused ~30 s @rate 1; 0 CMD emits (ts incl.)",
      added && adMs !== null && aDuringPlay.paused && aDuringSeek.paused && Math.abs(aDuringSeek.t - 30) < 1 && aDuringPlay.r === 1 && aDuringSeek.r === 1 && !Object.keys(dA).length,
      `status after ${adMs} ms; A during B-play=${JSON.stringify(aDuringPlay)} during B-seek=${JSON.stringify(aDuringSeek)}; emit diff=${JSON.stringify(dA)}; B=${JSON.stringify(await vstate(B))}`,
    );
    const removed = await ev(A, `document.getElementById('movie_player').remove(); true`);
    const backMs = await waitFor(async () => {
      const s = await vstate(A), b = await vstate(B);
      return s && b && s.paused && s.r === 1 && Math.abs(s.t - b.t) < 2;
    }, 2000);
    check(
      "n1b. ad removed -> A re-syncs from the room within 2 s (paused, rate 1, near the room position)",
      removed && backMs !== null,
      `A=${JSON.stringify(await vstate(A))} B=${JSON.stringify(await vstate(B))}; landed after ${backMs} ms`,
    );
  }

  // n2: simulated youtube navigation — A's video.src swaps to the same file with
  // ?v=2 while the room rate is 1.5; the site's default-rate reset must be
  // restored to the room rate silently (no CMD:playbackRate).
  {
    await ev(B, PANEL(`r.querySelector('#rates button[data-rate="1.5"]').click(); return true;`));
    await waitFor(async () => (await vstate(A)).r === 1.5, 3000);
    await sleep(400);
    const e2 = await emits(A);
    await ev(A, `document.querySelector('video').src = document.querySelector('video').src + '?v=2'; true`);
    // the site's own default-rate reset, right after the swap: the browser may
    // reset the rate itself too (or not) — either way the restore must fire
    await ev(A, `document.querySelector('video').playbackRate = 1; true`);
    const rateMs = await waitFor(async () => (await vstate(A)).r === 1.5, 3000);
    await sleep(1200); // the 3 s site-reset window must pass with no broadcast
    const dA2 = fullDiff(e2, await emits(A));
    const aFin2 = await vstate(A);
    check(
      "n2. src swap to ?v=2 while the room rate is 1.5: A ends at rate 1.5 and emits no CMD:playbackRate",
      rateMs !== null && aFin2.r === 1.5 && !dA2["CMD:playbackRate"],
      `rate 1.5 again after ${rateMs} ms; A=${JSON.stringify(aFin2)}; emit diff=${JSON.stringify(dA2)}`,
    );
  }

  // n3: a 160x90 muted autoplay preview on A must never win over the real video.
  {
    await ev(A, `(() => {
      const v = document.createElement('video');
      v.id = 'wpxPreview'; v.width = 160; v.height = 90; v.muted = true; v.autoplay = true; v.loop = true;
      v.src = '/dev/extension_test.webm';
      document.body.appendChild(v);
      return true; })()`);
    const previewPlaying = await waitFor(async () => ev(A, `document.getElementById('wpxPreview')?.paused === false`), 4000);
    await sleep(700); // at least one poll tick with both videos on the page
    await ev(B, `document.querySelector('video').play().then(() => true)`);
    await waitFor(async () => (await vstate(A)).paused === false, 2500);
    await sleep(600);
    await ev(B, `document.querySelector('video').pause(); true`);
    const aPaused = await waitFor(async () => (await vstate(A)).paused === true, 2500);
    const previewStill = await ev(A, `document.getElementById('wpxPreview')?.paused === false`);
    await ev(A, `document.getElementById('wpxPreview').remove(); true`);
    check(
      "n3. 160x90 muted autoplay preview added -> the big video stays bound: B's pause pauses A's main video while the preview keeps playing",
      previewPlaying !== null && aPaused !== null && previewStill === true,
      `preview autoplayed=${previewPlaying !== null}; A main paused after ${aPaused} ms (${JSON.stringify(await vstate(A))}); preview still playing=${previewStill}`,
    );
  }

  // n4: canonical title urls (page.js __wpExtPageCanon), query and tracking dropped.
  {
    const canon = (u) => ev(A, `window.__wpExtPageCanon(${JSON.stringify(u)})`);
    const cases = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
      ["https://www.youtube.com/watch?si=xyz&v=abc_12", "https://www.youtube.com/watch?v=abc_12"],
      ["https://www.youtube.com/feed/subscriptions", null],
      ["https://www.disneyplus.com/video/afdc98f1-26bf-48d8-8866-af185ba5d5ac?trackId=xyz&foo=bar", "https://www.disneyplus.com/video/afdc98f1-26bf-48d8-8866-af185ba5d5ac"],
      ["https://www.disneyplus.com/en-gb/play/9abc123?ref=x", "https://www.disneyplus.com/play/9abc123"],
      ["https://www.disneyplus.com/series/da-hai-qi-hang", "https://www.disneyplus.com/series/da-hai-qi-hang"],
      ["https://www.primevideo.com/detail/amzn1.dv.gti.8a13ba1d-2c47-498b?ref_=atv_dp", "https://www.primevideo.com/detail/amzn1.dv.gti.8a13ba1d-2c47-498b"],
      ["https://www.amazon.com/gp/video/detail/B086M5CBVM/ref=atv_dp_share_cu_r", "https://www.amazon.com/gp/video/detail/B086M5CBVM"],
      ["https://www.netflix.com/watch/81234567?trackId=13725522", "https://www.netflix.com/watch/81234567"],
    ];
    const got = [];
    for (const [u, want] of cases) got.push([u, await canon(u), want]);
    check(
      "n4. __wpExtPageCanon: youtube ?v= (other params dropped, non-watch null), disney /video|/play (locale prefix dropped), prime + amazon /detail (path /ref= dropped), netflix /watch",
      got.every(([, g, want]) => g === want),
      got.map(([u, g, want]) => `${u.replace(/^https:\/\/www\./, "")} -> ${g === want ? "ok" : `${g} (want ${want})`}`).join("; "),
    );
  }

  // ---------------- o. round 4B: one person drives (CMD:extControl) ----------------
  const ctlOf = (p) =>
    ev(p, PANEL(`return { id: h.dataset.controller || '', disabled: r.getElementById('ctl').disabled,
      label: r.getElementById('ctl').textContent, line: r.getElementById('ctltext').textContent,
      status: r.getElementById('status').textContent };`));
  {
    // o1: A takes control; everyone shows A as the controller, B's button is disabled
    // The room sits paused at ~46 s after n1b; o2 plays at 1.5x for up to ~9 s when the
    // askHost replies lag — once measured A ending at 60 s mid-o2, which broke B's
    // applyPlay cascade. Start o from 35 s so that window cannot reach the 60 s end.
    await ev(A, `document.querySelector('video').currentTime = 35; true`);
    await waitFor(async () => Math.abs((await vstate(B)).t - 35) < 1.5, 3000);
    await sleep(400);
    await ev(A, PANEL(`r.getElementById('ctl').click(); return true;`));
    const take1 = await waitFor(async () => {
      const a = (await ctlOf(A)).id, b = (await ctlOf(B)).id, c = (await ctlOf(C)).id;
      return a && a === b && b === c ? a : null;
    }, 3000);
    const aCtl = await ctlOf(A), bCtl = await ctlOf(B);
    check(
      "o1. A clicks Take control -> controller id on A/B/C (dataset.controller); A's button 'Release control'; B's button disabled, 'Alice controls playback', status 'Only Alice controls playback'",
      take1 !== null && aCtl.label === "Release control" && !aCtl.disabled && bCtl.disabled
        && bCtl.label === "Take control" && bCtl.line === "Alice controls playback" && bCtl.status === "Only Alice controls playback",
      `controller=${take1}; A=${JSON.stringify(aCtl)} B=${JSON.stringify(bCtl)} C=${JSON.stringify(await ctlOf(C))}`,
    );

    // o2: B (not the controller) acts locally: nothing playback-related emitted, undone
    // from the room state (CMD:askHost, rate-limited to 1/s so the sub-steps are spaced)
    await ev(A, `document.querySelector('video').play().then(() => true)`);
    await waitFor(async () => { const s = await vstate(B); return s && !s.paused; }, 3000);
    const b0 = await emits(B);
    await ev(B, `document.querySelector('video').pause(); true`);
    const backMs = await waitFor(async () => { const s = await vstate(B); return s && !s.paused; }, 2000);
    await sleep(1100);
    await ev(B, `document.querySelector('video').currentTime = 50; true`);
    const seekMs = await waitFor(async () => {
      const b = await vstate(B), a = await vstate(A);
      return b && a && !b.paused && Math.abs(b.t - a.t) < 2 ? true : null;
    }, 2000);
    await sleep(1100);
    await ev(B, `document.querySelector('video').playbackRate = 2; true`);
    const rateMs = await waitFor(async () => (await vstate(B)).r === 1.5, 2000);
    const d2 = nonTs(b0, await emits(B));
    const a2 = await vstate(A), c2 = await vstate(C);
    check(
      "o2. B's local pause / seek 50 / rate 2 while A controls: no playback emits, B back to playing, near the room position and at the room rate 1.5 within 2 s each; A and C unaffected",
      backMs !== null && seekMs !== null && rateMs !== null && !d2["CMD:play"] && !d2["CMD:pause"] && !d2["CMD:seek"] && !d2["CMD:playbackRate"]
        && a2 && c2 && !a2.paused && !c2.paused,
      `playing again after ${backMs} ms; snap-back after ${seekMs} ms; rate 1.5 after ${rateMs} ms; B emit diff=${JSON.stringify(d2)}; A=${JSON.stringify(a2)} C=${JSON.stringify(c2)}`,
    );

    // o3: the controller drives normally: A pauses -> B and C pause
    await ev(A, `document.querySelector('video').pause(); true`);
    const o3ms = await waitFor(async () => {
      const b = await vstate(B), c = await vstate(C);
      return b && c && b.paused && c.paused ? true : null;
    }, 2000);
    check(
      "o3. controller A pauses -> B and C pause within 2 s (A still drives)",
      o3ms !== null,
      `B=${JSON.stringify(await vstate(B))} C=${JSON.stringify(await vstate(C))} after ${o3ms} ms`,
    );

    // o4: B sends CMD:extControl true anyway (button force-enabled in the panel) -> the
    // server refuses: no REC:extControl comes back, the controller stays A
    const id4 = (await ctlOf(B)).id;
    const b4 = await emits(B);
    await ev(B, PANEL(`r.getElementById('ctl').disabled = false; r.getElementById('ctl').click(); return true;`));
    await sleep(800);
    const after4 = await ctlOf(B);
    const d4 = nonTs(b4, await emits(B));
    check(
      "o4. B emits CMD:extControl true while A controls -> no REC:extControl answered: controller stays A",
      after4.id === id4 && id4 && d4["CMD:extControl"] === 1,
      `controller '${id4}' -> '${after4.id}'; B emit diff=${JSON.stringify(d4)} (the steal attempt was sent, not answered)`,
    );

    // o5: A releases -> free everywhere; B can act again and it propagates
    await ev(A, PANEL(`r.getElementById('ctl').click(); return true;`));
    const relMs = await waitFor(async () => {
      const a = (await ctlOf(A)).id, b = (await ctlOf(B)).id, c = (await ctlOf(C)).id;
      return a === "" && b === "" && c === "" ? true : null;
    }, 3000);
    await ev(B, `document.querySelector('video').play().then(() => true)`);
    await waitFor(async () => { const a = await vstate(A), c = await vstate(C); return a && c && !a.paused && !c.paused; }, 3000);
    const b5 = await emits(B);
    await ev(B, `document.querySelector('video').pause(); true`);
    const o5ms = await waitFor(async () => {
      const a = await vstate(A), c = await vstate(C);
      return a && c && a.paused && c.paused ? true : null;
    }, 2000);
    const d5 = nonTs(b5, await emits(B));
    check(
      "o5. A releases -> controller '' everywhere; B pauses again and A/C follow (B's CMD:pause relayed)",
      relMs !== null && o5ms !== null && d5["CMD:pause"] === 1,
      `released after ${relMs} ms; A/C paused after ${o5ms} ms; B emit diff=${JSON.stringify(d5)}`,
    );

    // o6: the controller's tab leaves -> control clears within 2 s; A rejoins afterwards
    // for the media-guard section below
    await ev(A, PANEL(`r.getElementById('ctl').click(); return true;`));
    const take6 = await waitFor(async () => (await ctlOf(B)).id !== "", 3000);
    await ev(A, PANEL(`r.getElementById('join').click(); return true;`));
    const clear6 = await waitFor(async () => {
      const b = (await ctlOf(B)).id, c = (await ctlOf(C)).id;
      return b === "" && c === "" ? true : null;
    }, 2000);
    check(
      "o6. controller A's tab leaves (Leave) -> controller cleared for B/C within 2 s",
      take6 !== null && clear6 !== null,
      `taken=${take6 !== null}; cleared after ${clear6} ms; B controller now '${(await ctlOf(B)).id}'`,
    );
    await joinRoom(A, roomUrl, "Alice");
    await sleep(500);
  }

  // ---------------- q. round 6A: re-sync after an in-page title change ----------------
  // Room paused at 30 s @1.5. The room's title …/watch/333 is announced by C (A's page
  // only ever posts the dev-page url — page.js canon of localhost — and A's own echoes
  // do not count as the room's url).
  const N444 = "https://www.netflix.com/watch/444";
  {
    await ev(A, PANEL(`r.querySelector('#rates button[data-rate="1.5"]').click(); return true;`));
    await waitFor(async () => (await vstate(B)).r === 1.5 && (await vstate(C)).r === 1.5, 3000);
    await ev(A, `document.querySelector('video').pause(); true`);
    await waitFor(async () => (await vstate(B)).paused === true, 2500);
    // A's o6 rejoin re-posted its page url (getSiteUrl) — a title-change trigger that
    // arms A's 3 s site-reset window; wait it out or the setup seek below is swallowed
    await sleep(2600);
    await ev(A, `document.querySelector('video').currentTime = 30; true`);
    if ((await waitFor(async () => Math.abs((await vstate(B)).t - 30) < 1 && Math.abs((await vstate(C)).t - 30) < 1, 3000)) === null)
      throw new Error("q setup: B/C did not land at 30 s (room seek swallowed?)");
    await sleep(800);
    await postSite(C, N333); // the room's title announced (C moves to it)
    await sleep(800); // announcement settles on every member

    // q1: B's page posts …/222 (B was on another episode), the site resets rate to 1
    // and position to 0, then B's page posts …/333 = the room's title. The resets must
    // stay local (0 playback emits) and the room state must arrive via CMD:askHost.
    const q0 = await emits(B);
    await postSite(B, N222);
    await sleep(500); // B announces 222; its own echo must not move the room's latest url
    await ev(B, `(() => { const v = document.querySelector('video'); v.playbackRate = 1; v.currentTime = 0; return true; })()`);
    await sleep(400);
    await postSite(B, N333); // B followed the room: pulls the room state
    const q1ms = await waitFor(async () => {
      const s = await vstate(B);
      return s && s.r === 1.5 && Math.abs(s.t - 30) < 2 ? true : null;
    }, 3000);
    const dq1 = nonTs(q0, await emits(B));
    check(
      "q1. in-page title change to the room's title: the site's rate/position resets stay local (0 CMD:seek/play/pause/playbackRate) and B lands at rate 1.5 within ±2 s of the room position via CMD:askHost",
      q1ms !== null && !dq1["CMD:seek"] && !dq1["CMD:play"] && !dq1["CMD:pause"] && !dq1["CMD:playbackRate"],
      `landed after ${q1ms} ms; B=${JSON.stringify(await vstate(B))}; emit diff=${JSON.stringify(dq1)} (CMD:siteUrl/askHost allowed)`,
    );

    // q2: B's page posts …/444 (not the room's title): rate reset undone to the room's
    // 1.5, position untouched (no askHost pull), 0 playback emits.
    await sleep(1000);
    const bPre = await vstate(B);
    const q20 = await emits(B);
    await postSite(B, N444);
    await sleep(500);
    await ev(B, `document.querySelector('video').playbackRate = 1; true`);
    await sleep(1200);
    const bPost = await vstate(B);
    const dq2 = nonTs(q20, await emits(B));
    check(
      "q2. in-page title change away from the room's title: rate reset undone to the room's 1.5, position untouched (no askHost pull), 0 playback emits",
      bPost.r === 1.5 && Math.abs(bPost.t - bPre.t) < 1 && !dq2["CMD:seek"] && !dq2["CMD:play"] && !dq2["CMD:pause"] && !dq2["CMD:playbackRate"] && !dq2["CMD:askHost"],
      `B ${JSON.stringify(bPre)} -> ${JSON.stringify(bPost)}; emit diff=${JSON.stringify(dq2)} (CMD:siteUrl allowed)`,
    );
  }

  // ---------------- r. round 7A: survive a network drop (auto-reconnect) ----------------
  // CDP offline emulation does not cut an established WebSocket, so the drop is forced
  // directly: close the socket.io engine WebSocket in the world content.js runs in
  // (isolated world for the extension, page world for the bookmarklet) while offline
  // emulation blocks the reconnect attempts. socket.io then retries on its own.
  const connOf = (p) => ev(p, PANEL(`return h.dataset.conn || '';`));
  const countLines = (p) => ev(p, PANEL(`return r.querySelectorAll('#log div').length;`));
  const joinLeaveLines = (p) =>
    ev(p, PANEL(`return Array.from(r.querySelectorAll('#log .sys')).filter((d) => / (joined|left)$/.test(d.textContent)).length;`));
  const netOffline = async (p, offline) => {
    await p.s("Network.enable");
    await p.s("Network.emulateNetworkConditions", {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
    });
  };
  const closeSocketIoWs = async (p) => {
    let closed = 0;
    for (const c of p.ctxById.values()) {
      const type = c.auxData && c.auxData.type;
      if (type !== "default" && type !== "isolated") continue;
      try {
        const proto = await p.s("Runtime.evaluate", { expression: "WebSocket.prototype", contextId: c.id });
        if (!proto.result.objectId) continue;
        const objs = await p.s("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId });
        if (!objs.objects || !objs.objects.objectId) continue;
        const r = await p.s("Runtime.callFunctionOn", {
          objectId: objs.objects.objectId,
          functionDeclaration:
            "function () { const hit = this.filter((w) => /socket\\.io/.test(w.url || '') && w.readyState <= 1); hit.forEach((w) => w.close()); return hit.length; }",
          returnByValue: true,
        });
        closed += r.result.value || 0;
      } catch {}
    }
    return closed;
  };
  // the blocked reconnect handshakes are logged as console errors by the page itself:
  // expected during the outage, not extension defects — keep real errors, drop these
  // (the second pattern: socket.io writing/closing onto the WS the harness just closed)
  const dropWsNoise = (p, before) => {
    p.errors = p.errors.filter(
      (e, i) => i < before || !/WebSocket connection to .* failed|WebSocket is already in CLOSING or CLOSED state/.test(e),
    );
  };

  // r1: B drops off the network for ~4 s while A pauses, seeks to 40 and sets rate 1.25.
  // After the reconnect B re-syncs like a joiner (room state wins), the chat history is
  // not duplicated, A and C were not moved, and B emitted no playback commands.
  {
    await ev(A, PANEL(`r.querySelector('#rates button[data-rate="1"]').click(); return true;`));
    await waitFor(async () => { const b = await vstate(B), c = await vstate(C); return b && c && b.r === 1 && c.r === 1; }, 3000);
    await ev(A, `document.querySelector('video').play().then(() => true)`);
    await waitFor(async () => { const s = await vstate(B); return s && !s.paused; }, 3000);
    await sleep(800);
    const bLines0 = await countLines(B);
    const bJl0 = await joinLeaveLines(B);
    const bEmits0 = await emits(B);
    const bErr0 = B.errors.length;
    await netOffline(B, true);
    const closed = await closeSocketIoWs(B);
    const recMs = await waitFor(() => ev(B, PANEL(`return h.dataset.conn === 'reconnecting';`)), 4000);
    const recStatus = (await statusOf(B)).text;
    dropWsNoise(B, bErr0);
    // while B is offline: A pauses, seeks to 40, sets rate 1.25 (C follows live)
    await ev(A, `document.querySelector('video').pause(); true`);
    await waitFor(async () => { const s = await vstate(C); return s && s.paused; }, 3000);
    await ev(A, `document.querySelector('video').currentTime = 40; true`);
    await waitFor(async () => Math.abs((await vstate(C)).t - 40) < 1.5, 3000);
    await ev(A, PANEL(`r.querySelector('#rates button[data-rate="1.25"]').click(); return true;`));
    await waitFor(async () => { const s = await vstate(C); return s && s.r === 1.25; }, 3000);
    const aPre = await vstate(A), cPre = await vstate(C);
    await sleep(3000); // the outage holds ~4 s; socket.io retries with backoff meanwhile
    await netOffline(B, false);
    const onMs = await waitFor(() => ev(B, PANEL(`return h.dataset.conn === 'on';`)), 15000);
    dropWsNoise(B, bErr0);
    const landMs = await waitFor(async () => {
      const s = await vstate(B);
      return s && s.paused && s.r === 1.25 && Math.abs(s.t - 40) < 1.5 ? true : null;
    }, 3000);
    const aPost = await vstate(A), cPost = await vstate(C);
    const bLines1 = await countLines(B);
    const helloCount = ((await logText(B)).match(/Alice: hello from A/g) || []).length;
    const dB = nonTs(bEmits0, await emits(B));
    check(
      "r1. B's drop shows 'Reconnecting…' (conn='reconnecting') then 'on'; re-syncs like a joiner (paused 40±1.5 s @1.25 within 3 s); chat history not duplicated; A/C unmoved; no stray CMD:seek/play/pause from B",
      closed >= 1 && recMs !== null && recStatus === "Reconnecting…" && onMs !== null && landMs !== null
        && aPost && cPost && aPost.paused && cPost.paused && aPost.r === 1.25 && cPost.r === 1.25
        && Math.abs(aPost.t - aPre.t) < 0.7 && Math.abs(cPost.t - cPre.t) < 0.7
        && bLines1 === bLines0 + 3 - bJl0 && helloCount === 1
        && !dB["CMD:seek"] && !dB["CMD:play"] && !dB["CMD:pause"] && !dB["CMD:playbackRate"]
        && (await statusOf(B)).text === `Connected to ${roomName}`,
      `closed=${closed}; reconnecting after ${recMs} ms ('${recStatus}'), 'on' after ${onMs} ms; B ${JSON.stringify(await vstate(B))} landed after ${landMs} ms; A ${JSON.stringify(aPre)}->${JSON.stringify(aPost)} C ${JSON.stringify(cPre)}->${JSON.stringify(cPost)}; chat lines ${bLines0}->${bLines1} (+3 = A's pause/seek/rate notices missed while offline, -${bJl0} = local join/leave notes replaced by the fresh chatinit), 'hello from A' x${helloCount}; B emit diff=${JSON.stringify(dB)} (ts/name/siteUrl allowed); status='${(await statusOf(B)).text}'`,
    );
  }

  // r2: B pauses locally while offline -> after the reconnect the room state wins (the
  // room kept playing) and B emitted no stale CMD:pause.
  {
    await ev(A, PANEL(`r.querySelector('#rates button[data-rate="1"]').click(); return true;`));
    await waitFor(async () => { const b = await vstate(B), c = await vstate(C); return b && c && b.r === 1 && c.r === 1; }, 3000);
    // play from well before the 60 s end: the outage + reconnect backoff window is long
    // and the file does not loop — reaching the end would pause the room mid-check
    await ev(A, `document.querySelector('video').currentTime = 20; true`);
    await waitFor(async () => Math.abs((await vstate(B)).t - 20) < 1.5, 3000);
    await ev(A, `document.querySelector('video').play().then(() => true)`);
    await waitFor(async () => { const s = await vstate(B); return s && !s.paused; }, 3000);
    await sleep(800);
    const bEmits0 = await emits(B);
    const bErr0 = B.errors.length;
    await netOffline(B, true);
    const closed = await closeSocketIoWs(B);
    const recMs = await waitFor(() => ev(B, PANEL(`return h.dataset.conn === 'reconnecting';`)), 4000);
    dropWsNoise(B, bErr0);
    await sleep(500);
    await ev(B, `document.querySelector('video').pause(); true`);
    const bPausedOffline = await ev(B, `document.querySelector('video').paused`);
    await sleep(2800); // the room keeps playing while B sits paused, offline
    const aMid = await vstate(A);
    await netOffline(B, false);
    const onMs = await waitFor(() => ev(B, PANEL(`return h.dataset.conn === 'on';`)), 15000);
    dropWsNoise(B, bErr0);
    const landMs = await waitFor(async () => {
      const s = await vstate(B), a = await vstate(A);
      return s && a && !s.paused && Math.abs(s.t - a.t) < 3 ? true : null;
    }, 4000);
    const dB = nonTs(bEmits0, await emits(B));
    check(
      "r2. B pauses locally while offline: no stale CMD:pause emitted; after the reconnect the room state wins (B playing near A) and conn is back to 'on'",
      closed >= 1 && recMs !== null && bPausedOffline === true && onMs !== null && landMs !== null
        && !dB["CMD:pause"] && !dB["CMD:play"] && !dB["CMD:seek"] && !dB["CMD:playbackRate"]
        && (await statusOf(B)).text === `Connected to ${roomName}`,
      `closed=${closed}; reconnecting after ${recMs} ms; local pause applied=${bPausedOffline}; room kept playing (A t=${aMid.t.toFixed(1)}); 'on' after ${onMs} ms; B playing near A after ${landMs} ms (B ${JSON.stringify(await vstate(B))} A ${JSON.stringify(await vstate(A))}); B emit diff=${JSON.stringify(dB)} (ts/name/siteUrl allowed); status='${(await statusOf(B)).text}'`,
    );
  }

  // ---------------- s. round 8A: slow drift (measure first, then correction) ----------------
  // A silent drift = B's video moved through the panel's own remote-apply path. The
  // panel masks 'seeked' for 700 ms while applying a remote seek (REC:seek or the
  // CMD:askHost reply), so a listener that fires when the panel's own apply has
  // settled can move the video again inside that window: no CMD:seek leaves B and
  // the room keeps playing as if B had never been touched. delta < 0 = B falls
  // behind. The inject waits for the apply's recovery ('playing', or 'seeked' when
  // the room is paused) and then waits 30 ms more: measured (dev/probe round), a
  // seek that interrupts the previous seek's recovery leaves a CMD:buffering true
  // unclosed and the server's 2.5 s buffer-pause pauses the whole room mid-test.
  const silentDrift = async (p, source, target, delta, watch = "playing") => {
    const injected = ev(
      p,
      `(async () => {
        const v = document.querySelector('video');
        const t1 = ${target};
        const done = new Promise((res) => {
          const h = () => {
            if (v.seeking) return;
            v.removeEventListener(${JSON.stringify(watch)}, h);
            setTimeout(() => {
              v.currentTime = t1 + ${delta}; // still inside the panel's 700 ms 'seeked' mask
              res({ applied: true, at: t1, driftedTo: v.currentTime });
            }, 30);
          };
          v.addEventListener(${JSON.stringify(watch)}, h);
        });
        return Promise.race([done, new Promise((res) => setTimeout(() => res({ applied: false }), 6000))]);
      })()`,
    );
    await sleep(150); // let the listener install before the seek
    await ev(source, `document.querySelector('video').currentTime = ${target}; true`);
    return injected;
  };
  {
    // normalize: room rate 1, everyone playing (C follows the room like B)
    await ev(A, PANEL(`r.querySelector('#rates button[data-rate="1"]').click(); return true;`));
    await waitFor(async () => { const b = await vstate(B), c = await vstate(C); return b && c && b.r === 1 && c.r === 1; }, 3000);
    await ev(A, `document.querySelector('video').play().then(() => true)`);
    await waitFor(async () => { const s = await vstate(B); return s && !s.paused; }, 3000);
    // r2's tail left CMD:buffering changes inside the server's 5-per-1000 ms rate-limit
    // window (room.ts setBuffering): without this pause the inject's recovery false is
    // dropped, bufferingMap[B] stays true and every play/seek re-arms the 2.5 s
    // buffer-pause — measured as "Bob bufferPause" pausing the room mid-s1.
    await sleep(1300);

    // s1: silent 2 s drift on B -> converge within 10 s, 0 playback emits, room rate restored
    {
      const b0 = await emits(B);
      const inj = await silentDrift(B, A, 12, -2);
      const convMs = await waitFor(async () => {
        const a = await vstate(A), b = await vstate(B);
        return a && b && !b.paused && Math.abs(b.t - a.t) < 0.5 ? true : null;
      }, 10000);
      const rateMs = await waitFor(async () => (await vstate(B)).r === 1, 6000);
      const dB = nonTs(b0, await emits(B));
      check(
        "s1. silent 2 s drift on B (no CMD:seek left B): |B−A| < 0.5 s within 10 s, 0 playback emits, B's rate back to the room rate 1",
        inj.applied && convMs !== null && rateMs !== null
          && !dB["CMD:seek"] && !dB["CMD:play"] && !dB["CMD:pause"] && !dB["CMD:playbackRate"],
        `injected=${JSON.stringify(inj)}; |B−A| < 0.5 after ${convMs} ms (host.dataset.drift='${await ev(B, PANEL(`return h.dataset.drift;`))}'); rate 1 again after +${rateMs} ms; B emit diff=${JSON.stringify(dB)} (CMD:ts allowed); A=${JSON.stringify(await vstate(A))} B=${JSON.stringify(await vstate(B))}`,
      );
    }

    // s2: silent 8 s drift -> beyond the nudge range: one masked local seek, < 1 s within 4 s
    {
      await ev(A, `document.querySelector('video').play().then(() => true)`);
      await waitFor(async () => { const s = await vstate(B); return s && !s.paused; }, 3000);
      await sleep(400);
      const b0 = await emits(B);
      const inj = await silentDrift(B, A, 14, -8);
      const convMs = await waitFor(async () => {
        const a = await vstate(A), b = await vstate(B);
        return a && b && !b.paused && Math.abs(b.t - a.t) < 1 ? true : null;
      }, 4000);
      const dB = nonTs(b0, await emits(B));
      check(
        "s2. silent 8 s drift on B: corrected within 4 s (|B−A| < 1 s) via one masked local seek, 0 playback emits",
        inj.applied && convMs !== null && !dB["CMD:seek"] && !dB["CMD:play"] && !dB["CMD:pause"] && !dB["CMD:playbackRate"],
        `injected=${JSON.stringify(inj)}; |B−A| < 1 after ${convMs} ms (host.dataset.drift='${await ev(B, PANEL(`return h.dataset.drift;`))}'); B emit diff=${JSON.stringify(dB)} (CMD:ts allowed); A=${JSON.stringify(await vstate(A))} B=${JSON.stringify(await vstate(B))}`,
      );
    }

    // s3: room paused -> no correction: B keeps the drifted position, 0 playback emits
    {
      await ev(A, `document.querySelector('video').pause(); true`);
      await waitFor(async () => (await vstate(B)).paused === true, 3000);
      const b0 = await emits(B);
      const inj = await silentDrift(B, A, 20, 2, "seeked"); // paused room: no 'playing' fires
      await sleep(6000);
      const bEnd = await vstate(B);
      const dB = nonTs(b0, await emits(B));
      check(
        "s3. room paused: no drift correction — B keeps the injected +2 s position for 6 s, 0 playback emits, no host.dataset.drift",
        inj.applied && bEnd && bEnd.paused && Math.abs(bEnd.t - 22) < 0.3
          && !dB["CMD:seek"] && !dB["CMD:play"] && !dB["CMD:pause"] && !dB["CMD:playbackRate"]
          && (await ev(B, PANEL(`return h.dataset.drift;`))) === undefined,
        `injected=${JSON.stringify(inj)}; B after 6 s=${JSON.stringify(bEnd)} (want paused ≈ 22); B emit diff=${JSON.stringify(dB)} (CMD:ts allowed); drift dataset='${await ev(B, PANEL(`return h.dataset.drift;`))}'`,
      );
    }
  }

  // ---------------- t. round 9A: cross-feature interactions ----------------
  // Features that were only ever tested alone, driven together here. t1-t3 pair two
  // features into a real bug (they FAIL on the pre-fix code); t4-t8 are candidates
  // that checked out clean and must keep passing.
  const N555 = "https://www.netflix.com/watch/555";
  // known state: rate 1 everywhere, paused together at `pos`, then playing
  const tNormalize = async (pos) => {
    await ev(A, PANEL(`r.querySelector('#rates button[data-rate="1"]').click(); return true;`));
    await waitFor(async () => { const b = await vstate(B), c = await vstate(C); return b && c && b.r === 1 && c.r === 1; }, 3000);
    await ev(A, `document.querySelector('video').pause(); true`);
    await waitFor(async () => (await vstate(B)).paused === true, 2500);
    await sleep(400);
    await ev(A, `document.querySelector('video').currentTime = ${pos}; true`);
    await waitFor(async () => Math.abs((await vstate(B)).t - pos) < 1.5 && Math.abs((await vstate(C)).t - pos) < 1.5, 3000);
    await sleep(1200);
    await ev(A, `document.querySelector('video').play().then(() => true)`);
    await waitFor(async () => { const s = await vstate(B); return s && !s.paused; }, 3000);
  };

  // t1: drift nudge × "Sync everyone to me". While nudging, B's video runs at the
  // temporary nudge rate; the sync must hand the room the room rate, not the nudge.
  {
    await tNormalize(8);
    const inj = await silentDrift(B, A, 10, -2);
    const nudgeMs = await waitFor(async () => { const b = await vstate(B); return b && !b.paused && b.r > 1.01 && b.r < 2 ? true : null; }, 8000);
    const b0 = await emits(B);
    let clickErr = null;
    try {
      await Promise.race([
        ev(B, PANEL(`r.getElementById('synctome').click(); return true;`)),
        sleep(6000).then(() => { throw new Error("confirm() never returned (dialog not handled?)"); }),
      ]);
    } catch (e) {
      clickErr = e.message;
    }
    await sleep(1500);
    const aF = await vstate(A), bF = await vstate(B), cF = await vstate(C);
    const dB = nonTs(b0, await emits(B));
    check(
      "t1. B nudging (drift correction) clicks Sync-to-me: the room rate is what gets applied — A/C stay at 1x, B's nudge ends at 1x, everyone lands on B, no CMD:playbackRate leaves B",
      inj.applied && nudgeMs !== null && clickErr === null && B.lastDialog === "Move everyone to your position?"
        && aF && bF && cF && aF.r === 1 && cF.r === 1 && bF.r === 1
        && Math.abs(aF.t - bF.t) < 1.5 && Math.abs(cF.t - bF.t) < 1.5
        && !dB["CMD:playbackRate"],
      `nudging after ${nudgeMs} ms (inj=${JSON.stringify(inj)}); dialog='${B.lastDialog}' clickErr=${clickErr || "none"}; B emit diff=${JSON.stringify(dB)}; A=${JSON.stringify(aF)} B=${JSON.stringify(bF)} C=${JSON.stringify(cF)}`,
    );
  }

  // t2: drift nudge × local pause+play. onPlay makes the room line up on B (CMD:seek
  // + re-anchor), so the nudge being corrected is obsolete — a stale one keeps 1.25x
  // running and B walks away from the room it just aligned.
  {
    await tNormalize(12);
    const inj = await silentDrift(B, A, 14, -2);
    const nudgeMs = await waitFor(async () => { const b = await vstate(B); return b && !b.paused && b.r > 1.01 && b.r < 2 ? true : null; }, 8000);
    await ev(B, `document.querySelector('video').pause(); true`);
    await waitFor(async () => (await vstate(B)).paused === true, 2500);
    await sleep(300);
    const b0 = await emits(B);
    await ev(B, `document.querySelector('video').play().then(() => true)`);
    const landMs = await waitFor(async () => {
      const a = await vstate(A), b = await vstate(B);
      return a && b && !a.paused && !b.paused && Math.abs(a.t - b.t) < 1.5 ? true : null;
    }, 4000);
    const rateBackMs = await waitFor(async () => (await vstate(B)).r === 1, 6000);
    await sleep(3000);
    const aF = await vstate(A), bF = await vstate(B);
    const dB = nonTs(b0, await emits(B));
    check(
      "t2. B pauses+plays while nudging (room lines up on B): B's rate returns to the room rate 1 and stays aligned 3 s later; the stale nudge must not keep pushing B ahead",
      inj.applied && nudgeMs !== null && landMs !== null && rateBackMs !== null
        && aF && bF && !bF.paused && bF.r === 1 && Math.abs(aF.t - bF.t) < 1.5
        && !dB["CMD:playbackRate"],
      `nudging after ${nudgeMs} ms (inj=${JSON.stringify(inj)}); room landed on B after ${landMs} ms; rate back to 1 after ${rateBackMs} ms; +3 s: A=${JSON.stringify(aF)} B=${JSON.stringify(bF)}; B emit diff=${JSON.stringify(dB)} (CMD:seek/play expected)`,
    );
  }

  // t3: title change × drift anchor. An in-page hop to a title the room is NOT on
  // leaves the drift anchor describing the old title; correction must wait for a
  // fresh room apply, not seek the new episode to the old title's position.
  {
    await tNormalize(14);
    const b0 = await emits(B);
    const bPre = await vstate(B);
    await postSite(B, N555);
    await sleep(500);
    // the new episode starts at 0; 'playing' keeps the seek's transient buffering
    // report from arming the server's room pause
    await ev(B, `(() => { const v = document.querySelector('video'); v.currentTime = 0; v.dispatchEvent(new Event('playing')); return true; })()`);
    await sleep(6000);
    const bF = await vstate(B);
    const dB = nonTs(b0, await emits(B));
    check(
      "t3. B hops to a fresh title (new episode at 0) while the room keeps the old one: no drift seek pulls B to the old title's position — B stays near 0 playing at the room rate",
      bPre && bF && !bF.paused && bF.t < 10 && bF.r === 1 && !dB["CMD:seek"] && !dB["CMD:playbackRate"],
      `B before=${JSON.stringify(bPre)} after 6 s=${JSON.stringify(bF)}; B emit diff=${JSON.stringify(dB)} (CMD:siteUrl/ts allowed)`,
    );
  }

  // t4 (checked, not a bug): remote rate change mid-nudge. The nudge must rebase
  // onto the new room rate and the old nudged rate must never leak anywhere.
  {
    await tNormalize(16);
    const inj = await silentDrift(B, A, 18, -2);
    const nudgeMs = await waitFor(async () => { const b = await vstate(B); return b && !b.paused && b.r > 1.01 && b.r < 2 ? true : null; }, 8000);
    const b0 = await emits(B);
    await ev(A, PANEL(`r.querySelector('#rates button[data-rate="1.5"]').click(); return true;`));
    const r15 = await waitFor(async () => (await vstate(B)).r >= 1.5, 3000);
    const convMs = await waitFor(async () => {
      const a = await vstate(A), b = await vstate(B);
      return a && b && !b.paused && Math.abs(a.t - b.t) < 1 ? true : null;
    }, 12000);
    // the re-armed nudge legitimately runs until the gap is under 0.3 s: wait for the
    // restore instead of sampling on a fixed timer
    const rateBackMs = await waitFor(async () => (await vstate(B)).r === 1.5, 8000);
    const bF = await vstate(B);
    const dB = nonTs(b0, await emits(B));
    check(
      "t4. remote rate 1.5 mid-nudge: B takes the new rate, converges to the room, ends at 1.5, and never emits the old nudged rate",
      inj.applied && nudgeMs !== null && r15 !== null && convMs !== null && rateBackMs !== null && bF && bF.r === 1.5 && !dB["CMD:playbackRate"],
      `nudging after ${nudgeMs} ms (inj=${JSON.stringify(inj)}); rate 1.5 taken after ${r15} ms; converged after ${convMs} ms; rate back to 1.5 after ${rateBackMs} ms; B=${JSON.stringify(bF)}; B emit diff=${JSON.stringify(dB)} (CMD:ts allowed)`,
    );
  }

  // t5 (checked, not a bug): reconnect × drift anchor. A 4 s outage while everyone
  // keeps playing: the stale anchor must not fire a bogus seek before REC:host
  // re-anchors on the reconnect.
  {
    await tNormalize(20);
    const bEmits0 = await emits(B);
    const bErr0 = B.errors.length;
    await netOffline(B, true);
    const closed = await closeSocketIoWs(B);
    const recMs = await waitFor(() => ev(B, PANEL(`return h.dataset.conn === 'reconnecting';`)), 4000);
    dropWsNoise(B, bErr0);
    await sleep(3000); // B keeps playing through the outage on the stale anchor
    await netOffline(B, false);
    const onMs = await waitFor(() => ev(B, PANEL(`return h.dataset.conn === 'on';`)), 15000);
    dropWsNoise(B, bErr0);
    const landMs = await waitFor(async () => {
      const s = await vstate(B), a = await vstate(A);
      return s && a && !s.paused && Math.abs(s.t - a.t) < 1.5 ? true : null;
    }, 4000);
    const dB = nonTs(bEmits0, await emits(B));
    check(
      "t5. 4 s outage while everyone keeps playing: no bogus drift seek from the stale anchor (0 playback emits from B), reconnect re-syncs B near the room",
      closed >= 1 && recMs !== null && onMs !== null && landMs !== null
        && !dB["CMD:seek"] && !dB["CMD:play"] && !dB["CMD:pause"] && !dB["CMD:playbackRate"],
      `closed=${closed}; reconnecting after ${recMs} ms, 'on' after ${onMs} ms; B near A after ${landMs} ms (B=${JSON.stringify(await vstate(B))} A=${JSON.stringify(await vstate(A))}); B emit diff=${JSON.stringify(dB)} (ts/name/siteUrl allowed)`,
    );
  }

  // t6 (checked, not a bug): ad guard × drift nudge. The correction freezes under
  // the ad; the ad-end re-sync (CMD:askHost → REC:host → applyHostState) restores
  // rate and position.
  {
    await tNormalize(24);
    const inj = await silentDrift(B, A, 26, -2);
    const nudgeMs = await waitFor(async () => { const b = await vstate(B); return b && !b.paused && b.r > 1.01 && b.r < 2 ? true : null; }, 8000);
    const b0 = await emits(B);
    await ev(B, `(() => { const d = document.createElement('div'); d.id = 'movie_player'; d.className = 'ad-showing'; document.body.appendChild(d); return true; })()`);
    const adMs = await waitFor(async () => (await statusOf(B)).text === "Ad playing — sync paused", 2500);
    await sleep(2000); // driftCheck ticks are skipped under the ad
    await ev(B, `document.getElementById('movie_player').remove(); true`);
    const backMs = await waitFor(async () => {
      const s = await vstate(B), a = await vstate(A);
      return s && a && s.r === 1 && Math.abs(s.t - a.t) < 2 ? true : null;
    }, 4000);
    const dB = nonTs(b0, await emits(B));
    check(
      "t6. ad starts while B is nudging, then ends: B re-syncs from the room (rate 1, near the room position); the nudge never leaks (0 playback emits)",
      inj.applied && nudgeMs !== null && adMs !== null && backMs !== null
        && !dB["CMD:seek"] && !dB["CMD:play"] && !dB["CMD:pause"] && !dB["CMD:playbackRate"],
      `nudging after ${nudgeMs} ms (inj=${JSON.stringify(inj)}); ad status after ${adMs} ms; re-synced after ${backMs} ms; B=${JSON.stringify(await vstate(B))} A=${JSON.stringify(await vstate(A))}; B emit diff=${JSON.stringify(dB)} (CMD:askHost/ts allowed)`,
    );
  }

  // t7 (checked, not a bug): drift correction × control mode. Another member drives;
  // B still aligns locally and silently (no CMD:askHost, no playback emits).
  {
    await tNormalize(28);
    await ev(A, PANEL(`r.getElementById('ctl').click(); return true;`));
    const ctlId = await waitFor(async () => {
      const a = await ctlOf(A), b = await ctlOf(B);
      return a.id && a.id === b.id ? a.id : null;
    }, 3000);
    const inj = await silentDrift(B, A, 30, -2);
    const nudgeMs = await waitFor(async () => { const b = await vstate(B); return b && !b.paused && b.r > 1.01 && b.r < 2 ? true : null; }, 8000);
    const b0 = await emits(B);
    const convMs = await waitFor(async () => {
      const a = await vstate(A), b = await vstate(B);
      return a && b && !b.paused && Math.abs(a.t - b.t) < 1 ? true : null;
    }, 12000);
    const rateBackMs = await waitFor(async () => (await vstate(B)).r === 1, 8000);
    const bF = await vstate(B);
    const dB = nonTs(b0, await emits(B));
    await ev(A, PANEL(`r.getElementById('ctl').click(); return true;`));
    await waitFor(async () => (await ctlOf(A)).id === "", 3000);
    check(
      "t7. drift correction while A controls playback: B converges locally (0 playback emits, no CMD:askHost), rate back to the room rate 1",
      ctlId !== null && inj.applied && nudgeMs !== null && convMs !== null && rateBackMs !== null && bF && bF.r === 1
        && !dB["CMD:seek"] && !dB["CMD:play"] && !dB["CMD:pause"] && !dB["CMD:playbackRate"] && !dB["CMD:askHost"],
      `controller=${ctlId}; nudging after ${nudgeMs} ms (inj=${JSON.stringify(inj)}); converged after ${convMs} ms; rate back to 1 after ${rateBackMs} ms; B=${JSON.stringify(bF)}; B emit diff=${JSON.stringify(dB)} (CMD:ts allowed)`,
    );
  }

  // t8 (checked, not a bug): buffering wait × leave. A reports buffering true then
  // leaves at once: the server drops the claim on disconnect, so the room is not
  // auto-paused by a ghost 2.5 s later; the rejoin lands clean.
  {
    await tNormalize(34);
    const a0 = await emits(A);
    await ev(A, `document.querySelector('video').dispatchEvent(new Event('waiting')); true`);
    const bufMs = await waitFor(async () => ((await emits(A))["CMD:buffering"] || 0) === (a0["CMD:buffering"] || 0) + 1, 1500);
    await ev(A, PANEL(`r.getElementById('join').click(); return true;`)); // Leave
    const leftMs = await waitFor(async () => (await statusOf(A)).ds !== "on", 4000);
    await sleep(3500); // past the server's 2.5 s buffer-pause grace
    const bF = await vstate(B), cF = await vstate(C);
    check(
      "t8. A reports buffering then immediately leaves: the room is NOT auto-paused by the ghost claim (B/C keep playing)",
      bufMs !== null && leftMs !== null && bF && cF && !bF.paused && !cF.paused,
      `buffering true emitted after ${bufMs} ms; A left after ${leftMs} ms; 3.5 s later B=${JSON.stringify(bF)} C=${JSON.stringify(cF)}`,
    );
    const aR0 = await emits(A);
    console.log("   A rejoins:", await joinRoom(A, roomUrl, "Alice"), "ms");
    await sleep(2500);
    const aF = await vstate(A);
    const dA8 = nonTs(aR0, await emits(A));
    check(
      "t8b. rejoining after the buffering-leave: A lands clean (playing at the room rate near the room, no playback emits) — leave() cleared the pending state",
      aF && aF.r === 1 && !aF.paused && Math.abs(aF.t - (await vstate(B)).t) < 2 && !dA8["CMD:playbackRate"] && !dA8["CMD:seek"],
      `A=${JSON.stringify(aF)} B=${JSON.stringify(await vstate(B))}; A emit diff=${JSON.stringify(dA8)} (ts/name/siteUrl allowed)`,
    );
  }

  // h. console errors
  console.log("\nconsole/runtime errors per page (extension isolated world included via Runtime.enable):");
  let any = false;
  for (const p of pages.values()) {
    if (p.label === "web") continue;
    console.log(`  ${p.label}: ${p.errors.length} error(s), ${p.warnings.length} warning(s); contexts: ${[...new Set(p.contexts)].join(" ; ")}`);
    p.errors.forEach((e) => ((any = true), console.log("    ERR  " + e)));
    p.warnings.forEach((e) => console.log("    warn " + e));
  }
  check("h. no console errors from the extension in A/B/C", !any, any ? "see list above" : "none");

  if (MODE === "bookmarklet") {
    // AMD page: a loader-style window.define (with .amd) is present while socket.io's UMD runs.
    // Without the loader's hiding, the UMD would call define() and window.io would stay undefined.
    const D = await newPage("D", TEST_URL);
    await waitFor(() => ev(D, `document.readyState === 'complete'`), 8000);
    await ev(D, `window.__defCalls = 0; window.define = function () { window.__defCalls++; }; window.define.amd = {}; window.__defRef = window.define; true`);
    await runBookmarklet(D);
    const dms = await waitFor(() => hasPanel(D), 8000, 200);
    const info = await ev(D, `({ io: typeof window.io, defCalls: window.__defCalls, restored: window.define === window.__defRef, amd: !!(window.define && window.define.amd) })`);
    check("bm3. page with an AMD window.define: io still loads as a global, define untouched afterwards", dms !== null && info.io === "function" && info.defCalls === 0 && info.restored && info.amd, `${JSON.stringify(info)} errors: ${JSON.stringify(D.errors)}`);
    // control: the same page WITHOUT the hiding would break (shows the test can fail)
    const E = await newPage("E", TEST_URL);
    await waitFor(() => ev(E, `document.readyState === 'complete'`), 8000);
    await ev(E, `window.__defCalls = 0; window.define = function () { window.__defCalls++; }; window.define.amd = {}; true`);
    const raw = await ev(E, `new Promise((res) => { const s = document.createElement('script'); s.src = ${JSON.stringify(SERVER_ORIGIN)} + '/extension/vendor/socket.io.min.js'; s.onload = () => res({ io: typeof window.io, defCalls: window.__defCalls }); document.head.appendChild(s); })`);
    check("bm3b. control: loading socket.io.min.js directly on an AMD page registers via define() and leaves no window.io", raw.io === "undefined" && raw.defCalls === 1, JSON.stringify(raw));
  }

  // ---------------- i. room hosts its own media (guard: extension must stay out of the way) ----------------
  const errCount = () => A.errors.length + B.errors.length + C.errors.length;
  const errBefore = errCount();
  const wState = () =>
    ev(W, `(() => { const v = document.querySelector('video'); return v ? { src: v.currentSrc || v.src, paused: v.paused, t: v.currentTime, r: v.playbackRate, w: Date.now() } : null; })()`);

  // load the media through the web UI: focus the URL input, type, Enter
  const haveInput = await waitFor(() => ev(W, `!!document.querySelector(${JSON.stringify(inputSel)})`), 10000, 200);
  console.log("   web room URL input present:", haveInput !== null);
  await ev(W, `document.querySelector(${JSON.stringify(inputSel)}).focus(); true`);
  await sleep(300);
  await W.s("Input.insertText", { text: MEDIA });
  await sleep(300);
  for (const type of ["keyDown", "keyUp"]) {
    await W.s("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined });
  }

  // (1) both panels flag the room as busy
  const busy = async (p) => {
    const s = await statusOf(p);
    return s.text.includes("playing something else") && s.ds === "err";
  };
  const bMs = await waitFor(async () => (await busy(A)) && (await busy(B)), 6000);
  const stA = await statusOf(A), stB = await statusOf(B), stC = await statusOf(C);
  check(
    "i1. room hosts media -> A and B status 'playing something else', data-status=err",
    bMs !== null,
    `A ${JSON.stringify(stA)} | B ${JSON.stringify(stB)} | (C ${JSON.stringify(stC)}) after ${bMs} ms`,
  );

  // web tab video must exist to compare against
  const wReady = await waitFor(async () => (await wState())?.src?.includes("extension_test.webm"), 10000, 200);
  console.log("   web tab video after hosting:", JSON.stringify(await wState()), "ready after", wReady, "ms");
  await sleep(1500);

  // (2) A acts; nothing may leave A and nothing may reach the web tab's video
  const ea0 = await emits(A), eb0 = await emits(B);
  const sysA0 = await sysLines(A), sysB0 = await sysLines(B);
  const w0 = await wState();
  await ev(A, `document.querySelector('video').play().then(() => true)`);
  await sleep(500);
  await ev(A, `document.querySelector('video').pause(); true`);
  await sleep(500);
  await ev(A, `document.querySelector('video').currentTime = 10; true`);
  await sleep(500);
  await ev(A, PANEL(`r.querySelector('#rates button[data-rate="2"]').click(); return true;`));
  await sleep(2000);
  const ea1 = await emits(A), eb1 = await emits(B);
  const sysA1 = await sysLines(A), sysB1 = await sysLines(B);
  const w1 = await wState();
  const aLocal = await vstate(A), bLocal = await vstate(B);
  const allDiff = (x, y) => {
    const d = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if ((y[k] || 0) !== (x[k] || 0)) d[k] = (y[k] || 0) - (x[k] || 0);
    return d;
  };
  const dA = allDiff(ea0, ea1), dB = allDiff(eb0, eb1);
  check(
    "i2a. A play/pause/seek 10/click 2x -> A's emit counts unchanged (incl. CMD:ts)",
    !Object.keys(dA).length && !Object.keys(dB).length && sysA1 === sysA0 && sysB1 === sysB0,
    `A diff=${JSON.stringify(dA)} B diff=${JSON.stringify(dB)}; sys lines A ${sysA0}->${sysA1} B ${sysB0}->${sysB1}; A local after: ${JSON.stringify(aLocal)} (actions did run locally)`,
  );
  let wOk = false, wDetail = "web tab has no video";
  if (w0 && w1) {
    const elapsed = (w1.w - w0.w) / 1000;
    const expected = w0.t + (w0.paused ? 0 : elapsed * w0.r);
    wOk = w1.paused === w0.paused && w1.r === w0.r && Math.abs(w1.t - expected) < 1.5 && Math.abs(w1.t - 10) > 1.5;
    wDetail = `before ${JSON.stringify(w0)} after ${JSON.stringify(w1)} elapsed=${elapsed.toFixed(2)}s expectedT=${expected.toFixed(2)}`;
  }
  check("i2b. web tab video (paused, currentTime, playbackRate) unaffected by A's actions", wOk, wDetail);

  // (3) clear the room media through the web UI's Clear button
  const cleared = await ev(W, `(() => { const b = document.querySelector('button[aria-label="Clear"]'); if (!b) return false; b.click(); return true; })()`);
  console.log("   web UI Clear button found:", cleared);
  if (cleared) {
    const okMs = await waitFor(async () => {
      const a = await statusOf(A), b = await statusOf(B);
      return a.text === `Connected to ${roomName}` && a.ds === "on" && b.text === `Connected to ${roomName}` && b.ds === "on";
    }, 6000);
    check("i3. web tab clears room media -> A and B panels back to 'Connected to <room>'", okMs !== null, `A ${JSON.stringify(await statusOf(A))} B ${JSON.stringify(await statusOf(B))} after ${okMs} ms`);
    // bonus: sync works again once the room is empty
    await sleep(1000);
    await ev(A, `document.querySelector('video').play().then(() => true)`);
    const pms = await waitFor(async () => (await vstate(B)).paused === false, 2500);
    check("i3b. (bonus) after clearing, A plays -> B playing again", pms !== null, `B ${JSON.stringify(await vstate(B))} after ${pms} ms`);
    await ev(A, `document.querySelector('video').pause(); true`);
  } else {
    console.log("SKIP  i3. web UI has no Clear button in this state");
  }
  check("i4. no new console errors in A/B/C during step i", errCount() === errBefore, `errors before=${errBefore} after=${errCount()}`);
}

const wanted = process.argv[2] ? [process.argv[2]] : ["extension", "bookmarklet"];
for (const mode of wanted) {
  MODE = mode;
  results = [];
  pages.clear();
  console.log(`\n=================== MODE: ${mode} ===================`);
  try {
    await main();
  } catch (e) {
    console.log("SCRIPT ERROR:", e.stack);
    process.exitCode = 1;
    results.push({ label: `[${mode}] script error`, ok: false });
  } finally {
    killEdge();
    await sleep(500);
    try {
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch {}
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY [${mode}]: ${results.length - failed.length}/${results.length} PASS` + (failed.length ? "  FAILED: " + failed.map((f) => f.label).join(" | ") : ""));
  if (failed.length) process.exitCode = 1;
}
