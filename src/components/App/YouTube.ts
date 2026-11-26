import { MediaPlayerClass } from "dashjs";
import { Player } from "./Player";

export class YouTube implements Player {
  watchPartyYTPlayer: YT.Player | null;
  constructor(watchPartyYTPlayer: YT.Player | null) {
    this.watchPartyYTPlayer = watchPartyYTPlayer;
    // The embed loads its captions module by itself for every video it loads
    // (measured R34A, even after unloadModule + a new cue): after an explicit
    // Off pick, switch it off again once the video has loaded, so Off stays
    // true. Before any pick (null) YouTube's own default is left alone
    watchPartyYTPlayer?.addEventListener("onStateChange", (e) => {
      if (
        this.captionKey === "" &&
        (e.data === window.YT?.PlayerState?.CUED ||
          e.data === window.YT?.PlayerState?.PLAYING)
      ) {
        this.setCaptionTrack("");
      }
    });
  }
  clearDashState = () => {};
  setDashState = (player: MediaPlayerClass) => {};

  // R17C: YouTube fires PLAYING/PAUSED by itself right after the app drives the
  // embed (a playVideo on an ENDED video reports PAUSED ~10 ms later without
  // starting, a seek re-buffers through PLAYING) — the App.tsx relay skips
  // events within this window of an app call; real iframe clicks land later.
  static readonly SELF_EVENT_GRACE_MS = 1000;
  lastAppCallAt = 0;
  lastAppCallWasPlay = false;
  // playVideo's delayed call: a pause / stop / cue that comes after it within
  // the 200 ms must win, or the room's Play-then-Pause ends up playing (R17L)
  playTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  getCurrentTime = () => {
    return this.watchPartyYTPlayer?.getCurrentTime() ?? 0;
  };

  getDuration = () => {
    return this.watchPartyYTPlayer?.getDuration() ?? 0;
  };

  isMuted = () => {
    return this.watchPartyYTPlayer?.isMuted() ?? false;
  };

  // The embed's own getOption('captions', 'track') never changes after a
  // setOption / unloadModule (measured R34A: it keeps reporting the default
  // track), so the pick is remembered here: null = none made, YouTube's own
  // default applies (start state); "" = Off picked (sticky across media
  // changes, like YouTube's CC toggle); else the key of the picked track
  captionKey: string | null = null;

  isSubtitled = (): boolean => {
    return !!this.captionKey;
  };

  getPlaybackRate = (): number => {
    return this.watchPartyYTPlayer?.getPlaybackRate() ?? 1;
  };

  setPlaybackRate = (rate: number) => {
    this.watchPartyYTPlayer?.setPlaybackRate(rate);
  };

  setSrcAndTime = async (src: string, time: number) => {
    let url = new window.URL(src);
    // Standard link https://www.youtube.com/watch?v=ID
    let videoId = new URLSearchParams(url.search).get("v");
    // Link shortener https://youtu.be/ID
    let altVideoId = src.split("/").slice(-1)[0].split("?")[0];
    this.lastAppCallAt = Date.now();
    this.lastAppCallWasPlay = false;
    clearTimeout(this.playTimer);
    // Off stays Off for the new video; a language pick was for the previous
    // video (the new one may not have it): back to YouTube's own default
    if (this.captionKey === "") {
      this.setCaptionTrack("");
    } else {
      this.captionKey = null;
    }
    this.watchPartyYTPlayer?.cueVideoById(videoId || altVideoId, time);
    // this.watchPartyYTPlayer?.cuePlaylist({listType: 'playlist', list: 'OLAK5uy_mtoaOGQksRdPbwlNtQ9IiK67wir5QqyIc'});
  };

  playVideo = async () => {
    // stamped at intent so the grace window spans the 200 ms delayed call
    this.lastAppCallAt = Date.now();
    this.lastAppCallWasPlay = true;
    clearTimeout(this.playTimer);
    this.playTimer = setTimeout(() => {
      console.log("play yt");
      this.watchPartyYTPlayer?.playVideo();
    }, 200);
  };

  pauseVideo = () => {
    this.lastAppCallAt = Date.now();
    this.lastAppCallWasPlay = false;
    clearTimeout(this.playTimer);
    this.watchPartyYTPlayer?.pauseVideo();
  };

  seekVideo = (time: number) => {
    this.lastAppCallAt = Date.now();
    this.lastAppCallWasPlay = false;
    this.watchPartyYTPlayer?.seekTo(time, true);
  };

