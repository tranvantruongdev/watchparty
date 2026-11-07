import type MediasoupClient from "mediasoup-client";
import React from "react";
import { Alert, Loader, Menu, Overlay, Select, Title } from "@mantine/core";
import io, { Socket } from "socket.io-client";
import {
  formatSpeed,
  iceServers,
  isMobile,
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
  getSavedStubs,
  saveStubs,
} from "../../utils/utils";
import { generateName } from "../../utils/generateName";
import { Chat, type SeekCommand } from "../Chat/Chat";
import { TopBar } from "../TopBar/TopBar";
import { VBrowser } from "../VBrowser/VBrowser";
import { VideoChat } from "../VideoChat/VideoChat";
import { getCurrentSettings } from "../Settings/LocalSettings";
import { MultiStreamModal } from "../Modal/MultiStreamModal";
import { ComboBox } from "../ComboBox/ComboBox";
import { SearchComponent } from "../SearchComponent/SearchComponent";
import { Controls } from "../Controls/Controls";
import { VBrowserModal } from "../Modal/VBrowserModal";
import { SettingsModal } from "../Settings/SettingsModal";
import { ErrorModal } from "../Modal/ErrorModal";
import { PasswordModal } from "../Modal/PasswordModal";
import { ScreenShareModal } from "../Modal/ScreenShareModal";
import { FileShareModal } from "../Modal/FileShareModal";
import {
  ClientTranscoder,
  isClientTranscodeSupported,
  type AudioTrackInfo,
} from "../../utils/clientTranscode";
import firebase from "firebase/compat/app";
import { SubtitleModal } from "../Modal/SubtitleModal";
import { HTML } from "./HTML";
import { YouTube } from "./YouTube";
import { PixelFloor } from "./PixelFloor";
import styles from "./App.module.css";
import config from "../../config";
import { MetadataContext } from "../../MetadataContext";
import ChatVideoCard from "../ChatVideoCard/ChatVideoCard";
import {
  ActionIcon,
  Badge,
  TextInput,
  Button,
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
  IconKeyboardFilled,
  IconList,
  IconMicrophone,
  IconCoffee,
  IconScreenShare,
  IconSettings,
  IconUser,
  IconUserScreen,
  IconUsersGroup,
  IconVolume,
  IconX,
} from "@tabler/icons-react";
import { InviteButton } from "../InviteButton/InviteButton";
import type WebTorrent from "webtorrent";
import type Hls from "hls.js";
import { type MediaPlayerClass } from "dashjs";
import { type Torrent } from "webtorrent";

