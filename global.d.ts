declare module "srt-webvtt";

type StringDict = Record<string, string>;
type NumberDict = Record<string, number>;
type BooleanDict = Record<string, boolean>;
type AnyDict = Record<string, any>;
type PCDict = Record<string, RTCPeerConnection>;
type HTMLVideoElementDict = Record<string, HTMLVideoElement>;
type MediaType = "vbrowser" | "screenshare" | "video" | "youtube";

interface User {
  id: string;
  isVideoChat?: boolean;
  isMuted?: boolean;
  isScreenShare?: boolean;
  buffering?: boolean;
  pos?: Position;
}

// A pixel character on the theater floor: x/y are 0..1 of the floor area,
// ch is the chosen preset id (server-validated allow-list)
interface Position {
  x: number;
  y: number;
  dir: "l" | "r" | "u" | "d";
  sit: boolean;
  ch?: string;
}

interface Reaction {
  user: string;
  value: string;
  msgId: string;
  msgTimestamp: string;
}

// A ticket stub on the memory wall: pinned when a video actually ended,
// stored per room in this device's localStorage (see App.addTicketStub)
interface TicketStub {
  url: string;
  title: string;
  at: number;
}

type ChatPayload = {
  msg: string;
  replyToId?: string;
  replyToTimestamp?: string;
};

interface ChatMessageBase {
  id: string;
  cmd?: string;
  msg?: string;
  system?: boolean;
  isSub?: boolean;
  replyToId?: string;
  replyToTimestamp?: string;
  replyToUserId?: string;
  replyToMsg?: string;
}

interface ChatMessage extends ChatMessageBase {
  timestamp: string;
  videoTS?: number;
  reactions?: { [value: string]: string[] };
}

interface Settings {
  disableChatSound?: boolean;
}

interface PlaylistVideo {
  url: string;
  name: string;
  img?: string;
  channel?: string;
  duration: number;
  type: string;
}

interface SearchResult extends PlaylistVideo {
  size?: string | number;
  seeders?: string;
  magnet?: string;
  type: "youtube" | "file" | "magnet";
  url: string;
  name: string;
  duration: number;
}

interface HostState {
  video: string;
  videoTS: number;
  subtitle: string;
  paused: boolean;
  isVBrowserLarge: boolean;
  controller?: string;
  playbackRate: number;
  loop: boolean;
}

interface RoomIntermission {
  // clientId of whoever called the intermission
  by: string;
  // epoch ms it ends at, null = "back whenever"
  until: number | null;
}

interface RoomSleepTimer {
  // clientId of whoever set the timer
  by: string;
  // epoch ms of the deadline (the room then asks "still watching?")
  at: number;
  // epoch ms the check began, 0 before it does (a pause at the deadline
  // leaves the timer armed until the room plays again)
  askedAt: number;
  // true while the room waits for someone to answer the check
  asking: boolean;
}

interface PersistentRoom {
  roomId: string;
  password: string;
  owner: string;
  vanity: string;
  isChatDisabled: boolean;
  isSubRoom: boolean;
  data: any;
}

interface LinkAccount {
  accountname: string;
  accountid: string;
  discriminator: string;
  kind: string;
}

interface ShardMetric {
  uptime: number;
  mem: number;
  roomCount: number;
  users: number;
  vbWaiting: number;
}
