import React from "react";
import { ActionIcon, Menu } from "@mantine/core";
import { IconVolume, IconVolumeOff } from "@tabler/icons-react";

// Per-member voice controls for one remote seat. Lives in the tile's top-right
// corner next to the (host-only) options menu. Local only: it never emits to
// the socket, so muting someone changes this page's audio and nothing else.
export const VoiceTileMenu = ({
  id,
  name,
  muted,
  onToggle,
  right,
}: {
  id: string;
  name: string;
  muted: boolean;
  onToggle: (id: string) => void;
  // Left offset so the host's own options button keeps its corner
  right: number;
}) => (
  <div
    style={{ position: "absolute", right, top: 0, zIndex: 1 }}
    data-voice-menu={id}
    data-muted-for-me={muted ? "true" : "false"}
  >
    <Menu closeOnItemClick closeOnClickOutside trigger="click" withinPortal>
      <Menu.Target>
        {/* 32px: the touch minimum this round checks; the icon stays 18px */}
        <ActionIcon
          variant="transparent"
          size={32}
          aria-label={
            muted
              ? `Audio options for ${name} (muted for you)`
              : `Audio options for ${name}`
          }
          title={muted ? `${name}: muted for you` : `Audio options for ${name}`}
          style={{ color: muted ? "#ff8787" : "inherit" }}
        >
          {muted ? <IconVolumeOff size={18} /> : <IconVolume size={18} />}
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{name}</Menu.Label>
        <Menu.Item
          leftSection={
            muted ? <IconVolume size={16} /> : <IconVolumeOff size={16} />
          }
          aria-pressed={muted}
          onClick={() => onToggle(id)}
        >
          {muted ? `Unmute ${name} for me` : `Mute ${name} for me`}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  </div>
);
