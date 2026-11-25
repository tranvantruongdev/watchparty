import React from "react";
import { ActionIcon } from "@mantine/core";
import { decodeEntities, formatTimestamp } from "../../utils/utils";

import classes from "./ChatVideoCard.module.css";
import {
  IconArrowUp,
  IconBrandYoutubeFilled,
  IconFile,
  IconMagnetFilled,
  IconPlayerPlayFilled,
  IconPlaylistAdd,
  IconTrash,
} from "@tabler/icons-react";

const DRAG_TYPE = "application/x-watchparty-playlist-index";
// Index of the card being dragged (one drag at a time, cards share the module)
let dragFrom = -1;

const ChatVideoCard: React.FC<{
  video: PlaylistVideo;
  index: number;
  controls?: boolean;
  onPlay?: (index: number) => void;
  onRemove?: (index: number) => void;
  onPlayNext?: (index: number) => void;
  onSetMedia?: (value: string) => void;
  onPlaylistAdd?: (value: string) => void;
  // Drag-and-drop reorder: dropping item `from` on this card moves it to `index`
  onMove?: (from: number, to: number) => void;
  disabled?: boolean;
}> = (props) => {
  const {
    video,
    index,
    controls,
    onPlay,
    onPlayNext,
    onRemove,
    onSetMedia,
    disabled,
    onPlaylistAdd,
    onMove,
  } = props;

  // dragging: this card is the one being dragged; dropAt: where the dragged
  // item will land relative to this card (above when coming from below)
  const [dragging, setDragging] = React.useState(false);
  const [dropAt, setDropAt] = React.useState<"above" | "below" | null>(null);
  const canDrag = Boolean(controls && onMove && !disabled);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_TYPE, String(index));
    dragFrom = index;
    setDragging(true);
  };
  const handleDragEnd = () => {
    dragFrom = -1;
    setDragging(false);
    setDropAt(null);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!canDrag || dragFrom < 0 || !e.dataTransfer.types.includes(DRAG_TYPE)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // The dragged item ends up at this card's index: the line shows on the
    // side it comes from
    setDropAt(dragFrom === index ? null : dragFrom > index ? "above" : "below");
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDropAt(null);
    }
  };
  const handleDrop = (e: React.DragEvent) => {
    setDropAt(null);
    const from = dragFrom;
    if (!canDrag || !onMove || from < 0 || from === index) {
      return;
    }
    e.preventDefault();
    onMove(from, index);
  };

  const handlePlayClick = React.useCallback(
    (e: any) => {
      if (onPlay) {
        onPlay(index);
      }
    },
    [onPlay, index],
  );

  const handlePlayNextClick = React.useCallback(
    (e: any) => {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      if (onPlayNext) {
        onPlayNext(index);
      }
    },
    [onPlayNext, index],
  );

  const handleRemoveClick = React.useCallback(
    (e: any) => {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      if (onRemove) {
        onRemove(index);
      }
    },
    [onRemove, index],
  );

  return (
    <div
      title={video.name}
      className={[
        classes.Card,
        dragging && classes.Dragging,
        dropAt === "above" && classes.DropAbove,
        dropAt === "below" && classes.DropBelow,
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={canDrag}
      // Mantine's Menu.Item preventDefaults mousedown, which cancels a drag
      onMouseDown={canDrag ? (e) => e.stopPropagation() : undefined}
      onDragStart={canDrag ? handleDragStart : undefined}
      onDragEnd={canDrag ? handleDragEnd : undefined}
      onDragOver={canDrag ? handleDragOver : undefined}
      onDragLeave={canDrag ? handleDragLeave : undefined}
      onDrop={canDrag ? handleDrop : undefined}
      onClick={
        onSetMedia
          ? (e) => {
              onSetMedia(video.url);
            }
          : undefined
      }
    >
      <div className={classes.Wrapper}>
        <div className={classes.ThumbnailWrapper}>
          {!!video.duration && (
            <div className={classes.DurationLabel}>
              {formatTimestamp(video.duration)}
            </div>
          )}
          {!!video.img && (
            <img
              className={classes.Thumbnail}
              src={video.img}
              alt={video.name}
            />
          )}
        </div>
        <div style={{ flexShrink: 0 }}>
          {video.type === "youtube" && <IconBrandYoutubeFilled color="red" />}
          {video.type === "file" && <IconFile />}
          {video.type === "magnet" && <IconMagnetFilled />}
        </div>
        <div className={classes.Content}>
          <div className={classes.Title}>{decodeEntities(video.name)}</div>
          <div className={classes.ChannelName}>{video.channel}</div>
        </div>
        {onPlaylistAdd && (
          <div className={classes.Controls}>
            <ActionIcon
              title="Add to Playlist"
              aria-label="Add to Playlist"
              onClick={(e) => {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                onPlaylistAdd(video.url);
              }}
            >
              <IconPlaylistAdd />
            </ActionIcon>
          </div>
        )}
        {controls && (
          <div className={classes.Controls}>
            <ActionIcon
              color="green"
              title="Play now"
              aria-label="Play now"
              onClick={handlePlayClick}
              disabled={disabled}
            >
              <IconPlayerPlayFilled size={16} />
            </ActionIcon>
            <ActionIcon
              color="black"
              title="Play next"
              aria-label="Play next"
              onClick={handlePlayNextClick}
              disabled={disabled}
            >
              <IconArrowUp size={16} />
            </ActionIcon>
            <ActionIcon
              color="red"
              title="Remove"
              aria-label="Remove"
              onClick={handleRemoveClick}
              disabled={disabled}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatVideoCard;
