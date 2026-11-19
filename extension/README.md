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
   position, pause state and speed.

Speed: the **0.5x 0.75x 1x 1.25x 1.5x 2x** buttons change the speed for everyone. A change made
in Netflix's own speed menu is shared the same way.

The panel also has a chat that shares the room's chat with the WatchParty web page. The `-`
button collapses the panel; it follows the player into fullscreen.

## Server address

The socket server is the `SERVER` constant at the top of `content.js` (`http://localhost:8080`).
Change it to your deployed server (use `wss`/`https` for Netflix, an `https` page cannot open a
plain `ws://` socket to a remote host).

## Dev test page

`http://localhost:5173/dev/extension_test.html` (served by `npm run ui`) has one seekable
60 s video. The extension also runs on `http://localhost/dev/*`, so two tabs of that page can
be synced without a Netflix account.

## Known limits

- The Netflix seek path (`page.js`, Netflix player API) and Netflix's play / pause behaviour are
  not covered by the automated test: it needs a logged-in account.
- Typing in the chat box on Netflix may still trigger Netflix shortcuts (space, f, m) if Netflix
  listens in the capture phase.
- In a locked room the server drops play / pause / seek / speed from members that are not the
  lock owner; extension members are never logged in, so only chat works there.
- The room's sleep timer and intermission pause everyone, extension members included.