declare global {
  interface Window {
    onYouTubeIframeAPIReady: any;
    YT: YT.JsApi;
    watchparty: {
      ourStream: MediaStream | undefined;
      videoRefs: HTMLVideoElementDict;
      videoPCs: PCDict;
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
  // What the incoming screen share really gets: path, size, fps, bitrate
  shareStats: string;
  participants: User[];
  rosterUpdateTS: Number;
  chat: ChatMessage[];
  playlist: PlaylistVideo[];
  tsMap: NumberDict;
  nameMap: StringDict;
  pictureMap: StringDict;
  myName: string;
  myPicture: string;
  loading: boolean;
  scrollTimestamp: number;
  unreadCount: number;
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
  isFileShareModalOpen: boolean;
  localCopyNeeded: boolean;
  isSubtitleModalOpen: boolean;
  isMultiSelectModalOpen: boolean;
  roomLock: string;
  controller?: string;
  savedPasswords: StringDict;
  roomId: string;
  errorMessage: string;
  successMessage: string;
  warningMessage: string;
  isChatDisabled: boolean;
  showChatColumn: boolean;
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
  // Cinema look for the watch page (curtains, house lights, seats)
  theaterMode: boolean;
  // Audio tracks of the file being converted on this device, and which one is playing
  audioTracks: AudioTrackInfo[] | undefined;
  audioTrackId: number | undefined;
  floatReactions: FloatReaction[];
  // Fullscreen chat overlay (F4): whether the mini input is open and what's in it
  chatOverlayTyping: boolean;
  chatOverlayMsg: string;
  // Memory wall: ticket stubs of the videos that reached the end in this room
  ticketStubs: TicketStub[];
}

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
    shareStats: "",
    participants: [],
    rosterUpdateTS: Date.now(),
    chat: [],
    floatReactions: [],
    chatOverlayTyping: false,
    chatOverlayMsg: "",
    ticketStubs: [],
    playlist: [],
    tsMap: {},
    nameMap: {},
    pictureMap: {},
    myName: window.localStorage.getItem("watchparty-username") ?? "",
    myPicture: "",
    loading: true,
    scrollTimestamp: 0,
    unreadCount: 0,
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
    localCopyNeeded: false,
    isSubtitleModalOpen: false,
    isMultiSelectModalOpen: false,
    roomLock: "",
    controller: "",
    roomId: "",
    savedPasswords: {},
    errorMessage: "",
    successMessage: "",
    warningMessage: "",
    isChatDisabled: false,
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
  // Buffering report state: when a stall started, and whether we already
  // told the room it lasted long enough to show (> 1.5 s)
  bufferingSince = 0;
  bufferingReported = false;
  ytNeedsFirstPlaySync = false;
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
  // "Local copy" mode: the file this client plays from its own disk
  localCopyFile?: File;
  localCopyObjectUrl?: string;
  transcoder?: ClientTranscoder;
  publisherConns: PCDict = {};
  consumerConn?: RTCPeerConnection;
  shareStatsTimer?: number;
  shareStatsLast?: { bytes: number; ts: number };
  progressUpdater?: number;
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

  async componentDidMount() {
    document.onfullscreenchange = this.onFullScreenChange;
    document.onkeydown = this.onKeydown;

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
      firebase.auth().onAuthStateChanged(async (user: firebase.User | null) => {
        if (user) {
          this.loadSignInData(user);
        }
      });
    }
  }

  componentWillUnmount() {
    document.removeEventListener("fullscreenchange", this.onFullScreenChange);
    document.removeEventListener("keydown", this.onKeydown);
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.playbackCheckTimer);
    window.clearTimeout(this.ytPostSeekTimer);
  }

  init = async () => {
    let roomId = "/" + this.props.urlRoomId;
    // if a vanity name, resolve the url to a room id
    if (this.props.vanity) {
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
    }
    this.setState(
      {
        roomId,
        // The memory wall is per device, so it loads with the room and keeps
        // whatever was pinned on earlier nights
        ticketStubs: getSavedStubs()[roomId] ?? [],
      },
      () => {
        this.join(roomId);
      },
    );
  };

  join = async (roomId: string) => {
    const password = getSavedPasswords()[roomId] ?? "";
    const response = await fetch(serverPath + "/resolveShard" + roomId);
    const shard = Number(await response.text()) || "";
    const socket = io(serverPath + roomId, {
      transports: ["websocket"],
      query: {
        clientId,
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
        errorMessage: "",
        successMessage: "",
        warningMessage: "",
      });
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
        this.setState({ overlayMsg: "Couldn't load this room." });
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
      this.localPlay();
    });
    socket.on("REC:pause", () => {
      if (this.state.exploring) {
        this.setState({ roomPaused: true });
        return;
      }
      this.localPause();
    });
    socket.on("REC:seek", (data: number) => {
      if (this.state.exploring) {
        return;
      }
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
      // Put back whatever we were watching before the attempt cleared
      // leftVideo: the room media didn't change, so no REC:host will reload it
      // and the RTC paths above skip already-connected viewers
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
    });
    socket.on("REC:host", async (data: HostState) => {
      let currentMedia = data.video || "";
      if (this.playingScreenShare() && !isScreenShare(currentMedia)) {
        this.stopPublishingLocalStream();
      }
      if (this.playingFileShare() && !isFileShare(currentMedia)) {
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
          else if (
            this.state.convertEnabled &&
            isClientTranscodeSupported() &&
            isDirectVideoUrl(src)
          ) {
            await this.convertAndPlay(src, time);
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
        new Audio("/clearly.mp3").play();
      }
      this.state.chat.push(data);
      if (this.state.chat.length > 100) {
        this.state.chat.shift();
      }
      this.setState({
        chat: this.state.chat,
        scrollTimestamp: Date.now(),
        unreadCount:
          this.state.currentTab === "chat"
            ? this.state.unreadCount
            : this.state.unreadCount + 1,
      });
    });
    socket.on("REC:addReaction", (data: Reaction) => {
      const { chat } = this.state;
      const msgIndex = chat.findIndex(
        (m) => m.id === data.msgId && m.timestamp === data.msgTimestamp,
      );
      if (msgIndex === -1) {
        return;
      }
      const msg = chat[msgIndex];
      msg.reactions = msg.reactions || {};
      msg.reactions[data.value] = msg.reactions[data.value] || [];
      msg.reactions[data.value].push(data.user);
      this.setState({ chat }, () => {
        // if we add a reaction to the last message we need to scroll down
        // or else the reaction icon might be hidden
        if (
          msgIndex === chat.length - 1 &&
          this.chatRef.current?.state.isNearBottom
        ) {
          this.chatRef.current?.scrollToBottom();
        }
      });
    });
    socket.on("REC:removeReaction", (data: Reaction) => {
      const { chat } = this.state;
      const msg = chat.find(
        (m) => m.id === data.msgId && m.timestamp === data.msgTimestamp,
      );
      if (!msg || !msg.reactions?.[data.value]) {
        return;
      }
      msg.reactions[data.value] = msg.reactions[data.value].filter(
        (id) => id !== data.user,
      );
      this.setState({ chat });
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
      this.setState({ tsMap: data }, () => {
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
        if (this.state.roomSubtitle) {
          const sharer = this.state.participants.find((p) => p.isScreenShare);
          if (sharer && sharer.id !== clientId) {
            // Sync only if someone is sharing and it's not us
            const sharerTime = this.state.tsMap[sharer.id];
            this.Player().syncSubtitles(sharerTime);
          }
        }
      });
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
    socket.on("roster", (data: User[]) => {
      this.setState({ participants: data, rosterUpdateTS: Date.now() }, () => {
        this.setupRTCConnections();
      });
    });
    socket.on("chatinit", (data: ChatMessage[]) => {
      this.setState({ chat: data, scrollTimestamp: Date.now() });
    });
    socket.on("playlist", (data: PlaylistVideo[]) => {
      this.setState({ playlist: data });
    });
    socket.on(
      "signalSS",
      async (data: {
        msg: { ice: any; sdp: any };
        from: string;
        sharer: boolean;
      }) => {
        config.NODE_ENV === "development" && console.log(data);
        // Handle messages received from signaling server
        const msg = data.msg;
        const from = data.from;
        // Determine whether the message came from the sharer or the sharee
        const pc = (
          data.sharer ? this.consumerConn : this.publisherConns[from]
        ) as RTCPeerConnection;
        if (msg.ice !== undefined) {
          pc.addIceCandidate(new RTCIceCandidate(msg.ice));
        } else if (msg.sdp && msg.sdp.type === "offer") {
          // console.log('offer');
          // TODO Currently ios/Safari cannot handle this property, so remove it from the offer
          const _sdp = msg.sdp.sdp
            .split("\n")
            .filter((line: string) => {
              return line.trim() !== "a=extmap-allow-mixed";
            })
            .join("\n");
          msg.sdp.sdp = _sdp;
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
        } else if (msg.sdp && msg.sdp.type === "answer") {
          pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
      },
    );
    socket.on("REC:getRoomState", this.handleRoomState);
    window.setInterval(() => {
      // Not while watching alone: our time would drag the leader time around
      if (this.state.roomMedia && !this.state.exploring) {
        const toSend = this.getRoomTSToSet(this.Player().getCurrentTime());
        this.socket.emit("CMD:ts", toSend);
        this.reportBuffering();
      }
    }, 1000);
  };

  setFileSelection = (
    data: { name: string; url: string; length: number; playFn?: () => void }[],
  ) => {
    this.setState({ fileSelection: data });
  };

  setMultiSelectModal = (isMultiSelectModalOpen: boolean) => {
    this.setState({ isMultiSelectModalOpen });
  };

  resetMultiSelect = () => {
    this.setState({ isMultiSelectModalOpen: false, fileSelection: [] });
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
              this.onVideoEnded(e.target.getVideoUrl());
            }
            if (
              this.ytDebounce &&
              // Solo: pausing or playing our own player isn't a room action
              !this.state.exploring &&
              ((e.data === window.YT?.PlayerState?.PLAYING &&
                this.state.roomPaused) ||
                (e.data === window.YT?.PlayerState?.PAUSED &&
                  !this.state.roomPaused))
            ) {
              this.ytDebounce = false;
              if (e.data === window.YT?.PlayerState?.PLAYING) {
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
              e.data === window.YT?.PlayerState?.PLAYING &&
              this.ytNeedsFirstPlaySync
            ) {
              // First play after joining or a media change (e.g. the user clicking
              // YouTube's play button after autoplay was blocked): jump to the room
              // position, same as the Sync button, since the cued position is stale
              this.ytNeedsFirstPlaySync = false;
              this.localSeek();
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

  showError = (message: string) => {
    this.setState({ errorMessage: message });
    setTimeout(() => {
      this.setState({ errorMessage: "" });
    }, 3000);
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

  createTranscoder = (
    source: File | string,
    video: HTMLMediaElement,
    startTime: number,
    onError: (err: Error) => void,
  ) => {
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
    const transcoder = this.createTranscoder(src, video, time, (err) => {
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
    if (options?.convert && !isClientTranscodeSupported()) {
      this.showError("Your browser doesn't support converting videos");
      return;
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
    if (options?.convert) {
      const transcoder = this.createTranscoder(file, leftVideo, 0, (err) => {
        // Conversion failed mid-share
        this.showError(`Conversion failed: ${err.message}`);
        this.stopPublishingLocalStream();
      });
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
      leftVideo.src = URL.createObjectURL(file);
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
    if (
      !this.localStreamToPublish ||
      !this.localStreamToPublish.getTracks().length
    ) {
      this.localStreamToPublish = undefined;
      this.showError("This file can't be played in your browser");
      return;
    }
    this.isLocalStreamAFile = true;
    this.socket.emit("CMD:joinScreenShare", {
      file: true,
      mediasoup: useMediaSoup,
    });
  };

  startScreenShare = async (useMediaSoup: boolean) => {
    // Screen share doesn't touch leftVideo, so there's nothing to restore
    this.preShareVideoState = undefined;
    if (navigator.mediaDevices.getDisplayMedia) {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        //@ts-expect-error
        // Full HD when the screen has it; the direct share sends up to 8 Mbps
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
      this.localStreamToPublish = stream;
      this.isLocalStreamAFile = false;
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
        const trackParams = { track: videoTrack };
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
    if (this.consumerConn) {
      this.consumerConn.close();
      this.consumerConn = undefined;
    }
    window.clearInterval(this.shareStatsTimer);
    this.shareStatsLast = undefined;
    this.setState({ shareStats: "" });
    Object.values(this.publisherConns).forEach((pc) => {
      pc.close();
    });
    this.publisherConns = {};
    this.isLocalStreamAFile = false;
    if (this.mediasoupPubSocket) {
      this.mediasoupPubSocket.close();
      this.mediasoupPubSocket = null;
    }
    if (this.mediasoupSubSocket) {
      this.mediasoupSubSocket.close();
      this.mediasoupSubSocket = null;
    }
  };

  setupRTCConnections = async () => {
    if (!this.playingScreenShare() && !this.playingFileShare()) {
      return;
    }
    const sharer = this.state.participants.find((p) => p.isScreenShare);
    const selfId = getOrCreateClientId();
    const localTrack = this.localStreamToPublish?.getVideoTracks()[0];
    if (localTrack && !localTrack.onended) {
      // Stop sharing if the local stream stops
      localTrack.onended = () => this.stopPublishingLocalStream();
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
      // If we're not sharing a file, also start watching
      // avoid duplicate watching if the socket already exists
      if (!this.isLocalStreamAFile && this.mediasoupSubSocket == null) {
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

      this.state.participants.forEach((user) => {
        const id = user.id;
        if (id === selfId && this.isLocalStreamAFile) {
          // Don't set up a connection to ourselves if sharing file
          return;
        }
        if (!this.publisherConns[id]) {
          // Set up the RTCPeerConnection for sharing media to each member
          const pc = new RTCPeerConnection({ iceServers: iceServers() });
          this.publisherConns[id] = pc;
          this.localStreamToPublish?.getTracks().forEach((track) => {
            if (this.localStreamToPublish == null) {
              return;
            }
            if (track.kind === "video") {
              // Browsers cap a peer video near 2 Mbps and drop 720p to 540p; let it use more
              const tr = pc.addTransceiver(track, {
                streams: [this.localStreamToPublish],
                sendEncodings: [{ maxBitrate: 8_000_000 }],
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
            } else {
              pc.addTrack(track, this.localStreamToPublish);
            }
          });
          pc.onicecandidate = (event) => {
            // We generated an ICE candidate, send it to peer
            if (event.candidate) {
              this.sendSignalSS(id, { ice: event.candidate }, true);
            }
          };
          pc.onnegotiationneeded = async () => {
            // Start connection for peer's video
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.sendSignalSS(id, { sdp: pc.localDescription }, true);
          };
        }
      });
    }
    // We're a watcher, establish connection to sharer
    // If screensharing, sharer also does this
    // If filesharing, sharer does not do this since we use leftVideo
    if (sharer && !this.consumerConn && !this.isLocalStreamAFile) {
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      this.consumerConn = pc;
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
    this.setState({
      shareStats: `${relay ? "relay (TURN)" : "direct"} · ${video.frameWidth ?? 0}x${video.frameHeight ?? 0} ${Math.round(video.framesPerSecond ?? 0)}fps · ${mbps.toFixed(1)} Mbps ${codec}`,
    });
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

  localSetVolume = (volume: number) => {
    this.Player().setVolume(volume);
    this.refreshControls();
  };

  localSubtitleModal = () => {
    // Native player uses subtitle modal.
    if (this.usingNative()) {
      this.setState({ isSubtitleModalOpen: true });
    }
  };

  roomSetPlaybackRate = (rate: number) => {
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
    if (this.usingYoutube()) {
      raw =
        this.YouTubeInterface.watchPartyYTPlayer?.getPlayerState() ===
        window.YT?.PlayerState.BUFFERING;
    } else {
      const el = this.Player().getVideoEl();
      raw = Boolean(el && !el.paused && el.readyState < 3);
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
    if (!this.haveLock()) {
      return;
    }
    if (this.isPauseDisabled()) {
      return;
    }
    const shouldPlay = this.Player().shouldPlay();
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
      const others = Object.entries(this.state.tsMap)
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
    this.state.chat.push({
      id: "",
      cmd: "help",
      system: true,
      timestamp: new Date().toISOString(),
    });
    if (this.state.chat.length > 100) {
      this.state.chat.shift();
    }
    this.setState({ chat: this.state.chat, scrollTimestamp: Date.now() });
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
      container.webkitEnterFullScreen
    ) {
      // e.g. iPhone doesn't allow requestFullscreen
      //@ts-expect-error
      container.webkitEnterFullscreen();
      return;
    }
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
  };

  localToggleMute = () => {
    this.localSetMute(!this.Player().isMuted());
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
    this.socket.emit("CMD:playlistMove", { index, toIndex });
  };

  roomPlaylistDelete = (index: number) => {
    this.socket.emit("CMD:playlistDelete", index);
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

  // Join/leave voice chat from the chat bar; the call itself lives in VideoChat (People)
  renderVoiceButton = () => {
    const inVoice = this.state.participants.find(
      (p) => p.id === getOrCreateClientId(),
    )?.isVideoChat;
    return (
      <ActionIcon
        title={inVoice ? "Leave voice chat" : "Join voice chat"}
        color={inVoice ? "red" : "green"}
        onClick={() =>
          inVoice
            ? this.videoChatRef.current?.stopWebRTC()
            : this.videoChatRef.current?.setupWebRTC()
        }
      >
        <IconMicrophone />
      </ActionIcon>
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
    const values = Object.values(this.state.tsMap);
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

  // Pin the current video to the memory wall. Skips screenshares and the
  // vbrowser (neither is a "watched this together" keepsake) and a stub for
  // the same video as the last one (loop/repeat), and caps the wall at 30
  addTicketStub = () => {
    const media = this.state.roomMedia;
    if (
      !media ||
      media.startsWith("screenshare://") ||
      this.playingVBrowser()
    ) {
      return;
    }
    const stubs = this.state.ticketStubs;
    if (stubs.length && stubs[stubs.length - 1].url === media) {
      return;
    }
    let title =
      this.Player().getVideoTitle() || this.getMediaDisplayName(media);
    // A bare URL makes a useless stub: keep the file name without extension
    if (/^https?:\/\//.test(title)) {
      const file = title.split(/[?#]/)[0].split("/").pop() || title;
      try {
        title = decodeURIComponent(file).replace(/\.[a-z0-9]{2,4}$/i, "");
      } catch (e) {
        title = file;
      }
    }
    const next = [
      ...stubs,
      { url: media, title: title.slice(0, 60), at: Date.now() },
    ].slice(-30);
    saveStubs(this.state.roomId, next);
    this.setState({ ticketStubs: next });
  };

  onVideoEnded = (url: string) => {
    this.localPause();
    // check if looping is on, if so set time back to 0 and restart
    if (this.state.roomLoop) {
      this.localSeek(0);
      this.localPlay();
      return;
    }
    // A video that actually ran to the end earns its ticket stub on the
    // memory wall (loop replays never land here). Each device pins its own
    // copy: rooms reset on server restart, so localStorage is what keeps the
    // stubs alive across nights
    this.addTicketStub();
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
    this.setState({ settingsModalOpen });
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
          <MultiStreamModal
            streams={this.state.fileSelection}
            setMedia={this.roomSetMedia}
            resetMultiSelect={this.resetMultiSelect}
          />
        )}
        {this.state.isVBrowserModalOpen && (
          <VBrowserModal
            closeModal={() => this.setState({ isVBrowserModalOpen: false })}
            startVBrowser={this.startVBrowser}
          />
        )}
        {this.state.isScreenShareModalOpen && (
          <ScreenShareModal
            closeModal={() => this.setState({ isScreenShareModalOpen: false })}
            startScreenShare={this.startScreenShare}
          />
        )}
        {this.state.isFileShareModalOpen && (
          <FileShareModal
            closeModal={() => this.setState({ isFileShareModalOpen: false })}
            startFileShare={this.startFileShare}
          />
        )}
        {this.state.isSubtitleModalOpen && (
          <SubtitleModal
            closeModal={() => this.setState({ isSubtitleModalOpen: false })}
            socket={this.socket}
            roomSubtitle={this.state.roomSubtitle}
            roomMedia={this.state.roomMedia}
            haveLock={this.haveLock}
            getMediaDisplayName={this.getMediaDisplayName}
            setSubtitleMode={this.Player().setSubtitleMode}
            getSubtitleMode={this.Player().getSubtitleMode}
            loadLocalSubtitle={this.HTMLInterface.loadLocalSubtitle}
          />
        )}
        {this.state.state === "starting" && (
          <Overlay className={styles.flexCenter}>
            <Title order={2}>Loading...</Title>
          </Overlay>
        )}
        {this.state.overlayMsg && <ErrorModal error={this.state.overlayMsg} />}
        {this.state.isErrorAuth && <PasswordModal roomId={this.state.roomId} />}
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
                          onClick={this.stopPublishingLocalStream}
                          leftSection={<IconX />}
                        >
                          Stop Share
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
                              this.setState({
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
                              this.setState({
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
                              this.setState({
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
                      {isClientTranscodeSupported() && (
                        <Tooltip
                          multiline
                          w={280}
                          refProp="rootRef"
                          label="Use CPU/GPU to convert content before playback (only with links, use if video or audio doesn't play, or to choose between audio tracks)"
                        >
                          <Switch
                            label="Convert"
                            checked={this.state.convertEnabled}
                            onChange={(e) =>
                              this.setConvertEnabled(e.currentTarget.checked)
                            }
                            style={{ flexShrink: 0, alignSelf: "center" }}
                          />
                        </Tooltip>
                      )}
                      <Tooltip
                        multiline
                        w={280}
                        refProp="rootRef"
                        label="Cinema look: curtains, house lights and seats. Turn off for the classic layout."
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
                    {this.state.shareStats && (
                      <div className={styles.shareStats}>
                        {this.state.shareStats}
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
                      !this.isSharingScreen() && (
                        <Overlay className={styles.flexCenter}>
                          <Button
                            onClick={() => {
                              // Real user gesture: muted autoplay was refused, so
                              // actually start playback too (if the room is playing)
                              this.setState(
                                {
                                  isAutoPlayable: true,
                                  playbackBlocked: false,
                                },
                                () => {
                                  this.localSetMute(false);
                                  this.localSetVolume(1);
                                  if (!this.state.roomPaused) {
                                    this.localPlay();
                                  }
                                },
                              );
                            }}
                            leftSection={<IconVolume />}
                            size="xl"
                          >
                            Unmute
                          </Button>
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
                        onEnded={(e) => this.onVideoEnded(e.currentTarget.src)}
                        playsInline
                        onClick={this.roomTogglePlay}
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
                    {/* Fullscreen chat overlay: newest messages over the player,
                        each fading out ~8s after it arrived (CSS animation) */}
                    {this.state.fullScreen &&
                      document.fullscreenElement !== document.body && (
                        <div className={styles.chatOverlay}>
                          {this.state.chat
                            .filter((m) => !m.system && !m.cmd && m.msg)
                            .slice(-5)
                            .map((msg) => (
                              <div
                                key={msg.timestamp + msg.id}
                                className={styles.chatOverlayItem}
                              >
                                <span className={styles.chatOverlayName}>
                                  {this.state.nameMap[msg.id] || msg.id}
                                </span>
                                <span>{msg.msg}</span>
                              </div>
                            ))}
                          {this.state.chatOverlayTyping && (
                            <input
                              autoFocus
                              className={styles.chatOverlayInput}
                              placeholder="Enter to send, Esc to close"
                              value={this.state.chatOverlayMsg}
                              onChange={(e) =>
                                this.setState({
                                  chatOverlayMsg: e.target.value,
                                })
                              }
                              onBlur={() =>
                                this.setState({ chatOverlayTyping: false })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  this.setState({
                                    chatOverlayTyping: false,
                                    chatOverlayMsg: "",
                                  });
                                } else if (
                                  e.key === "Enter" &&
                                  this.state.chatOverlayMsg &&
                                  this.state.chatOverlayMsg.length <= 10000
                                ) {
                                  this.socket.emit(
                                    "CMD:chat",
                                    this.state.chatOverlayMsg,
                                  );
                                  this.setState({ chatOverlayMsg: "" });
                                }
                              }}
                            />
                          )}
                        </div>
                      )}
                  </div>
                </div>
                {this.state.roomMedia && controls}
                {theater && (
                  <PixelFloor
                    participants={this.state.participants}
                    nameMap={this.state.nameMap}
                    socket={this.socket}
                    lightsDown={lightsDown}
                    stubs={this.state.ticketStubs}
                  />
                )}
                {!isMobile() && !this.state.fullScreen && (
                  <div className={styles.expandButton}>
                    <ActionIcon
                      onClick={() => {
                        const newVal = !this.state.showChatColumn;
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
                      onClick={async () =>
                        this.updateName(await generateName())
                      }
                    >
                      Random
                    </Button>
                  }
                />
                <InviteButton />
              </div>
              <div className={styles.segGroup}>
                <Button
                  variant={this.state.showPeopleColumn ? "light" : "subtle"}
                  color="violet"
                  onClick={() =>
                    this.setState({
                      showPeopleColumn: !this.state.showPeopleColumn,
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
                  />
                </div>
              )}
              <Chat
                chat={this.state.chat}
                nameMap={this.state.nameMap}
                pictureMap={this.state.pictureMap}
                socket={this.socket}
                scrollTimestamp={this.state.scrollTimestamp}
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
