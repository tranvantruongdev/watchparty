// The two share badges' text lives outside App state: the 2 s stats poll
// changes the text almost every tick when the share wobbles (fps/bitrate), and
// putting it in App state re-rendered the whole 4800-line App for a string
// (round 123). ShareStatsPills reads it with useSyncExternalStore, so the poll
// re-renders only the pill.
type ShareStatsSnapshot = { stats: string; send: string };

let snapshot: ShareStatsSnapshot = { stats: "", send: "" };
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((fn) => fn());

export const shareStatsStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot(): ShareStatsSnapshot {
    return snapshot;
  },
  setStats(v: string) {
    if (v === snapshot.stats) return;
    snapshot = { ...snapshot, stats: v };
    emit();
  },
  setSend(v: string) {
    if (v === snapshot.send) return;
    snapshot = { ...snapshot, send: v };
    emit();
  },
};
