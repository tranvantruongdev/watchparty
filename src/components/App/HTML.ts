import { default as toWebVTT } from "srt-webvtt";
import { Player } from "./Player";
import { getCurrentSettings } from "../Settings/LocalSettings";

// VTTCue line numbers (snapToLines): negative counts up from the bottom
const SUBTITLE_LINES = { higher: -4, top: 0 };

export class HTML implements Player {
  elId: string;
  localTrackUrl?: string;
  constructor(elId: string) {
    this.elId = elId;
  }

  getVideoEl = (): HTMLMediaElement => {
    return document.getElementById(this.elId) as HTMLMediaElement;
  };

  // Native files have no title metadata; the wall shows the URL-derived name
  getVideoTitle = (): string => {
    return "";
  };

  getCurrentTime = () => {
    return this.getVideoEl()?.currentTime ?? 0;
  };

  getDuration = () => {
    return this.getVideoEl()?.duration ?? 0;
  };

  isMuted = () => {
    return this.getVideoEl()?.muted ?? false;
  };

  isSubtitled = () => {
    return this.getSubtitleMode() === "showing";
  };

  getPlaybackRate = (): number => {
    return this.getVideoEl()?.playbackRate ?? 1;
  };

  setPlaybackRate = (rate: number) => {
    if (this.getVideoEl()) {
      this.getVideoEl().playbackRate = rate;
    }
  };

  setSrcAndTime = async (src: string, time: number) => {
    const leftVideo = this.getVideoEl();
    if (leftVideo) {
      leftVideo.currentTime = time;
      leftVideo.src = src;
    }
  };

  playVideo = async () => {
    if (this.getVideoEl()) {
      await this.getVideoEl().play();
    }
  };

  pauseVideo = () => {
    if (this.getVideoEl()) {
      this.getVideoEl().pause();
    }
  };

  seekVideo = (time: number) => {
    if (this.getVideoEl()) {
      this.getVideoEl().currentTime = time;
    }
  };

  shouldPlay = () => {
    const leftVideo = this.getVideoEl();
    return Boolean(leftVideo?.paused || leftVideo?.ended);
  };

  setMute = (muted: boolean) => {
    const leftVideo = this.getVideoEl();
    if (leftVideo) {
      leftVideo.muted = muted;
    }
    const audio = document.getElementById("iPhoneAudio") as HTMLAudioElement;
    if (audio) {
      audio.muted = muted;
    }
  };

  setVolume = (volume: number) => {
    if (this.getVideoEl()) {
      this.getVideoEl().volume = volume;
    }
  };

  getVolume = (): number => {
    return this.getVideoEl()?.volume ?? 1;
  };

  setSubtitleMode = (mode?: TextTrackMode) => {
    if (this.getVideoEl()) {
      for (
        let i = 0;
        i < Math.min(this.getVideoEl().textTracks.length, 1);
        i++
      ) {
        this.getVideoEl().textTracks[i].mode =
          mode ??
          (this.getVideoEl().textTracks[i].mode === "hidden"
            ? "showing"
            : "hidden");
      }
    }
  };

  getSubtitleMode = () => {
    return this.getVideoEl()?.textTracks[0]?.mode ?? "hidden";
  };

  isReady = () => {
    return Boolean(this.getVideoEl());
  };

  clearState = () => {
    const leftVideo = this.getVideoEl();

    // Clear src and srcObject
    leftVideo.src = "";
    leftVideo.srcObject = null;

    // Clear subtitles
    this.setSubtitleMode("hidden");
    this.dropLocalSubtitle();
    leftVideo.innerHTML = "";
  };

  loadSubtitles = async (src: string) => {
    const leftVideo = this.getVideoEl();
    if (!leftVideo) {
      return;
    }
    // Clear subtitles and put new ones in
    this.dropLocalSubtitle();
    leftVideo.innerHTML = "";
    if (Boolean(src)) {
      let subtitleSrc = src;
      if (subtitleSrc) {
        const response = await fetch(subtitleSrc);
        const buffer = await response.arrayBuffer();
        const url = await toWebVTT(new Blob([buffer]));
        const track = document.createElement("track");
        track.kind = "captions";
        track.label = "English";
        track.srclang = "en";
        track.src = url;
        track.addEventListener("load", this.applySubtitleStyle);
        leftVideo.appendChild(track);
        leftVideo.textTracks[0].mode = "showing";
        this.applySubtitleStyle();
      }
    }
  };

