import React, { useSyncExternalStore } from "react";
import { shareStatsStore } from "./shareStatsStore";
import styles from "./App.module.css";

// Compact pill on narrow players (round 175): resolution + fps only, e.g.
// "720p · 30fps". Returns "" when the string has no "WxH Nfps" part
// ("reconnecting…"), so the caller falls back to the full text.
const compactHint = (text: string) => {
  const m = text.match(/(\d+)x(\d+) ([\d.]+fps)/);
  return m ? `${Math.min(+m[1], +m[2])}p · ${m[3]}` : "";
};

// The two badges over the shared video: the sharer's own encode text and the
// viewer's arrival stats ("reconnecting…" while the stall pill from round 95
// is up). Text comes from shareStatsStore so the 2 s poll updates only this
// component; sharing/cap/stalled change rarely and ride App state as props.
// The visible text switches full/compact by player width (CSS @container);
// screen readers get the full string either way. No title tooltip:
// pointer-events stays none (clicks pass through to the video).
export function ShareStatsPills(props: {
  sharing: boolean;
  capMbps: number;
  stalled: boolean;
}) {
  const snap = useSyncExternalStore(
    shareStatsStore.subscribe,
    shareStatsStore.getSnapshot,
  );
  const sharingFull = `You're sharing your screen (${props.capMbps} Mbps max)${snap.send}`;
  const sharingCompact = compactHint(snap.send)
    ? `sharing · ${compactHint(snap.send)}`
    : sharingFull;
  const statsFull = props.stalled ? "reconnecting…" : snap.stats;
  return (
    <>
      {props.sharing && (
        <div className={styles.shareStats}>
          <span className={styles.visuallyHidden}>{sharingFull}</span>
          <span aria-hidden="true">
            <span className={styles.pillWide}>{sharingFull}</span>
            <span className={styles.pillCompact}>{sharingCompact}</span>
          </span>
        </div>
      )}
      {snap.stats && (
        <div className={styles.shareStats}>
          <span className={styles.visuallyHidden}>{statsFull}</span>
          <span aria-hidden="true">
            <span className={styles.pillWide}>{statsFull}</span>
            <span className={styles.pillCompact}>
              {compactHint(statsFull) || statsFull}
            </span>
          </span>
        </div>
      )}
    </>
  );
}
