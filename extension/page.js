// Runs in the page's own JS world (manifest "world": "MAIN"). The isolated content
// script cannot reach the Netflix player API, so it asks us to seek via postMessage.
// Also watches the URL for the title the member is on (SPA-safe) and posts it out;
// source tag "wp-ext-page" is distinct so content.js never mistakes it for commands.
(() => {
  if (window.__wpExtPage) return;
  window.__wpExtPage = true;

  const largestVideo = () => {
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
  };

  const seek = (seconds) => {
    if (location.hostname.endsWith("netflix.com")) {
      try {
        // Setting video.currentTime directly makes the Netflix player error out (M7375),
        // so go through its own player API.
        const vp = netflix.appContext.state.playerApp.getAPI().videoPlayer;
        const player = vp.getVideoPlayerBySessionId(vp.getAllPlayerSessionIds()[0]);
        player.seek(seconds * 1000);
        return;
      } catch (e) {
        console.warn("[wp-ext] Netflix seek failed, falling back to currentTime", e);
      }
    }
    const video = largestVideo();
    if (video) video.currentTime = seconds;
  };

  // Canonical "title URL": query/hash and tracking params dropped, null when the
  // page is not a title. Accepts a URL string so tests can call it directly.
  const canon = (u) => {
    const loc = u ? new URL(u) : location;
    if (loc.hostname.endsWith("netflix.com")) {
      const m = loc.pathname.match(/\/watch\/(\d+)$/); // matches any locale prefix before /watch
      return m ? `https://www.netflix.com/watch/${m[1]}` : null;
    }
    if (loc.hostname.endsWith("youtube.com")) {
      const v = new URLSearchParams(loc.search).get("v");
      return v ? `https://www.youtube.com/watch?v=${v}` : null;
    }
    return loc.origin + loc.pathname;
  };
  window.__wpExtPageCanon = canon; // tests only

  let last;
  const checkUrl = () => {
    const c = canon();
    if (c !== last) {
      last = c;
      window.postMessage({ source: "wp-ext-page", type: "siteUrl", url: last }, "*");
    }
  };
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...a) {
      const r = orig.apply(this, a);
      checkUrl();
      return r;
    };
  }
  window.addEventListener("popstate", checkUrl);
  setInterval(checkUrl, 1000); // fallback for SPA routers we didn't wrap
  checkUrl();

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "wp-ext") return;
    if (d.type === "seek" && Number.isFinite(d.seconds)) seek(d.seconds);
    else if (d.type === "getSiteUrl")
      window.postMessage({ source: "wp-ext-page", type: "siteUrl", url: canon() }, "*");
  });
})();
