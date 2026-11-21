import React, { useCallback, useRef, useState } from "react";
import { Alert, Button, Modal, Stack } from "@mantine/core";
import { IconBrandNetflix, IconExternalLink } from "@tabler/icons-react";
import { serverPath } from "../../utils/utils";
import {
  bookmarkletBlockedByHttp,
  getBookmarklet,
} from "../../utils/bookmarklet";

const currentRoom = () =>
  decodeURIComponent(
    window.location.pathname.match(/^\/watch\/([^/?#]+)/)?.[1] ?? "",
  );

// The javascript: URL for this room, shared by the drag button and its copy fallback.
const bookmarkletCode = () => getBookmarklet(serverPath, currentRoom());

// A server on this computer: Chrome/Edge ask before netflix.com may reach it
// (Local Network Access); a dismissed prompt fails the bookmark's script loads
const serverIsLoopback =
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(serverPath);

// The new tab's name carries this room to the bookmark (getBookmarklet reads
// "wpx:<room>"), so a bookmark dragged in another room still fills in this one.
// Measured in Edge: window.name stays across same-site pages and is cleared when
// the tab moves to another site, so it never reaches a third party. The suffix
// keeps each click a new tab instead of re-navigating an open one by name.
const openNetflix = (e: React.MouseEvent) => {
  e.preventDefault();
  const w = window.open(
    "https://www.netflix.com/",
    "wpx:" + currentRoom() + "\n" + Date.now(),
  );
  if (w) {
    w.opener = null;
  }
};

export const NetflixSteps = () => {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // React refuses javascript: hrefs in JSX (a warning in 18, blocked in 19), so set it
  // directly. A callback ref, because the Modal mounts its content in a portal after this
  // component's first effect.
  const bookmarkletRef = useCallback((a: HTMLAnchorElement | null) => {
    a?.setAttribute("href", bookmarkletCode());
  }, []);

  // Clipboard can legitimately fail (permission denied, stale focus): the
  // success message must not lie, or the bookmark never gets created.
  const handleCopyBookmarklet = () => {
    navigator.clipboard
      .writeText(bookmarkletCode())
      .then(() => {
        setCopyFailed(false);
        setCopied(true);
      })
      .catch(() => setCopyFailed(true));
  };

  if (bookmarkletBlockedByHttp(serverPath)) {
    return (
      <Alert
        title="The bookmark can't load from this server"
        color="orange"
        variant="light"
      >
        WatchParty is served over plain http ({serverPath}), and Netflix is an
        https site, so the browser blocks the bookmark's scripts. Open
        WatchParty at its https address to use it.
      </Alert>
    );
  }

  return (
    <Stack gap="xs" style={{ fontSize: 13 }}>
      <div>
        1. Drag{" "}
        <Button
          component="a"
          ref={bookmarkletRef}
          variant="light"
          size="xs"
          // only for dragging to the bookmarks bar; clicking it here must not run anything
          onClick={(e: React.MouseEvent) => e.preventDefault()}
        >
          WatchParty Sync
        </Button>{" "}
        to your bookmarks bar.
        <div style={{ color: "var(--mantine-color-dimmed)" }}>
          Bookmarks bar hidden? Press Ctrl+Shift+B (⌘+Shift+B on Mac). Already
          have the bookmark from another room? Skip to step 2.
        </div>
        <Button
          variant="subtle"
          size="compact-xs"
          onClick={handleCopyBookmarklet}
        >
          Can't drag? Copy bookmark code
        </Button>
        {copied && (
          <div>
            Copied. Open your bookmarks manager (Ctrl+Shift+O), add a bookmark
            named WatchParty Sync and paste this as its URL.
          </div>
        )}
        {copyFailed && (
          <div style={{ color: "red" }}>
            Couldn't copy — drag the button instead.
          </div>
        )}
      </div>
      <div>
        2.{" "}
        <Button
          component="a"
          href="https://www.netflix.com/"
          target="_blank"
          rel="noopener noreferrer"
          onClick={openNetflix}
          size="xs"
          leftSection={<IconBrandNetflix size={16} />}
          rightSection={<IconExternalLink size={14} />}
        >
          Open Netflix
        </Button>{" "}
        and start your title.
      </div>
      <div>
        3. Click the bookmark there and press Join. Everyone uses their own
        Netflix account.
        {serverIsLoopback && (
          <div style={{ color: "var(--mantine-color-dimmed)" }}>
            If the browser asks to let netflix.com reach devices on your local
            network, allow it: this WatchParty server runs on your computer.
          </div>
        )}
      </div>
    </Stack>
  );
};

export const NetflixModal = ({ onClose }: { onClose: () => void }) => (
  <Modal
    opened
    centered
    onClose={onClose}
    closeButtonProps={{ "aria-label": "Close" }}
    title="Watch Netflix together"
  >
    <NetflixSteps />
  </Modal>
);

// The room's own entry point (the steps used to live only at the bottom of the
// Invite dialog). The modal mounts conditionally, so put focus back on the
// trigger after it unmounts, like InviteButton does.
export const NetflixButton = () => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    const el = triggerRef.current;
    if (el && el.isConnected) {
      window.setTimeout(() => el.focus(), 0);
    }
  };
  return (
    <>
      {open && <NetflixModal onClose={close} />}
      <Button
        ref={triggerRef}
        size="xs"
        variant="light"
        color="red"
        leftSection={<IconBrandNetflix size={16} />}
        onClick={() => setOpen(true)}
      >
        Watch Netflix together
      </Button>
    </>
  );
};