  // Local (per-browser) subtitle size and position from the saved settings.
  // Size is a ::cue rule scoped to the player video; position moves the cues
  // of the active track, and runs again once a track's cues have loaded.
  applySubtitleStyle = () => {
    const { subtitleSize, subtitlePosition } = getCurrentSettings();
    const styleId = "wp-subtitle-style";
    let style = document.getElementById(styleId);
    if (subtitleSize && subtitleSize !== 100) {
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        document.head.appendChild(style);
      }
      style.textContent = `#${this.elId}::cue { font-size: ${subtitleSize}%; }`;
    } else {
      style?.remove();
    }
    const track = this.getVideoEl()?.textTracks[0];
    const cues = track?.cues;
    if (!track || !cues) {
      return;
    }
    let moved = false;
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i] as VTTCue & {
        origLine?: { line: LineAndPositionSetting; snap: boolean };
      };
      if (!cue.origLine) {
        cue.origLine = { line: cue.line, snap: cue.snapToLines };
      }
      const line =
        subtitlePosition === "higher" || subtitlePosition === "top"
          ? SUBTITLE_LINES[subtitlePosition]
          : cue.origLine.line;
      if (cue.line !== line) {
        cue.snapToLines = line === cue.origLine.line ? cue.origLine.snap : true;
        cue.line = line;
        moved = true;
      }
    }
    // Chromium keeps drawing an already shown cue where it was; re-showing
    // the track makes it lay the cues out again
    if (moved && track.mode === "showing") {
      track.mode = "hidden";
      track.mode = "showing";
    }
  };

  dropLocalSubtitle = () => {
    if (this.localTrackUrl) {
      URL.revokeObjectURL(this.localTrackUrl);
      this.localTrackUrl = undefined;
    }
  };

  loadLocalSubtitle = async (file: File) => {
    const leftVideo = this.getVideoEl();
    if (!leftVideo) {
      return;
    }
    const buffer = await file.arrayBuffer();
    let text: string;
    try {
      // Strict UTF-8 first: Vietnamese .srt files are often windows-1258
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      text = new TextDecoder("windows-1258").decode(buffer);
    }
    // Whoever loads last wins: room subtitle and previous local track both go
    this.dropLocalSubtitle();
    leftVideo.innerHTML = "";
    let url: string;
    if (file.name.toLowerCase().endsWith(".vtt")) {
      url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
    } else {
      url = await toWebVTT(new Blob([text]));
    }
    this.localTrackUrl = url;
    const track = document.createElement("track");
    track.kind = "captions";
    track.label = file.name;
    track.src = url;
    track.addEventListener("load", this.applySubtitleStyle);
    leftVideo.appendChild(track);
    leftVideo.textTracks[0].mode = "showing";
    this.applySubtitleStyle();
  };

  syncSubtitles = (sharerTime: number) => {
    // When sharing, our timestamp doesn't match the subtitles so adjust them
    // For each cue, subtract the videoTS of the sharer, then add our own
    const leftVideo = this.getVideoEl();
    const track = leftVideo?.textTracks[0];
    let offset = leftVideo.currentTime - sharerTime;
    if (track && track.cues && offset) {
      for (let i = 0; i < track.cues.length; i++) {
        let cue = track?.cues?.[i] as TextTrackCue & {
          origStart: number;
          origEnd: number;
        };
        if (!cue) {
          continue;
        }
        // console.log(cue.text, offset, cue.origStart, cue.origEnd);
        if (!cue.origStart) {
          cue.origStart = cue.startTime;
          cue.origEnd = cue.endTime;
        }
        cue.startTime = cue.origStart + offset;
        cue.endTime = cue.origEnd + offset;
      }
    }
  };

  getTimeRanges = (): { start: number; end: number }[] => {
    const leftVideo = this.getVideoEl();
    const buffers = [];
    const rangeCount = leftVideo?.buffered.length;
    for (let i = 0; i < rangeCount; i++) {
      const start = leftVideo?.buffered.start(i);
      const end = leftVideo?.buffered.end(i);
      buffers.push({ start, end });
    }
    return buffers;
  };

  setLoop = (loop: boolean): void => {
    const leftVideo = this.getVideoEl();
    leftVideo.loop = loop;
  };
}
