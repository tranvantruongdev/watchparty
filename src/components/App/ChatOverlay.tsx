import React, { useSyncExternalStore } from "react";
import { chatStore } from "./chatStore";
import styles from "./App.module.css";
import { isTouchPrimary } from "../../utils/utils";

// Fullscreen chat overlay: newest messages over the player, each fading out
// ~8s after it arrived (CSS animation). Messages come from chatStore (round
// 130) so an incoming chat only re-renders this, not the whole App.
export function ChatOverlay(props: {
  nameMap: StringDict;
  typing: boolean;
  overlayMsg: string;
  // Opens the input without an Enter key (touch devices); undefined when the
  // room has chat disabled
  onOverlayOpen?: () => void;
  onOverlayMsg: (v: string) => void;
  onOverlayClose: () => void;
  onOverlayBlur: () => void;
  onOverlaySend: () => void;
}) {
  const { messages } = useSyncExternalStore(
    chatStore.subscribe,
    chatStore.getSnapshot,
  );
  return (
    <div className={styles.chatOverlay}>
      {messages
        .filter((m) => !m.system && !m.cmd && m.msg)
        .slice(-5)
        .map((msg) => (
          <div key={msg.timestamp + msg.id} className={styles.chatOverlayItem}>
            <span className={styles.chatOverlayName}>
              {props.nameMap[msg.id] || msg.id}
            </span>
            <span>{msg.msg}</span>
          </div>
        ))}
      {!props.typing && props.onOverlayOpen && isTouchPrimary() && (
        <button
          type="button"
          aria-label="Chat"
          className={styles.chatOverlayOpen}
          onClick={props.onOverlayOpen}
        >
          Chat
        </button>
      )}
      {props.typing && (
        <input
          autoFocus
          className={styles.chatOverlayInput}
          placeholder="Enter to send, Esc to close"
          value={props.overlayMsg}
          onChange={(e) => props.onOverlayMsg(e.target.value)}
          onBlur={props.onOverlayBlur}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              props.onOverlayClose();
            } else if (
              e.key === "Enter" &&
              props.overlayMsg &&
              props.overlayMsg.length <= 10000
            ) {
              props.onOverlaySend();
            }
          }}
        />
      )}
    </div>
  );
}
