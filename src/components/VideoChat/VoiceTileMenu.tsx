import React from "react";
import { ActionIcon, Menu, Slider } from "@mantine/core";
import { IconVolume, IconVolumeOff } from "@tabler/icons-react";

import {
  getMemberVolume,
  MAX_MEMBER_VOLUME,
  setMemberVolume,
} from "./voicePrefs";

// Per-member voice controls for one remote seat. Lives in the tile's top-right
// corner next to the (host-only) options menu. Local only: it never emits to
// the socket, so muting someone, or turning them up or down, changes this
// page's audio and nothing else.
export const VoiceTileMenu = ({
  id,
  name,
  muted,
  onToggle,
  onVolume,
  right,
}: {
  id: string;
  name: string;
  muted: boolean;
  onToggle: (id: string) => void;
  // This seat's own volume changed (already saved): re-apply its output
  onVolume: (id: string) => void;
  // Left offset so the host's own options button keeps its corner
  right: number;
}) => {
  const [volume, setVolume] = React.useState(() => getMemberVolume(id));
  const changeVolume = (v: number) => {
    setVolume(setMemberVolume(id, v));
    onVolume(id);
  };
  return (
    <div
      style={{ position: "absolute", right, top: 0, zIndex: 1 }}
      data-voice-menu={id}
      data-muted-for-me={muted ? "true" : "false"}
      data-member-volume={volume}
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
            title={
              muted ? `${name}: muted for you` : `Audio options for ${name}`
            }
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
          {/* Not a Menu.Item: dragging must not close the menu, and the
              menu's arrow-key focus walk must not eat the slider's keys */}
          <div
            style={{ padding: "6px 12px 14px", width: 230 }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 12, marginBottom: 4 }}>
              Volume for me: {Math.round(volume * 100)}%
            </div>
            <Slider
              aria-label={`Volume of ${name} for me`}
              value={volume}
              onChange={changeVolume}
              min={0}
              max={MAX_MEMBER_VOLUME}
              step={0.05}
              label={(v) => `${Math.round(v * 100)}%`}
              marks={[{ value: 1 }]}
            />
          </div>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
};
