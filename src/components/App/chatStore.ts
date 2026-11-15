// Chat messages live outside App state (round 130): one incoming message used
// to commit the whole 5000-line App. Chat and the fullscreen overlay subscribe
// here instead — mirrors shareStatsStore (round 123).
type ChatSnapshot = { messages: ChatMessage[]; scrollTimestamp: number };

let snapshot: ChatSnapshot = { messages: [], scrollTimestamp: 0 };
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((fn) => fn());

// New array per change, but the old message objects keep their identity, so
// the ChatMessage memo (Chat.tsx) only renders the newcomer
const commit = (messages: ChatMessage[], scrollTimestamp: number) => {
  snapshot = { messages, scrollTimestamp };
  emit();
};

export const chatStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot(): ChatSnapshot {
    return snapshot;
  },
  // One incoming message (or the local /help hint): keep the newest 100
  push(msg: ChatMessage) {
    commit([...snapshot.messages.slice(-99), msg], Date.now());
  },
  setHistory(list: ChatMessage[]) {
    commit(list, Date.now());
  },
  // Reactions mutate the message in place (round 116): the memo compares the
  // recomputed reactionsSignature, not object identity
  mutate(
    id: string,
    timestamp: string,
    mut: (msg: ChatMessage) => void,
  ): { msg: ChatMessage; index: number } | undefined {
    const index = snapshot.messages.findIndex(
      (m) => m.id === id && m.timestamp === timestamp,
    );
    if (index === -1) {
      return undefined;
    }
    mut(snapshot.messages[index]);
    commit(snapshot.messages, snapshot.scrollTimestamp);
    return { msg: snapshot.messages[index], index };
  },
};
