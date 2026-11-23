import type MediasoupClient from "mediasoup-client";
import React from "react";
import { Alert, Loader, Menu, Overlay, Select, Title } from "@mantine/core";
import io, { Socket } from "socket.io-client";
import {
  formatSpeed,
  formatTimestamp,
  iceServers,
  isMobile,
  isTouchPrimary,
  serverPath,
  testAutoplay,
  openFileSelector,
  getOrCreateClientId,
  getOrCreateSessionId,
  getRoomKey,
  withRoomKey,
  calculateMedian,
  getUserImage,
  isYouTube,
  isMagnet,
  isHttp,
  isHls,
  isScreenShare,
  isFileShare,
  isLocalCopy,
  parseLocalCopy,
  isDirectVideoUrl,
  pickSingleLargeFile,
  isVBrowser,
  isDash,
  VIDEO_MAX_HEIGHT_CSS,
  softWhite,
  getSavedPasswords,
  getSavedResume,
  saveResume,
  type SavedResume,
} from "../../utils/utils";
import { generateName } from "../../utils/generateName";
import { Chat, type SeekCommand } from "../Chat/Chat";
import { chatStore } from "./chatStore";
import { ChatOverlay } from "./ChatOverlay";
import { NewRoomButton, TopBar } from "../TopBar/TopBar";
import { VBrowser } from "../VBrowser/VBrowser";
import { VideoChat } from "../VideoChat/VideoChat";
import { getPushToTalk } from "../VideoChat/voicePrefs";
import { getCurrentSettings } from "../Settings/LocalSettings";
import { ComboBox } from "../ComboBox/ComboBox";
import { SearchComponent } from "../SearchComponent/SearchComponent";
import { Controls } from "../Controls/Controls";
import { ErrorModal } from "../Modal/ErrorModal";
import { PasswordModal } from "../Modal/PasswordModal";
import {
  ScreenShareModal,
  getShareMbps,
  getShareCapMbps,
} from "../Modal/ScreenShareModal";
import type firebase from "firebase/compat/app";
import { HTML } from "./HTML";
import { YouTube } from "./YouTube";
import styles from "./App.module.css";
import config from "../../config";
import { getFirebase } from "../../firebaseLazy";
import { MetadataContext } from "../../MetadataContext";
import ChatVideoCard from "../ChatVideoCard/ChatVideoCard";
import {
  ActionIcon,
  Badge,
  TextInput,
  Button,
  Modal,
  Switch,
  Tooltip,
} from "@mantine/core";
import {
  IconAntennaBars5,
  IconBrowser,
  IconChevronLeft,
  IconChevronRight,
  IconFile,
  IconFiles,
  IconHistory,
  IconHome,
  IconKeyboardFilled,
  IconList,
  IconHeadphones,
  IconHeadphonesOff,
  IconMicrophone,
  IconCoffee,
  IconEye,
  IconEyeOff,
  IconScreenShare,
  IconSettings,
  IconUser,
  IconUserScreen,
  IconUsersGroup,
  IconVolume,
  IconX,
} from "@tabler/icons-react";
import { InviteButton } from "../InviteButton/InviteButton";
import { NetflixButton } from "../Modal/NetflixSteps";
import { bookmarkletUsable } from "../../utils/bookmarklet";
import type WebTorrent from "webtorrent";
import type Hls from "hls.js";
import { type MediaPlayerClass } from "dashjs";
import { type Torrent } from "webtorrent";
import { shareStatsStore } from "./shareStatsStore";
import { ShareStatsPills } from "./ShareStatsPills";
import { ConvertToggle } from "./ConvertToggle";

// Room-usability rule (round 123): none of these modals is needed to join and
// watch, so each loads on demand at its render point. ScreenShareModal stays
// static: App needs its getShareMbps/getShareCapMbps helpers synchronously.
const MultiStreamModal = React.lazy(() =>
  import("../Modal/MultiStreamModal").then((m) => ({
    default: m.MultiStreamModal,
  })),
);
const VBrowserModal = React.lazy(() =>
  import("../Modal/VBrowserModal").then((m) => ({ default: m.VBrowserModal })),
);
const SettingsModal = React.lazy(() =>
  import("../Settings/SettingsModal").then((m) => ({
    default: m.SettingsModal,
  })),
);
const FileShareModal = React.lazy(() =>
  import("../Modal/FileShareModal").then((m) => ({
    default: m.FileShareModal,
  })),
);
const SubtitleModal = React.lazy(() =>
  import("../Modal/SubtitleModal").then((m) => ({ default: m.SubtitleModal })),
);
import type {
  AudioTrackInfo,
  ClientTranscoder,
} from "../../utils/clientTranscode";

declare global {
  interface Window {
    onYouTubeIframeAPIReady: any;
    YT: YT.JsApi;
    watchparty: {
      ourStream: MediaStream | undefined;
      videoRefs: HTMLVideoElementDict;
      videoPCs: PCDict;
      voiceVolume?: number;
      webtorrent?: WebTorrent.Instance;
      hls?: Hls;
      dash?: MediaPlayerClass;
    };
  }
}

window.watchparty = {
  ourStream: undefined,
  videoRefs: {},
  videoPCs: {},
};

// Glass card look shared by the in-player notices
const glassCardStyle: React.CSSProperties = {
  background: "rgba(30, 18, 58, 0.72)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  border: "1px solid rgba(190, 150, 255, 0.25)",
  borderRadius: 16,
};

const clientId = getOrCreateClientId();

// Round 197: when the browser blocks autoplay, localPlay mutes the player and
// the room's sound (a screen share's audio, or the media) stays silent until
// the viewer clicks the Unmute overlay. Voice chat already retries on any
// gesture (VideoChat retryPlay, round 188), so one tap on the voice hint
// brought voice while the share audio stayed muted behind its own button —
// the late joiner needed a second click to hear the room. Unlock the player
// on the first activation too, listening to the same events the voice retry
// does (a touch only counts as activation at pointerup/touchend, round 188)
const AUDIO_UNLOCK_EVENTS = ["pointerdown", "pointerup", "touchend", "keydown"];

// Round 168: the player's volume survives a reload / a new tab, like the voice
// volume does (watchparty-voice-volume). "0".."1"; anything unparsable falls
// back to full volume
const VOLUME_KEY = "watchparty-volume";
const parseStoredVolume = (raw: string | null): number => {
  // Number(null) is 0, not NaN: a missing key must fall back to full volume
  if (raw === null || raw === "") {
    return 1;
  }
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
};

// Round 122: every Watchparty tab exposes this non-identifying Capture Handle
// at startup, so a sharer capturing a monitor that shows a Watchparty tab can
// detect it (see checkSelfCapture). Not a secret and not an identity — any
// tab can set the same string
const CAPTURE_HANDLE = "watchparty";

// One emoji floating up over the video (REC:floatReaction)
interface FloatReaction {
  user: string;
  value: string;
  id: string;
  // Horizontal start position, percent of the player width
  left: number;
}

interface AppProps {
  vanity?: string;
  urlRoomId?: string;
}

interface AppState {
  state: "starting" | "connected";
  roomMedia: string;
  roomSubtitle: string;
  roomPaused: boolean;
  roomLoop: boolean;
  roomIntermission: RoomIntermission | null;
  roomSleepTimer: RoomSleepTimer | null;
  // No new frame while ICE is unhappy: the share is frozen (round 95). The
  // stats badge text itself lives in shareStatsStore (round 123): it changes
  // almost every 2 s poll and must not re-render the whole App for a string
  shareStalled: boolean;
  // Sharer side (round 184): how many viewers' links have been down for
  // ~6 s (ICE not connected), so the sharer's pill can say who isn't getting it
  shareUnreachable: number;
  // The sharer hid their own-screen preview (round 115): leftVideo stops
  // mirroring the capture and a short note takes its place
  sharePreviewHidden: boolean;
  voiceDeaf: boolean;
  participants: User[];
  rosterUpdateTS: Number;
  playlist: PlaylistVideo[];
  tsMap: NumberDict;
  nameMap: StringDict;
  pictureMap: StringDict;
  myName: string;
  myPicture: string;
  loading: boolean;
  fullScreen: boolean;
  controlsTimestamp: number;
  watchOptions: SearchResult[];
  isVBrowser: boolean;
  isAutoPlayable: boolean;
  // The player was asked to start but stayed cued (YouTube reports nothing when
  // it drops or refuses the request), so offer the start/unmute overlay
  playbackBlocked: boolean;
  // Watching alone: room play/pause/seek don't move this player, and this
  // player's controls don't move the room, until "Rejoin" (watchpoll-style)
  exploring: boolean;
  downloaded: number;
  total: number;
  speed: number;
  connections: number;
  fileSelection: {
    name: string;
    url: string;
    length: number;
    playFn?: () => void;
  }[];
  overlayMsg: string;
  // The server answered that this room does not exist (no namespace): the
  // screen must say so and stop offering a reload that can never work. Kept
  // apart from overlayMsg, whose modal (ErrorModal) also covers transient
  // errors where "Try again" is right.
  roomGone: boolean;
  isErrorAuth: boolean;
  settings: Settings;
  vBrowserResolution: string;
  vBrowserQuality: string;
  isVBrowserLarge: boolean;
  nonPlayableMedia: boolean;
  currentTab: string;
  isSubscribeModalOpen: boolean;
  isVBrowserModalOpen: boolean;
  isScreenShareModalOpen: boolean;
  // The sharer's capture ended without them asking for it (network cut the
  // share, display unplugged): offer to share again
  shareEndedPrompt: boolean;
  isFileShareModalOpen: boolean;
  localCopyNeeded: boolean;
  // "Continue watching" offer (per-device saved position): what to reopen or
  // seek to, and whether the room has no media yet (reopen) or is behind us
  resumeOffer: (SavedResume & { reopen: boolean }) | undefined;
  // The media the user already declined to reopen, so the 1s tick doesn't
  // offer it again
  resumeDismissed: string | undefined;
  isSubtitleModalOpen: boolean;
  isMultiSelectModalOpen: boolean;
  roomLock: string;
  // "One person drives" (WatchParty Sync extension, round 5C): the clientId
  // currently holding playback control, or null. While someone else holds it
  // the server drops CMD:play/pause/seek/playbackRate from this socket, so the
  // app skips those emits and shows who drives
  extController: string | null;
  // Latest REC:siteUrl url: a streaming title an extension member announced;
  // InviteModal turns it into a #wpx= deep link
  extSiteUrl: string | null;
  controller?: string;
  savedPasswords: StringDict;
  roomId: string;
  errorMessage: string;
  successMessage: string;
  warningMessage: string;
  isChatDisabled: boolean;
  showChatColumn: boolean;
  // Messages from others that arrived while the chat column was collapsed
  chatUnread: number;
  showPeopleColumn: boolean;
  owner: string | undefined;
  vanity: string | undefined;
  password: string | undefined;
  inviteLink: string;
  roomTitle: string | undefined;
  roomDescription: string | undefined;
  roomTitleColor: string | undefined;
  mediaPath: string | undefined;
  roomPlaybackRate: number;
  isLiveStream: boolean;
  settingsModalOpen: boolean;
  convertProgress: number | undefined;
  convertEnabled: boolean;
  // Cinema look for the watch page (curtains, house lights)
  theaterMode: boolean;
  // Audio tracks of the file being converted on this device, and which one is playing
  audioTracks: AudioTrackInfo[] | undefined;
  audioTrackId: number | undefined;
  floatReactions: FloatReaction[];
  // Fullscreen chat overlay (F4): whether the mini input is open and what's in it
  chatOverlayTyping: boolean;
  chatOverlayMsg: string;
  // Catch-up chip (round 62): seconds this viewer is behind the room leader
  // while the chip is showing, null when it is hidden
  catchUpBehind: number | null;
}

// One id per page load (r220). A socket.io reconnect reuses the same query,
// so it survives a network blip; a reopened tab (same localStorage clientId)
// gets a new one, which tells the sharer its old PC to us is dead
const pageId = Math.random().toString(36).slice(2);

// A rebuilt share link (sharer freeze / blip) otherwise restarts its sending
// bandwidth estimate at Chrome's ~300 kbps default and ramps for ~30 s
// (measured 0.33 -> 2.35 Mbps over 30 s after a 20 s sharer freeze). Setting
// x-google-start-bitrate on each video codec tells the sender-side estimator
// where to begin; the caller passes the same cap the share encoder uses
// (capped at 2.5 Mbps) so a weak link is never flooded at start.
// The DTLS certificate line identifies the remote PC: a new one means the peer rebuilt its side
const sdpFingerprint = (sdp?: string) => sdp?.match(/^a=fingerprint:.*$/m)?.[0];

const addShareStartBitrate = (sdp: string, startKbps: number): string => {
  const lines = sdp.split("\r\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)\/90000$/);
    if (!m) {
      continue;
    }
    const pt = m[1];
    // fmtp for this payload type lives in the same media section (before the
    // next m= line); PT numbers can repeat across sections
    let sectionEnd = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith("m=")) {
        sectionEnd = j;
        break;
      }
    }
    let fmtpIdx = -1;
    for (let j = i + 1; j < sectionEnd; j++) {
      if (lines[j].startsWith(`a=fmtp:${pt} `)) {
        fmtpIdx = j;
        break;
      }
    }
    const tag = `x-google-start-bitrate=${startKbps}`;
    if (fmtpIdx >= 0) {
      if (!lines[fmtpIdx].includes("x-google-start-bitrate")) {
        lines[fmtpIdx] += `;${tag}`;
      }
    } else {
      // VP8/VP9 usually have no fmtp line: add one right after the rtpmap
      lines.splice(i + 1, 0, `a=fmtp:${pt} ${tag}`);
      i++; // skip the line just inserted
    }
  }
  return lines.join("\r\n");
};

export class App extends React.Component<AppProps, AppState> {
  static contextType = MetadataContext;
  declare context: React.ContextType<typeof MetadataContext>;
  state: AppState = {
    state: "starting",
    roomMedia: "",
    roomPaused: false,
    roomSubtitle: "",
    roomLoop: false,
    roomIntermission: null,
    roomSleepTimer: null,
    // No new frame for ~4 s while the transport is unhappy: the share is
    // frozen and the badge must say so instead of reading as a live stream
    shareStalled: false,
    shareUnreachable: 0,
    sharePreviewHidden: false,
    voiceDeaf: window.localStorage.getItem("watchparty-deaf") === "1",
    participants: [],
    rosterUpdateTS: Date.now(),
    floatReactions: [],
    chatOverlayTyping: false,
    chatOverlayMsg: "",
    catchUpBehind: null,
    playlist: [],
    tsMap: {},
    nameMap: {},
    pictureMap: {},
    myName: window.localStorage.getItem("watchparty-username") ?? "",
    myPicture: "",
    loading: true,
    fullScreen: false,
    controlsTimestamp: 0,
    watchOptions: [],
    isVBrowser: false,
    isAutoPlayable: true,
    playbackBlocked: false,
    exploring: false,
    downloaded: 0,
    total: 0,
    speed: 0,
    connections: 0,
    fileSelection: [],
    overlayMsg: "",
    roomGone: false,
    isErrorAuth: false,
    settings: {},
    vBrowserResolution: "1280x720@30",
    vBrowserQuality: "1",
    isVBrowserLarge: false,
    nonPlayableMedia: false,
    currentTab:
      new URLSearchParams(window.location.search).get("tab") ?? "chat",
    isSubscribeModalOpen: false,
    isVBrowserModalOpen: false,
    isScreenShareModalOpen: false,
    isFileShareModalOpen: false,
    shareEndedPrompt: false,
    localCopyNeeded: false,
    resumeOffer: undefined,
    resumeDismissed: undefined,
    isSubtitleModalOpen: false,
    isMultiSelectModalOpen: false,
    roomLock: "",
    extController: null,
    extSiteUrl: null,
    controller: "",
    roomId: "",
    savedPasswords: {},
    errorMessage: "",
    successMessage: "",
    warningMessage: "",
    isChatDisabled: false,
    chatUnread: 0,
    showChatColumn: isMobile()
      ? true
      : Boolean(
          Number(
            window.localStorage.getItem("watchparty-showchatcolumn") ?? "1",
          ),
        ),
    showPeopleColumn: false,
    // Boolean(
    //       Number(
    //         window.localStorage.getItem('watchparty-showpeoplecolumn') ?? '0',
    //       ),
    //     ),
    owner: undefined,
    vanity: undefined,
    password: undefined,
    inviteLink: "",
    roomTitle: "",
    roomDescription: "",
    roomTitleColor: "",
    mediaPath: undefined,
    roomPlaybackRate: 0,
    isLiveStream: false,
    settingsModalOpen: false,
    convertProgress: undefined,
    convertEnabled: window.localStorage.getItem("watchparty-convert") === "1",
    theaterMode: window.localStorage.getItem("watchparty-theater") !== "0",
    audioTracks: undefined,
    audioTrackId: undefined,
  };
  socket: Socket = null!;
  mediasoupPubSocket: Socket | null = null;
  mediasoupSubSocket: Socket | null = null;
  ytDebounce = true;
  // One local playVideo retry after a suppressed PAUSED (R17C, see
  // onStateChange); re-armed by every localPlay and by any PLAYING
  ytPlayRetried = false;
  // Buffering report state: when a stall started, and whether we already
  // told the room it lasted long enough to show (> 1.5 s)
  bufferingSince = 0;
  bufferingReported = false;
  ytNeedsFirstPlaySync = false;
  // Counts 1s ts ticks so the resume point is saved every ~10s
  resumeTicker = 0;
  // Position to pull the room to after the "continue watching" reopen loads
  // (consumed on the first play sync), and the media it belongs to
  pendingResume?: number;
  pendingResumeMedia?: string;
  // The current video can't play embedded (removed, or the owner disabled
  // embedding): YouTube shows its own message, so don't cover it with Unmute
  ytUnplayable = false;
  playbackCheckTimer: number | undefined = undefined;
  ytPostSeekTimer: number | undefined = undefined;
  // What leftVideo was playing before a file share attempt cleared it, so a
  // rejected share can put it back (nothing else re-attaches it). roomMedia is
  // the room media at snapshot time: the restore only applies if it's still
  // current, otherwise the room moved on to someone else's share
  preShareVideoState?: {
    src: string;
    srcObject: MediaStream | null;
    time: number;
    roomMedia: string;
  };
  localStreamToPublish?: MediaStream;
  isLocalStreamAFile = false;
  // What the share that just stopped was: "share again" reopens that modal
  // (isLocalStreamAFile is already cleared by then)
  shareEndedWasFile = false;
  // Set when the stop was the user's own doing (Stop Share button, failed
  // conversion): stopPublishingLocalStream stays quiet instead of offering
  // "share again"
  shareStopSilent = false;
  // A socket reconnect re-announced our still-live share (CMD:resumeShare)
  // and the answer hasn't landed yet: REC:host with "" in that window is the
  // pre-resume snapshot, not a share end, so the capture must survive it
  resumeShareInFlight = false;
  // "Local copy" mode: the file this client plays from its own disk
  localCopyFile?: File;
  localCopyObjectUrl?: string;
  // One chat-notification sound element, reused; a new Audio per message
  // (round 110) leaked an element for every chat line read while hidden
  chatAudio?: HTMLAudioElement;
  // The player's mute state before the sharer preview forced it muted
  sharePreviewWasMuted?: boolean;
  // True once the "sharing a Watchparty tab" notice fired for this share:
  // capturehandlechange can re-fire mid-share (tab navigation, config change)
  // and the notice must stay a one-shot per share
  selfCaptureNoticed?: boolean;
  // The blob URL a non-converted file share plays leftVideo from; revoked when
  // the share ends so the file's handle doesn't stay pinned until tab close
  fileShareObjectUrl?: string;
  transcoder?: ClientTranscoder;
  publisherConns: PCDict = {};
  // Inaudible tone that keeps a hidden file-share tab unthrottled (setupRTCConnections)
  shareKeepAwake?: AudioContext;
  // A file share's audio re-sourced through shareKeepAwake (see setupRTCConnections)
  shareAudioOut?: MediaStreamTrack;
  consumerConn?: RTCPeerConnection;
  shareStatsTimer?: number;
  shareStatsLast?: { bytes: number; ts: number };
  // Consecutive 2 s polls with zero new frames on the viewer copy (round 95):
  // a static screen legitimately sends none, so frames alone must not raise
  // the flag — it only shows while ICE is unhappy too (disconnected/failed),
  // which a healthy static screen never is
  shareStallTicks = 0;
  // A dead viewer copy needs an immediate offer when its replacement is ready.
  consumerDied = false;
  shareLastFrames?: number;
  // Round 145 tried a frame-gap stall watch here (no presented frame for 10 s
  // => "Sharer's screen paused") and REVERTED it the same round: the static
  // measurement proved a legitimately frozen share and a starved sender are
  // indistinguishable at the viewer — motion-then-static for 60 s froze
  // framesReceived AND bytesReceived AND packetsReceived at exactly 0 deltas
  // with ICE connected, so any frame/byte-silence threshold false-alarms on
  // the most common share (slides, docs, paused video). Keep the ICE-based
  // poll behavior; a real fix needs a sender-side signal
  // Last 3 instantaneous encode fps samples for the sharer badge: the single
  // poll value swings 2-8 fps while the window average is steady (round 64)
  shareSendFps: number[] = [];
  progressUpdater?: number;
  tsInterval?: number;
  heartbeat: number | undefined = undefined;
  YouTubeInterface: YouTube = new YouTube(null);
  HTMLInterface: HTML = new HTML("leftVideo");
  Player = () => {
    if (this.usingYoutube()) {
      return this.YouTubeInterface;
    } else {
      return this.HTMLInterface;
    }
  };

  chatRef = React.createRef<Chat>();
  videoChatRef = React.createRef<VideoChat>();
  // The autoplay-blocked unlock listens on document gestures once (see
  // AUDIO_UNLOCK_EVENTS); the flag keeps a re-arm from stacking listeners
  audioUnlockArmed = false;
  // When a gesture last unlocked playback (see videoClick)
  unlockedAt = 0;
  // Per-second position reports, kept out of state: storing them in state
  // re-rendered the whole tree twice a second while a video plays. Sync logic
  // reads this field; state.tsMap is only refreshed for the ts badges while
  // the people column is open, and Controls polls the player itself (pollLive)
  // because its position display is computed at render time.
  tsMapData: NumberDict = {};
  // Round 192: true while the chat column is collapsed by the screen share
  // (not by the person). A hand toggle of the chevron clears it, so a person
  // who re-opened the chat is never collapsed again for that share, and a
  // chat they collapsed themselves before the share is not re-opened after it
  chatAutoCollapsed = false;

  componentDidUpdate(_prevProps: AppProps, prevState: AppState) {
    if (this.state.showChatColumn && this.state.chatUnread) {
      this.setState({ chatUnread: 0 });
    }
    const wasShare = isScreenShare(prevState.roomMedia);
    const isShare = isScreenShare(this.state.roomMedia);
    if (isShare && !wasShare) {
      // Entering a screen share: the picture gets the chat's width. Same
      // breakpoint as the CSS that sizes the open chat; narrower windows keep
      // the stacked layout and their chat. Not written to localStorage: that
      // key holds the person's own choice, which the share must not change
      if (
        this.state.showChatColumn &&
        window.matchMedia("(min-width: 901px)").matches
      ) {
        this.chatAutoCollapsed = true;
        this.setState({ showChatColumn: false });
      }
    } else if (
      !isShare &&
      this.chatAutoCollapsed &&
      // The sharer's reconnect passes through a "" snapshot before its share
      // resumes (REC:host, shareResuming): not an end, keep the chat collapsed
      !this.resumeShareInFlight
    ) {
      this.chatAutoCollapsed = false;
      this.setState({ showChatColumn: true });
    }
  }

  async componentDidMount() {
    document.onfullscreenchange = this.onFullScreenChange;
    document.onkeydown = this.onKeydown;
    // Round 135: a tab Chrome throttled or froze while hidden wakes up stale —
    // the last REC:tsMap / share stats are minutes old and the player can sit
    // far behind the room (measured: ~16 s of drift still there a minute
    // after returning, with only the manual catch-up chip). Reuse the join
    // path: CMD:askHost -> REC:host (room.ts:569 answers immediately; a
    // disconnected socket.io buffers the emit and flushes it on reconnect)
    // and tick the stats polls once. visibilitychange only fires on real
    // hidden<->visible flips (never on a mere focus change), resume only
    // follows a freeze, pageshow only matters for a bfcache restore.
    document.addEventListener("visibilitychange", this.pageVisibility);
    document.addEventListener("resume", this.pageWake);
    window.addEventListener("pageshow", this.pageShow);
    this.setupCaptureHandle();
    // chatStore is module-global: a remounted App (another room without a page
    // load) must not show the previous room's messages until chatinit arrives
    chatStore.setHistory([]);

    // Send heartbeat to the server
    this.heartbeat = window.setInterval(
      () => {
        fetch(serverPath + "/ping");
      },
      10 * 60 * 1000,
    );

    const canAutoplay = await testAutoplay();
    this.setState({ isAutoPlayable: canAutoplay });
    this.loadSettings();
    this.loadYouTube();
    this.init();
    if (config.VITE_FIREBASE_CONFIG) {
      // The auth SDK loads lazily (firebaseLazy): a signed-out viewer,
      // and this page's first paint, never wait for it
      getFirebase().then((fb) => {
        fb.auth().onAuthStateChanged(async (user: firebase.User | null) => {
          if (user) {
            this.loadSignInData(user);
          }
        });
      });
    }
  }

