import React, { useSyncExternalStore } from "react";
import { shareStatsStore } from "./shareStatsStore";
import styles from "./App.module.css";

// The two badges over the shared video: the sharer's own encode text and the
// viewer's arrival stats ("reconnecting…" while the stall pill from round 95
// is up). Text comes from shareStatsStore so the 2 s poll updates only this
// component; sharing/cap/stalled change rarely and ride App state as props.
export function ShareStatsPills(props: {
  sharing: boolean;
  capMbps: number;
  stalled: boolean;
}) {
  const snap = useSyncExternalStore(
    shareStatsStore.subscribe,
    shareStatsStore.getSnapshot,
  );
  return (
    <>
      {props.sharing && (
        <div className={styles.shareStats}>
          You're sharing your screen ({props.capMbps} Mbps max)
          {snap.send}
        </div>
      )}
      {snap.stats && (
        <div className={styles.shareStats}>
          {props.stalled ? "reconnecting…" : snap.stats}
        </div>
      )}
    </>
  );
}
