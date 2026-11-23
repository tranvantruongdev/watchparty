import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Menu, Progress, Slider } from "@mantine/core";
import { formatTimestamp, softWhite, volumeSettable } from "../../utils/utils";
import styles from "./Controls.module.css";
import { MetadataContext } from "../../MetadataContext";
import type { AudioTrackInfo } from "../../utils/clientTranscode";
import {
  IconPlayerPlayFilled,
  IconPlayerPauseFilled,
  IconRefresh,
  IconCheck,
  IconRepeat,
  IconBadgeCc,
  IconHeadphones,
  IconVolumeOff,
  IconVolume,
  IconTheater,
  IconMaximize,
  IconPictureInPicture,
  IconPlayerSkipForwardFilled,
  type IconProps,
} from "@tabler/icons-react";

/** The control-bar icons: a real <button> around the SVG so keyboard users
 *  get a tab stop, a name and Enter/Space activation like every other button. */
const ActIcon = ({
  icon: Icon,
  label,
  onClick,
  disabled,
  className,
  color,
  ...rest
}: {
  icon: React.ComponentType<IconProps>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
} & IconProps) => (
  <button
    type="button"
    className={`${styles.actBtn} ${className ?? ""}`}
    aria-label={label}
    title={label}
    aria-disabled={disabled || undefined}
    style={color ? { color } : undefined}
    onClick={() => {
      if (!disabled) {
        onClick();
      }
    }}
    onKeyDown={(e: React.KeyboardEvent) => {
      if (!disabled && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        onClick();
      }
    }}
  >
    <Icon {...rest} />
  </button>
);

interface ControlsProps {
  duration: number;
  video: string;
  paused: boolean;
  muted: boolean;
  volume: number;
  subtitled: boolean;
  currentTime: number;
  disabled?: boolean;
  leaderTime?: number;
  /** Watching alone (not following the room); toggleExplore leaves or rejoins */
  exploring?: boolean;
  toggleExplore?: () => void;
  isPauseDisabled?: boolean;
  playbackRate: number;
  roomPlaybackRate: number;
  isYouTube: boolean;
  isLiveStream: boolean;
  timeRanges: { start: number; end: number }[];
  loop: boolean;
  roomTogglePlay: () => void;
  roomSeek: (time: number) => void;
  roomSetPlaybackRate: (rate: number) => void;
  roomSetLoop: (loop: boolean) => void;
  localFullScreen: (fs: boolean) => void;
  /** Only set for HTML5 video (not YouTube/vbrowser) when the browser supports PiP */
  togglePictureInPicture?: () => void;
  localToggleMute: () => void;
  localSubtitleModal: () => void;
  localSeek: () => void;
  localSetVolume: (volume: number) => void;
  localSetSubtitleMode: (mode: TextTrackMode, lang?: string) => void;
  roomPlaylistPlay: (index: number) => void;
  playlist: PlaylistVideo[];
  /** Live reads from the player. The parent no longer re-renders every second
   *  (per-second position reports left its state), so while media is loaded
   *  Controls ticks itself and polls these; the plain currentTime/leaderTime/
   *  timeRanges props are the fallback (and used before the first tick) */
  pollLive?: () => {
    time: number;
    leader?: number;
    timeRanges: { start: number; end: number }[];
  };
  /** Audio tracks of the file being converted on this device (only set when there's a choice to make) */
  audioTracks?: AudioTrackInfo[];
  audioTrackId?: number;
  localSetAudioTrack?: (id: number) => void;
}

