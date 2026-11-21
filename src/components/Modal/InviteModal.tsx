import { useMemo, useState } from "react";
import { Modal, TextInput, ActionIcon } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { withRoomKey } from "../../utils/utils";
import { NetflixSteps } from "./NetflixSteps";

export const InviteModal = ({
  closeInviteModal,
  siteUrl,
}: {
  closeInviteModal: () => void;
  siteUrl: string | null;
}) => {
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [deepLinkCopied, setDeepLinkCopied] = useState(false);
  const [deepLinkCopyFailed, setDeepLinkCopyFailed] = useState(false);

  // A streaming title an extension member announced (REC:siteUrl): offer the
  // #wpx=<room> deep link the extension panel auto-joins from. The client-side
  // https check mirrors the server's gate; the href is built with the URL API,
  // never string-concatenated into HTML.
  const deepLink = useMemo(() => {
    if (!siteUrl) return null;
    try {
      const parsed = new URL(siteUrl);
      if (parsed.protocol !== "https:") return null;
      const room =
        window.location.pathname.match(/^\/watch\/([^/?#]+)/)?.[1] ?? "";
      parsed.hash = "wpx=" + decodeURIComponent(room);
      return parsed;
    } catch {
      return null;
    }
  }, [siteUrl]);

  const handleCopyDeepLink = () => {
    if (!deepLink) return;
    navigator.clipboard
      .writeText(deepLink.href)
      .then(() => {
        setDeepLinkCopyFailed(false);
        setDeepLinkCopied(true);
      })
      .catch(() => setDeepLinkCopyFailed(true));
  };

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
      {deepLink && (
        <div style={{ marginTop: 20 }}>
          <div>
            <b>Watching on {deepLink.hostname}:</b>{" "}
            <a href={deepLink.href} target="_blank" rel="noopener noreferrer">
              open it with WatchParty Sync
            </a>{" "}
            <ActionIcon
              onClick={handleCopyDeepLink}
              color="teal"
              aria-label={`Copy ${deepLink.hostname} deep link`}
            >
              <IconCopy size={16} />
            </ActionIcon>
          </div>
          {deepLinkCopied && (
            <div style={{ marginTop: 8 }}>
              <b style={{ color: "green" }}>Link copied to clipboard.</b>
            </div>
          )}
          {deepLinkCopyFailed && (
            <div style={{ marginTop: 8 }}>
              <b style={{ color: "red" }}>
                Couldn't copy automatically — select the link and copy it
                manually.
              </b>
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: 20 }}>
        <b>Watch Netflix together</b>
        <div style={{ marginTop: 8 }}>
          <NetflixSteps />
        </div>
      </div>
    </Modal>
  );
};
