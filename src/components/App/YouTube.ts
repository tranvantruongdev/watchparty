import { MediaPlayerClass } from "dashjs";
import { Player } from "./Player";

export class YouTube implements Player {
  watchPartyYTPlayer: YT.Player | null;
  constructor(watchPartyYTPlayer: YT.Player | null) {
    this.watchPartyYTPlayer = watchPartyYTPlayer;
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

  isSubtitled = (): boolean => {
    // This actually isn't accurate after subtitles have been toggled off because track doesn't update
    // try {
    //   const current = this.watchPartyYTPlayer?.getOption('captions', 'track');
    //   return Boolean(current && current.languageCode);
    // } catch (e) {
    //   console.warn(e);
    //   return false;
    // }
    return false;
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

  setSubtitleMode = (mode?: TextTrackMode, lang?: string) => {
    // Show the available options
    // console.log(this.watchPartyYTPlayer?.getOptions('captions'));
    if (mode === "showing") {
      console.log(lang);
      //@ts-expect-error
      this.watchPartyYTPlayer?.setOption("captions", "reload", true);
      //@ts-expect-error
      this.watchPartyYTPlayer?.setOption("captions", "track", {
        languageCode: lang ?? "en",
      });
    }
    if (mode === "hidden") {
      // BUG this doesn't actually set the value of track
      // so we can't determine if subtitles are on or off
      // need to provide separate menu options
      //@ts-expect-error
      this.watchPartyYTPlayer?.setOption("captions", "track", {});
    }
  };

  getSubtitleMode = () => {
    return "hidden" as TextTrackMode;
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
