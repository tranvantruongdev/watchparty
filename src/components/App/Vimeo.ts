import { Player } from "./Player";
import { parseVimeo } from "../../utils/utils";

// The Vimeo Player SDK talks to the player iframe by postMessage, so every
// call is async. Position, duration, paused and rate are kept from its events
// so the Player methods the room sync calls stay synchronous.
type SdkPlayer = {
  ready: () => Promise<void>;
  on: (event: string, callback: (data: any) => void) => void;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  setCurrentTime: (seconds: number) => Promise<number>;
  setMuted: (muted: boolean) => Promise<boolean>;
  setVolume: (volume: number) => Promise<number>;
  setPlaybackRate: (rate: number) => Promise<number>;
  getDuration: () => Promise<number>;
  getVideoTitle: () => Promise<string>;
  destroy: () => Promise<void>;
};

const SDK_URL = "https://player.vimeo.com/api/player.js";
// A private, removed or embedding-disabled video shows Vimeo's own notice in
// the iframe and never answers the SDK: give up on ready() after this
const READY_TIMEOUT_MS = 15000;

// One script tag, added the first time a Vimeo video is played
let sdkPromise: Promise<new (el: HTMLIFrameElement) => SdkPlayer> | undefined;
const loadSdk = () => {
  sdkPromise ??= new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = SDK_URL;
    tag.async = true;
    tag.onload = () => resolve((window as any).Vimeo.Player);
    tag.onerror = () => {
      sdkPromise = undefined;
      tag.remove();
      reject(new Error("The Vimeo player script did not load"));
    };
    document.body.append(tag);
  });
  return sdkPromise;
};

export type VimeoCallbacks = {
  // The player is ready: the room position and play state can be applied
  onLoaded: () => void;
  onEnded: () => void;
  // A click in the iframe's own controls, not something the app drove
  onUserPlay: () => void;
  onUserPause: () => void;
  onUserSeek: (seconds: number) => void;
  onError: (message: string) => void;
};

export class Vimeo implements Player {
  // Vimeo reports play / pause / seeked for what the app did too: events this
  // soon after an app call are its echo, not a person using the iframe
  static readonly SELF_EVENT_GRACE_MS = 1000;
  // A seek takes a while to report on a slow link: a seeked event that lands
  // on an app seek's target within this long is that seek's echo
  static readonly SELF_SEEK_WINDOW_MS = 10000;
  static readonly SELF_SEEK_TOLERANCE_S = 1;

  callbacks: VimeoCallbacks;
  constructor(callbacks: VimeoCallbacks) {
    this.callbacks = callbacks;
  }

  player: SdkPlayer | null = null;
  ready = false;
  // Bumped by every load and teardown: a step that resumes under an older
  // value belongs to a video the room already left
  generation = 0;
  // What the player is actually doing (from its events)
  paused = true;
  buffering = false;
  ended = false;
  // What the room last asked for or the viewer chose: roomTogglePlay reads it
  // at once, the events arrive a moment later
  wantPlay = false;
  duration = 0;
  rate = 1;
  volume = 1;
  muted = false;
  title = "";
  loadedFraction = 0;
  // Last position the player reported (or we seeked to), and when
  position = 0;
  positionAt = 0;
  // The room's position when this video was started (the App seeks to it when
  // nobody has reported a position yet)
  startAt = 0;
  lastAppCallAt = 0;
  // Targets of the app's recent seeks, matched against "seeked" events
  appSeeks: { target: number; at: number }[] = [];

  private setPosition = (seconds: number) => {
    this.position = seconds;
    this.positionAt = Date.now();
  };

  // Calls made before ready() are queued by the SDK and fire their events
  // once it is: nothing before that is a viewer
  private fromApp = () =>
    !this.ready || Date.now() - this.lastAppCallAt < Vimeo.SELF_EVENT_GRACE_MS;

