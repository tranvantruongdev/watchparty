// Builds the javascript: URL for the "WatchParty Sync" bookmarklet. It loads the browser
// extension's own scripts (served by the server at /extension) into the page, so the
// extension and the bookmarklet share one code base. Netflix sends only a
// report-only CSP, which is why scripts and a websocket from our origin are allowed.
export function getBookmarklet(serverOrigin: string, roomName: string): string {
  const origin = serverOrigin.replace(/\/+$/, "");
  // No "%" anywhere: the browser percent-decodes a javascript: URL before running it.
  const code = `(function(o,r){
var w=window;
w.__wpServer=o;
w.__wpRoom=r;
if(w.__wpExtShow){w.__wpExtShow();return}
var k=["define","exports","module"],S={};
k.forEach(function(n){if(n in w){S[n]=w[n];try{w[n]=void 0}catch(e){}}});
function R(){k.forEach(function(n){if(n in S)try{w[n]=S[n]}catch(e){}})}
function L(p,f){
var s=document.createElement("script");
s.src=o+"/extension/"+p;
s.onload=f;
s.onerror=function(){R();alert("WatchParty Sync: cannot load "+s.src)};
document.head.appendChild(s)
}
L("vendor/socket.io.min.js",function(){R();L("page.js",function(){L("content.js",function(){L("ui.js")})})})
})(${JSON.stringify(origin)},${JSON.stringify(roomName)})`;
  // collapse the newlines (they are only for reading here) to keep the URL short
  return "javascript:" + code.replace(/\n/g, "");
}
