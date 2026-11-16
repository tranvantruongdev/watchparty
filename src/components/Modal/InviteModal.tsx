import React, { useState } from "react";
import { Modal, TextInput, ActionIcon } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { withRoomKey } from "../../utils/utils";

export const InviteModal = ({
  closeInviteModal,
}: {
  closeInviteModal: () => void;
}) => {
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

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
    </Modal>
  );
};