  private isOwnSeek = (seconds: number) => {
    const now = Date.now();
    return this.appSeeks.some(
      (s) =>
        now - s.at < Vimeo.SELF_SEEK_WINDOW_MS &&
        Math.abs(s.target - seconds) < Vimeo.SELF_SEEK_TOLERANCE_S,
    );
  };

  getCurrentTime = () => {
    if (this.paused || this.buffering) {
      return this.position;
    }
    // timeupdate arrives every ~250 ms: carry the position between events
    const t =
      this.position + ((Date.now() - this.positionAt) / 1000) * this.rate;
    return this.duration > 0 ? Math.min(t, this.duration) : t;
  };

  getDuration = () => this.duration;

  isMuted = () => this.muted;

  isSubtitled = () => false;

  getPlaybackRate = () => this.rate;

  setPlaybackRate = (rate: number) => {
    const before = this.rate;
    this.rate = rate;
    // Outside what Vimeo offers (e.g. 3x): the player stays where it was
    this.player?.setPlaybackRate(rate).catch(() => {
      this.rate = before;
    });
  };

  // Tears down whatever was playing, builds the player for src and resolves
  // once it is ready (or has failed: callbacks.onError)
  setSrcAndTime = async (src: string, time: number) => {
    this.teardown();
    const generation = this.generation;
    const parsed = parseVimeo(src);
    if (!parsed) {
      this.callbacks.onError("This is not a Vimeo video link");
      return;
    }
    this.startAt = time;
    this.setPosition(time);
    let Sdk;
    try {
      Sdk = await loadSdk();
    } catch (e: any) {
      if (generation === this.generation) {
        this.callbacks.onError(e.message);
      }
      return;
    }
    const container = document.getElementById("leftVimeo");
    if (generation !== this.generation || !container) {
      return;
    }
    const iframe = document.createElement("iframe");
    const params = new URLSearchParams({ dnt: "1", playsinline: "1" });
    if (parsed.hash) {
      params.set("h", parsed.hash);
    }
    iframe.src = `https://player.vimeo.com/video/${parsed.id}?${params}`;
    iframe.title = "Vimeo";
    iframe.allow = "autoplay; fullscreen; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.style.cssText = "width:100%;height:100%;border:0";
    container.append(iframe);
    const player = new Sdk(iframe);
    this.player = player;
    this.wire(player, generation);
    const timer = window.setTimeout(() => {
      if (generation === this.generation) {
        this.callbacks.onError(
          "Vimeo did not answer: the video may be private, removed, or not allowed to be embedded",
        );
      }
    }, READY_TIMEOUT_MS);
    try {
      await player.ready();
    } catch (e: any) {
      if (generation === this.generation) {
        this.callbacks.onError(e?.message || "Vimeo could not start");
      }
      return;
    } finally {
      window.clearTimeout(timer);
    }
    if (generation !== this.generation) {
      return;
    }
    this.ready = true;
    // Events of calls queued while loading are the app's, however late
    this.lastAppCallAt = Date.now();
    player
      .getDuration()
      .then((d) => generation === this.generation && (this.duration = d))
      .catch(() => {});
    player
      .getVideoTitle()
      .then((t) => generation === this.generation && (this.title = t))
      .catch(() => {});
    this.callbacks.onLoaded();
  };

