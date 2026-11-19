# WatchParty Sync (browser extension)

Watch Netflix together: every person watches in their own browser with their own Netflix
account, and the extension keeps **play, pause, seek and playback speed** in sync through a
WatchParty room. No video is re-streamed and DRM is never touched.

## Install (Chrome 111+ / Edge)

1. Open `edge://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `extension/` folder.

## Use

1. Create or open a WatchParty room (for example `http://localhost:5173/watch/crowded-shirt-stain`)
   and copy its URL.
2. Open the Netflix title in your own browser (each friend needs their own Netflix account).
3. In the panel on the right of the page, paste the room URL (or just the room name), type your
   name and press **Join**.
4. Press play / pause / seek as usual: everyone follows. Late joiners jump to the room's
   position, pause state and speed. If a machine silently falls behind or ahead while the room plays (a stall, a slow machine — no seek involved), the panel catches up on its own within seconds: a temporary speed nudge for gaps up to 5 s, one silent local seek beyond, without sending anything to the room (the gap is exposed as `data-drift` on the panel host).

Speed: the **0.5x 0.75x 1x 1.25x 1.5x 2x** buttons change the speed for everyone. A change made
in Netflix's own speed menu is shared the same way.

The panel also has a chat that shares the room's chat with the WatchParty web page. Chat lines
carry a small dim HH:MM stamp in your local time (the sender's send time for room chat, your
own clock for the join / leave notes), and each member's name is shown in a stable colour
derived from their id — the same shade in every panel — with a "(you)" marker next to your
own name in the members line. If your
video buffers while the room is playing, the room pauses until everyone can play again. It
shows who is watching ("N watching: ...") with join / leave notes in its log, and a row of
emoji reactions that float over the video — shared with the web app in both directions. A 🙂
button by the chat box opens a sticker grid; a sticker is a chat line that renders as one
large emoji in every panel (same list as the web app). The
`-` button collapses the panel; it follows the player into fullscreen, and while collapsed a
"• N" badge in the header counts chat messages that arrived from the others (opening the
panel clears it). **Sync everyone to me** (under the speed row) moves the whole room to your
position, speed and play state after a confirmation. Opening a page with `#wpx=<room>` in its
URL prefills the room and joins at once when your name is already saved, and **Copy invite**
copies such a link for the page you are on. While you type in the chat box a line above the
input shows who else is typing, and when another member is on a different streaming title
(page URL) the panel shows a **Follow** bar: Follow opens that title when it is on the same
site, otherwise it shows the link to open on that site. When your own title changes in-page
(next episode) the room's speed is kept, and if the room is already on that title its
position and play state are pulled once the new video is ready. If the connection drops, the
status shows "Reconnecting…" (with `data-conn="reconnecting"` on the panel host) while
socket.io retries on its own; when it comes back the room's state is applied again like a
late joiner's (the room wins), the chat history is not duplicated, and local actions made
while offline are not replayed.

**Take control**: the button under the speed row turns on "one person drives" — only the
controller's play / pause / seek / speed changes are relayed, everyone else's (web app
members included) are dropped by the server. While another member controls, the button is
disabled, a line shows "<name> controls playback", and a local play / pause / seek / speed
change is undone: the panel re-applies the room's state (pulled once per second at most) and
the status reads "Only <name> controls playback". **Release control** hands it back; control
cannot be taken away from the controller, and it clears at once when their tab leaves.

## Sites

The panel runs on **Netflix**, **YouTube**, **Disney+**, **Prime Video** and Amazon video
pages (`amazon.com/gp/video/...`), plus the dev test page. The content scripts only run in
the top frame, so a site whose player lives inside an iframe is not supported. On YouTube,
while an ad is playing the panel shows "Ad playing — sync paused" and nothing is sent or
applied; when the ad ends the room's state is pulled again and applied like a late joiner's.
Small preview / hover videos on a page are ignored: only the largest visible video syncs.

## Bookmarklet (no install)

The same panel without installing anything:

1. Open a WatchParty room, click **Invite** and drag the **WatchParty Sync** link from the
   dialog to your bookmarks bar.
2. Open the Netflix title and click that bookmark. The panel appears with the room already
   filled in; press **Join**. Clicking the bookmark again just reopens the panel.

The bookmark only loads `/extension/vendor/socket.io.min.js`, `page.js` and `content.js` from
the WatchParty server (`server/server.ts` serves this folder at `/extension`), so it always runs
the same code as the extension. It works because Netflix sends only a report-only
Content-Security-Policy; on sites whose policy enforces (see Known limits) the bookmark alerts
instead of loading, and the extension is the only way there. The saved
room and name live in the page's `localStorage` (`wpx:` keys) instead of `chrome.storage`.

## Server address

The socket server is the `SERVER` constant at the top of `content.js` (`http://localhost:8080`;
the bookmarklet overrides it through `window.__wpServer`). Change it to your deployed server (use `wss`/`https` for Netflix, an `https` page cannot open a
plain `ws://` socket to a remote host).

## Dev test page

`http://localhost:5173/dev/extension_test.html` (served by `npm run ui`) has one seekable
60 s video. The extension also runs on `http://localhost/dev/*`, so two tabs of that page can
be synced without a Netflix account.

Automated test: with `npm run dev` and `npm run ui` running, `node dev/extension_e2e.mjs` drives headless Edge over CDP through every feature, once with the extension loaded and once as the bookmarklet (`EDGE=<browser path>` to use another Chromium).

## Known limits

- **The bookmarklet cannot load on YouTube** (and any site that enforces its
  Content-Security-Policy): youtube.com sends `require-trusted-types-for 'script'` plus
  https-only `script-src` allowlists, so the loader's `<script src=http://localhost:8080/…>`
  injection is blocked by design — Trusted Types reject the `script.src` assignment with
  `TypeError: … requires 'TrustedScriptURL' assignment`, and even a Trusted Types policy
  could not pass the script-src check (a default policy would weaken the site's own guard,
  so none is created). The loader catches this and alerts "WatchParty Sync can't load on
  this site (its security policy blocks scripts) — use the extension" instead of dying
  silently; nothing half-loads. Measured on a real youtube.com watch page (round 13A).

- The Netflix seek path (`page.js`, Netflix player API) and Netflix's play / pause behaviour are
  not covered by the automated test: it needs a logged-in account.
- Typing in the chat box on Netflix may still trigger Netflix shortcuts (space, f, m) if Netflix
  listens in the capture phase.
- In a locked room the server drops play / pause / seek / speed from members that are not the
  lock owner; extension members are never logged in, so only chat works there.
- The room's sleep timer and intermission pause everyone, extension members included.
- **Local Network Access (LNA)**: Chrome/Edge block a page's connection to a local/private
  server. On a public https site (e.g. youtube.com) with the panel pointed at
  `http://localhost:8080`, the socket is refused; headed browsers show a "local network
  access" permission prompt for the site. If it was dismissed, re-enable it later in the
  site settings (icon in the address bar → Site settings → Local network access → Allow)
  and press Join again. The panel detects this and says so instead of a bare "Cannot
  connect". Hosting the server itself on https (a public host) avoids the check entirely.