  componentWillUnmount() {
    // Handlers installed via the on<event> properties must be removed the same
    // way; removeEventListener would not match them
    document.onfullscreenchange = null;
    document.onkeydown = null;
    AUDIO_UNLOCK_EVENTS.forEach((type) =>
      document.removeEventListener(type, this.audioUnlock),
    );
    document.removeEventListener("visibilitychange", this.pageVisibility);
    document.removeEventListener("resume", this.pageWake);
    window.removeEventListener("pageshow", this.pageShow);
    window.clearInterval(this.heartbeat);
    window.clearInterval(this.tsInterval);
    window.clearInterval(this.shareStatsTimer);
    window.clearInterval(this.progressUpdater);
    window.clearTimeout(this.playbackCheckTimer);
    window.clearTimeout(this.ytPostSeekTimer);
    if (this.localCopyObjectUrl) {
      URL.revokeObjectURL(this.localCopyObjectUrl);
      this.localCopyObjectUrl = undefined;
    }
  }

  init = async () => {
    let roomId = "/" + this.props.urlRoomId;
    // if a vanity name, resolve the url to a room id
    if (this.props.vanity) {
      try {
        const resp = await fetch(
          serverPath + "/resolveRoom/" + this.props.vanity,
        );
        if (!resp.ok) {
          this.setState({ overlayMsg: "Couldn't load this room." });
          return;
        }
        const data = await resp.json();
        if (!data?.roomId) {
          this.setState({ overlayMsg: "Couldn't load this room." });
          return;
        }
        roomId = data.roomId;
      } catch {
        // A dead server must show the overlay, not die as an unhandled rejection
        this.setState({ overlayMsg: "Couldn't load this room." });
        return;
      }
    }
    this.setState(
      {
        roomId,
      },
      () => {
        this.join(roomId);
      },
    );
  };