  private wire = (player: SdkPlayer, generation: number) => {
    const on = (event: string, callback: (data: any) => void) =>
      player.on(event, (data) => {
        if (generation === this.generation) {
          callback(data);
        }
      });
    on("play", () => {
      const byViewer = !this.fromApp();
      this.paused = false;
      this.ended = false;
      this.wantPlay = true;
      this.setPosition(this.position);
      if (byViewer) {
        this.callbacks.onUserPlay();
      }
    });
    on("playing", () => {
      this.paused = false;
      this.buffering = false;
      this.setPosition(this.position);
    });
    on("pause", () => {
      // Vimeo pauses at the end too (before or after "ended")
      const atEnd =
        this.ended ||
        (this.duration > 0 && this.getCurrentTime() >= this.duration - 0.5);
      const byViewer = !this.fromApp() && !atEnd;
      this.setPosition(this.getCurrentTime());
      this.paused = true;
      if (byViewer) {
        this.wantPlay = false;
        this.callbacks.onUserPause();
      }
    });
    on("timeupdate", (data) => {
      this.setPosition(data.seconds);
      this.duration = data.duration || this.duration;
    });
    on("progress", (data) => {
      this.loadedFraction = data.percent;
    });
    on("seeked", (data) => {
      this.setPosition(data.seconds);
      if (!this.fromApp() && !this.isOwnSeek(data.seconds)) {
        this.callbacks.onUserSeek(data.seconds);
      }
    });
    on("bufferstart", () => {
      this.setPosition(this.getCurrentTime());
      this.buffering = true;
    });
    on("bufferend", () => {
      this.buffering = false;
      this.setPosition(this.position);
    });
    on("ended", () => {
      this.ended = true;
      this.paused = true;
      this.wantPlay = false;
      this.callbacks.onEnded();
    });
    on("playbackratechange", (data) => {
      this.rate = data.playbackRate;
    });
    on("error", (data) => {
      this.callbacks.onError(
        data?.message || "Vimeo could not play this video",
      );
    });
  };

  // Removes the iframe; a no-op when no Vimeo video is up
  teardown = () => {
    this.generation++;
    this.player?.destroy().catch(() => {});
    this.player = null;
    document.getElementById("leftVimeo")?.replaceChildren();
    this.ready = false;
    this.paused = true;
    this.buffering = false;
    this.ended = false;
    this.wantPlay = false;
    this.duration = 0;
    this.rate = 1;
    this.title = "";
    this.loadedFraction = 0;
    this.appSeeks = [];
    this.startAt = 0;
    this.position = 0;
  };

  playVideo = async () => {
    this.lastAppCallAt = Date.now();
    this.wantPlay = true;
    try {
      await this.player?.play();
    } catch (e) {
      // Autoplay refused: the room says playing, this player is not
      this.wantPlay = false;
      throw e;
    }
  };

  pauseVideo = () => {
    this.lastAppCallAt = Date.now();
    this.wantPlay = false;
    this.player?.pause().catch(() => {});
  };

  seekVideo = (time: number) => {
    const target =
      this.duration > 0 ? Math.min(time, this.duration) : Math.max(time, 0);
    const now = Date.now();
    this.appSeeks = this.appSeeks.filter(
      (s) => now - s.at < Vimeo.SELF_SEEK_WINDOW_MS,
    );
    this.appSeeks.push({ target, at: now });
    this.setPosition(target);
    this.player?.setCurrentTime(target).catch(() => {});
  };

  shouldPlay = () => !this.wantPlay || this.ended;

  setMute = (muted: boolean) => {
    this.muted = muted;
    this.player?.setMuted(muted).catch(() => {});
  };

  setVolume = (volume: number) => {
    this.volume = volume;
    this.player?.setVolume(volume).catch(() => {});
  };

  getVolume = () => this.volume;

  // No captions for Vimeo (the file subtitle menu is not offered for it)
  getSubtitleMode = () => "hidden" as TextTrackMode;

  setSubtitleMode = (_mode?: TextTrackMode) => {};

  isReady = () => this.ready;

  clearState = () => {};

  loadSubtitles = (_src: string) => {};

  syncSubtitles = (_sharerTime: number) => {};

  getTimeRanges = (): { start: number; end: number }[] => [
    { start: 0, end: this.loadedFraction * this.duration },
  ];

  // The app loops by seeking to 0 when the video ends (onVideoEnded)
  setLoop = (_loop: boolean) => {};

  // The div the iframe lives in (like YouTube's iframe: not a media element)
  getVideoEl = (): HTMLMediaElement =>
    document.getElementById("leftVimeo") as unknown as HTMLMediaElement;

  getVideoTitle = () => this.title;
}
