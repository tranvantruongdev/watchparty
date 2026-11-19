import React, { useRef, useState } from "react";
import { ActionIcon } from "@mantine/core";
import { InviteModal } from "../Modal/InviteModal";
import { IconUserPlus } from "@tabler/icons-react";

export const InviteButton = ({ siteUrl }: { siteUrl: string | null }) => {
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  // The modal is mounted conditionally, so closing it unmounts the whole
  // Mantine Modal and its built-in returnFocus never runs — focus falls to
  // <body> (same bug round 150 fixed in App.tsx). Remember the trigger and
  // put focus back after React has removed the modal from the DOM.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeInviteModal = () => {
    setInviteModalOpen(false);
    const el = triggerRef.current;
    if (el && el.isConnected) {
      // after this update commits and unmounts the modal
      window.setTimeout(() => el.focus(), 0);
    }
  };

  return (
    <>
      {inviteModalOpen && (
        <InviteModal closeInviteModal={closeInviteModal} siteUrl={siteUrl} />
      )}
      <ActionIcon
        ref={triggerRef}
        size="36px"
        color="green"
        title="Invite friends"
        aria-label="Invite friends"
        onClick={() => setInviteModalOpen(true)}
      >
        <IconUserPlus />
      </ActionIcon>
    </>
  );
};