export const Controls = (props: ControlsProps) => {
  const [hoverState, setHoverState] = useState({
    hoverTimestamp: 0,
    hoverPos: 0,
  });
  const [showTimestamp, setShowTimestamp] = useState(false);
  // One tick per second while media is loaded: refreshes the position display,
  // progress bar, Sync badge and buffered bar from pollLive without
  // re-rendering the parent tree
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!props.video) {
      return;
    }
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [props.video]);
  const live = props.pollLive?.();
  const getEnd = () => props.duration;
  const getStart = () => 0;
  const getLength = () => getEnd() - getStart();
  const getCurrent = () => live?.time ?? props.currentTime;
  const getPercent = () => (getCurrent() - getStart()) / getLength();
  // The wall clock time that media time 0 corresponds to, for live streams where the duration is the live edge.
  // Only computed once the duration is known: an infinite one (e.g. a DASH stream before it has a seekable range)
  // would give a time that is never valid, and the memo wouldn't recompute when the duration later became finite.
  const hasFiniteDuration = Number.isFinite(props.duration);
  const zeroTime = useMemo(
    () =>
      hasFiniteDuration
        ? Math.floor(Date.now() / 1000) - props.duration
        : undefined,
    [props.video, hasFiniteDuration],
  );
  const onMouseOver = () => {
    setShowTimestamp(true);
  };
  const onMouseOut = () => {
    setShowTimestamp(false);
  };
  const onMouseMove = (e: any) => {
    const rect = e.target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const max = rect.width;
    const pct = x / max;
    // console.log(x, max);
    const target = getStart() + pct * getLength();
    // console.log(pct);
    if (pct >= 0) {
      setHoverState({ hoverTimestamp: target, hoverPos: pct });
    }
  };
  const {
    roomTogglePlay,
    roomSeek,
    localFullScreen,
    togglePictureInPicture,
    localToggleMute,
    localSubtitleModal,
    localSeek,
    leaderTime,
    isPauseDisabled,
    disabled,
    subtitled,
    paused,
    muted,
    volume,
    isLiveStream,
    playlist,
    roomPlaylistPlay,
    timeRanges,
    roomSetPlaybackRate,
    roomPlaybackRate,
  } = props;
  // Keyboard seeking: the same roomSeek the click handler calls, in 5s/30s steps
  const onSeekKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || !hasFiniteDuration) {
      return;
    }
    const current = getCurrent();
    const targetByKey: Record<string, number> = {
      ArrowLeft: current - 5,
      ArrowRight: current + 5,
      PageDown: current - 30,
      PageUp: current + 30,
      Home: getStart(),
      End: getEnd(),
    };
    const target = targetByKey[e.key];
    if (target === undefined) {
      return;
    }
    e.preventDefault();
    roomSeek(Math.min(Math.max(target, getStart()), getEnd()));
  };
  // console.log(leaderTime, currentTime);
  const behindThreshold = 10;
  const leader = live?.leader ?? leaderTime;
  const behindTime =
    !isLiveStream && leader && leader < Infinity
      ? leader - getCurrent()
      : getEnd() - getCurrent();
  const isBehind = behindTime > behindThreshold;
  const buffers = (live?.timeRanges ?? timeRanges).map(({ start, end }) => {
    const buffStartPct = (start / getLength()) * 100;
    const buffLengthPct = ((end - start) / getLength()) * 100;
    return (
      <div
        key={start}
        style={{
          position: "absolute",
          height: "8px",
          backgroundColor: "grey",
          left: buffStartPct + "%",
          width: buffLengthPct + "%",
          bottom: "0em",
          zIndex: 0,
          pointerEvents: "none",
        }}
      ></div>
    );
  });
  const playPauseProps = {
    onClick: () => {
      roomTogglePlay();
    },
    className: ` ${styles.action}`,
    disabled: disabled || isPauseDisabled,
  };
  return (
    <div className={styles.controls}>
      {paused ? (
        <ActIcon
          icon={IconPlayerPlayFilled}
          label={paused ? "Play" : "Pause"}
          {...playPauseProps}
        />
      ) : (
        <ActIcon
          icon={IconPlayerPauseFilled}
          label={paused ? "Play" : "Pause"}
          {...playPauseProps}
        />
      )}
      {playlist.length > 0 && (
        <ActIcon
          icon={IconPlayerSkipForwardFilled}
          label="Skip to next"
          className={styles.action}
          onClick={() => roomPlaylistPlay(0)}
        />
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          position: "relative",
        }}
      >
        <Button
          size="compact-xs"
          className={styles.compactBtn}
          color={isBehind ? "blue" : "grey"}
          title="Sync"
          onClick={() => {
            if (isLiveStream) {
              // in live case we want to seek the entire room to edge
              roomSeek(props.duration);
            } else {
              localSeek();
            }
          }}
        >
          Sync
        </Button>
        {/* <div style={{ position: 'absolute', fontSize: '6px', zIndex: -1 }}>
            {Math.max(Math.floor(behindTime), 0)}
          </div> */}
      </div>
      {props.toggleExplore && (
        <Button
          size="compact-xs"
          className={styles.compactBtn}
          color={props.exploring ? "orange" : "grey"}
          variant={props.exploring ? "filled" : "subtle"}
          title={
            props.exploring
              ? "Go back to the room's time"
              : "Watch alone: seek and pause without moving the room"
          }
          onClick={props.toggleExplore}
        >
          {props.exploring ? "Rejoin" : "Solo"}
        </Button>
      )}
      <div className={` ${styles.text}`}>
        {formatTimestamp(getCurrent(), isLiveStream ? zeroTime : undefined)}
      </div>
      <Progress.Root
        radius="0px"
        role="slider"
        tabIndex={hasFiniteDuration ? 0 : -1}
        aria-label="Seek"
        aria-valuemin={getStart()}
        aria-valuemax={hasFiniteDuration ? getEnd() : 0}
        aria-valuenow={
          hasFiniteDuration
            ? Math.min(Math.max(getCurrent(), getStart()), getEnd())
            : 0
        }
        aria-valuetext={formatTimestamp(
          getCurrent(),
          isLiveStream ? zeroTime : undefined,
        )}
        aria-disabled={disabled || undefined}
        onKeyDown={onSeekKeyDown}
        onClick={(e: any) => {
          // No finite duration (live share, DASH before the seekable range):
          // getLength() is Infinity and the seek would set a non-finite
          // currentTime; stay inert like the keyboard path above
          if (!disabled && hasFiniteDuration) {
            // Read the time from the click event
            if (e) {
              const rect = e.target.getBoundingClientRect();
              const x = e.clientX - rect.left;
              const max = rect.width;
              const pct = x / max;
              // roomseek operates on actual media element times, not timestamps
              // for DASH we set getStart() value to when stream started, so left side is 0 video time
              // even though it's not all seekable this makes the click to seek simple
              let target = getLength() * pct;
              roomSeek(target);
            }
          }
        }}
        onMouseOver={onMouseOver}
        onMouseOut={onMouseOut}
        onMouseMove={onMouseMove}
        style={{
          flexGrow: 1,
          marginTop: 0,
          marginBottom: 0,
          position: "relative",
          minWidth: "50px",
          overflow: "visible",
          cursor: "pointer",
        }}
      >
        <Progress.Section
          style={{ pointerEvents: "none", zIndex: 1 }}
          value={getPercent() * 100}
        ></Progress.Section>
        {buffers}
        {/* {
            <div
              style={{
                position: 'absolute',
                bottom: '0px',
                left: `calc(${this.getPercent() * 100 + '% - 6px'})`,
                pointerEvents: 'none',
                width: '12px',
                height: '12px',
                transform:
                  this.getLength() < Infinity && showTimestamp
                    ? 'scale(1, 1)'
                    : 'scale(0, 0)',
                transition: '0.25s all',
                borderRadius: '50%',
                backgroundColor: '#54c8ff',
              }}
            ></div>
          } */}
        {getLength() < Infinity && showTimestamp && (
          <Badge
            style={{
              position: "absolute",
              bottom: "10px",
              left: `calc(${hoverState.hoverPos * 100 + "%"})`,
              transform: "translate(-50%)",
              display: "inline-block",
            }}
          >
            {formatTimestamp(
              hoverState.hoverTimestamp,
              isLiveStream ? zeroTime : undefined,
            )}
          </Badge>
        )}
      </Progress.Root>
      <div className={` ${styles.text}`}>{formatTimestamp(getEnd())}</div>
      {isLiveStream && (
        <Badge size="xs" color="red">
          LIVE
        </Badge>
      )}
      {
        <Menu disabled={disabled}>
          <Menu.Target>
            <button
              type="button"
              className={`${styles.actBtn} ${styles.action} ${styles.speedPill}`}
              style={{
                backgroundColor: "rgba(100,100,100, 0.6)",
                fontSize: 10,
                borderRadius: "4px",
                padding: "2px",
                fontWeight: 700,
                color: "inherit",
                fontFamily: "inherit",
              }}
              aria-label="Playback speed"
            >
              {props.playbackRate?.toFixed(2)}x
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            {[
              { key: "Auto", text: "Auto", value: 0 },
              { key: "0.25", text: "0.25x", value: 0.25 },
              { key: "0.5", text: "0.5x", value: 0.5 },
              // { key: '0.75', text: '0.75x', value: 0.75 },
              { key: "1", text: "1x", value: 1 },
              // { key: '1.25', text: '1.25x', value: 1.25 },
              { key: "1.5", text: "1.5x", value: 1.5 },
              // { key: '1.75', text: '1.75x', value: 1.75 },
              { key: "2", text: "2x", value: 2 },
              { key: "3", text: "3x", value: 3 },
            ].map((item) => (
              <Menu.Item
                key={item.key}
                onClick={() => roomSetPlaybackRate(item.value)}
                rightSection={
                  roomPlaybackRate === item.value ? <IconCheck /> : null
                }
              >
                {item.text}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      }
      <ActIcon
        icon={IconRepeat}
        label="Loop"
        disabled={disabled}
        onClick={() => props.roomSetLoop(Boolean(!props.loop))}
        className={` ${styles.action}`}
        color={props.loop ? "green" : softWhite}
      />
      {props.isYouTube ? (
        <Menu>
          <Menu.Target>
            <button
              type="button"
              className={`${styles.actBtn} ${styles.action}`}
              aria-label="Captions"
            >
              <IconBadgeCc />
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            {[
              { key: "hidden", text: "Off", value: "hidden" },
              { key: "en", text: "English", value: "showing" },
              { key: "es", text: "Spanish", value: "showing" },
            ].map((item) => (
              <Menu.Item
                key={item.key}
                onClick={() =>
                  props.localSetSubtitleMode(
                    item.value as TextTrackMode,
                    item.key,
                  )
                }
              >
                {item.text}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      ) : (
        <ActIcon
          icon={IconBadgeCc}
          label="Captions"
          onClick={() => localSubtitleModal()}
          className={` ${styles.action}`}
          color={subtitled ? "green" : softWhite}
        />
      )}
      {props.audioTracks && props.audioTracks.length > 1 && (
        // Local to this device, so unlike the room controls it isn't affected by the lock
        <Menu>
          <Menu.Target>
            <button
              type="button"
              className={`${styles.actBtn} ${styles.action}`}
              aria-label="Audio track"
              style={{ color: softWhite }}
            >
              <IconHeadphones />
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Audio track</Menu.Label>
            {props.audioTracks.map((track) => (
              <Menu.Item
                key={track.id}
                onClick={() => props.localSetAudioTrack?.(track.id)}
                rightSection={
                  props.audioTrackId === track.id ? <IconCheck /> : null
                }
              >
                {track.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
      {/* iPhone has no element fullscreen and the YouTube iframe can't be
          fullscreened from outside: both buttons were dead clicks there, the
          player's own fullscreen button works (R16I) */}
      {!(props.isYouTube && !document.fullscreenEnabled) && (
        <>
          <ActIcon
            icon={IconTheater}
            label="Theater Mode"
            onClick={() => localFullScreen(false)}
            className={` ${styles.action}`}
          />
          <ActIcon
            icon={IconMaximize}
            label="Fullscreen"
            onClick={() => localFullScreen(true)}
            className={` ${styles.action}`}
          />
        </>
      )}
      {togglePictureInPicture && (
        <ActIcon
          icon={IconPictureInPicture}
          label="Picture-in-Picture"
          onClick={togglePictureInPicture}
          className={` ${styles.action}`}
        />
      )}
      {muted ? (
        <ActIcon
          icon={IconVolumeOff}
          label="Unmute"
          onClick={() => localToggleMute()}
          className={` ${styles.action}`}
        />
      ) : (
        <ActIcon
          icon={IconVolume}
          label="Mute"
          onClick={() => localToggleMute()}
          className={` ${styles.action}`}
        />
      )}
      {/* iOS: the slider would move with no effect; mute still works */}
      {volumeSettable && (
        <div style={{ width: "100px" }}>
          <Slider
            defaultValue={volume}
            thumbLabel="Volume"
            disabled={muted}
            min={0}
            max={1}
            step={0.01}
            onChangeEnd={(value: number) => {
              props.localSetVolume(value);
            }}
          />
        </div>
      )}
    </div>
  );
};
