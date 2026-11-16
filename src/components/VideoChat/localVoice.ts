// Per-seat "mute for me": this listener's own choice about one other member's
// voice. Module scope, so it survives element remounts, the People-panel
// collapse (VideoChat remount) and the member's reconnect/renegotiation — the
// seat keeps its clientId across both. A page reload starts clean on purpose:
// the setting belongs to the page session, not to the account (nothing is sent
// to the server or the other members).
const mutedForMe = new Set<string>();

export const isMutedForMe = (id: string) => mutedForMe.has(id);

export const setMutedForMe = (id: string, muted: boolean) => {
  if (muted) {
    mutedForMe.add(id);
  } else {
    mutedForMe.delete(id);
  }
  return muted;
};

export const mutedForMeIds = () => [...mutedForMe];