  join = async (roomId: string) => {
    const password = getSavedPasswords()[roomId] ?? "";
    let shard: string | number = "";
    try {
      const response = await fetch(serverPath + "/resolveShard" + roomId);
      shard = Number(await response.text()) || "";
    } catch {
      // The socket connection below reports its own error when the server is
      // unreachable; a dead resolveShard must not die as an unhandled rejection
    }
    const socket = io(serverPath + roomId, {
      transports: ["websocket"],
      query: {
        clientId,
        pageId,
        password,
        shard,
        roomId: roomId.slice(1),
      },
      auth: {
        sessionId: getOrCreateSessionId(),
        roomKey: getRoomKey(),
      },
    });
    this.socket = socket;
    socket.on("connect", async () => {
      this.setState({
        state: "connected",
        overlayMsg: "",
        roomGone: false,
        errorMessage: "",
        successMessage: "",
        warningMessage: "",
      });
      // A disconnect this page slept through (frozen tab, suspended machine)
      // leaves publisher PCs nobody closed: the viewer's own copy is torn down
      // while we hold the stale entry, and that entry defeats the
      // !this.publisherConns[id] guard below — no fresh offer is ever built, so
      // the pill says "not reaching 1 viewer" and the viewer's picture never
      // returns (measured round 202: S frozen 60 s, share dead 75 s after
      // resume, voice fine). Drop the unhealthy ones; after a short blip they
      // are all connected, so the normal no-renegotiation path is untouched
      Object.entries(this.publisherConns).forEach(([id, pc]) => {
        if (
          pc.connectionState === "disconnected" ||
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          pc.close();
          delete this.publisherConns[id];
        }
      });
      this.setupRTCConnections();
      // Re-announce our screen/file share if the capture survived the socket
      // gap: short blips never cleared it (server grace window), long ones
      // did and this puts it back without re-picking the screen. Before the
      // name await below, so the in-flight flag is up before the connect-time
      // REC:host snapshot ("" after a cleared share) is processed
      const shareMedia = this.state.roomMedia;
      if (
        this.localStreamToPublish?.getVideoTracks()[0]?.readyState === "live" &&
        (isScreenShare(shareMedia) || isFileShare(shareMedia))
      ) {
        this.resumeShareInFlight = true;
        socket.emit("CMD:resumeShare", { media: shareMedia });
      }
      // Use the name in our state, generate one if empty
      this.updateName(this.state.myName || (await generateName()));
      this.loadSignInData(this.context.user);
      // Re-join video chat if we were in it before the reconnection
      if (window.watchparty.ourStream) {
        socket.emit("CMD:joinVideo");
      }
    });
    socket.on("connect_error", (err: any) => {
      console.error(err);
      if (err.message === "Invalid namespace") {
        // The server answered: this room does not exist (deleted, expired, or
        // never created). Auto-reconnect may still bring it back if storage
        // reloads it, but a modal "Try again" reloads onto the same answer.
        this.setState({
          roomGone: true,
          overlayMsg: "",
          warningMessage: "",
        });
      } else if (err.type === "TransportError") {
        // Server unreachable (down, network cut): the socket keeps retrying on
        // its own, so show the reconnect pill and no blocking modal
        if (!this.state.roomGone) {
          this.setState({ warningMessage: "Reconnecting..." });
        }
      } else if (err.message === "password") {
        this.setState({ isErrorAuth: true });
      } else if (err.message === "roomKey") {
        this.setState({
          overlayMsg:
            "This theater is private. Open the invite link you were given.",
        });
      } else {
        this.setState({ overlayMsg: err?.message ?? "An error occurred" });
      }
    });
    socket.on("disconnect", (reason) => {
      if (reason === "io server disconnect") {
        // the disconnection was initiated by the server, you need to reconnect manually
        this.setState({ overlayMsg: "Disconnected from server." });
      } else {
        // else the socket will automatically try to reconnect
        // Use the alert pill since it's less disruptive
        this.setState({ warningMessage: "Reconnecting..." });
      }
    });
    socket.on("errorMessage", (err: string) => {
      this.setState({ errorMessage: err });
      setTimeout(() => {
        this.setState({ errorMessage: "" });
      }, 3000);
    });
    socket.on("successMessage", (success: string) => {
      this.setState({ successMessage: success });
      setTimeout(() => {
        this.setState({ successMessage: "" });
      }, 3000);
    });
    socket.on("kicked", () => {
      window.location.assign("/");
    });
    socket.on("REC:play", () => {
      if (this.state.exploring) {
        // Remember the room state for Rejoin, leave our own player alone
        this.setState({ roomPaused: false });
        return;
      }
      // Someone resumed while we still hold a stall (paused, short of data):
      // claim again, the pause consumed the old claim on the server
      if (this.bufferingReported) {
        socket.emit("CMD:buffering", true);
      }
      this.localPlay();
    });
    socket.on("REC:pause", () => {
      if (this.state.exploring) {
        this.setState({ roomPaused: true });
        return;
      }
      // A pause landing on our stall (the buffer auto-pause): the others played
      // on until it did, allow one YouTube catch-up after the resume
      this.ytCatchUpArmed = this.bufferingReported;
      this.localPause();
    });
    socket.on("REC:seek", (data: number) => {
      if (this.state.exploring) {
        return;
      }
      // A room seek makes the saved-spot offer stale
      this.setState({ resumeOffer: undefined });
      // Remember where the room was, for /fb
      this.rememberPreSeek();
      this.localSeek(data);
    });
    socket.on("REC:playbackRate", (data: number) => {
      this.setState({ roomPlaybackRate: data });
      if (data > 0) {
        this.Player().setPlaybackRate(data);
      }
    });
    socket.on("REC:subtitle", (data: string) => {
      this.setState({ roomSubtitle: data }, () => {
        this.Player().loadSubtitles(data);
      });
    });
    socket.on("REC:loop", (data: boolean) => {
      this.setState({ roomLoop: data });
    });
    socket.on("REC:intermission", (data: RoomIntermission | null) => {
      this.setState({ roomIntermission: data });
    });
    socket.on("REC:sleep", (data: RoomSleepTimer | null) => {
      this.setState({ roomSleepTimer: data });
    });
    socket.on("REC:changeController", (data: string) => {
      this.setState({ controller: data });
    });
    socket.on("REC:shareRejected", () => {
      // Someone else started sharing first: drop our capture without a leave
      // (we never became the sharer), then watch theirs.
      // The rejected attempt already fired the "No audio..." yellow pill
      // (startScreenShare warns before the server answers): it blames a share
      // that never started, so clear it — and only it, "Reconnecting..." also
      // owns warningMessage
      this.setState((state) =>
        state.warningMessage.includes("No audio is being shared")
          ? { warningMessage: "" }
          : null,
      );
      this.stopConvert();
      if (this.isLocalStreamAFile) {
        // Stopping the capture doesn't stop our file playing in leftVideo
        this.HTMLInterface.pauseVideo();
        this.Player().clearState();
      }
      this.localStreamToPublish?.getTracks().forEach((track) => track.stop());
      this.localStreamToPublish = undefined;
      this.isLocalStreamAFile = false;
      this.setupRTCConnections();
      this.restorePreShareVideo();
    });
    socket.on("REC:host", async (data: HostState) => {
      let currentMedia = data.video || "";
      // A share resume is in flight (the socket reconnected while our capture
      // is still live and CMD:resumeShare is on its way): the empty "" here is
      // the pre-resume snapshot, our own share is the resume landing — the
      // capture survives both. Any other media really did take over
      if (this.resumeShareInFlight && currentMedia) {
        this.resumeShareInFlight = false;
      }
      // "" while a resume is in flight is not a share end (see above)
      const shareResuming = !currentMedia && this.resumeShareInFlight;
      if (
        this.playingScreenShare() &&
        !isScreenShare(currentMedia) &&
        !shareResuming
      ) {
        this.stopPublishingLocalStream();
      }
      if (
        this.playingFileShare() &&
        !isFileShare(currentMedia) &&
        !shareResuming
      ) {
        this.stopPublishingLocalStream();
      }
      // A replaced sharer: the room's share belongs to someone else now (ours
      // was cleared by the dead-sharer grace while our socket was gone and
      // another member started their own, or our resumeShare lost that race).
      // The capture is a zombie: it feeds no connection and the roster no
      // longer says we are the sharer. Stop it here and fall through — the
      // setState below switches us to their share and setupRTCConnections
      // builds a consumer like any viewer's
      const selfId = getOrCreateClientId();
      const ownShare =
        currentMedia === "screenshare://" + selfId ||
        currentMedia === "fileshare://" + selfId ||
        currentMedia.startsWith("screenshare://" + selfId + "@") ||
        currentMedia.startsWith("fileshare://" + selfId + "@");
      if (
        this.localStreamToPublish &&
        (isScreenShare(currentMedia) || isFileShare(currentMedia)) &&
        !ownShare
      ) {
        // Silent: "share again" would be rejected while theirs is live (also
        // covers a share attempt that lost the start race and never became ours)
        this.shareStopSilent = true;
        this.stopPublishingLocalStream();
      }
      if (this.playingVBrowser() && !isVBrowser(currentMedia)) {
        this.stopVBrowser();
      }
      if (this.localCopyFile && !isLocalCopy(currentMedia)) {
        this.dropLocalCopy();
      }
      if (this.playingScreenShare() && isScreenShare(currentMedia)) {
        // Ignore, it's probably a reconnection
        return;
      }
      if (this.playingFileShare() && isFileShare(currentMedia)) {
        // Ignore, it's probably a reconnection
        return;
      }
      if (
        this.playingLocalCopy() &&
        currentMedia === this.state.roomMedia &&
        this.localCopyFile
      ) {
        // Already playing our own copy of this file: reconnect, not a new host
        return;
      }
      if (
        this.playingVBrowser() &&
        this.getVBrowserHost() &&
        isVBrowser(currentMedia)
      ) {
        // Ignore, it's probably a reconnection
        return;
      }
      if (
        this.usingYoutube() &&
        !data.paused &&
        data.videoTS > 0 &&
        this.state.roomMedia === currentMedia &&
        (this.YouTubeInterface.watchPartyYTPlayer?.getPlayerState() ===
          window.YT?.PlayerState?.PLAYING ||
          this.YouTubeInterface.watchPartyYTPlayer?.getPlayerState() ===
            window.YT?.PlayerState?.BUFFERING)
      ) {
        // Already playing this exact video: this is a reconnect or a duplicate
        // askHost, not a new host (a real CMD:host resets videoTS to 0).
        // Stopping and re-cuing would throw away playback, and the follow-up
        // play can be swallowed while the cue reloads, leaving the viewer
        // stuck cued behind the room. The server can't replay missed events,
        // so anything broadcast while we were disconnected (subtitle, loop,
        // rate, seeks) is gone: resync it here without re-cueing
        this.setState(
          {
            roomSubtitle: data.subtitle,
            roomLoop: data.loop,
            roomPlaybackRate: data.playbackRate,
          },
          () => {
            if (data.subtitle) {
              this.Player().loadSubtitles(data.subtitle);
            }
            if (data.playbackRate) {
              this.Player().setPlaybackRate(data.playbackRate);
            }
          },
        );
        if (
          !this.state.exploring &&
          Math.abs(this.Player().getCurrentTime() - data.videoTS) > 2
        ) {
          this.localSeek(data.videoTS);
        }
        return;
      }
      // /fb must not jump into the new media at the old media's time
      this.lastSeekFrom = undefined;
      // A new video from someone else makes a pending "share again" moot
      const newVideoCame =
        !!currentMedia &&
        !isScreenShare(currentMedia) &&
        !isFileShare(currentMedia);
      this.setState(
        {
          roomMedia: currentMedia,
          roomPaused: data.paused,
          roomSubtitle: data.subtitle,
          roomLoop: data.loop,
          roomPlaybackRate: data.playbackRate,
          loading: Boolean(data.video),
          nonPlayableMedia: false,
          playbackBlocked: false,
          // New media: everyone starts it together
          exploring: false,
          localCopyNeeded: false,
          // A new video from someone else makes a pending "share again" moot
          shareEndedPrompt: newVideoCame ? false : this.state.shareEndedPrompt,
          // Recompute the resume offer: the reopen offer dies here, and a
          // room behind our saved spot offers to pull the room forward
          resumeOffer: this.getResumeOffer(currentMedia, data.videoTS),
          resumeDismissed: undefined,
          isVBrowserLarge: data.isVBrowserLarge,
          vBrowserResolution: "1280x720@30",
          vBrowserQuality: "1",
          controller: data.controller,
          isLiveStream: false,
        },
        async () => {
          const leftVideo = this.HTMLInterface.getVideoEl();

          // Stop all players
          // Unless the user is sharing a file, because we play it in leftVideo and capture stream
          if (!this.isLocalStreamAFile) {
            this.stopConvert();
            this.HTMLInterface.pauseVideo();
          }
          this.YouTubeInterface.stopVideo();

          if (!this.isLocalStreamAFile) {
            this.Player().clearState();
          }
          if (data.subtitle) {
            this.Player().loadSubtitles(data.subtitle);
          }
          if (data.playbackRate) {
            this.Player().setPlaybackRate(data.playbackRate);
          }

          if (
            this.playingScreenShare() ||
            this.playingFileShare() ||
            this.playingVBrowser()
          ) {
            console.log(
              "exiting REC:host since we are using webRTC (fileshare, screenshare, or vbrowser). Check setupRTCConnections()",
            );
            if (!(this.playingVBrowser() && !this.getVBrowserHost())) {
              // Remove the loader unless we're waiting for a vbrowser
              this.setLoadingFalse();
            }
            // The roster event that triggers setupRTCConnections may have run
            // before this setState committed roomMedia (it bails unless the
            // share type is already set), so connect the RTC paths here now
            this.setupRTCConnections();
            return;
          }
          if (isLocalCopy(currentMedia)) {
            // Local copy mode: nothing streams, each client plays its own file
            this.handleLocalCopyMedia(data);
            return;
          }
          if (this.usingYoutube() && !this.YouTubeInterface.isReady()) {
            console.log(
              "YT player not ready, onReady callback will retry when it is",
            );
            return;
          }
          const src = data.video;
          const time = data.videoTS;
          if (isMagnet(src)) {
            // WebTorrent
            if (!window.watchparty.webtorrent) {
              const WebTorrent = //@ts-expect-error
                (await import("webtorrent/dist/webtorrent.min.js")).default;
              window.watchparty.webtorrent = new WebTorrent();
              const reg = await navigator.serviceWorker?.register("/sw.min.js");
              const worker = reg.active || reg.waiting || reg.installing;
              const checkState = (worker: ServiceWorker | null) => {
                if (worker?.state === "activated") {
                  return window.watchparty.webtorrent?.createServer({
                    controller: reg,
                  });
                }
                return null;
              };
              if (!checkState(worker)) {
                worker?.addEventListener("statechange", ({ target }) =>
                  checkState(target as ServiceWorker),
                );
              }
            }
            await new Promise(async (resolve) => {
              const finish = (torrent: Torrent) => {
                // Got torrent metadata!
                console.log("Client is downloading:", torrent.infoHash);

                // Torrents can contain many files.
                const files = torrent.files;
                const fileIndex = new URLSearchParams(src).get("fileIndex");
                // Try to find a single large file to play
                let target;
                if (fileIndex != null && fileIndex !== "") {
                  target = files[Number(fileIndex)];
                }
                if (!target) {
                  target = pickSingleLargeFile(files);
                }
                if (!target) {
                  // Open the selector
                  // Selecting a file sets a new URL with the fileIndex set so we go through again
                  this.setMultiSelectModal(true);
                  this.setFileSelection(
                    files.map((f: WebTorrent.TorrentFile, i: number) => ({
                      name: f.name,
                      url: src + `&fileIndex=${i}`,
                      length: f.length,
                    })),
                  );
                } else {
                  //@ts-expect-error
                  target.streamTo(leftVideo);
                }
                resolve(undefined);
              };
              let target = await window.watchparty.webtorrent?.get(src);
              if (!target) {
                target = window.watchparty.webtorrent?.add(src, {
                  announce: [
                    "wss://tracker.btorrent.xyz",
                    "wss://tracker.openwebtorrent.com",
                  ],
                  destroyStoreOnDestroy: true,
                  maxWebConns: 4,
                  path: "/tmp/webtorrent/",
                  storeCacheSlots: 20,
                  strategy: "sequential",
                  // noPeersIntervalTime: 30,
                });
              }
              if (target?.ready) {
                finish(target);
              } else {
                target?.on("ready", () => {
                  finish(target);
                });
              }
            });
          } else if (isDash(src)) {
            if (!window.watchparty.dash) {
              const Dash = await import("dashjs");
              window.watchparty.dash = Dash.MediaPlayer().create();
              window.watchparty.dash.on("streamInitialized", (_e: any) => {
                // for a live stream:
                // html.currenttime is time since stream start
                // html.duration is infinite
                // html.seekable ends at the live edge (see getDuration)
                // player.duration is the size of the seekable range, not a position
                const isLiveStream = Boolean(
                  window.watchparty.dash?.isDynamic(),
                );
                console.log("DASH stream initialized: isLive %s", isLiveStream);
                this.setState({
                  isLiveStream,
                });
              });
            }
            window.watchparty.dash.initialize(leftVideo, src);
          } else if (isHls(src) && window.MediaSource) {
            // Prefer using hls.js if MediaSource Extensions are supported
            // otherwise fallback to native HLS support using video tag (i.e. iPhones)
            if (!window.watchparty.hls) {
              const Hls = (await import("hls.js")).default;
              window.watchparty.hls = new Hls();
              window.watchparty.hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
                const isLiveStream = data.details.live;
                this.setState({ isLiveStream });
                console.log("HLS level loaded: isLive %s", isLiveStream);
              });
            }
            window.watchparty.hls.loadSource(src);
            window.watchparty.hls.attachMedia(leftVideo);
          }
          // else if (isMpegTs(src)) {
          //   const mpegts = (await import('mpegts.js')).default;
          //   let player = mpegts.createPlayer({
          //     type: 'mse', // could also be mpegts, m2ts, flv
          //     // isLive: true,
          //     url: src,
          //   });
          //   player.attachMediaElement(leftVideo);
          //   player.load();
          //   player.play();
          // }
          else if (this.state.convertEnabled && isDirectVideoUrl(src)) {
            // clientTranscode (mediabunny glue) is only downloaded when a
            // conversion actually starts (round 123)
            const { isClientTranscodeSupported } =
              await import("../../utils/clientTranscode");
            if (isClientTranscodeSupported()) {
              await this.convertAndPlay(src, time);
            } else {
              await this.Player().setSrcAndTime(src, time);
            }
          } else {
            await this.Player().setSrcAndTime(src, time);
          }
          // Start this video
          // YouTube can't use the canplay resync below (the iframe never fires media
          // events), so resync to the room position one-shot on its first PLAYING
          this.ytNeedsFirstPlaySync = this.usingYoutube();
          this.ytUnplayable = false;
          if (!data.paused) {
            this.localPlay();
          }
          // Do right before playing
          leftVideo?.addEventListener(
            "canplay",
            () => {
              this.setLoadingFalse();
              let ts = undefined;
              // WebTorrent and Hls and Dash reset position back to 0 so set it back here
              if (
                isMagnet(src) ||
                isHls(src) ||
                isDash(src) ||
                this.state.isLiveStream
              ) {
                ts = time;
              }
              // Resync to leader since the loading might have taken some time
              this.localSeek(ts);
              // A "continue watching" reopen pulls the room to the saved spot
              // once the media is actually playing
              this.consumePendingResume();
              if (data.playbackRate) {
                // Set playback rate again since it might have been lost
                console.log("setting playback rate again", data.playbackRate);
                this.Player().setPlaybackRate(data.playbackRate);
              }
            },
            { once: true },
          );

          // Progress updater
          window.clearInterval(this.progressUpdater);
          this.setState({ downloaded: 0, total: 0, speed: 0 });
          if (currentMedia.includes("/stream?torrent=magnet")) {
            this.progressUpdater = window.setInterval(async () => {
              try {
                const response = await fetch(
                  currentMedia.replace("/stream", "/progress"),
                );
                const data = await response.json();
                this.setState({
                  downloaded: data.downloaded,
                  total: data.total,
                  speed: data.speed,
                  connections: data.connections,
                });
              } catch {
                // The stream server went away; stop polling instead of
                // throwing an unhandled rejection every second
                window.clearInterval(this.progressUpdater);
              }
            }, 1000);
          }
          if (isMagnet(currentMedia)) {
            this.progressUpdater = window.setInterval(async () => {
              const client = window.watchparty.webtorrent;
              if (client) {
                this.setState({
                  downloaded: client.torrents[0]?.downloaded,
                  total: client.torrents[0]?.length,
                  speed: client.torrents[0]?.downloadSpeed,
                  connections: client.torrents[0]?.numPeers,
                });
              }
            }, 1000);
          }
        },
      );
    });
    socket.on("REC:chat", (data: ChatMessage) => {
      if (
        !getCurrentSettings().disableChatSound &&
        !data.system &&
        ((document.visibilityState && document.visibilityState !== "visible") ||
          this.state.currentTab !== "chat")
      ) {
        if (!this.chatAudio) {
          this.chatAudio = new Audio("/clearly.mp3");
        }
        this.chatAudio.play();
      }
      // chatStore (round 130): the message must not commit the whole App;
      // Chat and the fullscreen overlay subscribe to the store themselves
      chatStore.push(data);
      // Only commits App while the column is collapsed, so the round 130
      // "a message must not re-render App" holds whenever the chat is open
      // cmd lines (host / screenshare / seek notices) are room events, not chat
      if (
        !data.system &&
        !data.cmd &&
        data.id !== clientId &&
        !this.state.showChatColumn
      ) {
        this.setState((s) => ({ chatUnread: s.chatUnread + 1 }));
      }
    });
    socket.on("REC:addReaction", (data: Reaction) => {
      const hit = chatStore.mutate(data.msgId, data.msgTimestamp, (msg) => {
        msg.reactions = msg.reactions || {};
        msg.reactions[data.value] = msg.reactions[data.value] || [];
        msg.reactions[data.value].push(data.user);
      });
      if (!hit) {
        return;
      }
      // if we add a reaction to the last message we need to scroll down
      // or else the reaction icon might be hidden
      if (
        hit.index === chatStore.getSnapshot().messages.length - 1 &&
        this.chatRef.current?.state.isNearBottom
      ) {
        this.chatRef.current?.scrollToBottom();
      }
    });
    socket.on("REC:removeReaction", (data: Reaction) => {
      chatStore.mutate(data.msgId, data.msgTimestamp, (msg) => {
        if (!msg.reactions?.[data.value]) {
          return;
        }
        msg.reactions[data.value] = msg.reactions[data.value].filter(
          (id) => id !== data.user,
        );
      });
    });
    socket.on("REC:floatReaction", (data: FloatReaction) => {
      const float: FloatReaction = {
        ...data,
        id: Date.now() + ":" + Math.random().toString(36).slice(2),
        left: 5 + Math.random() * 90,
      };
      // Cap the layer so a chatty room can't stack up hundreds of nodes
      // Functional updates: a burst arrives within one batch, so this.state is stale
      this.setState((s) => ({
        floatReactions: [...s.floatReactions, float].slice(-30),
      }));
      setTimeout(() => {
        this.setState((s) => ({
          floatReactions: s.floatReactions.filter((f) => f.id !== float.id),
        }));
      }, 2500);
    });
    socket.on("REC:tsMap", (data: NumberDict) => {
      this.tsMapData = data;
      // When the map arrived: a leader position is up to ~2 s stale (their 1 s
      // report tick + this 1 s broadcast), the catch-up click compensates it
      this.tsMapAt = Date.now();
      const onTick = () => {
        // Dynamic playback rate based on timestamps
        // Disable for sharing types where the users can have different timestamps
        // e.g. screenshare, fileshare, .m3u8 HLS streams
        // Also not necessary for WebRTC sharing since it should be close to realtime
        if (
          !this.state.roomPaused &&
          !this.state.exploring &&
          !this.state.isLiveStream &&
          this.hasDuration() &&
          this.state.roomPlaybackRate === 0
        ) {
          const leader = this.getLeaderTime();
          const delta = leader - data[clientId];
          // Set leader pbr to 1
          let pbr = 1;
          // Add .01 pbr for each 100ms delay
          if (delta > 0.5) {
            pbr += Number((delta / 10).toFixed(2));
            pbr = Math.min(pbr, 1.1);
          }
          // console.log(delta, pbr);
          if (this.Player().getPlaybackRate() !== pbr) {
            this.Player().setPlaybackRate(pbr);
          }
        }
        // Catch-up chip: drift matters at any room playback rate, so this
        // does NOT share the pbr block's roomPlaybackRate === 0 clause — the
        // server's default room rate is 1, so that clause never fires after a
        // normal join and the pbr correction above is effectively dormant
        if (
          !this.state.roomPaused &&
          !this.state.exploring &&
          !this.state.isLiveStream &&
          this.hasDuration()
        ) {
          this.updateCatchUpChip(this.getLeaderTime() - data[clientId]);
          // Steady-state accuracy (round 163): a 3-member room measured a
          // constant ~1 s offset from the join/start race that nothing
          // corrects — the pbr nudge above is dormant (roomPlaybackRate
          // defaults to 1) and the chip only shows >2 s BEHIND, on a click.
          // Auto-resync self (never the room) when |drift| > 0.5 s survives
          // 4 consecutive ticks: one seek, then quiet while the stale
          // own-entry works its way out of the next maps.
          this.maybeCorrectDrift(this.getLeaderTime() - data[clientId]);
        } else {
          // Paused / solo / live / no duration: no drift to report, take the
          // chip down if it was up
          this.updateCatchUpChip(0);
          this.driftStreak = 0;
        }
        if (this.state.roomSubtitle) {
          const sharer = this.state.participants.find((p) => p.isScreenShare);
          if (sharer && sharer.id !== clientId) {
            // Sync only if someone is sharing and it's not us
            const sharerTime = this.tsMapData[sharer.id];
            this.Player().syncSubtitles(sharerTime);
          }
        }
      };
      // Only the ts badges in the people column display these, and they only
      // change every second while it is visible — don't re-render the whole
      // tree for them otherwise
      if (
        this.state.showPeopleColumn &&
        !this.sameTsMap(this.state.tsMap, data)
      ) {
        this.setState({ tsMap: data }, onTick);
      } else {
        onTick();
      }
    });
    socket.on("REC:nameMap", (data: StringDict) => {
      this.setState({ nameMap: data });
    });
    socket.on("REC:pictureMap", (data: StringDict) => {
      this.setState({ pictureMap: data });
    });
    socket.on("REC:lock", (data: string) => {
      this.setState({ roomLock: data });
    });
    socket.on("REC:extControl", (data: { id: string | null }) => {
      this.setState({ extController: data ? data.id : null });
    });
    socket.on("REC:siteUrl", (data: { id: string; url: string }) => {
      this.setState({ extSiteUrl: data.url });
    });
    socket.on("roster", (data: User[]) => {
      this.setState({ participants: data, rosterUpdateTS: Date.now() }, () => {
        this.setupRTCConnections();
      });
    });
    socket.on("chatinit", (data: ChatMessage[]) => {
      chatStore.setHistory(data);
    });
    socket.on("playlist", (data: PlaylistVideo[]) => {
      this.setState({ playlist: data });
    });
    socket.on(
      "signalSS",
      async (data: {
        msg: { ice: any; sdp: any; reoffer?: boolean };
        from: string;
        sharer: boolean;
      }) => {
        config.NODE_ENV === "development" && console.log(data);
        // Handle messages received from signaling server
        const msg = data.msg;
        // Malformed peer data (buggy or hostile sender) drops here, before any
        // PC work: a missing/non-string sdp reads as a fingerprint change in
        // the offer path below and closes a healthy PC right before the
        // .split() throws uncaught (measured red: viewer share black), and a
        // non-object ice throws in the RTCIceCandidate constructor outside
        // the answer chain's try. Legit frames always carry an sdp string
        // (pc.localDescription) and an ice object (emit is gated on
        // event.candidate), so nothing real is dropped
        if (
          (msg.sdp != null && typeof msg.sdp.sdp !== "string") ||
          (msg.ice !== undefined &&
            (typeof msg.ice !== "object" || msg.ice === null))
        ) {
          return;
        }
        const from = data.from;
        // Determine whether the message came from the sharer or the sharee
        let pc = (
          data.sharer ? this.consumerConn : this.publisherConns[from]
        ) as RTCPeerConnection;
        if (msg.ice !== undefined) {
          // Candidates can outlive the PC they belong to (rebuild races during
          // a network blip); dropping them is fine, throwing is not
          if (pc) {
            pc.addIceCandidate(new RTCIceCandidate(msg.ice)).catch(() => {});
          }
        } else if (msg.sdp && msg.sdp.type === "offer") {
          // A PC that slept through the peer's rebuild still looks healthy; reuse costs ~3 s of measured DTLS restart.
          if (
            !pc ||
            pc.connectionState === "failed" ||
            pc.connectionState === "closed" ||
            (pc.currentRemoteDescription &&
              sdpFingerprint(pc.currentRemoteDescription.sdp) !==
                sdpFingerprint(msg.sdp.sdp))
          ) {
            if (pc) {
              pc.close();
            }
            if (data.sharer) {
              this.consumerConn = undefined;
            } else {
              delete this.publisherConns[from];
            }
            // The offer can outrun the REC:host/roster commits that create our
            // PC (setupRTCConnections bails while roomMedia/participants are
            // still stale): retry on a beat instead of dropping it — the sharer
            // never re-offers and its ICE never starts without an answer, so a
            // drop blacks the share out until re-share (measured round 54)
            for (const ms of [0, 300, 1000]) {
              if (ms) {
                await new Promise((resolve) => setTimeout(resolve, ms));
              }
              await this.setupRTCConnections();
              pc = (
                data.sharer ? this.consumerConn : this.publisherConns[from]
              ) as RTCPeerConnection;
              if (pc) {
                break;
              }
            }
            if (!pc) {
              return;
            }
          }
          // console.log('offer');
          // TODO Currently ios/Safari cannot handle this property, so remove it from the offer
          const _sdp = msg.sdp.sdp
            .split("\n")
            .filter((line: string) => {
              return line.trim() !== "a=extmap-allow-mixed";
            })
            .join("\n");
          msg.sdp.sdp = _sdp;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            const answer = await pc.createAnswer();
            // Allow stereo audio
            answer.sdp = answer.sdp?.replace(
              "useinbandfec=1",
              "useinbandfec=1; stereo=1; maxaveragebitrate=510000",
            );
            // console.log(answer.sdp);
            // Allow multichannel audio if Chromium
            //@ts-expect-error
            const isChromium = Boolean(window.chrome);
            if (isChromium) {
              answer.sdp = answer.sdp
                ?.replace("opus/48000/2", "multiopus/48000/6")
                .replace(
                  "useinbandfec=1",
                  "channel_mapping=0,4,1,2,3,5; num_streams=4; coupled_streams=2;maxaveragebitrate=510000;minptime=10;useinbandfec=1",
                );
            }
            await pc.setLocalDescription(answer);
            this.sendSignalSS(from, { sdp: pc.localDescription }, !data.sharer);
          } catch (e) {
            // The PC can be closed out from under this answer (blip rebuild,
            // roster change) while the answer chain is in flight: drop it, the
            // replacement PC negotiates on its own (measured round 58)
            console.warn("stale share offer dropped", e);
          }
        } else if (msg.sdp && msg.sdp.type === "answer") {
          // An answer for a PC we already tore down (blip rebuild) answers an
          // offer that no longer exists: drop it, the new negotiation is in flight
          if (
            pc &&
            pc.connectionState !== "closed" &&
            pc.connectionState !== "failed"
          ) {
            const startKbps = Math.round(
              Math.min(
                getShareCapMbps(this.state.participants.length - 1),
                2.5,
              ) * 1000,
            );
            msg.sdp.sdp = addShareStartBitrate(msg.sdp.sdp, startKbps);
            pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch(
              (e) => console.warn("stale share answer dropped", e),
            );
          }
        } else if (msg.reoffer && !data.sharer) {
          // The viewer's fresh PC can wait idle while a frozen sharer's 6 s
          // watchdog still sees this PC as connected; restart ICE to offer now.
          if (
            pc &&
            pc.signalingState === "stable" &&
            pc.currentRemoteDescription
          ) {
            pc.restartIce();
          }
        }
      },
    );
    socket.on("REC:getRoomState", this.handleRoomState);
    this.tsInterval = window.setInterval(() => {
      // Not while watching alone: our time would drag the leader time around
      if (this.state.roomMedia && !this.state.exploring) {
        const toSend = this.getRoomTSToSet(this.Player().getCurrentTime());
        this.socket.emit("CMD:ts", toSend);
        this.reportBuffering();
      }
      this.tickResume();
    }, 1000);
  };

  setFileSelection = (
    data: { name: string; url: string; length: number; playFn?: () => void }[],
  ) => {
    this.setState({ fileSelection: data });
  };

  // Round 150: App mounts its modals conditionally, so closing one unmounts the
  // whole Mantine Modal and its built-in returnFocus never runs — focus falls
  // to <body>. Remember the focused trigger when a modal opens and put focus
  // back after React has removed the modal from the DOM.
  modalReturnFocus: HTMLElement | null = null;
  openModalTrackingFocus = <K extends keyof AppState>(
    patch: Pick<AppState, K>,
  ) => {
    this.modalReturnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.setState(patch);
  };
  closeModalRestoreFocus = <K extends keyof AppState>(
    patch: Pick<AppState, K>,
  ) => {
    this.setState(patch);
    const el = this.modalReturnFocus;
    this.modalReturnFocus = null;
    if (el && el.isConnected) {
      // after this update commits and unmounts the modal
      window.setTimeout(() => el.focus(), 0);
    }
  };

  setMultiSelectModal = (isMultiSelectModalOpen: boolean) => {
    isMultiSelectModalOpen
      ? this.openModalTrackingFocus({ isMultiSelectModalOpen })
      : this.closeModalRestoreFocus({ isMultiSelectModalOpen });
  };

  resetMultiSelect = () => {
    this.closeModalRestoreFocus({
      isMultiSelectModalOpen: false,
      fileSelection: [],
    });
  };

  loadSettings = async () => {
    // Load settings from localstorage
    let settings = getCurrentSettings();
    this.setState({ settings });
  };

  loadSignInData = async (user: firebase.User | undefined) => {
    if (user && this.socket) {
      // NOTE: firebase auth doesn't provide the actual first name data that individual providers (G/FB) do
      // It's accessible at the time the user logs in but not afterward
      // If we want accurate surname/given name we'll need to save that somewhere
      const firstName = user.displayName?.split(" ")[0];
      if (firstName) {
        // Don't update the username if the user wants to customize their own
        // Set a flag in localstorage so we only update this once, if the user changes name manually later we won't overwrite
        // Clear the flag on logout
        if (!window.localStorage.getItem("watchparty-loginname")) {
          this.updateName(firstName);
          window.localStorage.setItem(
            "watchparty-loginname",
            Date.now().toString(),
          );
        }
      }
      const userImage = await getUserImage(user);
      if (userImage) {
        this.updatePicture(userImage);
      }
      this.updateUid(user);
    }
  };

  loadYouTube = () => {
    // This code loads the IFrame Player API code asynchronously.
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.append(tag);
    window.onYouTubeIframeAPIReady = () => {
      // Note: this fails silently if the element is not available
      const ytPlayer = new window.YT.Player("leftYt", {
        events: {
          onReady: () => {
            console.log("yt onReady");
            this.YouTubeInterface = new YouTube(ytPlayer);
            // The iframe player starts at full volume: restore the last user
            // volume/mute (round 168). Later media changes reuse this player
            this.applyStoredVolume();
            this.setState({ loading: false });
            // We might have failed to play YT originally, ask for the current video again
            if (this.usingYoutube()) {
              console.log("requesting host data again after ytReady");
              this.socket.emit("CMD:askHost");
            }
          },
          onError: (e) => {
            // 100: removed or private, 101/150: embedding disabled
            if ([100, 101, 150].includes(e.data)) {
              this.ytUnplayable = true;
              window.clearTimeout(this.playbackCheckTimer);
              this.setState({ playbackBlocked: false, loading: false });
            }
          },
          onStateChange: (e) => {
            if (
              this.usingYoutube() &&
              e.data === window.YT?.PlayerState?.CUED
            ) {
              this.setState({ loading: false });
            }
            if (
              this.usingYoutube() &&
              e.data === window.YT?.PlayerState?.ENDED
            ) {
              console.log(e.data, e.target.getVideoUrl());
              // The room's url string, not the player's normalized one — the
              // server matches the playlist-next trigger against its own video
              this.onVideoEnded(this.state.roomMedia);
            }
            if (e.data === window.YT?.PlayerState?.PLAYING)
              this.ytPlayRetried = false;
            if (
              this.ytDebounce &&
              // Solo: pausing or playing our own player isn't a room action
              !this.state.exploring &&
              // YouTube fires PLAYING/PAUSED itself right after the app drove
              // the player (a playVideo on an ENDED video reports PAUSED ~10 ms
              // later without starting, a seek landing re-buffers, R17C) — not
              // a person clicking inside the iframe, don't move the room for it
              !(
                this.usingYoutube() &&
                Date.now() - this.YouTubeInterface.lastAppCallAt <
                  YouTube.SELF_EVENT_GRACE_MS
              ) &&
              ((e.data === window.YT?.PlayerState?.PLAYING &&
                this.state.roomPaused) ||
                (e.data === window.YT?.PlayerState?.PAUSED &&
                  !this.state.roomPaused))
            ) {
              this.ytDebounce = false;
              if (this.otherControlsPlayback()) {
                // An extension member drives: don't follow the click made in
                // the YouTube iframe, snap back to the room state instead
                if (e.data === window.YT?.PlayerState?.PLAYING) {
                  this.localPause();
                } else {
                  this.localPlay();
                }
              } else if (e.data === window.YT?.PlayerState?.PLAYING) {
                this.socket.emit("CMD:play");
                this.localPlay();
              } else {
                this.socket.emit("CMD:pause");
                this.localPause();
              }
              window.setTimeout(() => (this.ytDebounce = true), 500);
            }
            if (
              this.usingYoutube() &&
              e.data === window.YT?.PlayerState?.PAUSED &&
              !this.state.exploring &&
              Date.now() - this.YouTubeInterface.lastAppCallAt <
                YouTube.SELF_EVENT_GRACE_MS &&
              this.YouTubeInterface.lastAppCallWasPlay &&
              !this.ytPlayRetried
            ) {
              // A PAUSED right after our own playVideo is YouTube's restart
              // hiccup: the embed reset to 0 but stayed paused, so suppression
              // alone left the room stuck (R17C). One local retry restarts it;
              // no room command, so nobody else moves.
              this.ytPlayRetried = true;
              console.log("yt PAUSED right after our play, retrying once");
              this.Player().playVideo();
            }
            if (
              this.usingYoutube() &&
              e.data === window.YT?.PlayerState?.PLAYING &&
              this.ytNeedsFirstPlaySync
            ) {
              // First play after joining or a media change (e.g. the user clicking
              // YouTube's play button after autoplay was blocked): jump to the room
              // position, same as the Sync button, since the cued position is stale
              this.ytNeedsFirstPlaySync = false;
              this.localSeek();
              // A "continue watching" reopen pulls the room to the saved spot
              // once the video actually plays (YouTube has no canplay event)
              this.consumePendingResume();
            }
            if (
              e.data === window.YT?.PlayerState?.PLAYING &&
              this.state.playbackBlocked
            ) {
              this.setState({ playbackBlocked: false });
            }
          },
        },
      });
    };
  };

  // Functions for managing room settings
  getInviteLink = (vanity: string) => {
    if (vanity) {
      return withRoomKey(`${window.location.origin}/r/${vanity}`);
    }
    return withRoomKey(`${window.location.origin}/watch${this.state.roomId}`);
  };

  handleRoomState = (data: any) => {
    this.setOwner(data.owner);
    this.setVanity(data.vanity);
    this.setPassword(data.password);
    this.setInviteLink(this.getInviteLink(data.vanity));
    this.setIsChatDisabled(data.isChatDisabled);
    this.setRoomTitle(data.roomTitle);
    this.setRoomDescription(data.roomDescription);
    this.setRoomTitleColor(data.roomTitleColor);
    this.setMediaPath(data.mediaPath);
    // Keep the room key out of the address bar (it lives in localStorage);
    // only invite links deliberately carry it
    const roomUrl = new URL(this.getInviteLink(data.vanity));
    roomUrl.searchParams.delete("key");
    window.history.replaceState("", "", roomUrl);
  };

  setOwner = (owner: string) => {
    this.setState({ owner });
  };
  setVanity = (vanity: string | undefined) => {
    this.setState({ vanity });
  };
  setPassword = (password: string | undefined) => {
    this.setState({ password });
  };
  setInviteLink = (inviteLink: string) => {
    this.setState({ inviteLink });
  };
  setRoomTitle = (roomTitle: string | undefined) => {
    this.setState({ roomTitle });
  };
  setRoomDescription = (roomDescription: string | undefined) => {
    this.setState({ roomDescription });
  };
  setRoomTitleColor = (roomTitleColor: string | undefined) => {
    this.setState({ roomTitleColor });
  };
  setMediaPath = (mediaPath: string | undefined) => {
    this.setState({ mediaPath });
  };

  setRoomLock = async (locked: boolean) => {
    this.socket.emit("CMD:lock", { locked });
  };

  haveLock = () => {
    if (!this.state.roomLock) {
      return true;
    }
    return this.context.user?.uid === this.state.roomLock;
  };

  setIsChatDisabled = (val: boolean) => this.setState({ isChatDisabled: val });

  clearChat = async () => {
    this.socket.emit("CMD:deleteChatMessages", {});
  };

  showError = (message: string, ms = 3000) => {
    this.setState({ errorMessage: message });
    setTimeout(() => {
      this.setState({ errorMessage: "" });
    }, ms);
  };

  // Round 185: same shape as showError but on the yellow top-center pill,
  // which overlays nothing (the red bottom-right alert sat over the chat
  // input and blocked it for the whole duration). Mantine's Alert is
  // role="alert", so screen readers announce it like the red one
  showWarning = (message: string, ms = 3000) => {
    this.setState({ warningMessage: message });
    setTimeout(() => {
      // Only clear our own message: "Reconnecting..." owns warningMessage too
      this.setState((state) =>
        state.warningMessage === message ? { warningMessage: "" } : null,
      );
    }, ms);
  };

  // Round 184: getDisplayMedia throws NotAllowedError both when the person
  // closes the picker (stay silent) and when the system or browser forbids
  // capture (the sharer saw nothing). Tell them apart: Chrome words the block
  // "Permission denied by system", or a second denial in a row arrives under
  // 1 s after the click, faster than anyone can open and dismiss a picker
  shareDeniedBefore = false;
  noteShareDenied = (err: DOMException, clickedAt: number) => {
    const blocked =
      /system/i.test(err.message) ||
      (this.shareDeniedBefore && Date.now() - clickedAt < 1000);
    this.shareDeniedBefore = true;
    if (blocked) {
      this.showError(
        "Screen sharing is blocked by your system or browser settings",
      );
    }
  };

  // Stops client-side conversion (if running) and releases its resources
  stopConvert = () => {
    this.transcoder?.stop();
    this.transcoder = undefined;
    if (
      this.state.convertProgress !== undefined ||
      this.state.audioTracks !== undefined
    ) {
      this.setState({
        convertProgress: undefined,
        audioTracks: undefined,
        audioTrackId: undefined,
      });
    }
  };

  // Switches the audio track of the file being converted (e.g. another language). Local to this device for links,
  // for a shared file it changes what everyone hears since viewers receive the converted stream.
  localSetAudioTrack = async (id: number) => {
    try {
      await this.transcoder?.selectAudioTrack(id);
    } catch (err) {
      console.error(err);
      this.showError(
        err instanceof Error ? err.message : "Unable to change audio track",
      );
    }
  };

  createTranscoder = async (
    source: File | string,
    video: HTMLMediaElement,
    startTime: number,
    onError: (err: Error) => void,
  ) => {
    // Downloaded on demand: the module is only needed once a conversion runs
    const { ClientTranscoder } = await import("../../utils/clientTranscode");
    const transcoder = new ClientTranscoder({
      source,
      video,
      startTime,
      onProgress: (fraction) => {
        if (this.transcoder === transcoder) {
          this.setState({ convertProgress: fraction });
        }
      },
      onAudioTracks: (audioTracks, audioTrackId) => {
        if (this.transcoder === transcoder) {
          this.setState({ audioTracks, audioTrackId });
        }
      },
      onError,
    });
    this.transcoder = transcoder;
    this.setState({ convertProgress: 0 });
    return transcoder;
  };

  // Plays a media URL in this browser after converting it with WebCodecs (see clientTranscode.ts), for formats the
  // browser can't play natively. Only affects this client: the room's media URL is unchanged.
  convertAndPlay = async (src: string, time: number) => {
    const video = this.HTMLInterface.getVideoEl();
    const transcoder = await this.createTranscoder(src, video, time, (err) => {
      // Conversion failed while playing. Carry on without it.
      this.showError(
        `Conversion failed: ${err.message}. Playing without conversion.`,
      );
      this.stopConvert();
      this.Player().setSrcAndTime(src, video.currentTime);
    });
    try {
      await transcoder.start();
    } catch (err) {
      console.error(err);
      if (this.transcoder === transcoder) {
        // Typically a CORS restriction or a link that isn't a media file
        this.stopConvert();
        const reason =
          err instanceof Error ? err.message : "Unable to convert this video";
        this.showError(`${reason}. Playing without conversion.`);
        await this.Player().setSrcAndTime(src, time);
      }
    }
  };

  // Puts back whatever we were watching before a file share attempt cleared
  // leftVideo: the room media didn't change, so no REC:host will reload it
  // and the RTC paths skip already-connected viewers
  restorePreShareVideo = () => {
    const preShare = this.preShareVideoState;
    this.preShareVideoState = undefined;
    const leftVideo = this.HTMLInterface.getVideoEl();
    if (!leftVideo || !preShare) {
      return;
    }
    if (this.state.roomMedia !== preShare.roomMedia) {
      // The room's media changed while we were sharing (someone else took
      // over): it's loading through the normal paths, don't cover it
      return;
    }
    if (preShare.srcObject) {
      leftVideo.srcObject = preShare.srcObject;
      leftVideo.play();
    } else if (preShare.src) {
      leftVideo.src = preShare.src;
      leftVideo.currentTime = preShare.time;
      if (!this.state.roomPaused) {
        leftVideo.play();
      }
    }
  };

  // Shares a file from this device. With convert, the file is first transcoded in this browser using WebCodecs
  // into a format browsers can play (see clientTranscode.ts), then shared the same way as an unconverted file.
  startFileShare = async (
    useMediaSoup: boolean,
    options?: { convert?: boolean },
  ) => {
    const files = await openFileSelector();
    if (!files) {
      return;
    }
    const file = files[0];
    if (options?.convert) {
      // Downloaded on demand (round 123): only a conversion actually starting
      // needs the module
      const { isClientTranscodeSupported } =
        await import("../../utils/clientTranscode");
      if (!isClientTranscodeSupported()) {
        this.showError("Your browser doesn't support converting videos");
        return;
      }
    }
    const leftVideo = this.HTMLInterface.getVideoEl();
    if (leftVideo) {
      // Snapshot what we were watching (a share stream or a direct link) so a
      // rejected share can restore it. A blob: src is an MSE attachment we
      // can't reliably re-attach, so skip it.
      this.preShareVideoState = leftVideo.srcObject
        ? {
            src: "",
            srcObject: leftVideo.srcObject as MediaStream,
            time: 0,
            roomMedia: this.state.roomMedia,
          }
        : leftVideo.src && leftVideo.src.startsWith("http")
          ? {
              src: leftVideo.src,
              srcObject: null,
              time: leftVideo.currentTime,
              roomMedia: this.state.roomMedia,
            }
          : undefined;
    }
    this.stopConvert();
    this.Player().clearState();
    // A rejected attempt (shareRejected does its own inline cleanup) leaves
    // the previous share's URL alive; drop it before pinning the new file
    if (this.fileShareObjectUrl) {
      URL.revokeObjectURL(this.fileShareObjectUrl);
      this.fileShareObjectUrl = undefined;
    }
    if (options?.convert) {
      const transcoder = await this.createTranscoder(
        file,
        leftVideo,
        0,
        (err) => {
          // Conversion failed mid-share
          this.showError(`Conversion failed: ${err.message}`);
          this.shareStopSilent = true;
          this.stopPublishingLocalStream();
        },
      );
      try {
        await transcoder.start();
      } catch (err) {
        console.error(err);
        if (this.transcoder === transcoder) {
          this.stopConvert();
          this.showError(
            err instanceof Error ? err.message : "Unable to convert this file",
          );
        }
        return;
      }
      if (this.transcoder !== transcoder) {
        // Cancelled while starting up
        return;
      }
    } else {
      this.fileShareObjectUrl = URL.createObjectURL(file);
      leftVideo.src = this.fileShareObjectUrl;
    }
    const fileShareSrc = leftVideo.src;
    const fileShareTranscoder = options?.convert ? this.transcoder : undefined;
    leftVideo.play();
    if (leftVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
      // captureStream() of a media element starts with no tracks until the
      // first frame decodes; publishers need tracks to negotiate, so wait for
      // the element to be playable before capturing. Stop waiting on an error
      // too, so a file that can't be played doesn't hang the share.
      await new Promise<void>((resolve) => {
        const stopWaiting = () => {
          leftVideo.removeEventListener("canplay", stopWaiting);
          leftVideo.removeEventListener("error", stopWaiting);
          resolve();
        };
        leftVideo.addEventListener("canplay", stopWaiting);
        leftVideo.addEventListener("error", stopWaiting);
      });
    }
    // Cancelled or replaced while waiting: don't publish a stale capture
    if (
      leftVideo.src !== fileShareSrc ||
      (options?.convert && this.transcoder !== fileShareTranscoder)
    ) {
      return;
    }
    //@ts-expect-error
    this.localStreamToPublish = leftVideo.captureStream();
    const captured = this.localStreamToPublish;
    // A video whose picture the browser can't decode (e.g. HEVC) still
    // captures its audio, which would share a black screen with the room
    if (
      !captured ||
      !captured.getTracks().length ||
      (!captured.getVideoTracks().length && !file.type.startsWith("audio/"))
    ) {
      this.localStreamToPublish = undefined;
      // The attempt cleared leftVideo and may be playing the file's audio
      this.HTMLInterface.pauseVideo();
      this.showError("This file can't be played in your browser");
      this.restorePreShareVideo();
      return;
    }
    this.isLocalStreamAFile = true;
    // A share starting supersedes a stale "Share stopped" prompt from the
    // previous one (file A ended by itself, file B starts): an intentional
    // stop of B must not resurface A's prompt
    this.setState({ shareEndedPrompt: false });
    this.socket.emit("CMD:joinScreenShare", {
      file: true,
      mediasoup: useMediaSoup,
    });
  };

  startScreenShare = async (useMediaSoup: boolean) => {
    // Screen share doesn't touch leftVideo, so there's nothing to restore
    this.preShareVideoState = undefined;
    if (navigator.mediaDevices.getDisplayMedia) {
      // The pre-round-122 constraints; the picker-hint attempt below spreads
      // them so the TypeError fallback can retry with exactly these
      const baseOptions = () => ({
        // Full HD when the screen has it; the direct share sends up to 16 Mbps
        video: { height: { ideal: 1080 }, logicalSurface: true },
        audio: {
          autoGainControl: false,
          channelCount: 2,
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 48000,
          sampleSize: 16,
        },
      });
      let stream: MediaStream;
      const clickedAt = Date.now();
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          ...baseOptions(),
          // Round 122 picker hints: keep this tab out of the picker (the owner
          // shares the whole monitor, so the watchparty tab used to be offered
          // as its own capture source), keep Chrome's "Share this tab instead"
          // switch, keep whole screens offered. Unknown dictionary members are
          // ignored per WebIDL; a TypeError from an unknown enum value (older
          // browser) falls back to baseOptions below. Cast: this TS lib.dom
          // predates these members, which are the ones older browsers ignore
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          monitorTypeSurfaces: "include",
        } as DisplayMediaStreamOptions);
      } catch (err) {
        // An old browser rejecting the new members (TypeError) must still
        // share — retry once without them. Closing the picker
        // (NotAllowedError) is a normal cancel; a real failure must not die
        // as an unhandled rejection nobody sees
        if ((err as DOMException)?.name === "TypeError") {
          try {
            stream =
              await navigator.mediaDevices.getDisplayMedia(baseOptions());
          } catch (retryErr) {
            if ((retryErr as DOMException)?.name !== "NotAllowedError") {
              this.showError("Could not start screen share");
            } else {
              this.noteShareDenied(retryErr as DOMException, clickedAt);
            }
            return;
          }
        } else {
          if ((err as DOMException)?.name !== "NotAllowedError") {
            this.showError("Could not start screen share");
          } else {
            this.noteShareDenied(err as DOMException, clickedAt);
          }
          return;
        }
      }
      this.shareDeniedBefore = false;
      const captureTrack = stream.getVideoTracks()[0];
      this.localStreamToPublish = stream;
      // Resolve the preview before the first mirror attach (round 115): the
      // stored choice, or the capture surface (a monitor captures the whole
      // screen, where the preview would show inside itself)
      this.setState({
        sharePreviewHidden: this.resolveSharePreviewHidden(captureTrack),
      });
      // Round 122: the captured surface may be (or contain) a Watchparty tab;
      // if Capture Handle says so, hide the preview for this share and warn
      // once. Re-checked on capturehandlechange (the captured tab can
      // navigate or set its handle mid-share)
      this.selfCaptureNoticed = false;
      this.checkSelfCapture(captureTrack);
      captureTrack.addEventListener("capturehandlechange", () =>
        this.checkSelfCapture(captureTrack),
      );
      // Attach the ended handler at capture time: a Stop-bar click during the
      // CMD:joinScreenShare round trip fires 'ended' before setupRTCConnections
      // (App.tsx:2318) ever runs, and a handler attached after the event fired
      // never receives it — the room would stay on a dead capture forever, and
      // every rebuild re-attaches the same ended track. setupRTCConnections'
      // !track.onended guard keeps this idempotent once PCs exist
      captureTrack.onended = () => this.stopPublishingLocalStream();
      this.isLocalStreamAFile = false;
      // Same supersede as the file share: a fresh capture clears the old
      // prompt so stopping this share doesn't resurface it
      this.setState({ shareEndedPrompt: false });
      // Round 184: audio is always requested, but sharing a window (or a
      // screen without "share system audio") returns video only, and the
      // sharer would never learn that every viewer hears nothing. Round 185:
      // moved to the yellow pill — 8 s on the red alert blocked the chat
      // input the whole time
      if (!stream.getAudioTracks().length) {
        this.showWarning(
          "No audio is being shared, so viewers will hear nothing. To share sound, pick a tab or the whole screen and tick the audio box.",
          8000,
        );
      }
      this.socket.emit("CMD:joinScreenShare", {
        file: false,
        mediasoup: useMediaSoup,
      });
    }
  };

  // "Local copy" mode: the host shares only the file's name and size; every
  // client plays its own copy from disk in the normal HTML5 player, so the
  // existing play/pause/seek/ts sync applies unchanged. Nothing is streamed,
  // so there's no WebRTC quality loss.
  startLocalCopyShare = async () => {
    const files = await openFileSelector("video/*,audio/*");
    if (!files) {
      return;
    }
    const file = files[0];
    // Switching to a different file releases the old copy; re-picking the same
    // one keeps it playing
    if (
      this.localCopyFile?.name !== file.name ||
      this.localCopyFile?.size !== file.size
    ) {
      this.dropLocalCopy();
    }
    this.localCopyFile = file;
    this.roomSetMedia(
      `localcopy://${encodeURIComponent(file.name)}@${getOrCreateClientId()}?size=${file.size}`,
    );
  };

  // Stop playing our local copy and release it (the room moved to other media)
  dropLocalCopy = () => {
    const url = this.localCopyObjectUrl;
    this.localCopyObjectUrl = undefined;
    this.localCopyFile = undefined;
    // Revoke, not just drop: the blob handle pinned the whole file until tab
    // close (measured round 110)
    if (url) {
      URL.revokeObjectURL(url);
    }
    const leftVideo = this.HTMLInterface.getVideoEl();
    if (url && leftVideo && leftVideo.src === url) {
      leftVideo.pause();
      leftVideo.src = "";
    }
  };

  handleLocalCopyMedia = (data: HostState) => {
    this.setLoadingFalse();
    const copy = parseLocalCopy(data.video ?? "");
    if (
      !this.localCopyFile ||
      !copy ||
      this.localCopyFile.name !== copy.name ||
      this.localCopyFile.size !== copy.size
    ) {
      // No matching copy open yet: ask this viewer to open theirs
      this.dropLocalCopy();
      this.setState({ localCopyNeeded: true });
      return;
    }
    if (!this.localCopyObjectUrl) {
      this.localCopyObjectUrl = URL.createObjectURL(this.localCopyFile);
    }
    const leftVideo = this.HTMLInterface.getVideoEl();
    if (!leftVideo || leftVideo.src === this.localCopyObjectUrl) {
      return;
    }
    leftVideo.src = this.localCopyObjectUrl;
    if (data.videoTS) {
      leftVideo.currentTime = data.videoTS;
    }
    if (!data.paused) {
      this.localPlay();
    }
    leftVideo.addEventListener(
      "canplay",
      () => {
        this.setLoadingFalse();
        // Resync to the room position; opening the file may have taken a while
        this.localSeek();
      },
      { once: true },
    );
  };

  // Viewer picks their own copy from the overlay prompt
  openLocalCopy = async () => {
    const copy = parseLocalCopy(this.state.roomMedia);
    if (!copy) {
      return;
    }
    const files = await openFileSelector("video/*,audio/*");
    if (!files) {
      return;
    }
    const file = files[0];
    const sizeLabel = (n: number) =>
      n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`;
    if (
      file.size !== copy.size &&
      !window.confirm(
        `"${file.name}" is ${sizeLabel(file.size)} but the room's copy of "${copy.name}" is ${sizeLabel(copy.size)}. Use it anyway?`,
      )
    ) {
      return;
    }
    this.dropLocalCopy();
    this.localCopyFile = file;
    this.localCopyObjectUrl = URL.createObjectURL(file);
    this.setState({ localCopyNeeded: false }, () => {
      const leftVideo = this.HTMLInterface.getVideoEl();
      if (!leftVideo) {
        return;
      }
      leftVideo.src = this.localCopyObjectUrl!;
      this.localSeek();
      if (!this.state.roomPaused) {
        this.localPlay();
      }
      leftVideo.addEventListener("canplay", () => this.localSeek(), {
        once: true,
      });
    });
  };

  // Share the video to mediasoup
  publishMediasoup = async (mediasoupURL: string) => {
    const localStream = this.localStreamToPublish;
    let device: MediasoupClient.types.Device = null as any;
    let producerTransport: MediasoupClient.types.Transport = null as any;

    // =========== socket.io ==========
    const connectSocket = (mediasoupURL: string) => {
      return new Promise<void>((resolve, reject) => {
        this.mediasoupPubSocket = io(mediasoupURL, {
          transports: ["websocket"],
        });

        const socket = this.mediasoupPubSocket;
        socket?.on("connect", function () {
          console.log("PUBLISH: connected to socket.io");
          resolve();
        });
        socket?.on("error", function (err) {
          console.error("PUBLISH: socket.io ERROR:", err);
          reject(err);
        });
      });
    };

    const sendRequest = (type: string, data: any) => {
      return new Promise<any>((resolve, reject) => {
        const socket = this.mediasoupPubSocket;
        socket?.emit(type, data, (err: any, response: any) => {
          if (!err) {
            // Success response, so pass the mediasoup response to the local Room.
            resolve(response);
          } else {
            reject(err);
          }
        });
      });
    };

    async function publish() {
      // --- get transport info ---
      console.log("PUBLISH: --- createProducerTransport --");
      const params = await sendRequest("createProducerTransport", {});
      console.log("PUBLISH: transport params:", params);
      producerTransport = device.createSendTransport(params);
      console.log("PUBLISH: createSendTransport:", producerTransport);

      // --- join & start publish --
      producerTransport.on(
        "connect",
        async (
          {
            dtlsParameters,
          }: { dtlsParameters: MediasoupClient.types.DtlsParameters },
          callback: () => void,
          errback: (error: Error) => void,
        ) => {
          console.log("PUBLISH: --transport connect");
          sendRequest("connectProducerTransport", {
            dtlsParameters: dtlsParameters,
          })
            .then(callback)
            .catch(errback);
        },
      );

      producerTransport.on(
        "produce",
        async (
          {
            kind,
            rtpParameters,
          }: {
            kind: string;
            rtpParameters: MediasoupClient.types.RtpParameters;
          },
          callback: ({ id }: { id: string }) => void,
          errback: (error: Error) => void,
        ) => {
          console.log("PUBLISH: --transport produce");
          try {
            const { id } = await sendRequest("produce", {
              transportId: producerTransport.id,
              kind,
              rtpParameters,
            });
            callback({ id });
          } catch (err: any) {
            errback(err);
          }
        },
      );

      // producerTransport.on('connectionstatechange', (state: string) => {
      //   switch (state) {
      //     case 'connecting':
      //       console.log('PUBLISH: connecting');
      //       break;

      //     case 'connected':
      //       console.log('PUBLISH: connected');
      //       break;

      //     case 'failed':
      //       console.log('PUBLISH: failed');
      //       producerTransport.close();
      //       break;

      //     default:
      //       break;
      //   }
      // });

      const videoTrack = localStream?.getVideoTracks()[0];
      if (videoTrack) {
        // The direct path caps the sender at the picked Mbps (sendEncodings in
        // setupRTCConnections); give the relay producer the same cap. The
        // mediasoup router clamps it to what the router supports
        const trackParams = {
          track: videoTrack,
          encodings: [{ maxBitrate: getShareMbps() * 1_000_000 }],
        };
        await producerTransport.produce(trackParams);
      }
      const audioTrack = localStream?.getAudioTracks()[0];
      if (audioTrack) {
        const trackParams = { track: audioTrack };
        await producerTransport.produce(trackParams);
      }
    }

    async function loadDevice(
      routerRtpCapabilities: MediasoupClient.types.RtpCapabilities,
    ) {
      const { Device } = await import("mediasoup-client");
      device = new Device();
      await device.load({ routerRtpCapabilities });
    }

    await connectSocket(mediasoupURL);
    // --- get capabilities --
    const data = await sendRequest("getRouterRtpCapabilities", {});
    console.log("PUBLISH: getRouterRtpCapabilities:", data);
    await loadDevice(data);
    await publish();
  };

  // Play the video from MediaSoup
  subscribeMediasoup = async (mediaSoupURL: string) => {
    let device: MediasoupClient.types.Device = null as any;
    let consumerTransport: MediasoupClient.types.Transport = null as any;
    // =========== socket.io ==========

    const connectSocket = () => {
      return new Promise<void>((resolve, reject) => {
        this.mediasoupSubSocket = io(mediaSoupURL, {
          transports: ["websocket"],
        });
        const socket = this.mediasoupSubSocket;
        socket?.on("connect", function () {
          console.log("SUBSCRIBE: connected to socket.io");
          resolve();
        });
        socket?.on("error", function (err) {
          console.error("SUBSCRIBE: socket.io ERROR:", err);
          reject(err);
        });
        socket?.on("newProducer", async function (message) {
          console.log("SUBSCRIBE: socket.io newProducer:", message);
          if (consumerTransport) {
            // start consume
            if (message.kind === "video") {
              await consumeAndResume(message.kind);
            } else if (message.kind === "audio") {
              await consumeAndResume(message.kind);
            }
          }
        });

        // socket?.on('producerClosed', function (message) {
        //   console.log('socket.io producerClosed:', message);
        //   const localId = message.localId;
        //   const remoteId = message.remoteId;
        //   const kind = message.kind;
        //   if (kind === 'video') {
        //     if (videoConsumer) {
        //       videoConsumer.close();
        //       videoConsumer = null;
        //     }
        //   } else if (kind === 'audio') {
        //     if (audioConsumer) {
        //       audioConsumer.close();
        //       audioConsumer = null;
        //     }
        //   }
        // });
      });
    };

    const sendRequest = (type: string, data: any) => {
      return new Promise<any>((resolve, reject) => {
        const socket = this.mediasoupSubSocket;
        socket?.emit(type, data, (err: Error, response: any) => {
          if (!err) {
            // Success response, so pass the mediasoup response to the local Room.
            resolve(response);
          } else {
            reject(err);
          }
        });
      });
    };

    // =========== media handling ==========
    const addRemoteTrack = (track: MediaStreamTrack) => {
      let video = this.HTMLInterface.getVideoEl();
      if (video.srcObject) {
        // Track already exists, add it
        (video.srcObject as MediaStream).addTrack(track);
      } else {
        const mediaStream = new MediaStream();
        mediaStream.addTrack(track);
        video.srcObject = mediaStream;
      }
      this.localPlay();
    };

    async function consumeAndResume(kind: string) {
      const consumer = await consume(consumerTransport, kind);
      if (consumer) {
        console.log("SUBSCRIBE: -- track exist, consumer ready. kind=" + kind);
        if (kind === "video") {
          console.log("SUBSCRIBE: -- resume kind=" + kind);
          sendRequest("resume", { kind: kind })
            .then(() => {
              console.log("SUBSCRIBE: resume OK");
              return consumer;
            })
            .catch((err) => {
              console.error("SUBSCRIBE: resume ERROR:", err);
              return consumer;
            });
        } else {
          console.log("SUBSCRIBE: -- do not resume kind=" + kind);
        }
      } else {
        console.log("SUBSCRIBE: -- no consumer yet. kind=" + kind);
        return null;
      }
    }

    async function loadDevice(
      routerRtpCapabilities: MediasoupClient.types.RtpCapabilities,
    ) {
      try {
        const { Device } = await import("mediasoup-client");
        device = new Device();
        await device.load({ routerRtpCapabilities });
      } catch (error: any) {
        if (error.name === "UnsupportedError") {
          console.error("browser not supported");
        }
      }
    }

    async function consume(
      transport: MediasoupClient.types.Transport,
      trackKind: string,
    ) {
      console.log("SUBSCRIBE: --start of consume --kind=" + trackKind);
      const { rtpCapabilities } = device;
      const data = await sendRequest("consume", {
        rtpCapabilities: rtpCapabilities,
        kind: trackKind,
      }).catch((err) => {
        console.error("SUBSCRIBE: ERROR:", err);
      });
      const { producerId, id, kind, rtpParameters } = data;

      if (producerId) {
        let codecOptions = {};
        const consumer = await transport.consume({
          id,
          producerId,
          kind,
          rtpParameters,
          //@ts-expect-error
          codecOptions,
        });

        addRemoteTrack(consumer.track);
        console.log("SUBSCRIBE: --end of consume");
        return consumer;
      } else {
        console.warn("SUBSCRIBE: ---remote producer NOT READY");
        return null;
      }
    }

    async function subscribe() {
      console.log("SUBSCRIBE: ---createConsumerTransport --");
      const params = await sendRequest("createConsumerTransport", {});
      console.log("SUBSCRIBE: transport params:", params);
      consumerTransport = device.createRecvTransport(params);
      console.log("SUBSCRIBE: createConsumerTransport:", consumerTransport);

      // --- join & start watching
      consumerTransport.on(
        "connect",
        async (
          {
            dtlsParameters,
          }: { dtlsParameters: MediasoupClient.types.DtlsParameters },
          callback: () => void,
          errback: (err: Error) => void,
        ) => {
          console.log("SUBSCRIBE: ---consumer transport connect");
          sendRequest("connectConsumerTransport", {
            dtlsParameters: dtlsParameters,
          })
            .then(callback)
            .catch(errback);
        },
      );

      // consumerTransport.on('connectionstatechange', (state: string) => {
      //   switch (state) {
      //     case 'connecting':
      //       console.log('SUBSCRIBE: connecting');
      //       break;

      //     case 'connected':
      //       console.log('SUBSCRIBE: connected');
      //       break;

      //     case 'failed':
      //       console.log('SUBSCRIBE: failed');
      //       consumerTransport.close();
      //       break;

      //     default:
      //       break;
      //   }
      // });

      await consumeAndResume("video");
      await consumeAndResume("audio");
    }

    // Clear the srcobject so we load our stream when received
    const leftVideo = this.HTMLInterface.getVideoEl();
    leftVideo.srcObject = null;
    await connectSocket();
    // --- get capabilities --
    const data = await sendRequest("getRouterRtpCapabilities", {});
    console.log("getRouterRtpCapabilities:", data);
    await loadDevice(data);
    await subscribe();
  };

  stopPublishingLocalStream = async () => {
    // Only a stop of something real can offer "share again"; intentional
    // stops (Stop Share button, failed conversion) set shareStopSilent first
    const wasSharing = Boolean(this.localStreamToPublish);
    const silent = this.shareStopSilent;
    this.shareStopSilent = false;
    this.stopConvert();
    if (this.localStreamToPublish) {
      this.socket.emit("CMD:leaveScreenShare");
      // We don't actually need to unmute if it's a fileshare but this is fine
      this.localSetMute(false);
    }
    this.localStreamToPublish &&
      this.localStreamToPublish.getTracks().forEach((track) => {
        track.stop();
      });
    this.localStreamToPublish = undefined;
    this.shareKeepAwake?.close();
    this.shareKeepAwake = undefined;
    this.shareAudioOut = undefined;
    if (wasSharing) {
      // Drop the sharer preview mirror with the capture; a viewer's consumer
      // stream lives in srcObject too, but only the publisher gets here with
      // wasSharing (their share was never "started")
      const leftVideo = this.HTMLInterface.getVideoEl();
      if (leftVideo) {
        leftVideo.srcObject = null;
        if (this.sharePreviewWasMuted !== undefined) {
          leftVideo.muted = this.sharePreviewWasMuted;
          this.sharePreviewWasMuted = undefined;
        }
      }
    }
    // Release the file share's blob URL. leftVideo keeps the already-decoded
    // media and REC:host's clearState wipes its src right after; the revoke
    // only stops the file's handle from staying pinned until tab close
    if (this.fileShareObjectUrl) {
      URL.revokeObjectURL(this.fileShareObjectUrl);
      this.fileShareObjectUrl = undefined;
    }
    if (this.consumerConn) {
      this.consumerConn.close();
      this.consumerConn = undefined;
    }
    window.clearInterval(this.shareStatsTimer);
    this.shareStatsLast = undefined;
    this.shareSendFps = [];
    this.shareStallTicks = 0;
    this.shareLastFrames = undefined;
    shareStatsStore.setStats("");
    shareStatsStore.setSend("");
    this.setState({ shareStalled: false, shareUnreachable: 0 });
    this.shareLinkDownTicks = {};
    this.shareLinkFirstSeen = {};
    Object.values(this.publisherConns).forEach((pc) => {
      pc.close();
    });
    this.publisherConns = {};
    const wasFile = this.isLocalStreamAFile;
    this.isLocalStreamAFile = false;
    if (this.mediasoupPubSocket) {
      this.mediasoupPubSocket.close();
      this.mediasoupPubSocket = null;
    }
    if (this.mediasoupSubSocket) {
      this.mediasoupSubSocket.close();
      this.mediasoupSubSocket = null;
    }
    if (wasSharing && !silent) {
      // The capture ended without the user asking (display unplugged, browser
      // ended it, the room cleared a dead-looking share): say so and offer the
      // re-share one click away
      this.shareEndedWasFile = wasFile;
      this.setState({ shareEndedPrompt: true });
    }
  };

  setupRTCConnections = async () => {
    if (!this.playingScreenShare() && !this.playingFileShare()) {
      return;
    }
    const sharer = this.state.participants.find((p) => p.isScreenShare);
    const selfId = getOrCreateClientId();
    // Stop sharing if the local stream stops. Round 185: every track, not
    // just video — an audio-only file (mp3) has no video track, so its ended
    // went unwired and the room stayed stuck on the ended share while
    // viewers' clocks ran on (measured: sharer paused at the file's 10 s,
    // viewer clock counting to 34 s and beyond)
    this.localStreamToPublish?.getTracks().forEach((track) => {
      if (!track.onended) {
        track.onended = () => this.stopPublishingLocalStream();
      }
    });
    // The sharer's own preview: no PC connects to ourselves, so nothing ever
    // streams back into the player and it stayed black (measured round 110).
    // Mirror the live capture, muted, on every setup (REC:host's clearState
    // wipes the element each time the host state re-lands)
    if (
      sharer?.id === selfId &&
      this.localStreamToPublish &&
      !this.isLocalStreamAFile
    ) {
      const leftVideo = this.HTMLInterface.getVideoEl();
      if (leftVideo) {
        // Save once per share: a mid-share clearState wipes srcObject, so a
        // later setup would re-save the element's forced-preview muted=true
        // over the user's pre-share state (measured round 111: the restore
        // then left the player muted after the share ended)
        if (
          leftVideo.srcObject !== this.localStreamToPublish &&
          this.sharePreviewWasMuted === undefined
        ) {
          this.sharePreviewWasMuted = leftVideo.muted;
        }
        // Hidden preview (round 115): the element stays reserved by the share
        // (muted state kept for the restore) but renders nothing — the note
        // takes its place. Re-setups (REC:host clearState, late joiners) must
        // not turn a hidden preview back on
        if (this.state.sharePreviewHidden) {
          leftVideo.srcObject = null;
        } else {
          leftVideo.srcObject = this.localStreamToPublish;
          leftVideo.muted = true;
          this.localPlay();
        }
      }
    }
    if (this.state.roomMedia.includes("@")) {
      let prefix = "screenshare://";
      if (this.playingFileShare()) {
        prefix = "fileshare://";
      }
      const unprefixed = this.state.roomMedia.replace(prefix, "");
      const mediasoupURL = unprefixed.split("@")[1];
      if (sharer?.id === selfId && this.mediasoupPubSocket == null) {
        await this.publishMediasoup(mediasoupURL);
      }
      // Viewers watch; the sharer doesn't play its own share back
      // avoid duplicate watching if the socket already exists
      if (!this.localStreamToPublish && this.mediasoupSubSocket == null) {
        await this.subscribeMediasoup(mediasoupURL);
      }
      return;
    }

    // We're the sharer, create a connection to each other member
    if (sharer?.id === selfId) {
      // Delete and close any connections that aren't in the current member list (maybe someone disconnected)
      // This allows them to rejoin later
      const clientIds = new Set(this.state.participants.map((p) => p.id));
      Object.entries(this.publisherConns).forEach(([key, value]) => {
        if (!clientIds.has(key)) {
          value.close();
          delete this.publisherConns[key];
        }
      });

      // A file share is encoded from leftVideo.captureStream(), which Chrome
      // throttles once the tab is hidden (window covered/minimized) AND not
      // audible (player muted, a silent scene): measured 20-25 viewer freezes
      // per 60 s vs 0. A 20 Hz tone at -63 dBFS is inaudible but keeps the
      // page "playing audio", which exempts it. Screen shares don't need it
      // (their frames don't go through the page: 0 freezes hidden)
      if (this.isLocalStreamAFile && !this.shareKeepAwake) {
        const ctx = new AudioContext();
        const tone = ctx.createOscillator();
        const gain = ctx.createGain();
        tone.frequency.value = 20;
        gain.gain.value = 0.001;
        tone.connect(gain).connect(ctx.destination);
        tone.start();
        this.shareKeepAwake = ctx;
        // Viewers heard a file share's audio ~100 ms before its picture
        // (+101 / +92 ms, box + beep clip, headless chromium). Sending the
        // captured audio through this context first (no delay node) gave
        // +19 / +28 / +16 ms in 3 runs, viewer video jitter buffer 83-104 -> 34-45 ms
        const audio = this.localStreamToPublish?.getAudioTracks()[0];
        if (audio) {
          const dest = ctx.createMediaStreamDestination();
          ctx.createMediaStreamSource(new MediaStream([audio])).connect(dest);
          this.shareAudioOut = dest.stream.getAudioTracks()[0];
        }
      }
      this.state.participants.forEach((user) => {
        const id = user.id;
        if (id === selfId) {
          // No connection to ourselves: playing our own share back costs a
          // second encode and upload bandwidth for nothing
          return;
        }
        // r220: a member who reopens the tab keeps its clientId (the server
        // supersede path keeps the roster entry), so our PC to them still
        // looks connected while ICE stares at the dead tab, and no fresh offer
        // goes out until the 6 s watchdog. The roster carries each member's
        // per-page-load id: a change means a new tab, so close the PC and let
        // the rebuild below offer at once. Not the socket id: that also
        // changes on a socket blip of a live page, where the rebuild froze the
        // share 6.6 s (measured). Old server/client: both undefined, no change
        const pageId = (user as AnyDict).pageId;
        const existing = this.publisherConns[id];
        if (existing && (existing as unknown as AnyDict).pageId !== pageId) {
          existing.close();
          delete this.publisherConns[id];
        }
        if (!this.publisherConns[id]) {
          // Set up the RTCPeerConnection for sharing media to each member
          const pc = new RTCPeerConnection({ iceServers: iceServers() });
          this.publisherConns[id] = pc;
          // r220: the page this PC serves (see the mismatch check above)
          (pc as unknown as AnyDict).pageId = pageId;
          this.localStreamToPublish?.getTracks().forEach((track) => {
            if (this.localStreamToPublish == null) {
              return;
            }
            if (track.kind === "video") {
              // Round 226: a source larger than a 1440p display (a 4K monitor
              // on a browser that skips the capture constraints, a 4K file
              // share via captureStream) used to go on the wire whole.
              // Measured: 3840x2160 on software VP9 sent ~12.5 fps at 3.2 Mbps;
              // scaled to 2560x1440 it sent ~15.7 fps at 7.9 Mbps with 12 px
              // text still readable for a desktop or phone viewer, who never
              // shows more than 1440p anyway. Cap the sender at 2560x1440 by scaling
              // both dimensions down; a factor of 1 (any <=1440p source,
              // incl. the usual 1080p capture) leaves the encodings untouched
              const trackSettings = track.getSettings();
              const shareScaleDown = Math.max(
                (trackSettings.width || 0) / 2560,
                (trackSettings.height || 0) / 1440,
                1,
              );
              // Browsers cap a peer video near 2 Mbps and drop 720p to 540p; let it use more
              const tr = pc.addTransceiver(track, {
                streams: [this.localStreamToPublish],
                // Quality picked in the share dialog (1.5-16 Mbps); on the
                // untouched default a >2-viewer room caps each new PC lower —
                // the sharer's CPU fills up before its upload (round 66). The
                // browser still sends less when the link can't carry it
                sendEncodings: [
                  {
                    maxBitrate:
                      getShareCapMbps(this.state.participants.length - 1) *
                      1_000_000,
                    ...(shareScaleDown > 1
                      ? { scaleResolutionDownBy: shareScaleDown }
                      : {}),
                  },
                ],
              });
              // Prefer VP9: on a moving picture VP8 hits the cap and drops
              // 1080p to 480x270, VP9 keeps 1080p30 at the same bitrate
              const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
              if (tr.setCodecPreferences && codecs) {
                const vp9 = codecs.filter((c) => c.mimeType === "video/VP9");
                tr.setCodecPreferences([
                  ...vp9,
                  ...codecs.filter((c) => c.mimeType !== "video/VP9"),
                ]);
              }
              // Chrome's default degradation (balanced) trades resolution for fps even when
              // the encoder could hold full resolution at the same fps: on a capped share
              // (1.0/1.5 Mbps, round 57) balanced sent 720p where maintain-resolution held
              // 1080p at the same ~29 fps, so text stayed readable. A screen share is mostly
              // text — keep the resolution; a shared video file stays on balanced, where
              // smoothness matters more than sharpness
              if (!this.isLocalStreamAFile) {
                const params = tr.sender.getParameters();
                params.degradationPreference = "maintain-resolution";
                tr.sender.setParameters(params).catch(() => {});
              }
            } else {
              pc.addTrack(
                this.shareAudioOut ?? track,
                this.localStreamToPublish,
              );
            }
          });
          pc.onicecandidate = (event) => {
            // We generated an ICE candidate, send it to peer
            if (event.candidate) {
              this.sendSignalSS(id, { ice: event.candidate }, true);
            }
          };
          // A hard transport failure would freeze the share forever: rebuild like
          // VideoChat does, on the same roster-driven path. connectionState can go
          // "failed" while iceConnectionState stays "disconnected" (measured round
          // 52) and the two fire different events — watch both, guard double-fire.
          const rebuildShare = () => {
            if (this.publisherConns[id] !== pc) {
              return;
            }
            pc.close();
            delete this.publisherConns[id];
            this.setupRTCConnections();
          };
          // A wifi switch rebinds the NAT: the old pair never answers again but
          // ICE hangs at "disconnected" and Chrome only escalates to "failed"
          // ~25-30 s later (measured round 52) — a black share that whole time.
          // A short blip self-heals in ~1-2 s (measured round 58, freeze test),
          // so 6 s of dead air is a rebind: restart ICE now instead of waiting
          // for the failed escalation (6 s, not the round-52-era 10 s: Chrome
          // escalates "disconnected"→"failed" just 8-10 s later, and the 10 s
          // watchdog lost that race half the time — measured round 74 on the
          // voice twin of this watchdog). The sharer is the offerer and drives
          // it; the viewer's half restarts from the offer it receives.
          let shareDiscTimer = 0;
          pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === "failed") {
              rebuildShare();
            } else if (pc.iceConnectionState === "disconnected") {
              window.clearTimeout(shareDiscTimer);
              shareDiscTimer = window.setTimeout(() => {
                if (
                  pc.iceConnectionState === "disconnected" &&
                  this.publisherConns[id] === pc &&
                  pc.signalingState === "stable" &&
                  pc.currentRemoteDescription
                ) {
                  // fires negotiationneeded: the handler below sends the offer
                  pc.restartIce();
                }
              }, 6000);
            } else {
              window.clearTimeout(shareDiscTimer);
            }
          };
          pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed") {
              rebuildShare();
            }
          };
          pc.onnegotiationneeded = async () => {
            // Start connection for peer's video
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              this.sendSignalSS(id, { sdp: pc.localDescription }, true);
            } catch (e) {
              // The PC can be closed out from under this offer (share
              // rebuild, viewer roster change): drop it, the replacement PC
              // negotiates on its own (same guard as the voice twin)
              console.warn("share offer aborted", e);
            }
          };
          // A dropped offer is a permanent black share: the viewer-side retry
          // (round 54) only rebuilds OUR pc when an offer lands, and the
          // sharer never re-offers. Round 202 measured the resume race: a
          // sharer waking from a long freeze offers before CMD:resumeShare
          // re-registers it server-side (socket.io flushes the send buffer
          // before the reconnect's 'connect' handler emits), the relay drops
          // every signalSS while the room has no sharer id, and this pc sits
          // have-local-offer forever while the pill reads "not reaching 1
          // viewer". One resend 3 s in covers it — by then resumeShare has
          // landed; a connected pc (stable) sends nothing
          window.setTimeout(() => {
            if (
              this.publisherConns[id] === pc &&
              pc.signalingState === "have-local-offer" &&
              pc.localDescription
            ) {
              this.sendSignalSS(id, { sdp: pc.localDescription }, true);
            }
          }, 3000);
        }
      });
      // The sharer shows what their own encoder does (pollSendStats) instead
      // of the viewer's arrival stats
      window.clearInterval(this.shareStatsTimer);
      this.shareStatsTimer = window.setInterval(
        () => this.pollSendStats(),
        2000,
      );
    }
    // We're a watcher, establish connection to sharer (not the sharer itself)
    if (sharer && !this.consumerConn && !this.localStreamToPublish) {
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      this.consumerConn = pc;
      // A fresh copy starts unstalled (and un-counted), whatever an old one
      // flagged before the rebuild. shareStatsLast too: it still holds the
      // dead PC's byte count, so the first poll on the new PC would diff
      // against it and paint a negative Mbps on the pill (measured r212)
      this.shareStallTicks = 0;
      this.shareLastFrames = undefined;
      this.shareStatsLast = undefined;
      this.setState({ shareStalled: false });
      window.clearInterval(this.shareStatsTimer);
      this.shareStatsTimer = window.setInterval(
        () => this.pollShareStats(pc),
        2000,
      );
      pc.onicecandidate = (event) => {
        // We generated an ICE candidate, send it to sharer
        if (event.candidate) {
          this.sendSignalSS(sharer.id, { ice: event.candidate });
        }
      };
      // Transport dead (see the sharer-side note): drop our copy and wait; the
      // sharer rebuilds its side and the new offer lands on the fresh
      // consumerConn created by handleSignalSS's stale guard. Both events,
      // because connectionState can fail while iceConnectionState hangs at
      // "disconnected" (measured round 52); the guard keeps double-fire safe.
      const dropDeadConsumer = () => {
        if (this.consumerConn !== pc) {
          return;
        }
        pc.close();
        this.consumerConn = undefined;
        this.consumerDied = true;
        // No copy left to poll: the frozen frame is not coming back until the
        // sharer rebuilds, so flag it now (the poll can no longer flip it)
        this.setState({ shareStalled: true });
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") {
          dropDeadConsumer();
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          dropDeadConsumer();
        }
      };
      pc.ontrack = (event: RTCTrackEvent) => {
        // Mount the stream from sharer
        // console.log(stream);
        const leftVideo = this.HTMLInterface.getVideoEl();
        if (leftVideo) {
          leftVideo.src = "";
          leftVideo.srcObject = event.streams[0];
          this.localPlay();
        }
      };
      if (this.consumerDied) {
        // On resume, the sharer's PC can still look connected while our fresh
        // PC waits idle (measured: black until 14.3 s, idle since 1.1 s).
        this.consumerDied = false;
        this.sendSignalSS(sharer.id, { reoffer: true });
      }
    }
  };

  // Badge over the shared video: "direct" or "relay (TURN)" plus what really
  // arrives, so a blurry share shows whether the path or the sender is the limit
  pollShareStats = async (pc: RTCPeerConnection) => {
    if (pc !== this.consumerConn) return;
    const stats = await pc.getStats();
    let video: any;
    let pair: any;
    stats.forEach((r: any) => {
      if (r.type === "inbound-rtp" && r.kind === "video") video = r;
      if (r.type === "transport" && r.selectedCandidatePairId) {
        pair = stats.get(r.selectedCandidatePairId);
      }
    });
    if (!video || !pair) return;
    // Stalled = no new frame across 2 consecutive polls (~4 s) AND the link
    // itself unhappy (ICE off connected). Either alone is legitimate: a static
    // screen sends no frames for minutes (measured round 95, 20 s case) and
    // ICE alone can flap during a healthy reconnect, so both must agree
    const frames = video.framesReceived ?? 0;
    if (this.shareLastFrames !== undefined) {
      this.shareStallTicks =
        frames > this.shareLastFrames ? 0 : this.shareStallTicks + 1;
    }
    this.shareLastFrames = frames;
    const iceBad =
      pc.iceConnectionState !== "connected" &&
      pc.iceConnectionState !== "completed";
    const stalled = this.shareStallTicks >= 2 && iceBad;
    if (stalled !== this.state.shareStalled) {
      this.setState({ shareStalled: stalled });
    }
    const relay = [pair.localCandidateId, pair.remoteCandidateId].some(
      (id) => stats.get(id)?.candidateType === "relay",
    );
    const now = Date.now();
    const last = this.shareStatsLast;
    this.shareStatsLast = { bytes: video.bytesReceived, ts: now };
    if (!last) return;
    const mbps =
      ((video.bytesReceived - last.bytes) * 8) / (now - last.ts) / 1000;
    const codec = stats.get(video.codecId)?.mimeType?.split("/")[1] ?? "";
    // A healthy static screen sends no frames and no bytes (rounds 95/218),
    // so the old text read "0fps · 0.0 Mbps" and looked like an error. Two
    // polls without a new frame while ICE is happy = still image, not a
    // stall; the banner above stays the sole unhealthy signal.
    const still = !iceBad && this.shareStallTicks >= 2;
    const shareStats = `${relay ? "relay (TURN)" : "direct"} · ${video.frameWidth ?? 0}x${video.frameHeight ?? 0}${still ? ` · still image ${codec}` : ` ${Math.round(video.framesPerSecond ?? 0)}fps · ${mbps.toFixed(1)} Mbps ${codec}`}`;
    shareStatsStore.setStats(shareStats);
  };

  // The sharer's own badge: what the encode actually does, which is what every
  // viewer's quality depends on. The browser, not our Mbps picker, decides the
  // real bitrate (it ramps up over the first minute and quality-limits on
  // bandwidth/CPU), so show the real limit live; the cap is only a ceiling
  shareLinkDownTicks: Record<string, number> = {};
  // When each viewer's link first appeared this share (round 185): the
  // "not reaching" count starts after a 15 s join grace
  shareLinkFirstSeen: Record<string, number> = {};
  pollSendStats = async () => {
    // A PC can die without a single event: Chrome changes iceConnectionState/
    // connectionState to "closed" on a page-side close() but fires NOTHING
    // (probed round 63), so the "closed" rebuild handlers above never run and
    // that viewer stays black forever. Scan the map on this 2 s poll instead —
    // PCs we close ourselves (stop, rebuild, roster prune) are deleted in the
    // same tick they close, so only a foreign dead entry can be found here
    const dead = Object.entries(this.publisherConns).filter(
      ([, pc]) =>
        pc.connectionState === "closed" || pc.iceConnectionState === "closed",
    );
    if (dead.length) {
      dead.forEach(([id]) => delete this.publisherConns[id]);
      this.setupRTCConnections();
    }
    // Round 184: a viewer whose link is down (offline, ICE failed/stuck in
    // disconnected) got nothing and the sharer's pill still read "sending".
    // Count per viewer id across PC rebuilds (a failed link is rebuilt and
    // starts "new" again), 3 polls (~6 s) in a row: a blip heals in 1-2 s, so
    // it never trips it. Round 185: not during a viewer's first 15 s — a
    // joining viewer's ICE sits "new" for its whole setup (8 s with a slow
    // answer, measured), which is a join, not a cut. A grace, not "was it
    // ever connected": a viewer whose ICE never gets through is rebuilt every
    // ~16 s and never reads "failed", and is exactly who this warning is for.
    // firstSeen is per viewer id for the share's lifetime (reset in
    // stopPublishingLocalStream), so PC rebuilds don't restart the grace
    const now = Date.now();
    const downTicks: Record<string, number> = {};
    Object.entries(this.publisherConns).forEach(([id, conn]) => {
      this.shareLinkFirstSeen[id] ??= now;
      const up =
        conn.iceConnectionState === "connected" ||
        conn.iceConnectionState === "completed";
      downTicks[id] =
        up || now - this.shareLinkFirstSeen[id] < 15000
          ? 0
          : (this.shareLinkDownTicks[id] ?? 0) + 1;
    });
    this.shareLinkDownTicks = downTicks;
    const unreachable = Object.values(downTicks).filter((n) => n >= 3).length;
    if (unreachable !== this.state.shareUnreachable) {
      this.setState({ shareUnreachable: unreachable });
    }
    const pc = Object.values(this.publisherConns)[0];
    if (!pc) return;
    const stats = await pc.getStats();
    let out: any;
    stats.forEach((r: any) => {
      if (r.type === "outbound-rtp" && r.kind === "video") out = r;
    });
    if (!out) return;
    const fps = Math.round(out.framesPerSecond ?? 0);
    // Badge over the last 3 polls, not one: the instantaneous value swings so
    // much it reads as broken (2-8 fps shown while the window average was 9)
    this.shareSendFps.push(fps);
    if (this.shareSendFps.length > 3) this.shareSendFps.shift();
    const avgFps = (
      this.shareSendFps.reduce((a, b) => a + b, 0) / this.shareSendFps.length
    ).toFixed(1);
    const lim = out.qualityLimitationReason ?? "none";
    const limit =
      lim === "none"
        ? ""
        : lim === "cpu"
          ? " · encoder limited by CPU"
          : ` · encoder limited by ${lim}`;
    const shareSendStats = ` · sending ${out.frameWidth ?? 0}x${out.frameHeight ?? 0} ${avgFps}fps${limit}`;
    shareStatsStore.setSend(shareSendStats);
  };

  startVBrowser = async (options: { size: string }) => {
    this.socket.emit("CMD:startVBrowser", { options });
  };

  stopVBrowser = async () => {
    this.socket.emit("CMD:stopVBrowser");
  };

  changeController = async (value: string | null) => {
    // console.log(data);
    this.socket.emit("CMD:changeController", value);
  };

  sendSignalSS = async (to: string, data: any, sharer?: boolean) => {
    // console.log('sendSS', to, data);
    this.socket.emit("signalSS", { to, msg: data, sharer });
  };

  usingYoutube = () => {
    return isYouTube(this.state.roomMedia);
  };

  usingNative = () => {
    // Anything that uses HTML Video (e.g. not YouTube, Vimeo, or other embedded JS player)
    return !this.usingYoutube();
  };

  hasDuration = () => {
    // Youtube, link, or magnet, etc. Has a defined runtime (not WebRTC)
    return (
      isHttp(this.state.roomMedia) ||
      isMagnet(this.state.roomMedia) ||
      isLocalCopy(this.state.roomMedia)
    );
  };

  playingScreenShare = () => {
    return isScreenShare(this.state.roomMedia);
  };

  playingFileShare = () => {
    return isFileShare(this.state.roomMedia);
  };

  playingLocalCopy = () => {
    return isLocalCopy(this.state.roomMedia);
  };

  playingVBrowser = () => {
    return isVBrowser(this.state.roomMedia);
  };

  getVBrowserPass = () => {
    return this.state.roomMedia.replace("vbrowser://", "").split("@")[0];
  };

  getVBrowserHost = () => {
    return this.state.roomMedia.replace("vbrowser://", "").split("@")[1];
  };

  isPauseDisabled = () => {
    return this.playingScreenShare() || this.playingVBrowser();
  };

  // Host of a live screen share: they publish the room media instead of playing
  // it, and their leftVideo only mirrors their own (muted) preview
  isSharingScreen = () => {
    return Boolean(this.localStreamToPublish && !this.isLocalStreamAFile);
  };

  // The duration of the media. For a live stream this is the live edge on the same timeline as the current time,
  // which is what hls.js reports as the duration. dash.js leaves it at Infinity, so use the end of the seekable range.
  // The controls and seeking math below depend on it being finite.
  getDuration = () => {
    const duration = this.Player().getDuration();
    if (this.state.isLiveStream && duration === Infinity) {
      const seekable = this.Player().getVideoEl()?.seekable;
      if (seekable?.length) {
        return seekable.end(seekable.length - 1);
      }
    }
    return duration;
  };

  localSeek = (customTime?: number) => {
    // Jump to the leader's position, or a custom one
    let target = customTime ?? this.getLeaderTime();
    // For live this is the offset from the leading edge (negative)
    if (this.state.isLiveStream) {
      target = this.getDuration() + (customTime ?? 0);
    }
    if (target >= 0 && target < Infinity) {
      console.log("syncing self to leader or custom:", target);
      this.Player().seekVideo(target);
      this.ensureYtPlaysAfterSeek();
    }
  };

  // Consecutive REC:tsMap ticks (>2 s behind the leader) before the chip
  // shows, so a transient hiccup doesn't flash it
  catchUpStreak = 0;
  // Milliseconds timestamp until which the chip stays hidden after a catch-up
  // click (our own tsMap entry is stale for ~2 s, which would re-arm it)
  catchUpSuppressedUntil = 0;
  // When the last REC:tsMap arrived (see catchUpNow)
  tsMapAt = 0;

  // Catch-up chip (round 62): this viewer is playing > 2 s behind the room
  // leader. The room-wide sync only nudges the playback rate (max +10%), so
  // a genuinely lagged viewer never recovers — offer a one-click local resync
  // (localSeek, no CMD:seek, the room must not follow one laggy client).
  // Held back while anyone is buffering — a stalled player's ts freezes, so
  // the "leader" position would be stale — and while we're stalled ourselves
  // (bufferingReported), same ticks the room's buffer auto-pause uses
  updateCatchUpChip = (delta: number) => {
    const othersBuffering = this.state.participants.some(
      (p) => p.id !== clientId && p.buffering,
    );
    const behind =
      Number.isFinite(delta) &&
      delta > 2 &&
      !othersBuffering &&
      !this.bufferingReported &&
      Date.now() > this.catchUpSuppressedUntil;
    this.catchUpStreak = behind ? this.catchUpStreak + 1 : 0;
    const next = behind && this.catchUpStreak >= 3 ? Math.round(delta) : null;
    if (next !== this.state.catchUpBehind) {
      this.setState({ catchUpBehind: next });
    }
  };

  catchUpNow = () => {
    this.catchUpStreak = 0;
    this.catchUpSuppressedUntil = Date.now() + 5000;
    this.setState({ catchUpBehind: null });
    // The leader is playing, so their position has advanced since the map
    // arrived — add the staleness back instead of landing 1-2 s short
    this.localSeek(this.getLeaderTime() + (Date.now() - this.tsMapAt) / 1000);
  };

  // Consecutive REC:tsMap ticks with |drift| > 0.5 s before auto-resync
  driftStreak = 0;
  // Milliseconds timestamp until which auto-resync stays quiet after firing
  // (our own last report in tsMap is stale for ~2 s, same as the chip)
  driftSuppressedUntil = 0;
  // When the last correction fired, and how many consecutive corrections did
  // not hold (drift came back > 0.5 s within 2 windows) — each failure
  // doubles the quiet window so a member that cannot keep up (slow
  // connection) is not seek-pumped into re-buffering every ~14 s
  driftLastFixAt = 0;
  driftFailedFixes = 0;
  // YouTube's one drift resync, armed by a pause that landed on our stall
  ytCatchUpArmed = false;

  maybeCorrectDrift = (delta: number) => {
    if (!Number.isFinite(delta)) {
      return;
    }
    const now = Date.now();
    if (now < this.driftSuppressedUntil) {
      // Drift came back within 2 windows of a correction: it did not hold —
      // give up the next seek and double the quiet window instead
      if (
        this.driftLastFixAt &&
        now - this.driftLastFixAt <= 20000 &&
        Math.abs(delta) > 0.5
      ) {
        this.driftFailedFixes = Math.min(this.driftFailedFixes + 1, 3);
        this.driftLastFixAt = 0;
        this.driftSuppressedUntil = now + 10000 * 2 ** this.driftFailedFixes;
        console.log("drift correction did not hold, backing off");
      }
      return;
    }
    // YouTube has its own seek pitfalls (see ensureYtPlaysAfterSeek right
    // below) and its element is not a real video: resync only once the embed
    // plays and is > 1.5 s off, through the same streak / quiet window /
    // back-off as below. It was armed only after a buffer auto-pause on our
    // stall (R17F), so a member 2 s or 5 s off for any other reason never
    // came back (R23A: 0/12 in 30 s; now 12/12 in ~4 s with one seek)
    if (this.usingYoutube()) {
      if (
        this.bufferingReported ||
        this.YouTubeInterface.watchPartyYTPlayer?.getPlayerState() !==
          window.YT?.PlayerState?.PLAYING
      ) {
        return;
      }
      if (Math.abs(delta) <= 1.5) {
        this.ytCatchUpArmed = false;
        this.driftStreak = 0;
        return;
      }
    } else {
      const el = this.Player().getVideoEl();
      // Mid-seek, locally paused, or not playing smoothly (stalled or our own
      // buffering report armed): seeking now would only re-buffer — wait for a
      // healthy player
      if (
        !el ||
        el.seeking ||
        el.paused ||
        el.readyState < 3 ||
        this.bufferingReported
      ) {
        return;
      }
    }
    if (Math.abs(delta) <= 0.5) {
      this.driftStreak = 0;
      if (now - this.driftLastFixAt > 20000) {
        this.driftFailedFixes = 0;
      }
      return;
    }
    this.driftStreak += 1;
    if (this.driftStreak < 4) {
      return;
    }
    this.driftStreak = 0;
    this.driftLastFixAt = now;
    this.driftSuppressedUntil = now + 10000;
    console.log(
      "drift",
      delta.toFixed(2),
      "s survived 4 ticks, resyncing self to leader",
    );
    this.ytCatchUpArmed = false;
    this.localSeek(this.getLeaderTime() + (Date.now() - this.tsMapAt) / 1000);
  };

  // seekTo() keeps whatever state the YouTube player is in: a seek that lands
  // while it is CUED (autoplay was swallowed) only re-cues, and the iframe API
  // can leave a seek paused or stuck in BUFFERING. The room keeps playing, so
  // no REC:play will arrive, and checkPlaybackStarted is only armed after
  // localPlay — nothing would ever re-issue playVideo() and this viewer would
  // sit frozen while everyone else advances. Check shortly after any seek
  // (the state needs a moment to settle) and nudge it back into playing.
  ensureYtPlaysAfterSeek = () => {
    if (!this.usingYoutube() || this.state.roomPaused || this.state.exploring) {
      return;
    }
    window.clearTimeout(this.ytPostSeekTimer);
    this.ytPostSeekTimer = window.setTimeout(() => {
      if (this.state.roomPaused || this.state.exploring) {
        return;
      }
      const state = this.YouTubeInterface.watchPartyYTPlayer?.getPlayerState();
      // PLAYING is fine; ENDED must not be restarted; no player yet, nothing
      // to nudge. BUFFERING gets the call too — playVideo() is a no-op while
      // legitimately buffering, and the kick for a seek wedged in it.
      if (
        state === undefined ||
        state === window.YT?.PlayerState?.PLAYING ||
        state === window.YT?.PlayerState?.ENDED
      ) {
        return;
      }
      console.log("yt not playing after seek, nudging play:", state);
      this.Player().playVideo();
      this.checkPlaybackStarted();
    }, 1200);
  };

  localPlay = async () => {
    // re-arms the one-shot PAUSED retry (see onStateChange)
    this.ytPlayRetried = false;
    if (!this.state.roomMedia) {
      return;
    }
    const canAutoplay = this.state.isAutoPlayable || (await testAutoplay());
    this.setState(
      { roomPaused: false, isAutoPlayable: canAutoplay },
      async () => {
        if (
          !this.state.isAutoPlayable ||
          (this.localStreamToPublish && !this.isLocalStreamAFile)
        ) {
          console.log("auto-muting to allow autoplay or screenshare host");
          this.localSetMute(true);
          if (!this.state.isAutoPlayable) {
            this.armAudioUnlock();
          }
        } else {
          this.localSetMute(false);
        }
        try {
          await this.Player().playVideo();
        } catch (e: any) {
          console.warn(e, e.name);
          if (e.name === "NotSupportedError" && this.usingNative()) {
            this.setState({ loading: false, nonPlayableMedia: true });
          }
        }
        this.checkPlaybackStarted();
      },
    );
  };

  // YouTube's playVideo() resolves even when the request is dropped or refused
  // (e.g. it lands before the cue completes, or the browser wants a gesture):
  // the player just stays cued. Give it one more try, then show the overlay so
  // the viewer always has a way to start it.
  checkPlaybackStarted = (retry = true) => {
    window.clearTimeout(this.playbackCheckTimer);
    this.playbackCheckTimer = window.setTimeout(
      () => {
        const state =
          this.YouTubeInterface.watchPartyYTPlayer?.getPlayerState();
        if (
          this.state.roomPaused ||
          this.isSharingScreen() ||
          !this.usingYoutube() ||
          this.ytUnplayable ||
          !this.YouTubeInterface.watchPartyYTPlayer ||
          // A swallowed play lands in CUED (5) or, when it beats the cue
          // loading, back in UNSTARTED (-1); both mean playback never started
          (state !== window.YT?.PlayerState?.CUED &&
            state !== window.YT?.PlayerState?.UNSTARTED)
        ) {
          return;
        }
        if (retry) {
          console.log("yt still cued, retrying play");
          this.Player().playVideo();
          this.checkPlaybackStarted(false);
          return;
        }
        // The cued position is stale by the time the user clicks Unmute
        this.ytNeedsFirstPlaySync = true;
        this.setState({ playbackBlocked: true });
      },
      retry ? 2000 : 1500,
    );
  };

  localPause = () => {
    this.setState({ roomPaused: true }, async () => {
      this.Player().pauseVideo();
    });
  };

  localSetMute = (muted: boolean) => {
    this.Player().setMute(muted);
    this.refreshControls();
  };

  // The gesture-side twin of the Unmute overlay button (same setState, same
  // volume restore). The sharer is excluded: their leftVideo only mirrors
  // the muted preview, and unmuting it echoes their own capture (round 111)
  audioUnlock = () => {
    // A touch's pointerdown arrives before the browser grants activation:
    // unmuting then would pause the player, so stay armed for its touchend
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      return;
    }
    AUDIO_UNLOCK_EVENTS.forEach((type) =>
      document.removeEventListener(type, this.audioUnlock),
    );
    this.audioUnlockArmed = false;
    if (
      this.state.isAutoPlayable ||
      !this.state.roomMedia ||
      this.isSharingScreen()
    ) {
      return;
    }
    this.unlockPlayback();
  };

  // Both gesture unlocks (a tap anywhere, the Unmute overlay button)
  unlockPlayback = () => {
    this.unlockedAt = Date.now();
    this.setState({ isAutoPlayable: true, playbackBlocked: false }, () => {
      this.localSetMute(false);
      // The gesture means "give me sound", not "full blast": keep the
      // user's saved volume (round 168), don't stomp it with 1
      this.localSetVolume(parseStoredVolume(localStorage.getItem(VOLUME_KEY)));
      if (!this.state.roomPaused) {
        // The element sat paused while blocked and the room moved on: start
        // from the room's position (R16B: 2.2 s behind until the drift
        // resync 4 ticks later). YouTube does this on its first PLAYING
        // (ytNeedsFirstPlaySync); a share stream is live, nothing to seek
        if (this.hasDuration() && !this.usingYoutube()) {
          this.catchUpNow();
        }
        this.localPlay();
      }
    });
  };

  armAudioUnlock = () => {
    if (this.audioUnlockArmed) {
      return;
    }
    this.audioUnlockArmed = true;
    AUDIO_UNLOCK_EVENTS.forEach((type) =>
      document.addEventListener(type, this.audioUnlock),
    );
  };

  localSetVolume = (volume: number) => {
    this.Player().setVolume(volume);
    window.localStorage.setItem(VOLUME_KEY, String(volume));
    this.refreshControls();
  };

  // (Re)created player (reload, new tab, media swap) starts at the user's last
  // volume. Mute is not remembered: localPlay mutes/unmutes on its own for
  // autoplay and screen share hosting, so a saved mute would be whatever the
  // app last forced, not the user's choice. Targets both players: whichever
  // is live takes it, the other is a null-element no-op
  applyStoredVolume = () => {
    const volume = parseStoredVolume(localStorage.getItem(VOLUME_KEY));
    this.HTMLInterface.setVolume(volume);
    this.YouTubeInterface.setVolume(volume);
    this.refreshControls();
  };

  localSubtitleModal = () => {
    // Native player uses subtitle modal.
    if (this.usingNative()) {
      this.openModalTrackingFocus({ isSubtitleModalOpen: true });
    }
  };

  roomSetPlaybackRate = (rate: number) => {
    if (this.otherControlsPlayback()) {
      return;
    }
    // emit an event to the server
    this.socket.emit("CMD:playbackRate", rate);
  };

  roomSetLoop = (loop: boolean) => {
    this.socket.emit("CMD:loop", loop);
  };

  // Poll the player for a stall (HTML5: trying to play below HAVE_FUTURE_DATA;
  // YouTube: BUFFERING state 3) and tell the room once it lasts > 1.5 s, then
  // clear it the moment it recovers. Runs from the 1 s CMD:ts tick.
  reportBuffering = () => {
    let raw = false;
    let paused = false;
    if (this.usingYoutube()) {
      // window.YT exists ({loading, loaded}) before the widget API defines
      // PlayerState: without the second ?. the tick threw (R16B, 2 of 3 runs),
      // and while both sides are undefined the equality read as a stall, so
      // hosting during the widget load paused the room at 0 (R16U)
      const buffering = window.YT?.PlayerState?.BUFFERING;
      const state = this.YouTubeInterface.watchPartyYTPlayer?.getPlayerState();
      raw = buffering !== undefined && state === buffering;
      paused = state === 2;
    } else {
      const el = this.Player().getVideoEl();
      raw = Boolean(el && !el.paused && el.readyState < 3);
      paused = Boolean(el?.paused);
    }
    // The room pausing (the buffer auto-pause too) ends the stall but not the
    // shortage: the server resumes a buffer-paused room on our "false"
    // (bufferResume), so hold it until 3 s are buffered ahead — or up to the
    // end when less is left, a stall there never got 3 s and held the room
    // paused for good (codex R17H, as the extension's bufferedAhead)
    if (paused && this.bufferingReported) {
      const liveEl = this.usingYoutube() ? null : this.Player().getVideoEl();
      if (liveEl?.srcObject) {
        // A share's MediaStream never has buffered ranges: the range test below
        // would hold the claim for good and the buffer-paused room (sharer
        // included) never resumed after the viewer's link came back (R21A)
        raw = liveEl.readyState < 3;
      } else {
        const t = this.Player().getCurrentTime();
        const range = this.Player()
          .getTimeRanges()
          .find((r) => r.start <= t + 0.5 && r.end > t);
        const need = Math.min(
          3,
          (this.Player().getDuration() || Infinity) - t - 0.25,
        );
        raw = !range || range.end - t < need;
      }
    }
    const now = Date.now();
    if (raw) {
      if (!this.bufferingSince) {
        this.bufferingSince = now;
      }
      if (!this.bufferingReported && now - this.bufferingSince > 1500) {
        this.bufferingReported = true;
        this.socket.emit("CMD:buffering", true);
      }
    } else {
      this.bufferingSince = 0;
      if (this.bufferingReported) {
        this.bufferingReported = false;
        this.socket.emit("CMD:buffering", false);
      }
    }
  };

  // "One person drives" (round 5C): an extension member holds playback control
  // and the server silently drops CMD:play/pause/seek/playbackRate from every
  // other socket — web members included. Don't send what would be dropped: the
  // controller's REC:play/pause/seek/rate broadcasts keep us in sync
  otherControlsPlayback = () =>
    Boolean(this.state.extController && this.state.extController !== clientId);

  // leftVideo's click. Right after an unlock it is the unlock tap's own click:
  // the document pointerup unlock unmounts the Unmute overlay before the
  // browser dispatches the click, which then lands here and would pause what
  // the tap just started — the whole room in an unlocked room (R16P)
  videoClick = () => {
    if (Date.now() - this.unlockedAt > 500) {
      this.roomTogglePlay();
    }
  };

  roomTogglePlay = () => {
    if (this.state.exploring) {
      if (this.Player().shouldPlay()) {
        this.Player().playVideo();
      } else {
        this.Player().pauseVideo();
      }
      this.refreshControls();
      return;
    }
    if (this.otherControlsPlayback()) {
      return;
    }
    if (!this.haveLock()) {
      return;
    }
    if (this.isPauseDisabled()) {
      return;
    }
    // YouTube goes by the room, as the button label does: the embed's own state
    // is noise while it loads (no player, -1 unstarted, 5 cued: R16V), buffers
    // (3) or has ended (0: currentTime 19.021 vs duration 19 read as "not at
    // the end", so Play sent CMD:pause, R16W). Only a paused embed (2) in a
    // playing room plays, to unstick our own player as before — but not within
    // the grace window of our own Play: the embed is still paused until its
    // delayed playVideo lands, and a Pause tapped 100-150 ms after Play read
    // that as "stuck" and sent a second CMD:play (R22C: 0/6 paused at GAP
    // 100/150 ms, 3/3 at 200+)
    const yt = this.YouTubeInterface;
    const justPlayed =
      yt.lastAppCallWasPlay &&
      Date.now() - yt.lastAppCallAt < YouTube.SELF_EVENT_GRACE_MS;
    const shouldPlay = this.usingYoutube()
      ? this.state.roomPaused ||
        (yt.watchPartyYTPlayer?.getPlayerState() === 2 && !justPlayed)
      : this.Player().shouldPlay();
    if (shouldPlay) {
      this.socket.emit("CMD:play");
      this.localPlay();
    } else {
      this.socket.emit("CMD:pause");
      this.localPause();
    }
  };

  // Watch alone / Rejoin. Rejoin jumps to the room's time and play state.
  toggleExplore = () => {
    if (!this.state.exploring) {
      // The ts tick (and its buffering reports) stops while solo: don't leave
      // a "stuck" report behind that would keep auto-pausing the room
      if (this.bufferingReported) {
        this.bufferingReported = false;
        this.bufferingSince = 0;
        this.socket.emit("CMD:buffering", false);
      }
      this.setState({ exploring: true });
      return;
    }
    this.setState({ exploring: false }, () => {
      // Our own last report in tsMap is from before going solo: leave it out
      const others = Object.entries(this.tsMapData)
        .filter(([id]) => id !== clientId)
        .map(([, ts]) => ts);
      if (others.length) {
        this.localSeek(others.length > 1 ? calculateMedian(others) : others[0]);
      }
      if (this.state.roomPaused) {
        this.Player().pauseVideo();
      } else {
        this.Player().playVideo();
      }
      this.refreshControls();
    });
  };

  // Where the room was right before the most recent seek we saw (our own
  // roomSeek, or a REC:seek from someone else): the target /fb jumps to
  lastSeekFrom?: number;

  rememberPreSeek = () => {
    const t = this.Player().getCurrentTime();
    if (Number.isFinite(t)) {
      this.lastSeekFrom = t;
    }
  };

  roomSeek = (time: number) => {
    if (this.otherControlsPlayback()) {
      return;
    }
    // A share stream has no seekable clock: a viewer's leftVideo plays the
    // received MediaStream, whose currentTime is the stream clock (starts at
    // 0), so an arrow key sent CMD:seek with a bogus target that yanked the
    // sharer's file to it (R15T: 18.9 -> 1.5). The file sharer's own element
    // has the real clock, so their arrows still scrub; screen share has the
    // same viewer path and nothing seekable behind it either. Slash commands
    // already refuse both via hasDuration
    if (
      (this.playingFileShare() && !this.isLocalStreamAFile) ||
      (this.playingScreenShare() && !this.isSharingScreen())
    ) {
      return;
    }
    let target = time;
    target = Math.max(target, 0);
    // Remember where the room was, for /fb
    this.rememberPreSeek();
    this.Player().seekVideo(target);
    if (this.state.exploring) {
      return;
    }
    this.ensureYtPlaysAfterSeek();
    const toSend = this.getRoomTSToSet(target);
    this.socket.emit("CMD:seek", toSend);
    this.setState({ resumeOffer: undefined });
  };

  // "Continue watching": runs every second from the ts tick. An empty room
  // (deploy restart, fresh server) gets an offer to reopen what this device
  // watched here last; a playing room just saves the position every ~10s so
  // the next visit can offer it back
  tickResume = () => {
    if (!this.state.roomMedia && !this.state.loading) {
      const saved = getSavedResume()[this.state.roomId];
      if (
        saved &&
        isHttp(saved.media) &&
        saved.media !== this.state.resumeDismissed &&
        saved.media !== this.state.resumeOffer?.media
      ) {
        this.setState({ resumeOffer: { ...saved, reopen: true } });
      }
      return;
    }
    this.resumeTicker++;
    if (
      this.resumeTicker % 10 !== 0 ||
      !this.hasDuration() ||
      this.state.exploring
    ) {
      return;
    }
    const t = this.Player().getCurrentTime();
    if (!Number.isFinite(t) || t < 60) {
      return;
    }
    saveResume(this.state.roomId, {
      media: this.state.roomMedia!,
      pos: t,
      at: Date.now(),
    });
  };

  // A room already playing what this device watched here before, but behind
  // our saved spot (fresh room state): offer to pull the room forward
  getResumeOffer = (
    media: string,
    roomTs: number | undefined,
  ): (SavedResume & { reopen: boolean }) | undefined => {
    const saved = getSavedResume()[this.state.roomId];
    if (!saved || saved.media !== media || saved.pos <= 60) {
      return undefined;
    }
    if (saved.pos - (roomTs ?? 0) > 30) {
      return { ...saved, reopen: false };
    }
    return undefined;
  };

  continueResume = (offer: SavedResume & { reopen: boolean }) => {
    // A room seek below covers us; don't let a still-armed reopen seek fire twice
    this.pendingResume = undefined;
    this.pendingResumeMedia = undefined;
    this.setState({ resumeOffer: undefined });
    if (offer.reopen) {
      // The room has nothing loaded: host the saved media again, then
      // consumePendingResume pulls the room to the saved spot once it plays
      this.pendingResume = offer.pos;
      this.pendingResumeMedia = offer.media;
      this.roomSetMedia(offer.media);
    } else {
      this.roomSeek(offer.pos);
    }
  };

  dismissResume = () => {
    const offer = this.state.resumeOffer;
    if (offer) {
      this.setState({ resumeOffer: undefined, resumeDismissed: offer.media });
    }
  };

  consumePendingResume = () => {
    if (
      this.pendingResume === undefined ||
      this.state.roomMedia !== this.pendingResumeMedia
    ) {
      this.pendingResume = undefined;
      this.pendingResumeMedia = undefined;
      return;
    }
    const target = this.pendingResume;
    this.pendingResume = undefined;
    this.pendingResumeMedia = undefined;
    // Fresh room: no lock holder yet, so the seek is ours to give. roomSeek
    // also moves our own player: the server relays the seek to the others only
    this.roomSeek(target);
  };

  // Chat slash commands (/30 forward, /-10 back, /12:30 or /1h9m54 to jump,
  // /fb to rewind the room to before the last seek, /help for a local hint):
  // same path as the player's seek control so everyone syncs and the "jumped
  // to" chat line appears. Screen/file share streams aren't seekable, and
  // seeking follows the same lock rule as the controls.
  roomSeekCommand = (cmd: SeekCommand) => {
    if (cmd.kind === "help") {
      this.localHelpHint();
      return;
    }
    if (!this.hasDuration() || !this.haveLock()) {
      return;
    }
    if (cmd.kind === "flashback") {
      // No seek has happened yet, nothing to flash back to
      if (this.lastSeekFrom === undefined) {
        return;
      }
      this.roomSeek(this.lastSeekFrom);
      return;
    }
    const target =
      cmd.kind === "absolute"
        ? cmd.seconds
        : this.Player().getCurrentTime() + cmd.seconds;
    this.roomSeek(target);
  };

  // /help: a hint pushed straight into this client's chat; never emitted, so
  // nobody else sees it
  localHelpHint = () => {
    chatStore.push({
      id: "",
      cmd: "help",
      system: true,
      timestamp: new Date().toISOString(),
    });
  };

  getRoomTSToSet = (time: number) => {
    let target = time;
    // In live case, can't just send video time because clients may have different durations
    // Take the passed time and compute the offset from the end time (negative)
    // Each client should use this value to compute the time to set when starting playback
    if (this.state.isLiveStream) {
      target = time - this.getDuration();
    }
    // Otherwise just return the time
    return target;
  };

  onFullScreenChange = () => {
    this.setState({ fullScreen: Boolean(document.fullscreenElement) });
    setTimeout(() => this.chatRef.current?.scrollToBottom(), 100);
  };

  // One immediate catch-up when the page becomes visible again after being
  // hidden or frozen (round 135): pull the room's current media + position
  // through the existing askHost path and tick the stats polls once instead
  // of waiting for their 1-2 s intervals. share/localcopy/vbrowser handlers
  // ignore a same-media REC:host by design (realtime streams), YouTube gets
  // the gentle >2 s resync, URL media re-cues at the server position.
  pageWake = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    this.socket.emit("CMD:askHost");
    if (this.consumerConn) {
      this.pollShareStats(this.consumerConn);
    }
    if (this.localStreamToPublish) {
      this.pollSendStats();
    }
    this.reportBuffering();
  };

  // A quick tab switch must not resync: for URL media (and a paused YouTube)
  // REC:host re-cues the player, i.e. a reload + rebuffer on every switch
  // back. Only a hide long enough for Chrome's timer throttling to matter
  // asks the host; resume/pageshow (a real freeze / bfcache) always do.
  // ponytail: fixed 60 s threshold, measure real hidden-tab drift to tune it
  hiddenAt = 0;
  pageVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt = Date.now();
      return;
    }
    if (this.hiddenAt && Date.now() - this.hiddenAt >= 60000) {
      this.pageWake();
    }
    this.hiddenAt = 0;
  };

  pageShow = (e: PageTransitionEvent) => {
    if (e.persisted) {
      this.pageWake();
    }
  };

  onKeydown = (e: any) => {
    if (!document.activeElement || document.activeElement.tagName === "BODY") {
      if (e.key === " ") {
        e.preventDefault();
        this.roomTogglePlay();
      } else if (e.key === "ArrowRight") {
        this.roomSeek(this.Player().getCurrentTime() + 10);
      } else if (e.key === "ArrowLeft") {
        this.roomSeek(this.Player().getCurrentTime() - 10);
      } else if (e.key === "t") {
        this.localFullScreen(false);
      } else if (e.key === "f") {
        this.localFullScreen(true);
      } else if (e.key === "m") {
        this.localToggleMute();
      } else if (
        e.key === "Enter" &&
        this.state.fullScreen &&
        // Match the overlay's render condition: no invisible opens from
        // theater (body) fullscreen or when the room has chat disabled
        !this.state.isChatDisabled &&
        document.fullscreenElement !== document.body
      ) {
        // Type a chat message from the fullscreen overlay
        this.setState({ chatOverlayTyping: true });
      }
    }
  };

  localFullScreen = async (bVideoOnly: boolean) => {
    // Default: fullscreen the body (theater mode)
    let container = document.body as HTMLElement;
    if (bVideoOnly || isMobile()) {
      if (this.playingVBrowser() && !isMobile()) {
        // vbrowser needs to fullscreen the control wrapper div
        // Can't really control the VBrowser on mobile anyway, so just fullscreen the video
        container = document.getElementById("leftVideoParent") as HTMLElement;
      } else if (isMobile()) {
        // e.g. iPhone only allows webkitEnterFullscreen on the video itself
        container = this.Player().getVideoEl();
      } else {
        // Fullscreen the player column (video + controls + floating reactions +
        // chat overlay): a bare fullscreened <video> can't have DOM drawn above it
        container = document.getElementById("playerColumn") as HTMLElement;
      }
    }
    if (
      !container.requestFullscreen &&
      //@ts-expect-error
      container.webkitEnterFullscreen
    ) {
      // e.g. iPhone doesn't allow requestFullscreen. Check the same method
      // name we call (round 171: the guard tested the capital-S spelling)
      //@ts-expect-error
      container.webkitEnterFullscreen();
      return;
    }
    // The browser can refuse (document lost focus mid-click, Escape race);
    // don't let it die as an unhandled rejection from a click handler
    try {
      if (!document.fullscreenElement) {
        // not currently in fullscreen
        await container.requestFullscreen();
      } else {
        // e.g. switching from video fullscreen to theater mode
        const bChangeElements = document.fullscreenElement !== container;
        await document.exitFullscreen();
        if (bChangeElements) {
          await container.requestFullscreen();
        }
      }
    } catch (e) {
      console.warn("fullscreen request failed:", e);
    }
  };
  localToggleMute = () => {
    // While the sharer preview mirrors the live capture (element forced
    // muted), a click must not unmute the mirror — the sharer would hear
    // their own capture (echo, measured round 111). The button reads
    // "Unmute" here, so record that choice and apply it when the share ends
    if (
      this.localStreamToPublish &&
      !this.isLocalStreamAFile &&
      this.sharePreviewWasMuted !== undefined
    ) {
      this.sharePreviewWasMuted = false;
      return;
    }
    this.localSetMute(!this.Player().isMuted());
  };

  // Round 115: the own-screen preview mirrors the live capture on leftVideo,
  // so a whole-monitor capture shows the preview inside itself (mirror in
  // mirror) for everyone. The sharer can hide it; one stored choice wins,
  // otherwise whole-monitor captures start hidden and window/tab shares
  // start visible. Reads/writes are wrapped: blocked storage must not kill
  // the share
  resolveSharePreviewHidden = (track: MediaStreamTrack) => {
    try {
      const stored = localStorage.getItem("watchparty-sharePreviewHidden");
      if (stored === "true" || stored === "false") {
        return stored === "true";
      }
    } catch {
      // storage blocked (private mode): fall through to the surface default
    }
    return track.getSettings().displaySurface === "monitor";
  };

  // Round 122: every Watchparty tab announces itself via Capture Handle at
  // startup (setupCaptureHandle, componentDidMount). Chromium 102+ in a
  // secure context only — everywhere else the API members simply don't
  // exist, the optional calls below are skipped and nothing changes. The
  // handle is same-origin: only a page on this origin may read it
  setupCaptureHandle = () => {
    try {
      (
        navigator.mediaDevices as MediaDevices & {
          setCaptureHandleConfig?: (config: {
            handle: string;
            exposeOrigin: boolean;
            permittedOrigins: string[];
          }) => void;
        }
      ).setCaptureHandleConfig?.({
        handle: CAPTURE_HANDLE,
        exposeOrigin: false,
        permittedOrigins: [window.location.origin],
      });
    } catch {
      // Insecure context or restricted frame: no handle, detection stays off
    }
  };

  // If the captured surface is a Watchparty tab (this one, or another room's
  // on the same monitor), the sharer is sharing the page back into the room.
  // Force the preview hidden for this share WITHOUT writing the stored
  // round-115 choice, and show the warning once per share
  checkSelfCapture = (track: MediaStreamTrack) => {
    const handle = (
      track as MediaStreamTrack & {
        getCaptureHandle?: () => {
          handle: string;
          origin?: string;
        } | null;
      }
    ).getCaptureHandle?.();
    if (handle?.handle !== CAPTURE_HANDLE) {
      return;
    }
    if (!this.state.sharePreviewHidden) {
      this.setState({ sharePreviewHidden: true });
    }
    if (!this.selfCaptureNoticed) {
      this.selfCaptureNoticed = true;
      this.showError(
        "You are sharing a Watchparty tab — viewers will see this page",
      );
    }
  };

  toggleSharePreview = () => {
    const hidden = !this.state.sharePreviewHidden;
    try {
      localStorage.setItem("watchparty-sharePreviewHidden", String(hidden));
    } catch {
      // storage blocked: the choice just doesn't persist
    }
    const leftVideo = this.HTMLInterface.getVideoEl();
    if (hidden) {
      if (leftVideo) {
        leftVideo.srcObject = null;
      }
    } else if (leftVideo && this.localStreamToPublish) {
      leftVideo.srcObject = this.localStreamToPublish;
      leftVideo.muted = true;
      this.localPlay();
    }
    this.setState({ sharePreviewHidden: hidden });
  };

  togglePictureInPicture = async () => {
    const video = this.HTMLInterface.getVideoEl() as HTMLVideoElement;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      // The browser can refuse PiP (unsupported stream, disabled by policy)
    }
  };

  roomSetMedia = (value: string) => {
    this.socket.emit("CMD:host", value);
  };

  setConvertEnabled = (convertEnabled: boolean) => {
    window.localStorage.setItem(
      "watchparty-convert",
      convertEnabled ? "1" : "0",
    );
    this.setState({ convertEnabled });
    window.location.reload();
  };

  roomPlaylistPlay = (index: number) => {
    this.roomSetMedia(this.state.playlist[index]?.url);
    this.roomPlaylistDelete(index);
  };

  roomPlaylistAdd = (value: string) => {
    this.socket.emit("CMD:playlistAdd", value);
  };

  roomPlaylistMove = (index: number, toIndex: number) => {
    // The url lets the server reject the op when our list is stale (two
    // people editing at once): the index must still point at this item
    this.socket.emit("CMD:playlistMove", {
      index,
      toIndex,
      url: this.state.playlist[index]?.url,
    });
  };

  roomPlaylistDelete = (index: number) => {
    this.socket.emit("CMD:playlistDelete", {
      index,
      url: this.state.playlist[index]?.url,
    });
  };

  updateName = (name: string) => {
    this.setState({ myName: name });
    this.socket.emit("CMD:name", name);
    window.localStorage.setItem("watchparty-username", name);
  };

  updatePicture = (url: string) => {
    this.setState({ myPicture: url });
    this.socket.emit("CMD:picture", url);
  };

  updateUid = async (user: firebase.User) => {
    const uid = user.uid;
    const token = await user.getIdToken();
    this.socket.emit("CMD:uid", { uid, token });
  };

  // Mic on/off + headphones from the chat bar; the call itself lives in
  // VideoChat (People). Whoever opens their mic is heard by the others at once
  // (they join listen-only); headphones off stops hearing them
  renderVoiceButton = () => {
    const inVoice = this.state.participants.find(
      (p) => p.id === getOrCreateClientId(),
    )?.isVideoChat;
    // Key on the track's enabled state, not its presence: a tile-muted mic
    // still has a track, and this button said "Turn off mic" there — clicking
    // it then tore the whole capture down, camera included (R16F). With a
    // muted track it unmutes in place; no track means the mic-on path
    const audio = inVoice
      ? window.watchparty.ourStream?.getAudioTracks()[0]
      : undefined;
    // A push-to-talk mic is on while closed: the key only gates it (measured:
    // after a roster render this read "Turn on mic" and the click did nothing)
    const talking = !!audio && (audio.enabled || getPushToTalk().enabled);
    const deaf = this.state.voiceDeaf;
    return (
      <>
        <ActionIcon
          title={talking ? "Turn off mic" : "Turn on mic"}
          aria-label={talking ? "Mute microphone" : "Unmute microphone"}
          color={talking ? "red" : "green"}
          // VideoChat (videoChatRef) mounts only once connected: a click before
          // that hit a null ref and was dropped with no sign of it
          disabled={this.state.state !== "connected"}
          onClick={() =>
            talking
              ? this.videoChatRef.current?.micOff()
              : audio
                ? this.videoChatRef.current?.toggleAudioWebRTC()
                : this.videoChatRef.current?.setupWebRTC()
          }
        >
          <IconMicrophone />
        </ActionIcon>
        <ActionIcon
          title={deaf ? "Hear the others" : "Don't hear the others"}
          aria-label={deaf ? "Undeafen" : "Deafen"}
          color={deaf ? "red" : "gray"}
          onClick={() => {
            window.localStorage.setItem("watchparty-deaf", deaf ? "0" : "1");
            this.setState({ voiceDeaf: !deaf });
          }}
        >
          {deaf ? <IconHeadphonesOff /> : <IconHeadphones />}
        </ActionIcon>
      </>
    );
  };

  getMediaDisplayName = (input?: string) => {
    if (!input) {
      return "";
    }
    // Show the whole URL for youtube
    if (this.usingYoutube()) {
      return input;
    }
    // The sharer's id is in the URL (screenshare://<id>[@relay/<uuid>]), so old
    // chat messages still resolve after the share ends
    if (
      input.startsWith("screenshare://") ||
      input.startsWith("fileshare://")
    ) {
      const sharerId = input.split("://")[1].split("@")[0];
      const name = this.state.nameMap[sharerId] ?? "Someone";
      return (
        name + (input.startsWith("screenshare://") ? "'s screen" : "'s file")
      );
    }
    if (input.startsWith("localcopy://")) {
      const copy = parseLocalCopy(input);
      const sharer = (copy && this.state.nameMap[copy.id]) || "Someone";
      return `${sharer}'s local copy of ${copy?.name ?? "a file"}`;
    }
    if (input.startsWith("vbrowser://")) {
      return "Virtual Browser" + (this.state.isVBrowserLarge ? "+" : "");
    }
    if (isMagnet(input)) {
      const magnetParsed = new URLSearchParams(input);
      const index = magnetParsed.get("fileIndex");
      return magnetParsed.get("dn") + (index != null ? ` (file ${index})` : "");
    }
    if (input.includes("/stream?torrent=magnet")) {
      const search = new URL(input).search;
      const searchParsed = new URLSearchParams(search);
      const magnetUrl = searchParsed.get("torrent") ?? "";
      const magnetParsed = new URLSearchParams(magnetUrl);
      const index = searchParsed.get("fileIndex");
      return (
        (magnetParsed.get("dn") ?? searchParsed.get("dn")) +
        (index != null ? ` (file ${index})` : "")
      );
    }
    if (input.includes("/proxy")) {
      const urlParsed = new URLSearchParams(input);
      const displayName = urlParsed.get("displayName");
      if (displayName) {
        return displayName;
      }
    }
    return input;
  };

  setLoadingFalse = () => {
    this.setState({ loading: false });
  };

  getLeaderTime = () => {
    const values = Object.values(this.tsMapData);
    if (values.length === 0) {
      // Nobody has reported a position yet, so there is nothing to sync to
      // (localSeek skips it, same as the 2-person Math.max() empty case)
      return Number.NEGATIVE_INFINITY;
    }
    if (this.state.participants.length > 2) {
      return calculateMedian(values);
    }
    return Math.max(...values);
  };

  // A paused room reports the same position for everyone every second; the ts
  // badges would then re-render the whole tree for an identical map
  sameTsMap = (a: NumberDict, b: NumberDict) => {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) {
      return false;
    }
    return keys.every((key) => a[key] === b[key]);
  };

  onVideoEnded = (url: string) => {
    // Ignore 'ended' that fires while a new source is still loading (source
    // switch, stale event from the previous media) — it would pause the room,
    // and advance the playlist for a video that never ended
    if (this.state.loading) {
      return;
    }
    this.localPause();
    // check if looping is on, if so set time back to 0 and restart
    if (this.state.roomLoop) {
      this.localSeek(0);
      this.localPlay();
      return;
    }
    if (this.state.playlist.length) {
      // Pass the url of the video at the time this video was started
      this.socket.emit("CMD:playlistNext", url);
      return;
    }
    // Play next fileIndex
    const re = /&fileIndex=(\d+)$/;
    const match = re.exec(this.state.roomMedia);
    if (match) {
      const fileIndex = match[1];
      const nextNum = Number(fileIndex) + 1;
      const nextUrl = this.state.roomMedia.replace(
        /&fileIndex=(\d+)$/,
        `&fileIndex=${nextNum}`,
      );
      this.roomSetMedia(nextUrl);
    }
  };

  refreshControls = () => {
    this.setState({ controlsTimestamp: Date.now() });
  };

  setSettingsModalOpen = (settingsModalOpen: boolean) => {
    settingsModalOpen
      ? this.openModalTrackingFocus({ settingsModalOpen })
      : this.closeModalRestoreFocus({ settingsModalOpen });
  };

  setTheaterMode = (theaterMode: boolean) => {
    this.setState({ theaterMode });
    window.localStorage.setItem(
      "watchparty-theater",
      Number(theaterMode).toString(),
    );
  };

  render() {
    const sharer = this.state.participants.find((p) => p.isScreenShare);
    const playlist = this.state.playlist;
    // Theater look: on unless toggled off (or in fullscreen); house lights dim
    // while something is actually playing
    const theater = this.state.theaterMode && !this.state.fullScreen;
    const lightsDown =
      theater &&
      Boolean(this.state.roomMedia) &&
      !this.state.roomPaused &&
      !this.state.loading;
    const controls = (
      <Controls
        key={this.state.controlsTimestamp}
        video={this.state.roomMedia}
        paused={
          // Solo: the button shows our own player, not the room
          this.state.exploring
            ? this.Player().shouldPlay()
            : this.state.roomPaused
        }
        roomPlaybackRate={this.state.roomPlaybackRate}
        isLiveStream={this.state.isLiveStream}
        muted={this.Player().isMuted()}
        volume={this.Player().getVolume()}
        subtitled={this.Player().isSubtitled()}
        currentTime={this.Player().getCurrentTime()}
        pollLive={() => ({
          time: this.Player().getCurrentTime(),
          leader: this.hasDuration() ? this.getLeaderTime() : undefined,
          timeRanges: this.Player().getTimeRanges(),
        })}
        duration={this.getDuration()}
        disabled={!this.haveLock() && !this.state.exploring}
        exploring={this.state.exploring}
        toggleExplore={this.hasDuration() ? this.toggleExplore : undefined}
        leaderTime={this.hasDuration() ? this.getLeaderTime() : undefined}
        isPauseDisabled={this.isPauseDisabled()}
        playbackRate={this.Player().getPlaybackRate()}
        isYouTube={this.usingYoutube()}
        timeRanges={this.Player().getTimeRanges()}
        loop={this.state.roomLoop}
        roomSetLoop={this.roomSetLoop}
        roomTogglePlay={this.roomTogglePlay}
        roomSeek={this.roomSeek}
        roomSetPlaybackRate={this.roomSetPlaybackRate}
        localFullScreen={this.localFullScreen}
        localToggleMute={this.localToggleMute}
        localSubtitleModal={this.localSubtitleModal}
        localSetVolume={this.localSetVolume}
        localSeek={this.localSeek}
        localSetSubtitleMode={this.Player().setSubtitleMode}
        roomPlaylistPlay={this.roomPlaylistPlay}
        playlist={this.state.playlist}
        audioTracks={this.state.audioTracks}
        audioTrackId={this.state.audioTrackId}
        localSetAudioTrack={this.localSetAudioTrack}
        togglePictureInPicture={
          this.usingNative() &&
          !this.playingVBrowser() &&
          document.pictureInPictureEnabled
            ? this.togglePictureInPicture
            : undefined
        }
      />
    );
    const topBar = (
      <TopBar
        roomTitle={this.state.roomTitle}
        roomDescription={this.state.roomDescription}
        roomTitleColor={this.state.roomTitleColor}
      />
    );
    return (
      <React.Fragment>
        {theater && (
          <div
            className={
              styles.theaterBackdrop +
              (lightsDown ? " " + styles.theaterLightsDown : "")
            }
          />
        )}
        {this.state.isMultiSelectModalOpen && (
          <React.Suspense fallback={null}>
            <MultiStreamModal
              streams={this.state.fileSelection}
              setMedia={this.roomSetMedia}
              resetMultiSelect={this.resetMultiSelect}
            />
          </React.Suspense>
        )}
        {this.state.isVBrowserModalOpen && (
          <React.Suspense fallback={null}>
            <VBrowserModal
              closeModal={() =>
                this.closeModalRestoreFocus({ isVBrowserModalOpen: false })
              }
              startVBrowser={this.startVBrowser}
            />
          </React.Suspense>
        )}
        {this.state.isScreenShareModalOpen && (
          <ScreenShareModal
            closeModal={() =>
              this.closeModalRestoreFocus({ isScreenShareModalOpen: false })
            }
            startScreenShare={this.startScreenShare}
          />
        )}
        {this.state.isFileShareModalOpen && (
          <React.Suspense fallback={null}>
            <FileShareModal
              closeModal={() =>
                this.closeModalRestoreFocus({ isFileShareModalOpen: false })
              }
              startFileShare={this.startFileShare}
            />
          </React.Suspense>
        )}
        {this.state.isSubtitleModalOpen && (
          <React.Suspense fallback={null}>
            <SubtitleModal
              closeModal={() =>
                this.closeModalRestoreFocus({ isSubtitleModalOpen: false })
              }
              socket={this.socket}
              roomSubtitle={this.state.roomSubtitle}
              roomMedia={this.state.roomMedia}
              haveLock={this.haveLock}
              getMediaDisplayName={this.getMediaDisplayName}
              setSubtitleMode={this.Player().setSubtitleMode}
              getSubtitleMode={this.Player().getSubtitleMode}
              loadLocalSubtitle={this.HTMLInterface.loadLocalSubtitle}
            />
          </React.Suspense>
        )}
        {this.state.state === "starting" && !this.state.roomGone && (
          <Overlay className={styles.flexCenter}>
            <Title order={2}>Loading...</Title>
          </Overlay>
        )}
        {this.state.overlayMsg && <ErrorModal error={this.state.overlayMsg} />}
        {this.state.roomGone && (
          <Modal
            opened
            onClose={() => {}}
            title="This room no longer exists."
            centered
            withCloseButton={false}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "center",
                gap: "8px",
              }}
            >
              <NewRoomButton size="xl" />
              <Button
                size="xl"
                onClick={() => {
                  window.location.href = "/";
                }}
                leftSection={<IconHome />}
              >
                Go to home
              </Button>
            </div>
          </Modal>
        )}
        {this.state.isErrorAuth && <PasswordModal roomId={this.state.roomId} />}
        {this.state.settingsModalOpen && (
          <React.Suspense fallback={null}>
            <SettingsModal
              modalOpen={this.state.settingsModalOpen}
              setModalOpen={this.setSettingsModalOpen}
              roomLock={this.state.roomLock}
              setRoomLock={this.setRoomLock}
              socket={this.socket}
              roomId={this.state.roomId}
              isChatDisabled={this.state.isChatDisabled}
              setIsChatDisabled={this.setIsChatDisabled}
              owner={this.state.owner}
              setOwner={this.setOwner}
              vanity={this.state.vanity}
              setVanity={this.setVanity}
              inviteLink={this.state.inviteLink}
              password={this.state.password}
              setPassword={this.setPassword}
              clearChat={this.clearChat}
              roomTitle={this.state.roomTitle}
              setRoomTitle={this.setRoomTitle}
              roomDescription={this.state.roomDescription}
              setRoomDescription={this.setRoomDescription}
              roomTitleColor={this.state.roomTitleColor}
              setRoomTitleColor={this.setRoomTitleColor}
              mediaPath={this.state.mediaPath}
              setMediaPath={this.setMediaPath}
            />
          </React.Suspense>
        )}
        {this.state.errorMessage && (
          <Alert
            title="Error"
            color="red"
            style={{
              position: "fixed",
              bottom: "10px",
              right: "10px",
              zIndex: 1000,
            }}
          >
            {this.state.errorMessage}
          </Alert>
        )}
        {this.state.successMessage && (
          <Alert
            title="Success"
            color="green"
            style={{
              position: "fixed",
              bottom: "10px",
              right: "10px",
              zIndex: 1000,
            }}
          >
            {this.state.successMessage}
          </Alert>
        )}
        {this.state.warningMessage && (
          <Alert
            color="yellow"
            // header={this.state.warningMessage}
            style={{
              position: "fixed",
              top: "10px",
              left: "50%",
              transform: "translate(-50%, 0)",
              zIndex: 1000,
            }}
          >
            {this.state.warningMessage}
          </Alert>
        )}
        {!this.state.fullScreen && (
          <div className={lightsDown ? styles.theaterDim : undefined}>
            {topBar}
          </div>
        )}
        {
          <div
            className={styles.mobileStack}
            style={{ margin: "0 8px", display: "flex", columnGap: "32px" }}
          >
            <div
              className={
                (this.state.fullScreen
                  ? styles.fullHeightColumnFullscreen
                  : styles.fullHeightColumn) +
                " " +
                styles.leftColumn
              }
            >
              <div
                id="playerColumn"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                  position: "relative",
                  gap: "4px",
                }}
              >
                {/* Catch-up chip: one-click local resync when this viewer is
                    clearly behind the room (fullscreen overlays live here too,
                    see round 15) */}
                {this.state.catchUpBehind !== null && (
                  <button
                    className={styles.catchUpChip}
                    onClick={this.catchUpNow}
                  >
                    You're {this.state.catchUpBehind}s behind — click to catch
                    up
                  </button>
                )}
                {/* "One person drives" (round 15B): a web member can take and
                    release playback control too — same CMD:extControl as the
                    extension. While someone else drives, the server drops our
                    CMD:play/pause/seek/playbackRate, so taking is disabled
                    with the reason. Only shown where the extension is in
                    use (someone drives, or a member announced a title) */}
                {(this.state.extController || this.state.extSiteUrl) && (
                  <div className={styles.extControlRow}>
                    {this.state.extController && (
                      <div
                        className={styles.catchUpChip}
                        style={{
                          position: "static",
                          transform: "none",
                          cursor: "default",
                        }}
                      >
                        {this.state.extController === clientId
                          ? "You control playback"
                          : (this.state.nameMap[this.state.extController] ??
                              "Someone") +
                            " controls playback (WatchParty Sync)"}
                      </div>
                    )}
                    {this.state.extController &&
                    this.state.extController !== clientId ? (
                      <Tooltip
                        label={
                          (this.state.nameMap[this.state.extController] ??
                            "Someone") + " is driving playback"
                        }
                        withArrow
                      >
                        <span style={{ display: "inline-flex" }}>
                          <button
                            className={styles.catchUpChip}
                            disabled
                            aria-label={`Take control — ${
                              this.state.nameMap[this.state.extController] ??
                              "Someone"
                            } is driving playback`}
                          >
                            Take control
                          </button>
                        </span>
                      </Tooltip>
                    ) : (
                      <button
                        className={styles.catchUpChip}
                        onClick={() =>
                          this.socket.emit(
                            "CMD:extControl",
                            this.state.extController === clientId
                              ? false
                              : true,
                          )
                        }
                      >
                        {this.state.extController === clientId
                          ? "Release control"
                          : "Take control"}
                      </button>
                    )}
                  </div>
                )}
                {!this.state.fullScreen && (
                  <React.Fragment>
                    <div
                      className={
                        styles.mobileStack +
                        (lightsDown ? " " + styles.theaterDim : "")
                      }
                    >
                      <ComboBox
                        roomSetMedia={this.roomSetMedia}
                        playlistAdd={this.roomPlaylistAdd}
                        roomMedia={this.state.roomMedia}
                        getMediaDisplayName={this.getMediaDisplayName}
                        mediaPath={this.state.mediaPath}
                        disabled={!this.haveLock()}
                      />
                    </div>
                    <div
                      className={
                        styles.mobileStack +
                        (lightsDown ? " " + styles.theaterDimControls : "")
                      }
                    >
                      {this.localStreamToPublish && (
                        <Button
                          color="red"
                          onClick={() => {
                            this.shareStopSilent = true;
                            this.stopPublishingLocalStream();
                          }}
                          leftSection={<IconX />}
                        >
                          Stop Share
                        </Button>
                      )}
                      {this.isSharingScreen() && (
                        <Button
                          onClick={this.toggleSharePreview}
                          leftSection={
                            this.state.sharePreviewHidden ? (
                              <IconEye />
                            ) : (
                              <IconEyeOff />
                            )
                          }
                        >
                          {this.state.sharePreviewHidden
                            ? "Show preview"
                            : "Hide preview"}
                        </Button>
                      )}
                      {this.state.shareEndedPrompt &&
                        !this.localStreamToPublish && (
                          <Button
                            color="yellow"
                            onClick={() => {
                              this.openModalTrackingFocus({
                                shareEndedPrompt: false,
                                isScreenShareModalOpen: !this.shareEndedWasFile,
                                isFileShareModalOpen: this.shareEndedWasFile,
                              });
                            }}
                          >
                            Share stopped — share again
                          </Button>
                        )}
                      {!this.localStreamToPublish &&
                        !sharer &&
                        !this.playingVBrowser() && (
                          <Button
                            className={styles.shareButton}
                            color="violet"
                            disabled={!this.haveLock()}
                            onClick={() => {
                              this.openModalTrackingFocus({
                                isScreenShareModalOpen: true,
                              });
                            }}
                            leftSection={<IconScreenShare />}
                          >
                            Screenshare
                          </Button>
                        )}
                      {!this.localStreamToPublish &&
                        !sharer &&
                        !this.playingVBrowser() && (
                          <Button
                            className={styles.shareButton}
                            disabled={!this.haveLock()}
                            color="violet"
                            onClick={() => {
                              this.openModalTrackingFocus({
                                isVBrowserModalOpen: true,
                              });
                            }}
                            leftSection={<IconBrowser />}
                          >
                            VBrowser
                          </Button>
                        )}
                      <Menu withinPortal shadow="sm" width={170}>
                        <Menu.Target>
                          <Button
                            className={styles.shareButton}
                            color="violet"
                            disabled={!this.haveLock()}
                            leftSection={<IconCoffee />}
                          >
                            Intermission
                          </Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {[5, 10, 15].map((m) => (
                            <Menu.Item
                              key={m}
                              onClick={() =>
                                this.socket.emit("CMD:intermission", m)
                              }
                            >
                              Break for {m} min
                            </Menu.Item>
                          ))}
                          <Menu.Item
                            onClick={() =>
                              this.socket.emit("CMD:intermission", 0)
                            }
                          >
                            Back whenever
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                      {this.playingVBrowser() && (
                        <>
                          <Button
                            color="red"
                            disabled={!this.haveLock()}
                            onClick={this.stopVBrowser}
                            leftSection={<IconX />}
                          >
                            Stop VBrowser
                          </Button>
                          <Select
                            leftSection={<IconKeyboardFilled />}
                            value={this.state.controller}
                            placeholder="No controller"
                            clearable
                            onChange={this.changeController}
                            disabled={!this.haveLock()}
                            data={this.state.participants.map((p) => ({
                              label: this.state.nameMap[p.id] || p.id,
                              value: p.id,
                            }))}
                          ></Select>
                          <Select
                            leftSection={<IconUserScreen />}
                            disabled={!this.haveLock()}
                            value={this.state.vBrowserResolution}
                            onChange={(value) =>
                              this.setState({
                                vBrowserResolution: value!,
                              })
                            }
                            data={[
                              {
                                label: "1080p (Plus only)",
                                value: "1920x1080@30",
                                disabled: !this.state.isVBrowserLarge,
                              },
                              {
                                label: "720p",
                                value: "1280x720@30",
                              },
                              {
                                label: "576p",
                                value: "1024x576@60",
                              },
                              {
                                label: "486p",
                                value: "864x486@60",
                              },
                              {
                                label: "360p",
                                value: "640x360@60",
                              },
                            ]}
                          ></Select>
                          <Select
                            leftSection={<IconAntennaBars5 />}
                            disabled={!this.haveLock()}
                            value={this.state.vBrowserQuality}
                            onChange={(value) => {
                              this.setState({
                                vBrowserQuality: value!,
                              });
                            }}
                            data={[
                              {
                                label: "Eco (0.25x)",
                                value: "0.25",
                              },
                              {
                                label: "Low (0.5x)",
                                value: "0.5",
                              },
                              {
                                label: "Standard (1x)",
                                value: "1",
                              },
                              {
                                label: "High (1.5x)",
                                value: "1.5",
                              },
                              {
                                label: "Ultra (2x)",
                                value: "2",
                              },
                            ]}
                          ></Select>
                        </>
                      )}
                      {!this.localStreamToPublish &&
                        !sharer &&
                        !this.playingVBrowser() && (
                          <Button
                            className={styles.shareButton}
                            color="violet"
                            disabled={!this.haveLock()}
                            onClick={() => {
                              this.openModalTrackingFocus({
                                isFileShareModalOpen: true,
                              });
                            }}
                            leftSection={<IconFile />}
                          >
                            File
                          </Button>
                        )}
                      {!this.localStreamToPublish &&
                        !sharer &&
                        !this.playingVBrowser() && (
                          <Button
                            className={styles.shareButton}
                            color="violet"
                            disabled={!this.haveLock()}
                            onClick={this.startLocalCopyShare}
                            leftSection={<IconFiles />}
                          >
                            Local copy
                          </Button>
                        )}
                      {false && (
                        <SearchComponent
                          setMedia={this.roomSetMedia}
                          playlistAdd={this.roomPlaylistAdd}
                          type={"youtube"}
                          setShowMultiSelect={this.setMultiSelectModal}
                          setFileSelection={this.setFileSelection}
                          disabled={!this.haveLock()}
                        />
                      )}
                      {Boolean(this.context.streamPath) && (
                        <SearchComponent
                          setMedia={this.roomSetMedia}
                          playlistAdd={this.roomPlaylistAdd}
                          type={"stream"}
                          setShowMultiSelect={this.setMultiSelectModal}
                          setFileSelection={this.setFileSelection}
                          disabled={!this.haveLock()}
                        />
                      )}
                      <Menu>
                        <Menu.Target>
                          <Button
                            color="violet"
                            leftSection={<IconList />}
                            rightSection={
                              <Badge circle>{playlist.length}</Badge>
                            }
                            className={styles.shareButton}
                          >
                            Playlist
                          </Button>
                        </Menu.Target>
                        <Menu.Dropdown
                          style={{
                            overflowY:
                              playlist.length > 0 ? "scroll" : undefined,
                            maxHeight: 400,
                            maxWidth: isMobile() ? 400 : 600,
                          }}
                        >
                          {playlist.length === 0 && (
                            <Menu.Item disabled>
                              There are no items in the playlist.
                            </Menu.Item>
                          )}
                          {playlist.map(
                            (item: PlaylistVideo, index: number) => {
                              if (Boolean(item.img)) {
                                item.type = "youtube";
                              }
                              return (
                                <Menu.Item key={index}>
                                  <ChatVideoCard
                                    video={item}
                                    index={index}
                                    controls
                                    onPlay={this.roomPlaylistPlay}
                                    onPlayNext={(index) => {
                                      this.roomPlaylistMove(index, 0);
                                    }}
                                    onRemove={(index) => {
                                      this.roomPlaylistDelete(index);
                                    }}
                                    disabled={!this.haveLock()}
                                  />
                                </Menu.Item>
                              );
                            },
                          )}
                        </Menu.Dropdown>
                      </Menu>
                      <ConvertToggle
                        checked={this.state.convertEnabled}
                        onChange={(v) => this.setConvertEnabled(v)}
                      />
                      <Tooltip
                        multiline
                        w={280}
                        refProp="rootRef"
                        label="Cinema look: curtains and house lights. Turn off for the classic layout."
                      >
                        <Switch
                          label="Theater"
                          checked={this.state.theaterMode}
                          onChange={(e) =>
                            this.setTheaterMode(e.currentTarget.checked)
                          }
                          className={styles.theaterSwitch}
                          style={{ flexShrink: 0, alignSelf: "center" }}
                        />
                      </Tooltip>
                    </div>
                  </React.Fragment>
                )}
                <div style={{ flexGrow: 1, position: "relative" }}>
                  <div
                    className={
                      styles.playerContainer +
                      (theater ? " " + styles.theaterPlayer : "")
                    }
                  >
                    {theater && (
                      <div
                        className={
                          styles.curtainClip +
                          (lightsDown ? " " + styles.curtainClipOpen : "")
                        }
                      >
                        <div
                          className={styles.curtain + " " + styles.curtainLeft}
                        />
                        <div
                          className={styles.curtain + " " + styles.curtainRight}
                        />
                      </div>
                    )}
                    {this.playingScreenShare() &&
                      sharer &&
                      sharer.id !== clientId && (
                        <span className={styles.visuallyHidden}>
                          {(this.state.nameMap[sharer.id] ?? "Someone") +
                            " is sharing their screen"}
                        </span>
                      )}
                    <ShareStatsPills
                      sharing={this.isSharingScreen()}
                      capMbps={getShareCapMbps(
                        this.state.participants.length - 1,
                      )}
                      stalled={this.state.shareStalled}
                      unreachable={this.state.shareUnreachable}
                    />
                    {this.state.shareStalled && (
                      <div className={styles.shareStalled}>Reconnecting…</div>
                    )}
                    {this.isSharingScreen() &&
                      this.state.sharePreviewHidden && (
                        <div className={styles.sharePreviewPlaceholder}>
                          You are sharing your screen
                        </div>
                      )}
                    {this.state.roomIntermission && (
                      <div className={styles.intermissionOverlay}>
                        <div className={styles.intermissionCard}>
                          <div className={styles.intermissionTitle}>
                            Intermission
                          </div>
                          <div className={styles.intermissionLine}>
                            {(this.state.nameMap[
                              this.state.roomIntermission.by
                            ] ?? "Someone") + " stepped out"}
                          </div>
                          <div className={styles.intermissionLine}>
                            {/* An expired deadline is just an open break again:
                                never show a "Back by" time in the past */}
                            {this.state.roomIntermission.until &&
                            this.state.roomIntermission.until > Date.now()
                              ? `Back by ${new Date(
                                  this.state.roomIntermission.until,
                                ).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}`
                              : "Back whenever"}
                          </div>
                        </div>
                      </div>
                    )}
                    {this.state.roomSleepTimer?.asking && (
                      <div className={styles.intermissionOverlay}>
                        <div className={styles.intermissionCard}>
                          <div className={styles.intermissionTitle}>
                            😴 Still watching?
                          </div>
                          <div className={styles.intermissionLine}>
                            {(this.state.nameMap[
                              this.state.roomSleepTimer.by
                            ] ?? "Someone") +
                              " set a sleep timer that just ran out"}
                          </div>
                          <div className={styles.sleepBar} />
                          <Button
                            color="violet"
                            style={{ marginTop: 12, pointerEvents: "auto" }}
                            onClick={() => this.socket.emit("CMD:sleep", 0)}
                          >
                            Yes — keep watching
                          </Button>
                        </div>
                      </div>
                    )}
                    {(!this.state.isAutoPlayable ||
                      this.state.playbackBlocked) &&
                      this.state.roomMedia &&
                      // The host of a live screen share has no room media of their
                      // own to start: leftVideo only mirrors their muted preview,
                      // so Unmute would re-mute them (and could play the empty
                      // element before the preview mounts)
                      !this.isSharingScreen() &&
                      // The host of a file share is the same: their leftVideo is
                      // the local file itself, already playing unmuted from their
                      // own picker click (measured round 209: the overlay covered
                      // an audible share). A viewer of the share still needs it
                      !this.isLocalStreamAFile && (
                        <Overlay className={styles.flexCenter}>
                          <Button
                            // Real user gesture: muted autoplay was refused, so
                            // actually start playback too (if the room is playing)
                            onClick={this.unlockPlayback}
                            leftSection={<IconVolume />}
                            size="xl"
                          >
                            Unmute
                          </Button>
                        </Overlay>
                      )}
                    {this.state.resumeOffer && (
                      <Overlay className={styles.flexCenter}>
                        <Alert
                          color="violet"
                          title="Continue watching"
                          style={glassCardStyle}
                        >
                          <div>
                            Last time here:{" "}
                            {this.getMediaDisplayName(
                              this.state.resumeOffer.media,
                            )}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              marginTop: 16,
                            }}
                          >
                            <Button
                              color="violet"
                              leftSection={<IconHistory />}
                              onClick={() =>
                                this.continueResume(this.state.resumeOffer!)
                              }
                            >
                              Continue from{" "}
                              {formatTimestamp(this.state.resumeOffer.pos)}
                            </Button>
                            <Button
                              variant="subtle"
                              color="gray"
                              onClick={this.dismissResume}
                            >
                              Not now
                            </Button>
                          </div>
                        </Alert>
                      </Overlay>
                    )}
                    {this.state.localCopyNeeded &&
                      isLocalCopy(this.state.roomMedia) && (
                        <Overlay className={styles.flexCenter}>
                          <Alert
                            color="violet"
                            title="Local copy"
                            style={glassCardStyle}
                          >
                            <div>
                              Open your own copy of{" "}
                              {parseLocalCopy(this.state.roomMedia)?.name}.
                              Everyone plays their own file — only play, pause,
                              and seek are synced.
                            </div>
                            <Button
                              mt="sm"
                              color="violet"
                              onClick={this.openLocalCopy}
                              leftSection={<IconFiles />}
                            >
                              Open your copy
                            </Button>
                          </Alert>
                        </Overlay>
                      )}
                    {(this.state.loading ||
                      !this.state.roomMedia ||
                      this.state.nonPlayableMedia) &&
                      !this.state.isLiveStream && (
                        <div
                          id="loader"
                          className={`${styles.videoContent} ${styles.flexCenter}`}
                        >
                          {this.state.loading && (
                            <div
                              className={styles.flexCenter}
                              style={{
                                flexDirection: "column",
                              }}
                            >
                              <Loader />
                              <div>
                                {this.playingVBrowser()
                                  ? "Launching virtual browser. This can take up to a minute."
                                  : ""}
                              </div>
                            </div>
                          )}
                          {!this.state.loading && !this.state.roomMedia && (
                            <Alert
                              color="yellow"
                              title="You're not watching anything!"
                              style={glassCardStyle}
                            >
                              Pick something to watch above.
                              {bookmarkletUsable() && (
                                <div style={{ marginTop: 8 }}>
                                  <NetflixButton />
                                </div>
                              )}
                            </Alert>
                          )}
                          {!this.state.loading &&
                            this.state.nonPlayableMedia && (
                              <Alert
                                color="red"
                                title="It doesn't look like this is a media file!"
                                style={glassCardStyle}
                              >
                                Maybe you meant to launch a VBrowser if you're
                                trying to visit a web page?
                              </Alert>
                            )}
                        </div>
                      )}
                    <iframe
                      style={{
                        display:
                          this.usingYoutube() && !this.state.loading
                            ? "block"
                            : "none",
                      }}
                      title="YouTube"
                      id="leftYt"
                      className={styles.videoContent}
                      allowFullScreen
                      frameBorder="0"
                      allow="autoplay; encrypted-media"
                      src="https://www.youtube.com/embed/?enablejsapi=1&controls=0&rel=0"
                    />
                    {this.playingVBrowser() &&
                    this.getVBrowserPass() &&
                    this.getVBrowserHost() ? (
                      <VBrowser
                        username={clientId}
                        password={this.getVBrowserPass()}
                        hostname={this.getVBrowserHost()}
                        controlling={this.state.controller === clientId}
                        resolution={this.state.vBrowserResolution}
                        quality={this.state.vBrowserQuality}
                        doPlay={this.localPlay}
                        setResolution={(data: string) =>
                          this.setState({ vBrowserResolution: data })
                        }
                        setQuality={(data: string) => {
                          this.setState({ vBrowserQuality: data });
                        }}
                        isMobile={isMobile()}
                      />
                    ) : (
                      <video
                        style={{
                          display:
                            this.usingNative() && !this.state.loading
                              ? "block"
                              : "none",
                          width: "100%",
                          maxHeight: VIDEO_MAX_HEIGHT_CSS,
                        }}
                        id="leftVideo"
                        // roomMedia, not e.currentTarget.src (the resolved
                        // absolute/blob src would never match the server's url)
                        onEnded={() => this.onVideoEnded(this.state.roomMedia)}
                        // Every (re)created element starts at volume 1: restore
                        // the user's last volume/mute per media load (round 168)
                        onLoadedMetadata={() => {
                          if (this.usingNative()) {
                            this.applyStoredVolume();
                          }
                        }}
                        playsInline
                        onClick={this.videoClick}
                      ></video>
                    )}
                    <div
                      style={{
                        color: softWhite,
                        fontWeight: 400,
                        fontSize: 10,
                        lineHeight: "8px",
                        position: "absolute",
                        bottom: 0,
                        right: 0,
                        zIndex: 3,
                      }}
                    >
                      {[
                        Boolean(this.state.total) &&
                          Math.min(
                            (this.state.downloaded / this.state.total) * 100,
                            100,
                          ).toFixed(2) + "% downloaded",
                        Boolean(this.state.total) &&
                          formatSpeed(this.state.speed),
                        Boolean(this.state.total) &&
                          this.state.connections + " connections",
                        this.state.convertProgress !== undefined &&
                          (this.state.convertProgress * 100).toFixed(1) +
                            "% converted",
                      ]
                        .filter(Boolean)
                        .join(" - ")}
                    </div>
                    <div className={styles.floatReactionLayer}>
                      {this.state.floatReactions.map((float) => (
                        <div
                          key={float.id}
                          className={styles.floatReaction}
                          style={{ left: `${float.left}%` }}
                        >
                          <span className={styles.floatReactionEmoji}>
                            {float.value}
                          </span>
                          <span className={styles.floatReactionName}>
                            {this.state.nameMap[float.user] || float.user}
                          </span>
                        </div>
                      ))}
                    </div>
                    {/* Fullscreen chat overlay (round 130): its own subscriber
                        to chatStore so a message only re-renders the overlay */}
                    {this.state.fullScreen &&
                      document.fullscreenElement !== document.body && (
                        <ChatOverlay
                          nameMap={this.state.nameMap}
                          typing={this.state.chatOverlayTyping}
                          overlayMsg={this.state.chatOverlayMsg}
                          onOverlayMsg={(v) =>
                            this.setState({ chatOverlayMsg: v })
                          }
                          onOverlayClose={() =>
                            this.setState({
                              chatOverlayTyping: false,
                              chatOverlayMsg: "",
                            })
                          }
                          onOverlayBlur={() =>
                            this.setState({ chatOverlayTyping: false })
                          }
                          onOverlaySend={() => {
                            this.socket.emit(
                              "CMD:chat",
                              this.state.chatOverlayMsg,
                            );
                            this.setState({ chatOverlayMsg: "" });
                          }}
                        />
                      )}
                  </div>
                </div>
                {this.state.roomMedia && controls}
                {!isMobile() && !this.state.fullScreen && (
                  <div className={styles.expandButton}>
                    <ActionIcon
                      onClick={() => {
                        const newVal = !this.state.showChatColumn;
                        this.chatAutoCollapsed = false;
                        this.setState({
                          showChatColumn: newVal,
                        });
                        window.localStorage.setItem(
                          "watchparty-showchatcolumn",
                          Number(newVal).toString(),
                        );
                      }}
                    >
                      {this.state.showChatColumn ? (
                        <IconChevronRight size={16} />
                      ) : (
                        <IconChevronLeft size={16} />
                      )}
                    </ActionIcon>
                    {this.state.chatUnread > 0 && (
                      <Badge
                        size="xs"
                        color="red"
                        aria-label={`${this.state.chatUnread} unread messages`}
                        style={{
                          position: "absolute",
                          top: -10,
                          right: -8,
                          // above the collapsed chat column's edge line
                          zIndex: 2,
                          minWidth: 16,
                          padding: "0 4px",
                          pointerEvents: "none",
                        }}
                      >
                        {this.state.chatUnread > 9
                          ? "9+"
                          : this.state.chatUnread}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                position: "relative",
                width: this.state.showChatColumn ? 400 : 0,
                // min() so the 400px column never overflows a phone screen
                maxWidth: "min(400px, 100%)",
                overflow: "hidden",
                gap: "4px",
              }}
              // Collapsed = width 0, but clipped content stays in the Tab
              // order: block it while invisible (measured round 110)
              {...(!this.state.showChatColumn ? ({ inert: "" } as any) : {})}
              className={`${
                (this.state.fullScreen
                  ? styles.fullHeightColumnFullscreen
                  : styles.fullHeightColumn) +
                " " +
                styles.rightColumn
              }`}
            >
              <div style={{ display: "flex", width: "100%", gap: "4px" }}>
                <TextInput
                  // description="Name"
                  style={{
                    visibility: this.state.showChatColumn
                      ? undefined
                      : "hidden",
                    flexGrow: 1,
                  }}
                  value={this.state.myName}
                  onChange={(e) => {
                    this.updateName(e.target.value);
                  }}
                  onFocus={(e) => e.target.select()}
                  leftSection={<IconUser />}
                  rightSectionWidth={70}
                  rightSection={
                    <Button
                      size="compact-xs"
                      // 22px is too small to tap on a phone (round 133) or
                      // any touch-primary device such as a tablet (round 154)
                      style={{
                        height: isMobile() || isTouchPrimary() ? 24 : undefined,
                      }}
                      onClick={async () =>
                        this.updateName(await generateName())
                      }
                    >
                      Random
                    </Button>
                  }
                />
                <InviteButton siteUrl={this.state.extSiteUrl} />
              </div>
              <div className={styles.segGroup}>
                <Button
                  variant={this.state.showPeopleColumn ? "light" : "subtle"}
                  color="violet"
                  onClick={() =>
                    this.setState({
                      showPeopleColumn: !this.state.showPeopleColumn,
                      // While the column was closed the per-second badge
                      // updates were skipped: catch up from the field
                      tsMap: this.tsMapData,
                    })
                  }
                  fullWidth
                  leftSection={<IconUsersGroup />}
                  rightSection={
                    <Badge circle>{this.state.participants.length}</Badge>
                  }
                >
                  People
                </Button>
                <Button
                  variant="subtle"
                  color="violet"
                  title="Settings"
                  fullWidth
                  onClick={() => {
                    this.setSettingsModalOpen(true);
                  }}
                  leftSection={<IconSettings />}
                >
                  Settings
                </Button>
              </div>
              {this.state.state === "connected" && (
                <div
                  style={{
                    position: "absolute",
                    background: "rgba(20, 12, 40, 0.85)",
                    backdropFilter: "blur(12px)",
                    WebkitBackdropFilter: "blur(12px)",
                    borderRadius: 16,
                    border: "1px solid rgba(190, 150, 255, 0.15)",
                    zIndex: 200,
                    left: 0,
                    top: 76,
                    height: this.state.showPeopleColumn
                      ? "calc(100% - 120px)"
                      : "0%",
                    width: "100%",
                    overflowY: "auto",
                    // visibility: this.state.showPeopleColumn ? 'visible' : 'hidden',
                    transition: "height ease-out 0.5s",
                  }}
                  // Closed = height 0, but the voice tiles inside keep Tab
                  // focus (measured round 110). The overlay is clipped, so
                  // make it unfocusable while closed; the voice connection
                  // itself runs in JS and keeps going. React 18 types don't
                  // know `inert`, hence the spread cast
                  {...(!this.state.showPeopleColumn
                    ? ({ inert: "" } as any)
                    : {})}
                >
                  <VideoChat
                    ref={this.videoChatRef}
                    socket={this.socket}
                    participants={this.state.participants}
                    nameMap={this.state.nameMap}
                    pictureMap={this.state.pictureMap}
                    tsMap={this.state.tsMap}
                    rosterUpdateTS={this.state.rosterUpdateTS}
                    owner={this.state.owner}
                    getLeaderTime={this.getLeaderTime}
                    deaf={this.state.voiceDeaf}
                  />
                </div>
              )}
              <Chat
                nameMap={this.state.nameMap}
                pictureMap={this.state.pictureMap}
                socket={this.socket}
                getMediaDisplayName={this.getMediaDisplayName}
                isChatDisabled={this.state.isChatDisabled}
                owner={this.state.owner}
                ref={this.chatRef}
                hide={!this.state.showChatColumn}
                voiceButton={this.renderVoiceButton()}
                onSeekCommand={this.roomSeekCommand}
              />
            </div>
          </div>
        }
      </React.Fragment>
    );
  }
}
