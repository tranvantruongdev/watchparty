// Runs in the page's own JS world (manifest "world": "MAIN"). The isolated content
// script cannot reach the Netflix player API, so it asks us to seek via postMessage.
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

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "wp-ext") return;
    if (d.type === "seek" && Number.isFinite(d.seconds)) seek(d.seconds);
  });
})();
