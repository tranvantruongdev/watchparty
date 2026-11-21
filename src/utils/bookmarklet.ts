// Builds the javascript: URL for the "WatchParty Sync" bookmarklet. It loads the browser
// extension's own scripts (served by the server at /extension) into the page, so the
// extension and the bookmarklet share one code base. Netflix sends only a
// report-only CSP, which is why scripts and a websocket from our origin are allowed.
// Sites that enforce Trusted Types + script-src allowlists (youtube.com, measured round 13A)
// cannot load the loader at all; there the bookmarklet alerts the fixed security-policy
// message instead of dying silently.
// A tab opened by the room's "Open Netflix" button is named "wpx:<room>\n<nonce>"
// (NetflixSteps): that room beats the one baked in here, so one bookmark serves any
// room — but both must match the room charset below: the server only creates
// lowercase-word-hyphen names (server/utils/moniker.ts), and a name with other
// characters (e.g. "%22)…" from a crafted /watch/ path or window.name) is either a
// string-literal escape or a room that cannot exist.
const roomCharset = /^[a-z]+(-[a-z]+)*$/;
export function getBookmarklet(serverOrigin: string, roomName: string): string {
  const origin = serverOrigin.replace(/\/+$/, "");
  const room = roomCharset.test(roomName) ? roomName : "";
  // The browser percent-decodes a javascript: URL before running it, so every "%"
  // in the body — only user-controlled text can contain one — is escaped to "%25"
  // below and decodes back to the exact original text.
  const code = `(function(o,r){
var w=window;
w.__wpServer=o;
var n=/^wpx:/.test(w.name)?w.name.slice(4).split("\\n")[0]:r;
w.__wpRoom=/^[a-z]+(-[a-z]+)*$/.test(n)?n:r;
if(w.__wpExtShow){w.__wpExtShow();return}
var k=["define","exports","module"],S={};
k.forEach(function(n){if(n in w){S[n]=w[n];try{w[n]=void 0}catch(e){}}});
function R(){k.forEach(function(n){if(n in S)try{w[n]=S[n]}catch(e){}})}
function L(p,f){
var s=document.createElement("script");
try{
s.src=o+"/extension/"+p;
}catch(e){
R();
alert("WatchParty Sync can't load on this site (its security policy blocks scripts) — use the extension");
return
}
s.onload=f;
s.onerror=function(){R();alert("WatchParty Sync: cannot load "+s.src)};
document.head.appendChild(s)
}
L("vendor/socket.io.min.js",function(){R();L("page.js",function(){L("content.js",function(){L("ui.js")})})})
})(${JSON.stringify(origin)},${JSON.stringify(room)})`;
  // collapse the newlines (they are only for reading here) to keep the URL short
  return "javascript:" + code.replace(/\n/g, "").replace(/%/g, "%25");
}

// The bookmark only works in a desktop Chromium browser with a bookmarks bar (phones have
// none and Netflix plays only in its app there)
export const bookmarkletUsable = (): boolean =>
  window.screen.width > 600 &&
  !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) &&
  Boolean((window as any).chrome);

// An https page (Netflix) blocks scripts from a plain-http server (mixed content); only
// loopback http is exempt. Returns true when the bookmark cannot load from this server.
export const bookmarkletBlockedByHttp = (serverOrigin: string): boolean => {
  try {
    const parsed = new URL(serverOrigin);
    return (
      parsed.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
};
