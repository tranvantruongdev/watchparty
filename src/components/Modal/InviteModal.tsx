import React, { useCallback, useState } from "react";
import { Modal, TextInput, ActionIcon, Button } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { serverPath, withRoomKey } from "../../utils/utils";
import { getBookmarklet } from "../../utils/bookmarklet";

export const InviteModal = ({
  closeInviteModal,
}: {
  closeInviteModal: () => void;
}) => {
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // React refuses javascript: hrefs in JSX (a warning in 18, blocked in 19), so set it
  // directly. A callback ref, because the Modal mounts its content in a portal after this
  // component's first effect.
  const bookmarkletRef = useCallback((a: HTMLAnchorElement | null) => {
    const room =
      window.location.pathname.match(/^\/watch\/([^/?#]+)/)?.[1] ?? "";
    a?.setAttribute(
      "href",
      getBookmarklet(serverPath, decodeURIComponent(room)),
    );
  }, []);

  const inviteLink = withRoomKey(window.location.href);
  const handleCopyInviteLink = () => {
    // Clipboard can legitimately fail (permission denied, stale focus): the
    // success message must not lie, or the friend never receives the link.
    navigator.clipboard
      .writeText(inviteLink)
      .then(() => {
        setCopyFailed(false);
        setInviteLinkCopied(true);
      })
      .catch(() => setCopyFailed(true));
  };

  return (
    <Modal
      closeButtonProps={{ "aria-label": "Close" }}
      opened
      centered
      onClose={closeInviteModal}
      title="Invite friends and watch together!"
    >
      <TextInput
        label="Copy and share this link:"
        readOnly
        rightSection={
          <ActionIcon
            onClick={handleCopyInviteLink}
            color="teal"
            aria-label="Copy invite link"
          >
            <IconCopy size={16} />
          </ActionIcon>
        }
        defaultValue={inviteLink}
      />
      {inviteLinkCopied && (
        <div style={{ marginTop: 15 }}>
          <b style={{ color: "green" }}>Link copied to clipboard.</b>
        </div>
      )}
      {copyFailed && (
        <div style={{ marginTop: 15 }}>
          <b style={{ color: "red" }}>
            Couldn't copy automatically — select the link above and copy it
            manually.
          </b>
        </div>
      )}
      <div style={{ marginTop: 20 }}>
        <b>Watch Netflix together</b>
        <div style={{ marginTop: 8 }}>
          <Button
            component="a"
            ref={bookmarkletRef}
            variant="light"
            size="xs"
            // only for dragging to the bookmarks bar; clicking it here must not run anything
            onClick={(e: React.MouseEvent) => e.preventDefault()}
          >
            WatchParty Sync
          </Button>
        </div>
        <div style={{ marginTop: 8, fontSize: 13 }}>
          Drag this to your bookmarks bar, open Netflix, click it. Everyone uses
          their own Netflix account.
        </div>
      </div>
    </Modal>
  );
};