  shouldPlay = () => {
    return (
      this.watchPartyYTPlayer?.getPlayerState() ===
        window.YT?.PlayerState?.PAUSED ||
      this.getCurrentTime() === this.getDuration()
    );
  };

  setMute = (muted: boolean) => {
    if (muted) {
      this.watchPartyYTPlayer?.mute();
    } else {
      this.watchPartyYTPlayer?.unMute();
    }
  };

  setVolume = (volume: number) => {
    this.watchPartyYTPlayer?.setVolume(volume * 100);
  };

  getVolume = (): number => {
    const volume = this.watchPartyYTPlayer?.getVolume();
    return (volume ?? 0) / 100;
  };

  // The captions module of the IFrame API (not in the typings)
  private captionsApi = () =>
    this.watchPartyYTPlayer as unknown as {
      getOption: (module: string, option: string) => unknown;
      setOption: (module: string, option: string, value: unknown) => void;
      loadModule: (module: string) => void;
      unloadModule: (module: string) => void;
    } | null;

  // The caption tracks of the loaded video (manual and auto-generated), as
  // the embed lists them; empty until the video's data has loaded
  getCaptionTracks = (): {
    key: string;
    languageCode: string;
    kind: string;
    displayName: string;
  }[] => {
    try {
      const list = this.captionsApi()?.getOption("captions", "tracklist");
      if (!Array.isArray(list)) {
        return [];
      }
      return list
        .filter((t) => t && typeof t.languageCode === "string")
        .map((t) => ({
          key: t.languageCode + (t.kind ? ":" + t.kind : ""),
          languageCode: t.languageCode,
          kind: t.kind ?? "",
          displayName: t.displayName || t.languageName || t.languageCode,
        }));
    } catch (e) {
      return [];
    }
  };

  // Shows one caption track in this member's embed only (the room is not
  // told); "" turns captions off. The embed shows nothing until its captions
  // module is loaded, and a track can only be picked while it is loaded
  setCaptionTrack = (key: string) => {
    const api = this.captionsApi();
    if (!api) {
      return;
    }
    try {
      if (!key) {
        api.unloadModule("captions");
        this.captionKey = "";
        return;
      }
      const track = this.getCaptionTracks().find((t) => t.key === key);
      if (!track) {
        return;
      }
      if (!this.captionKey) {
        api.loadModule("captions");
      }
      api.setOption("captions", "track", {
        languageCode: track.languageCode,
        ...(track.kind ? { kind: track.kind } : {}),
      });
      this.captionKey = key;
    } catch (e) {
      console.warn(e);
    }
  };

  setSubtitleMode = (mode?: TextTrackMode, lang?: string) => {
    if (mode === "hidden") {
      this.setCaptionTrack("");
    } else if (mode === "showing") {
      const track = this.getCaptionTracks().find(
        (t) => t.languageCode === (lang ?? "en"),
      );
      if (track) {
        this.setCaptionTrack(track.key);
      }
    }
  };

  getSubtitleMode = () => {
    return (this.captionKey ? "showing" : "hidden") as TextTrackMode;
  };

  isReady = () => {
    return Boolean(this.watchPartyYTPlayer);
  };

  stopVideo = () => {
    this.lastAppCallAt = Date.now();
    this.lastAppCallWasPlay = false;
    clearTimeout(this.playTimer);
    this.watchPartyYTPlayer?.stopVideo();
  };

  clearState = () => {
    return;
  };

  loadSubtitles = async (src: string) => {
    return;
  };

  syncSubtitles = (sharerTime: number) => {
    return;
  };

  getTimeRanges = (): { start: number; end: number }[] => {
    return [
      {
        start: 0,
        end:
          (this.watchPartyYTPlayer?.getVideoLoadedFraction() ?? 0) *
          this.getDuration(),
      },
    ];
  };

  setLoop = (loop: boolean): void => {
    this.watchPartyYTPlayer?.setLoop(loop);
  };

  getVideoEl = (): HTMLMediaElement => {
    return document.getElementById("leftYt") as HTMLMediaElement;
  };

  // Real title from the iframe player (populated once the video's metadata
  // loads); empty until then, so callers fall back to the URL-derived name
  getVideoTitle = (): string => {
    try {
      return this.watchPartyYTPlayer?.getVideoData().title ?? "";
    } catch (e) {
      return "";
    }
  };
}
