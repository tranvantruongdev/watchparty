import React from "react";
import { createPortal } from "react-dom";
import { ActionIcon, Button, Select, Slider } from "@mantine/core";
import { Socket } from "socket.io-client";

import {
  formatTimestamp,
  getOrCreateClientId,
  getColorForStringHex,
  getDefaultPicture,
  iceServers,
  isTouchPrimary,
  softWhite,
} from "../../utils/utils";
import { UserMenu } from "../UserMenu/UserMenu";
import { MetadataContext } from "../../MetadataContext";
import {
  MAX_VOICE_VOLUME,
  parseStoredVoiceVolume,
  voicePeerOutput,
} from "./voiceVolume";
import { isMutedForMe, mutedForMeIds, setMutedForMe } from "./localVoice";
import { VoiceTileMenu } from "./VoiceTileMenu";
import {
  IconDotsVertical,
  IconMicrophone,
  IconScreenShare,
  IconVideo,
  IconVolume,
  IconX,
} from "@tabler/icons-react";
import classes from "./VideoChat.module.css";

interface VideoChatProps {
  socket: Socket;
  participants: User[];
  pictureMap: StringDict;
  nameMap: StringDict;
  tsMap: NumberDict;
  rosterUpdateTS: Number;
  hide?: boolean;
  owner: string | undefined;
  getLeaderTime: () => number;
  // Headphones off: don't hear the others (and don't auto-join to listen)
  deaf: boolean;
}

// Headset-style mic: keep the close voice, drop the room. voiceIsolation is
// Chrome's ML voice filter (ignored where unsupported); auto gain off so quiet
// far-away sounds aren't boosted up to speech level
const micConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
  voiceIsolation: true,
} as MediaTrackConstraints;

// The mic the user picked (a deviceId); asked for as "ideal" so an unplugged
// device falls back to the default one instead of failing the capture
const MIC_KEY = "watchparty-mic";
const SYSTEM_MIC = "__system_default__";
const readSavedMic = () => {
  try {
    return window.localStorage.getItem(MIC_KEY) ?? "";
  } catch {
    return "";
  }
};
const micAudio = (deviceId: string, exact = false): MediaTrackConstraints =>
  deviceId
    ? {
        ...micConstraints,
        deviceId: exact ? { exact: deviceId } : { ideal: deviceId },
      }
    : micConstraints;

// Voice volume 0..300%, saved so it survives reloads. window.watchparty is
// (re)created by App.tsx after this module loads, so seed it on first read
const VOICE_VOLUME_KEY = "watchparty-voice-volume";
const getVoiceVolume = () => {
  if (window.watchparty.voiceVolume == null) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(VOICE_VOLUME_KEY);
    } catch {}
    window.watchparty.voiceVolume = parseStoredVoiceVolume(raw);
  }
  return window.watchparty.voiceVolume;
};

// HD voice: Chrome encodes opus at ~32 kbps mono by default. maxaveragebitrate
// in the fmtp is the encoder cap (RFC 7587 §6.1) — raise it to 64 kbps, the
// level voice chat apps like Discord ship at; inband FEC is already on, and it
// gets more room to work at the higher bitrate. Munged into our offer AND our
// answer so whichever side encodes reads it (jitsi's mungeOpus does both
// directions the same way)
const HD_VOICE_BITRATE = 64000;
const hdVoiceSdp = (sdp: string | undefined) =>
  sdp?.replace(
    "useinbandfec=1",
    `useinbandfec=1; maxaveragebitrate=${HD_VOICE_BITRATE}`,
  );

// Prefer Opus RED (RFC 2198 RTP-level redundancy) on the voice audio
// transceivers: the sender wraps each packet with the previous frame, so a
// receiver hides isolated losses from its redundant copy instead of
// concealing (inband FEC repairs individual frames only; RED keeps whole
// packets). Prefs keep every other codec after RED, so a peer without RED
// still negotiates plain opus from the same offer. Applied at PC creation
// (and the rare addTrack fallback in setupWebRTC) so both offers and answers
// carry it. Audio only — screen-share audio is multiopus, untouched.
const preferRedVoice = (pc: RTCPeerConnection) => {
  const caps = RTCRtpSender.getCapabilities("audio");
  if (!caps) {
    return;
  }
  const red = caps.codecs.filter(
    (c) => c.mimeType.toLowerCase() === "audio/red",
  );
  if (!red.length) {
    return;
  }
  const rest = caps.codecs.filter(
    (c) => c.mimeType.toLowerCase() !== "audio/red",
  );
  pc.getTransceivers().forEach((tr) => {
    if (tr.receiver.track.kind === "audio") {
      try {
        tr.setCodecPreferences([...red, ...rest]);
      } catch {
        // A codec list the browser rejects must never break voice setup
      }
    }
  });
};

// Perfect-negotiation state, keyed per RTCPeerConnection in WeakMaps: closing
// or rebuilding a PC drops its entry with it, so an old PC's queued candidates
// can never leak into its replacement and no teardown site has to clean up
const makingOffer = new WeakMap<RTCPeerConnection, boolean>();
const pendingIce = new WeakMap<RTCPeerConnection, RTCIceCandidate[]>();

// Candidates that arrive before any remote description (there addIceCandidate
// rejects outright): hold them and flush right after setRemoteDescription
// succeeds, else a peer waiting out an offer collision stays dark — with no
// remote candidates ICE never starts checking, so the rebuild watchdogs
// (disconnected/failed) never arm either
const queueIce = (pc: RTCPeerConnection, ice: RTCIceCandidate) => {
  const queue = pendingIce.get(pc);
  if (queue) {
    queue.push(ice);
  } else {
    pendingIce.set(pc, [ice]);
  }
};
const flushIce = (pc: RTCPeerConnection) => {
  const queue = pendingIce.get(pc);
  if (!queue) {
    return;
  }
  pendingIce.delete(pc);
  queue.forEach((ice) => pc.addIceCandidate(ice).catch(() => {}));
};

// Events after which a blocked voice element may be played. A mouse click or
// key press counts as activation at pointerdown/keydown, a touch only at
// touchend/pointerup (round 188)
const GESTURE_EVENTS = ["pointerdown", "pointerup", "touchend", "keydown"];

// How long the "mic disconnected" notice stays on the page
const MIC_NOTICE_MS = 8000;

interface VideoChatState {
  playBlocked: boolean;
  // Page-level notice that the mic ended on its own (round 188): the self-tile
  // hint lives in the People panel, which is closed by default and holds no
  // self tile once the call is left
  micNotice: string;
  voiceVolume: number;
  speaking: string[];
  reconnecting: string[];
  // Microphones the browser lists (labels stay empty until mic permission)
  mics: { id: string; label: string }[];
  // Device-loss hint on the self tile (round 95)
  deviceHint: string;
  // Saved mic deviceId ("" = system default)
  micId: string;
  // Width of the voice-tile flex root (clientWidth incl. padding, 0 until
  // first measurement): tiles shrink so two fit per row on phones (round 167)
  peopleW: number;
  // Seats this listener muted locally (round 180), mirrored from localVoice so
  // the tile icon and menu label re-render on toggle
  mutedForMe: string[];
}

export class VideoChat extends React.Component<VideoChatProps, VideoChatState> {
  // Voice volume also lives on window.watchparty so it survives element
  // remounts and People-panel collapse (a fresh instance re-seeds from there)
  state = {
    playBlocked: false,
    micNotice: "",
    voiceVolume: getVoiceVolume(),
    speaking: [] as string[],
    reconnecting: [] as string[],
    mics: [] as { id: string; label: string }[],
    micId: readSavedMic(),
    // One-line device-loss hint shown on the self tile ("round 95"): a mic or
    // camera that ended on its own silently drops to mute/camera-off, so say
    // why next to the control; cleared when that device is live again
    deviceHint: "",
    peopleW: 0,
    mutedForMe: mutedForMeIds(),
  };
  static contextType = MetadataContext;
  declare context: React.ContextType<typeof MetadataContext>;

  socket = this.props.socket;
  // One stream per peer that we fill with their tracks ourselves: a track
  // that starts on a recvonly transceiver (they were listening, then opened
  // their mic) arrives with no stream of its own
  remoteStreams: Record<string, MediaStream> = {};
  elStreams: Record<string, MediaStream> = {};
  // Who is talking: clientId -> last poll where their incoming audio level
  // was above the speaking threshold (see pollSpeaking)
  speakSeen: { [id: string]: number } = {};
  speakTimer: NodeJS.Timeout | undefined = undefined;
  // Peers whose voice link came up once (so a later non-connected state is a
  // REconnection, not the normal first connect) — see pollSpeaking
  everConnected: { [id: string]: boolean } = {};
  // Above 100% a peer's voice plays through Web Audio (one shared context, a
  // source + gain per peer); at or below 100% none of this exists
  audioCtx: AudioContext | undefined = undefined;
  // The summing bus for routed voice: every peer's gain feeds one limiter
  // before the destination, so several near-full-scale voices sum to a
  // limited mix instead of hard-clipping the output (round 225). Rebuilt if
  // the context changes (close/reopen)
  voiceBus?: { ctx: AudioContext; input: GainNode };
  voiceNodes: {
    [id: string]: {
      track: MediaStreamTrack;
      source: MediaStreamAudioSourceNode;
      gain: GainNode;
    };
  } = {};
  // A mic switch is in flight (serialize changeMic — see the guard there)
  micSwitching = false;
  lastMicAutoReopenAt = 0;
  micNoticeTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  // Bumped by every teardown (Leave, mic-off, auto-listen's leave): a capture
  // that started before the teardown must not resurrect voice when it resolves
  teardownSeq = 0;
  // A camera reopen is in flight (serialize reopenCamera — see the guard there)
  cameraReopening = false;
  // The camera was off at the last mic-off teardown: the next mic-on re-capture
  // starts camera-off too (R16F), or the camera the user turned off would come
  // back. stopWebRTC (a real Leave) resets it
  keepCameraOff = false;
  // Our root element, for the People-closed check below (round 121)
  rootEl: HTMLDivElement | null = null;
  // Watches the root's width so tiles can two-up on narrow panels (round 167)
  resizeObs?: ResizeObserver;

  // The shared AudioContext, made on first need. A context made outside a user
  // gesture starts suspended: resume now (works inside a click) and on the
  // next click, touch or key press. A touch tap fires pointerdown BEFORE the
  // browser counts it as user activation (that lands on touchend/pointerup),
  // so a one-shot pointerdown retry fired refused, was consumed and left the
  // boost dead no matter how many taps followed (round 195, round 188's fix);
  // until it runs, applyVoiceOutput keeps the voice on the element so a
  // suspended context can never silence anyone
  ensureAudioContext = () => {
    if (!this.audioCtx) {
      if (typeof AudioContext === "undefined") {
        return undefined;
      }
      this.audioCtx = new AudioContext();
      this.audioCtx.addEventListener("statechange", this.applyAllVoiceOutputs);
    }
    if (this.audioCtx.state !== "running") {
      this.audioCtx.resume().catch(() => {});
      GESTURE_EVENTS.forEach((type) =>
        document.addEventListener(type, this.resumeAudio, { once: true }),
      );
    }
    return this.audioCtx;
  };

  resumeAudio = () => {
    this.audioCtx?.resume().catch(() => {});
  };

  // Bus input: routed peer gains connect here instead of ctx.destination. One
  // DynamicsCompressor as a limiter (threshold -3 dBFS, fast attack) keeps the
  // summed mix below full scale no matter how many loud voices join; Chrome's
  // automatic compressor makeup gain is undone by the post gain, so a voice
  // below the threshold passes at unity
  voiceBusInput = (ctx: AudioContext) => {
    if (!this.voiceBus || this.voiceBus.ctx !== ctx) {
      const input = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      const post = ctx.createGain();
      post.gain.value = 0.821; // 1/1.218: undoes Edge's compressor makeup gain
      input.connect(limiter);
      limiter.connect(post);
      post.connect(ctx.destination);
      this.voiceBus = { ctx, input };
    }
    return this.voiceBus.input;
  };

  dropVoiceNode = (id: string) => {
    const node = this.voiceNodes[id];
    if (node) {
      node.source.disconnect();
      node.gain.disconnect();
      delete this.voiceNodes[id];
    }
  };

  dropAllVoiceNodes = () => {
    Object.keys(this.voiceNodes).forEach(this.dropVoiceNode);
  };

  // The one place that sets how a seat's voice is played: its element's muted
  // and volume, and (above 100%) its gain node. Called from attach and from
  // every render's ref, so they cannot disagree
  applyVoiceOutput = (id: string) => {
    const el = window.watchparty.videoRefs[id];
    if (!el) {
      return;
    }
    const self = id === getOrCreateClientId();
    const stream = this.remoteStreams[id];
    const hasAudio = !!stream?.getAudioTracks().length;
    const mutedForMe = !self && isMutedForMe(id);
    const volume = getVoiceVolume();
    const ctx =
      !self && !mutedForMe && volume > 1 && hasAudio
        ? this.ensureAudioContext()
        : this.audioCtx;
    // Only use the graph when it can play now; else the element plays at <=100%
    const canRoute =
      !self && !mutedForMe && hasAudio && ctx?.state === "running";
    const out = voicePeerOutput({
      self,
      deaf: this.props.deaf,
      volume: canRoute ? volume : Math.min(volume, 1),
      mutedForMe,
    });
    el.muted = out.muted;
    if (!self) {
      el.volume = out.elementVolume;
    }
    if (out.useGraph && ctx && stream) {
      const track = stream.getAudioTracks()[0];
      // A source follows the one track it was made from: rebuild when it changed
      if (this.voiceNodes[id] && this.voiceNodes[id].track !== track) {
        this.dropVoiceNode(id);
      }
      if (!this.voiceNodes[id]) {
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(this.voiceBusInput(ctx));
        this.voiceNodes[id] = { track, source, gain };
      }
      this.voiceNodes[id].gain.gain.value = out.gain;
    } else {
      this.dropVoiceNode(id);
    }
  };

  applyAllVoiceOutputs = () => {
    Object.keys(window.watchparty.videoRefs).forEach(this.applyVoiceOutput);
  };

  // Keep a dead camera track from holding voice playback at its first frame
  syncElementStream = (id: string) => {
    const stream = this.remoteStreams[id];
    if (!stream) {
      return undefined;
    }
    const elementStream = (this.elStreams[id] ||= new MediaStream());
    const cameraOff = this.props.participants.find(
      (p) => p.id === id,
    )?.isCameraOff;
    const tracks: MediaStreamTrack[] = stream.getAudioTracks();
    if (!cameraOff) {
      tracks.push(...stream.getVideoTracks().filter((track) => !track.muted));
    }
    elementStream.getTracks().forEach((track) => {
      if (!tracks.includes(track)) {
        elementStream.removeTrack(track);
      }
    });
    tracks.forEach((track) => {
      if (!elementStream.getTracks().includes(track)) {
        elementStream.addTrack(track);
      }
    });
    return elementStream;
  };

  // Show the peer's stream on their element (which can mount after the track
  // arrives, or remount) and play it. Autoplay with sound is refused until
  // the page has had a click, so retry on the next click or key press
  attach = (id: string) => {
    const el = window.watchparty.videoRefs[id];
    const stream = this.remoteStreams[id];
    if (!el || !stream) {
      return;
    }
    const elementStream = this.syncElementStream(id);
    if (!elementStream) {
      return;
    }
    // The chosen voice volume rides on every (re)mount of the element; set
    // before the stream so nothing plays unmuted for a moment
    this.applyVoiceOutput(id);
    if (el.srcObject !== elementStream) {
      el.srcObject = elementStream;
    }
    if (el.paused) {
      el.play().catch(() => {
        this.setState({ playBlocked: true });
        GESTURE_EVENTS.forEach((type) =>
          document.addEventListener(type, this.retryPlay),
        );
      });
    }
  };

  // Play every voice element now (inside a gesture). The hint and the gesture
  // listeners go only once every play() succeeded: a touch tap fires pointerdown
  // BEFORE the browser counts it as activation (that happens on touchend /
  // pointerup), so a one-shot pointerdown retry was refused again and left the
  // listener silent with the hint gone (round 188)
  retryPlay = () => {
    Promise.all(
      Object.keys(this.remoteStreams).map((key) => {
        const el = window.watchparty.videoRefs[key];
        return el
          ? el.play().then(
              () => true,
              () => false,
            )
          : true;
      }),
    ).then((done) => {
      if (done.every(Boolean)) {
        GESTURE_EVENTS.forEach((type) =>
          document.removeEventListener(type, this.retryPlay),
        );
        this.setState({ playBlocked: false });
      }
    });
  };

  // One "voice volume" for everyone else (the movie keeps its own slider).
  // State drives the slider thumb; window.watchparty drives attach() on every
  // (re)mount, so the setting outlives element remounts and panel collapse
  setVoiceVolume = (v: number) => {
    window.watchparty.voiceVolume = v;
    try {
      window.localStorage.setItem(VOICE_VOLUME_KEY, String(v));
    } catch {}
    this.setState({ voiceVolume: v });
    if (v > 1) {
      // The slider drag is the user gesture that lets the context run
      this.ensureAudioContext();
    }
    this.applyAllVoiceOutputs();
  };

  // Mute/unmute ONE other member for this listener only (round 180). Purely
  // local: no socket event, so the member and everyone else are unaffected.
  // The store is module-scoped, so the choice survives element remounts, the
  // People panel closing (this component unmounts) and the member's own
  // renegotiation/reconnect, which keeps their clientId
  toggleMutedForMe = (id: string) => {
    setMutedForMe(id, !isMutedForMe(id));
    this.setState({ mutedForMe: mutedForMeIds() });
    this.applyVoiceOutput(id);
  };

  // Microphones the browser lists. Labels are empty until mic permission, so
  // this runs again after each capture and whenever a device is plugged/unplugged
  refreshMics = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.setState({
        mics: devices
          .filter((d) => d.kind === "audioinput" && d.deviceId)
          .map((d) => ({ id: d.deviceId, label: d.label })),
      });
    } catch (e) {
      console.warn(e);
    }
  };

  saveMic = (deviceId: string) => {
    try {
      if (deviceId) {
        window.localStorage.setItem(MIC_KEY, deviceId);
      } else {
        window.localStorage.removeItem(MIC_KEY);
      }
    } catch {}
    this.setState({ micId: deviceId });
  };

  // Pick a microphone. Not capturing yet (or mic off): only remember it for the
  // next mic-on. Capturing: open the new device, then swap its track into our
  // stream and into every connection's audio sender (same sender, so the 64
  // kbps cap stays). Any failure keeps the old mic and does not save the pick
  changeMic = async (deviceId: string) => {
    // One switch at a time: two switches started while the old track is live
    // share the same oldTrack, so the stale checks below cannot tell them
    // apart and both would finish — ourStream ends with two captures while
    // the sender carries only one of them, and the mic button mutes the
    // wrong one. A pick during a switch is dropped (the select snaps back);
    // the failure contract is unchanged: old mic kept, pick not saved
    if (this.micSwitching) {
      return;
    }
    this.micSwitching = true;
    try {
      const ourStream = window.watchparty.ourStream;
      const oldTrack = ourStream?.getAudioTracks()[0];
      if (!ourStream || !oldTrack) {
        this.saveMic(deviceId);
        return;
      }
      let fresh: MediaStream;
      try {
        fresh = await navigator.mediaDevices.getUserMedia({
          audio: micAudio(deviceId, true),
        });
      } catch (e) {
        console.warn("mic switch failed", e);
        return;
      }
      const newTrack = fresh.getAudioTracks()[0];
      // Mic turned off / left / switched again while the device opened
      if (
        window.watchparty.ourStream !== ourStream ||
        ourStream.getAudioTracks()[0] !== oldTrack
      ) {
        fresh.getTracks().forEach((track) => track.stop());
        return;
      }
      // A muted mic stays muted
      newTrack.enabled = oldTrack.enabled;
      await Promise.all(
        Object.entries(window.watchparty.videoPCs).map(([id, pc]) => {
          if (id === getOrCreateClientId() || pc.connectionState === "closed") {
            return undefined;
          }
          // A PC that dies mid-swap is replaced by the roster logic anyway
          return pc
            .getSenders()
            .find((s) => s.track === oldTrack)
            ?.replaceTrack(newTrack)
            .catch(() => {});
        }),
      );
      // The swap's await let mic off / leave / a mute toggle land between
      // the check above and the mutation below: re-check, else a just-opened
      // live mic would be re-added to a stream the user already muted or
      // left, and the enabled state copied earlier would be stale
      if (
        window.watchparty.ourStream !== ourStream ||
        ourStream.getAudioTracks()[0] !== oldTrack
      ) {
        fresh.getTracks().forEach((track) => track.stop());
        return;
      }
      newTrack.enabled = oldTrack.enabled;
      ourStream.removeTrack(oldTrack);
      ourStream.addTrack(newTrack);
      oldTrack.stop();
      newTrack.addEventListener("ended", () => this.micEnded(newTrack));
      this.saveMic(deviceId);
      this.refreshMics();
      this.clearDeviceHint("Microphone");
    } finally {
      this.micSwitching = false;
    }
  };

  micEnded = async (dead: MediaStreamTrack) => {
    if (this.micSwitching) return;
    const ourStream = window.watchparty.ourStream;
    if (!ourStream || ourStream.getAudioTracks()[0] !== dead) return;

    const now = Date.now();
    if (now - this.lastMicAutoReopenAt < 10_000) {
      this.micOff(true);
      return;
    }
    this.lastMicAutoReopenAt = now;

    const isStale = () =>
      window.watchparty.ourStream !== ourStream ||
      ourStream.getAudioTracks()[0] !== dead;
    let fresh: MediaStream | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1500));
        if (isStale()) return;
      }
      try {
        fresh = await navigator.mediaDevices.getUserMedia({
          audio: micAudio(this.state.micId),
        });
      } catch (e) {
        console.warn("mic reopen failed", e);
        if (isStale()) return;
        if (attempt === 1) {
          this.micOff(true);
          return;
        }
        continue;
      }
      if (isStale()) {
        fresh.getTracks().forEach((track) => track.stop());
        return;
      }
      break;
    }

    const newTrack = fresh?.getAudioTracks()[0];
    if (!fresh || !newTrack) {
      fresh?.getTracks().forEach((track) => track.stop());
      this.micOff(true);
      return;
    }
    newTrack.enabled = dead.enabled;
    await Promise.all(
      Object.entries(window.watchparty.videoPCs).map(([id, pc]) => {
        if (id === getOrCreateClientId() || pc.connectionState === "closed") {
          return undefined;
        }
        return pc
          .getSenders()
          .find((s) => s.track === dead)
          ?.replaceTrack(newTrack)
          .catch(() => {});
      }),
    );
    if (isStale()) {
      fresh.getTracks().forEach((track) => track.stop());
      return;
    }
    ourStream.removeTrack(dead);
    ourStream.addTrack(newTrack);
    newTrack.addEventListener("ended", () => this.micEnded(newTrack));
    this.refreshMics();
    this.clearDeviceHint("Microphone");
    this.forceUpdate();
  };

  componentDidMount() {
    this.socket.on("signal", this.handleSignal);
    this.socket.on("roster", this.onRoster);
    this.socket.on("connect", this.onSocketConnect);
    navigator.mediaDevices?.addEventListener("devicechange", this.refreshMics);
    this.refreshMics();
    // The speaking poll has work only while a voice PC exists: a remount into
    // an active voice session restarts it here; a fresh room stays timer-less
    // until updateWebRTC creates the first PC (see startSpeakTimer)
    if (Object.keys(window.watchparty.videoPCs ?? {}).length) {
      this.startSpeakTimer();
    }
    // Tile two-up (round 167): measure the panel once now, then on every
    // width change (phone rotation, People overlay reflow). Same value =
    // no re-render
    if (this.rootEl && typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => {
        const w = this.rootEl?.clientWidth ?? 0;
        this.setState((s) => (s.peopleW === w ? null : { peopleW: w }));
      });
      this.resizeObs.observe(this.rootEl);
    }
  }

  componentWillUnmount() {
    this.resizeObs?.disconnect();
    this.socket.off("signal", this.handleSignal);
    this.socket.off("roster", this.onRoster);
    this.socket.off("connect", this.onSocketConnect);
    navigator.mediaDevices?.removeEventListener(
      "devicechange",
      this.refreshMics,
    );
    if (this.speakTimer) {
      clearInterval(this.speakTimer);
    }
    GESTURE_EVENTS.forEach((type) =>
      document.removeEventListener(type, this.resumeAudio),
    );
    GESTURE_EVENTS.forEach((type) =>
      document.removeEventListener(type, this.retryPlay),
    );
    clearTimeout(this.micNoticeTimer);
    this.dropAllVoiceNodes();
    if (this.audioCtx) {
      this.audioCtx.removeEventListener(
        "statechange",
        this.applyAllVoiceOutputs,
      );
      this.audioCtx.close().catch(() => {});
      this.audioCtx = undefined;
      this.voiceBus = undefined;
    }
  }

  // (Re)start the speaking poll. Idle cost: with nobody in voice there is no
  // stream to analyse, so the timer only lives while a PC does — updateWebRTC
  // starts it when a PC appears, pollSpeaking stops itself when the map empties
  startSpeakTimer = () => {
    if (!this.speakTimer) {
      // ~2 polls a second is plenty; Chrome updates audioLevel roughly that fast
      this.speakTimer = setInterval(this.pollSpeaking, 450);
    }
  };

  // Who is talking right now, so a dead mic or a half-broken route is visible
  // at a glance. Chrome publishes each receiver's incoming audio level
  // (RFC 6464) via getSynchronizationSources — polling it needs no
  // AudioContext, no permissions and no capture. Browsers without the API
  // just never light up. A source must have sent a packet recently too: a
  // muted peer stops (or silences) its packets, but the entry lingers with
  // its last audioLevel (round 198 measured Edge's s.timestamp on the epoch
  // wall clock, not performance.now() — accept a timestamp only inside
  // [0, 2000] ms behind either clock, or a stale entry's old wall-clock
  // timestamp would look "recent" through pageNow - ts < 2000 being
  // vacuously negative and the ring would stick on a frozen peer).
  // A ring stays on ~600ms after the level drops so it doesn't flicker
  // between words. Our own mic is not shown; the mic button already shows
  // its own state
  pollSpeaking = () => {
    const videoPCs = window.watchparty.videoPCs ?? {};
    // People column closed = the ring and badge have no reader: skip the whole
    // scan. The timer keeps its cadence so reopening needs no restart dance —
    // an idle tick is one DOM read (round 121); ourStream/PCs keep running
    if (this.rootEl?.closest("[inert]")) {
      return;
    }
    const now = Date.now();
    const pageNow = performance.now();
    Object.entries(videoPCs).forEach(([id, pc]) => {
      let active = false;
      try {
        for (const receiver of pc.getReceivers()) {
          if (receiver.track.kind !== "audio") {
            continue;
          }
          // Typed loosely: the API is Chrome-only and older TS lib.dom
          // versions don't declare it
          const withSources = receiver as RTCRtpReceiver & {
            getSynchronizationSources?: () => {
              audioLevel?: number;
              timestamp?: number;
            }[];
          };
          if (
            withSources.getSynchronizationSources?.().some((s) => {
              const ts = s.timestamp;
              if (ts == null || (s.audioLevel ?? 0) <= 0.01) return false;
              // Fresh on either clock, lower-bounded so a wall-clock
              // timestamp can't slip through the performance.now() arm
              const agePage = pageNow - ts;
              const ageWall = Date.now() - ts;
              return (
                (agePage >= 0 && agePage < 2000) ||
                (ageWall >= 0 && ageWall < 2000)
              );
            })
          ) {
            active = true;
            break;
          }
        }
      } catch {
        // not supported on this receiver/browser
      }
      if (active) {
        this.speakSeen[id] = now;
      } else if (now - (this.speakSeen[id] ?? 0) > 600) {
        delete this.speakSeen[id];
      }
    });
    const ids = Object.keys(this.speakSeen).sort();
    const prev = this.state.speaking;
    if (ids.length !== prev.length || ids.some((id, i) => id !== prev[i])) {
      this.setState({ speaking: ids });
    }
    // Seats whose voice link is down: ICE disconnected/failed, or the PC was
    // rebuilt (blip recovery, failed rebuild) and has not connected again yet.
    // "reconnecting…" on the seat turns a dead peer's silence into something
    // visible. A PC that never connected shows nothing — that is the normal
    // first connect, not a reconnection (and the failed rebuild covers it)
    const videoPCsNow = window.watchparty.videoPCs ?? {};
    const selfId = getOrCreateClientId();
    const recon: string[] = [];
    Object.entries(videoPCsNow).forEach(([id, pc]) => {
      if (id === selfId) {
        return;
      }
      if (
        pc.connectionState === "connected" ||
        pc.iceConnectionState === "connected"
      ) {
        this.everConnected[id] = true;
        return;
      }
      if (
        this.everConnected[id] ||
        pc.iceConnectionState === "disconnected" ||
        pc.iceConnectionState === "failed" ||
        pc.connectionState === "failed"
      ) {
        recon.push(id);
      }
    });
    // A PC deleted from the map (peer left, rebuild swapped it) must not keep
    // its flag: a rejoin starts from scratch
    Object.keys(this.everConnected).forEach((id) => {
      if (!videoPCsNow[id]) {
        delete this.everConnected[id];
      }
    });
    recon.sort();
    const prevRecon = this.state.reconnecting;
    if (
      recon.length !== prevRecon.length ||
      recon.some((id, i) => id !== prevRecon[i])
    ) {
      this.setState({ reconnecting: recon });
    }
    // Everyone left voice: no PCs, nothing left to analyse — stop the timer
    // until updateWebRTC creates the next one, and drop the speaking markers
    // (the loop above only visits live PCs, so a departed peer's marker would
    // otherwise keep its ring lit and outlive them into a rejoin)
    if (!Object.keys(videoPCsNow).length) {
      if (this.speakTimer) {
        clearInterval(this.speakTimer);
        this.speakTimer = undefined;
      }
      if (Object.keys(this.speakSeen).length) {
        this.speakSeen = {};
        this.setState({ speaking: [] });
      }
    }
  };

  // App re-renders far more often than our props change (chat lines, share
  // stats, share badges): skip those renders. Every state change renders —
  // speaking/reconnecting/mic picker/portal are ours; every prop change
  // renders (roster, deaf, ts badges). Round 121
  shouldComponentUpdate(nextProps: VideoChatProps, nextState: VideoChatState) {
    const p = this.props;
    if (
      nextProps.socket !== p.socket ||
      nextProps.participants !== p.participants ||
      nextProps.pictureMap !== p.pictureMap ||
      nextProps.nameMap !== p.nameMap ||
      nextProps.tsMap !== p.tsMap ||
      nextProps.rosterUpdateTS !== p.rosterUpdateTS ||
      nextProps.owner !== p.owner ||
      nextProps.getLeaderTime !== p.getLeaderTime ||
      nextProps.deaf !== p.deaf ||
      nextProps.hide !== p.hide
    ) {
      return true;
    }
    for (const k of Object.keys(nextState) as (keyof VideoChatState)[]) {
      if (nextState[k] !== this.state[k]) {
        return true;
      }
    }
    return false;
  }

  componentDidUpdate(prevProps: VideoChatProps) {
    const rosterChanged =
      this.props.rosterUpdateTS !== prevProps.rosterUpdateTS;
    if (this.props.deaf !== prevProps.deaf) {
      // Headphones on/off: element mute and the boosted gain follow
      this.applyAllVoiceOutputs();
    }
    if (rosterChanged || this.props.deaf !== prevProps.deaf) {
      this.autoListen();
      this.updateWebRTC();
      if (rosterChanged) {
        Object.keys(this.remoteStreams).forEach(this.attach);
      }
    }
  }

  // Someone else opened their mic: join listen-only (no mic, no permission
  // prompt) so we hear them right away; leave again when nobody else is in voice
  // ponytail: with 3+ people, two listeners keep each other "in voice" until one leaves
  autoListen = () => {
    const selfId = getOrCreateClientId();
    const ourStream = window.watchparty.ourStream;
    const listening = ourStream && !ourStream.getTracks().length;
    const others = this.props.participants.filter(
      (p) => p.isVideoChat && p.id !== selfId,
    );
    if (!ourStream && !this.props.deaf && others.some((p) => !p.isMuted)) {
      this.setupWebRTC(true);
    } else if (listening && (this.props.deaf || !others.length)) {
      this.stopWebRTC();
    }
  };

  emitUserMute = () => {
    this.socket.emit("CMD:userMute", {
      isMuted: !this.getAudioWebRTC(),
      isCameraOff: !this.getVideoWebRTC(),
    });
  };

  // A socket reconnect must re-announce our mute flag: App re-emits
  // CMD:joinVideo on "connect", but a gap outlasting the server's ping window
  // drops the whole roster entry, so the fresh one has no isMuted/isCameraOff
  // and the room reads a muted mic as open until the user next toggles it
  onSocketConnect = () => {
    if (window.watchparty.ourStream) {
      this.emitUserMute();
    }
  };

  // The server lists us out of voice although we hold a stream: our socket
  // dropped and reconnected, our roster entry was removed and every peer
  // pruned its PC for us, so all of ours are orphans. Drop them the moment
  // that roster arrives instead of letting the old links die on the ICE
  // timers (an offerer with a healthy-looking old PC stayed silent ~15 s,
  // measured round 75); updateWebRTC builds fresh ones once the roster lists
  // us again (App re-sends CMD:joinVideo on connect). Handled on the raw
  // event: App batches rosters into props, and this one can be merged with
  // the next (us back in voice) before VideoChat ever renders it
  onRoster = (roster: User[]) => {
    const selfId = getOrCreateClientId();
    if (
      !window.watchparty.ourStream ||
      roster.some((u) => u.id === selfId && u.isVideoChat)
    ) {
      return;
    }
    const videoPCs = window.watchparty.videoPCs;
    Object.keys(videoPCs).forEach((key) => {
      videoPCs[key].close();
      delete videoPCs[key];
      delete this.remoteStreams[key];
      delete this.elStreams[key];
      this.dropVoiceNode(key);
    });
  };

  // An offer whose peer had no PC for it yet is dropped by handleSignal and
  // never re-sent: our PC then waits for an answer with no timeout while the
  // peer (the polite side — never the offerer by design) offers nothing on its
  // own, so the pair sits silent for good. Measured round 77: an answerer whose
  // roster commit lagged the offer ~1.5 s built its PC ~1.4 s after the offer's
  // 300+1000 ms wait expired, the offer was dropped, and the pair stayed silent
  // past 25 s. Re-send the same offer every 3 s while no answer has landed:
  // nothing changed on our side (no answer, no rollback), so the identical SDP
  // is still valid, and the peer applies it the moment its PC exists. A late
  // re-send during the peer's own offer is safe — glare handling decides. The
  // candidates we sent before the peer had a PC stay dropped: after the answer,
  // our checks carry our address to the peer (RFC 8445 triggered checks), and
  // round 76 measured the pair connecting with 26/28 of our candidates dropped.
  // Stops when the answer lands, the PC is replaced, or the peer leaves voice
  armAnswerResend = (id: string, pc: RTCPeerConnection) => {
    window.setTimeout(() => {
      if (
        window.watchparty.videoPCs[id] === pc &&
        pc.signalingState === "have-local-offer" &&
        this.props.participants.some((p) => p.id === id && p.isVideoChat)
      ) {
        this.sendSignal(id, { sdp: pc.localDescription });
        this.armAnswerResend(id, pc);
      }
    }, 3000);
  };

  handleSignal = async (data: any) => {
    // Handle messages received from signaling server
    const msg = data.msg;
    // Malformed peer data (buggy or hostile voice peer) drops here, before
    // any PC work: a non-object ice throws in the RTCIceCandidate constructor
    // outside the offer chain's try (an sdp offer/answer of the same shape is
    // already caught below, but dropping it up front keeps the two handlers
    // in App.tsx and here identical). Legit frames always carry an sdp string
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
    const selfId = getOrCreateClientId();
    let pc = window.watchparty.videoPCs[from];
    // An offer can outrun our own roster commit (updateWebRTC has not created
    // videoPCs[from] yet): re-check after a beat instead of dropping it — the
    // sender never re-offers, so a drop leaves the pair silenced until the
    // next renegotiation (measured round 54 on a slow device)
    if (!pc && msg?.sdp?.type === "offer") {
      for (const ms of [300, 1000]) {
        await new Promise((resolve) => setTimeout(resolve, ms));
        pc = window.watchparty.videoPCs[from];
        if (pc) {
          break;
        }
      }
    }
    if (!pc) {
      return;
    }
    if (msg.ice !== undefined) {
      // Candidates can outlive the PC they belong to (rebuild races during a
      // network blip); dropping them is fine, throwing is not. Before any
      // remote description addIceCandidate rejects outright: queue until
      // setRemoteDescription lands instead (see queueIce)
      if (pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(msg.ice)).catch(() => {});
      } else {
        queueIce(pc, new RTCIceCandidate(msg.ice));
      }
    } else if (msg.sdp && msg.sdp.type === "offer") {
      // If our PC is stale, replace it with a fresh one before handling the offer
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        pc.close();
        delete window.watchparty.videoPCs[from];
        this.updateWebRTC();
        pc = window.watchparty.videoPCs[from];
        if (!pc) {
          return;
        }
      }
      // Perfect negotiation, polite side fixed by id (larger id): a colliding
      // offer is rolled back and answered by the polite peer, ignored by the
      // impolite one, so two offers that cross never wedge the pair. The
      // collision test also covers our own offer still being built
      // (makingOffer): signalingState alone still reads "stable" there, and
      // applying the incoming offer would let our own setLocalDescription
      // implicitly roll it straight back — both sides then sit in
      // have-local-offer waiting for an answer nobody will send
      try {
        const polite = selfId > from;
        const collision =
          makingOffer.get(pc) === true || pc.signalingState !== "stable";
        if (collision) {
          if (!polite) {
            return;
          }
          if (pc.signalingState === "have-local-offer") {
            await pc.setLocalDescription({ type: "rollback" });
          }
        }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } catch (e) {
          // InvalidAccessError: this offer cannot be applied to the PC we
          // keep for them. A peer whose roster dropped us (socket blip)
          // pruned its PC and offers from a fresh one (2 m-lines) while our
          // old one went from listening to talking and grew to 4: Chrome
          // refuses a subsequent offer whose m-lines do not match, and the
          // pair stays silent for good (the offerer waits for an answer, and
          // as the impolite side ignores our own offers). Replace our PC
          // with a fresh one and answer from that
          if ((e as DOMException).name !== "InvalidAccessError") {
            throw e;
          }
          pc.close();
          delete window.watchparty.videoPCs[from];
          this.updateWebRTC();
          pc = window.watchparty.videoPCs[from];
          if (!pc) {
            return;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
        flushIce(pc);
        const answer = await pc.createAnswer();
        answer.sdp = hdVoiceSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        this.sendSignal(from, { sdp: pc.localDescription });
      } catch (e) {
        // The PC can be closed out from under this answer (blip rebuild,
        // roster change) while the glare/answer chain is in flight: drop it,
        // the replacement PC negotiates on its own (measured round 58)
        console.warn("stale voice offer dropped", e);
      }
    } else if (msg.sdp && msg.sdp.type === "answer") {
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        .then(() => flushIce(pc))
        .catch((e) => console.warn("stale voice answer dropped", e));
    }
  };

  setupWebRTC = async (listenOnly = false) => {
    if (listenOnly) {
      window.watchparty.ourStream = new MediaStream();
      this.socket.emit("CMD:joinVideo");
      this.emitUserMute();
      return;
    }
    // A fresh capture: any device-loss hint is stale by definition
    this.setState({ deviceHint: "", micNotice: "" });
    // The mic-on click is a user gesture: a saved boost (>100%) can start its
    // audio context now (before the awaits), it cannot at page load
    if (getVoiceVolume() > 1) {
      this.ensureAudioContext();
    }
    const seq = this.teardownSeq;
    const stream = await this.getOwnStream();
    // A Leave landed while the device was opening: the fresh capture is
    // dropped instead of silently re-joining voice with the mic on (measured
    // round 136 — the !ourStream branch below would otherwise re-join ~250ms
    // after the user left, with no click)
    if (seq !== this.teardownSeq) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    // The camera was off when the last mic-off tore the capture down: the
    // fresh capture starts camera-off too. Disabled here, the fresh-join
    // branch's PCs strip the video at the end of updateWebRTC
    // (muted-at-build); the listening branch clears its senders after the
    // addTrack loop below
    if (this.keepCameraOff) {
      stream.getVideoTracks().forEach((track) => {
        track.enabled = false;
      });
    }
    const ourStream = window.watchparty.ourStream;
    if (!ourStream) {
      window.watchparty.ourStream = stream;
      // alert server we've joined video chat
      this.socket.emit("CMD:joinVideo");
      this.emitUserMute();
      return;
    }
    // Listening already: send our mic on the same connections (renegotiated)
    // instead of leaving and rejoining, which the peer can't tell apart
    // A second mic-on click raced past the button state (e.g. double click
    // while the permission prompt was up): keep the one capture, stop ours
    if (ourStream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream.getTracks().forEach((track) => {
      ourStream.addTrack(track);
      Object.entries(window.watchparty.videoPCs).forEach(([id, pc]) => {
        if (id === getOrCreateClientId()) return;
        // A blip rebuild or roster change can close a PC between our roster
        // snapshot and this loop (measured round 58): touching it throws
        // synchronously and the click's promise chain dies unhandled
        if (pc.connectionState === "closed") return;
        const tr = pc
          .getTransceivers()
          .find((t) => t.receiver.track.kind === track.kind && !t.sender.track);
        if (tr) {
          tr.direction = "sendrecv";
          tr.sender.replaceTrack(track);
          // Chrome can leave a sender that started life recvonly at its ~32 kbps
          // opus default even though every applied SDP carries maxaveragebitrate
          // (measured over TURN: answer-then-offer glare + replaceTrack → the
          // peer hears ~33 kbps one-way). Pin the cap on the sender itself; the
          // SDP munge above still tells the peers what to send us. Audio only:
          // this branch also carries the camera in the listen-then-mic-on flow,
          // and 64 kbps there is an unreadable slideshow
          if (track.kind === "audio") {
            const params = tr.sender.getParameters();
            if (!params.encodings || !params.encodings.length) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = HD_VOICE_BITRATE;
            tr.sender.setParameters(params).catch(() => {});
          }
        } else {
          pc.addTrack(track, ourStream);
          preferRedVoice(pc);
        }
      });
    });
    // keepCameraOff disabled the fresh video track above: the senders got it
    // in the loop, so clear them again — the transceiver stays sendrecv but
    // sends nothing, and a later tile camera-on restores the track on every PC
    if (this.keepCameraOff) this.applyMute("video", true);
    this.emitUserMute();
    this.forceUpdate();
  };

  // The device is live again (turned back on, reopened, switched): drop that
  // device's hint, keep the other device's
  clearDeviceHint = (which: "Camera" | "Microphone") => {
    if (this.state.deviceHint.startsWith(which))
      this.setState({ deviceHint: "" });
  };

  // Mic off: keep listening while someone else is in voice, else leave.
  // fromEnded = the device died on its own (unplugged/revoked), not a button
  // click — say so near the mic control instead of dropping to listen-only
  // silently (round 95)
  micOff = (fromEnded?: boolean) => {
    if (fromEnded) this.setState({ deviceHint: "Microphone disconnected" });
    const ourStream = window.watchparty.ourStream;
    const selfId = getOrCreateClientId();
    const others = this.props.participants.some(
      (p) => p.isVideoChat && p.id !== selfId,
    );
    if (fromEnded) {
      // The tile hint is invisible with the People panel closed, and gone once
      // the call is left below: say it on the page for a few seconds (round 188)
      this.setState({
        micNotice: `Microphone disconnected. ${
          !ourStream || !others || this.props.deaf
            ? "Voice chat is off"
            : "You are still listening"
        }`,
      });
      clearTimeout(this.micNoticeTimer);
      this.micNoticeTimer = setTimeout(
        () => this.setState({ micNotice: "" }),
        MIC_NOTICE_MS,
      );
    }
    // The camera's state before the capture goes away: the next mic-on keeps
    // it (the user never asked the camera back). Computed even on the leave
    // path — stopWebRTC resets the field, so it is set again after it
    const cameraOff = ourStream?.getVideoTracks()[0]?.enabled === false;
    if (!ourStream || !others || this.props.deaf) {
      this.stopWebRTC();
      this.keepCameraOff = cameraOff;
      return;
    }
    Object.entries(window.watchparty.videoPCs).forEach(([id, pc]) => {
      if (id === selfId) return;
      // Same closed-PC race as setupWebRTC's mic-on loop (measured round 58)
      if (pc.connectionState === "closed") return;
      pc.getTransceivers().forEach((t) => {
        if (t.sender.track) {
          t.sender.replaceTrack(null);
          t.direction = "recvonly";
        }
      });
    });
    ourStream.getTracks().forEach((track) => {
      track.stop();
      ourStream.removeTrack(track);
    });
    this.keepCameraOff = cameraOff;
    this.emitUserMute();
    this.forceUpdate();
  };

  getOwnStream = async () => {
    // Set up our own video
    // Create default stream
    let black = ({ width = 640, height = 480 } = {}) => {
      let canvas: any = Object.assign(document.createElement("canvas"), {
        width,
        height,
      });
      canvas.getContext("2d")?.fillRect(0, 0, width, height);
      let stream = canvas.captureStream();
      return Object.assign(stream.getVideoTracks()[0], { enabled: false });
    };
    let stream = new MediaStream([black()]);

    try {
      stream = await navigator?.mediaDevices.getUserMedia({
        audio: micAudio(this.state.micId),
        video: true,
      });
    } catch (e) {
      console.warn(e);
      try {
        console.log("attempt audio only stream");
        stream = await navigator?.mediaDevices?.getUserMedia({
          audio: micAudio(this.state.micId),
          video: false,
        });
      } catch (e) {
        console.warn(e);
      }
    }
    // Device labels are only filled in once the browser has given mic access
    if (stream.getAudioTracks().length) {
      this.refreshMics();
    }
    // Sleep/resume or a driver stall can end capture while the device is still
    // present; before this, members stayed listen-only and silent until clicking
    // the mic.
    const audioTrack = stream.getAudioTracks()[0];
    audioTrack?.addEventListener("ended", () => this.micEnded(audioTrack));
    // Same for the camera: unplugging ends the track and the button would keep
    // showing a live camera over a frozen frame for everyone — show the manual
    // camera-off state instead (audio untouched)
    stream
      .getVideoTracks()[0]
      ?.addEventListener("ended", () => this.cameraEnded());
    return stream;
  };

  stopWebRTC = () => {
    // A real Leave starts the next join fresh: no camera-off carry-over
    this.keepCameraOff = false;
    this.teardownSeq++;
    const ourStream = window.watchparty.ourStream;
    const videoPCs = window.watchparty.videoPCs;
    ourStream &&
      ourStream.getTracks().forEach((track) => {
        track.stop();
      });
    window.watchparty.ourStream = undefined;
    this.remoteStreams = {};
    this.elStreams = {};
    this.dropAllVoiceNodes();
    Object.keys(videoPCs).forEach((key) => {
      videoPCs[key].close();
      delete videoPCs[key];
      // Same reason as the per-peer teardown in updateWebRTC: no detached
      // element left behind
      delete window.watchparty.videoRefs[key];
    });
    this.socket.emit("CMD:leaveVideo");
  };

  // The camera died on its own: drop to the camera-off state through the same
  // toggle the button uses. The ended track cannot be revived, so the next
  // camera-on click goes through reopenCamera instead of an enabled flip
  cameraEnded = () => {
    if (this.getVideoWebRTC()) this.toggleVideoWebRTC();
    this.setState({ deviceHint: "Camera disconnected" });
  };

  // Tile mute / camera-off must actually stop the RTP: an enabled flip alone
  // keeps the sender streaming silence/black frames (measured round R15L).
  // replaceTrack(null) sends nothing and needs no renegotiation; unmuting
  // restores our own track with a same-kind replace. recvonly transceivers
  // (listen-only) have nothing to send — skip them, and skip a sender already
  // in the wanted state so roster ticks stay no-ops
  applyMute = (kind: "audio" | "video", muted: boolean) => {
    const track = window.watchparty.ourStream
      ?.getTracks()
      .find((t) => t.kind === kind);
    Object.entries(window.watchparty.videoPCs).forEach(([id, pc]) => {
      if (id === getOrCreateClientId() || pc.connectionState === "closed") {
        return;
      }
      pc.getTransceivers().forEach((t) => {
        if (t.direction === "recvonly" || t.receiver.track.kind !== kind) {
          return;
        }
        if (muted) {
          if (t.sender.track) t.sender.replaceTrack(null).catch(() => {});
        } else if (track && t.sender.track !== track) {
          t.sender.replaceTrack(track).catch(() => {});
        }
      });
    });
  };

  toggleVideoWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    const track = ourStream?.getVideoTracks()[0];
    if (ourStream && track) {
      // An enabled flip cannot revive an ended track (device unplugged): this
      // click is the user asking for the camera back, so open it again
      if (!track.enabled && track.readyState === "ended") {
        this.reopenCamera();
        return;
      }
      track.enabled = !track.enabled;
      this.applyMute("video", !track.enabled);
      if (track.enabled) this.clearDeviceHint("Camera");
    }
    this.emitUserMute();
    this.forceUpdate();
  };

  // One reopen at a time: two clicks share the same dead track, so the stale
  // check below cannot tell them apart and ourStream would end with two
  // captures (the double-mic bug changeMic serializes)
  reopenCamera = async () => {
    if (this.cameraReopening) {
      return;
    }
    this.cameraReopening = true;
    try {
      const ourStream = window.watchparty.ourStream;
      const dead = ourStream?.getVideoTracks()[0];
      if (!ourStream || !dead || dead.readyState !== "ended") {
        return;
      }
      let fresh: MediaStream;
      try {
        fresh = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (e) {
        console.warn("camera reopen failed", e);
        // The click showed nothing before (console.warn only): say why on the
        // tile, same channel as a device that died on its own
        this.setState({ deviceHint: "Camera unavailable" });
        return;
      }
      // Left / a teardown mutated the stream while the device opened
      if (
        window.watchparty.ourStream !== ourStream ||
        ourStream.getVideoTracks()[0] !== dead
      ) {
        fresh.getTracks().forEach((track) => track.stop());
        return;
      }
      const newTrack = fresh.getVideoTracks()[0];
      ourStream.removeTrack(dead);
      ourStream.addTrack(newTrack);
      // Attach the ended listener NOW, before the replaceTrack awaits: ended
      // fires once, and a camera that dies while they run was never noticed
      // with the listener attached only after them
      newTrack.addEventListener("ended", () => this.cameraEnded());
      await Promise.all(
        Object.entries(window.watchparty.videoPCs).map(([id, pc]) => {
          if (id === getOrCreateClientId() || pc.connectionState === "closed") {
            return undefined;
          }
          // A PC that dies mid-swap is replaced by the roster logic anyway
          // The camera was off at death: applyMute cleared the sender (track
          // null), so look it up by transceiver kind, not by the dead track
          const sender = pc
            .getTransceivers()
            .find(
              (t) =>
                t.receiver.track.kind === "video" && t.direction !== "recvonly",
            )?.sender;
          return sender?.replaceTrack(newTrack).catch(() => {});
        }),
      );
      // A camera that died during the awaits already re-set the hint through
      // cameraEnded — do not clear a live problem
      if (newTrack.readyState === "live") {
        this.clearDeviceHint("Camera");
        this.emitUserMute();
      }
      this.forceUpdate();
    } finally {
      this.cameraReopening = false;
    }
  };

  getVideoWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    return ourStream && ourStream.getVideoTracks()[0]?.enabled;
  };

  toggleAudioWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    const audioTrack = ourStream && ourStream.getAudioTracks()[0];
    if (!audioTrack) {
      // Listening (auto-listen, or mic-off removed the track): there is no
      // track to flip, the button means "turn my mic on" — same path as the
      // chat-bar mic button (it used to be a silent no-op here, measured
      // round 165: 0 bytes out for the whole 30 s window)
      this.setupWebRTC();
      return;
    }
    audioTrack.enabled = !audioTrack.enabled;
    this.applyMute("audio", !audioTrack.enabled);
    if (audioTrack.enabled) this.clearDeviceHint("Microphone");
    this.emitUserMute();
    this.forceUpdate();
  };

  getAudioWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    return (
      ourStream &&
      ourStream.getAudioTracks()[0] &&
      ourStream.getAudioTracks()[0].enabled
    );
  };

  updateWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    const videoPCs = window.watchparty.videoPCs;
    const videoRefs = window.watchparty.videoRefs;
    if (!ourStream) {
      // We haven't started video chat, exit
      return;
    }
    const selfId = getOrCreateClientId();

    // Delete and close any connections that aren't in the current member list (maybe someone disconnected)
    // This allows them to rejoin later
    const clientIds = new Set(
      this.props.participants.filter((p) => p.isVideoChat).map((p) => p.id),
    );
    Object.entries(videoPCs).forEach(([key, value]) => {
      if (!clientIds.has(key)) {
        value.close();
        delete videoPCs[key];
        delete this.remoteStreams[key];
        delete this.elStreams[key];
        this.dropVoiceNode(key);
        // Their tile unmounts with them; without this the detached <video>
        // lingers in videoRefs forever (applyAllVoiceOutputs keeps visiting it)
        delete videoRefs[key];
      }
    });
    // Not listed in voice yet (first join, or our entry was dropped by a
    // reconnect and CMD:joinVideo is on its way): the server drops the
    // signals of a sender it does not list, so an offer made now is lost.
    // Wait for the roster that lists us
    if (!clientIds.has(selfId)) {
      return;
    }

    this.props.participants.forEach((user) => {
      const id = user.id;
      if (!user.isVideoChat || videoPCs[id]) {
        // User isn't in video chat, or we already have a connection to them
        return;
      }
      if (id === selfId) {
        // A leave raced a stale roster: stopWebRTC already cleared ourStream
        // and the refs while participants still lists us in voice, so the
        // self tile unmounted — building its PC here would throw on the
        // missing ref and unmount the whole app (no error boundary)
        if (!videoRefs[id]) {
          return;
        }
        videoPCs[id] = new RTCPeerConnection();
        videoRefs[id].srcObject = ourStream;
      } else {
        const pc = new RTCPeerConnection({ iceServers: iceServers() });
        videoPCs[id] = pc;
        // Add our own video as outgoing stream
        ourStream?.getTracks().forEach((track) => {
          if (ourStream) {
            pc.addTrack(track, ourStream);
          }
        });
        // Listen-only: nothing to send, but ask for their audio/video so the
        // offer isn't empty when we are the offerer
        if (!ourStream.getTracks().length) {
          pc.addTransceiver("audio", { direction: "recvonly" });
          pc.addTransceiver("video", { direction: "recvonly" });
        }
        preferRedVoice(pc);
        pc.onicecandidate = (event) => {
          // We generated an ICE candidate, send it to peer
          if (event.candidate) {
            this.sendSignal(id, { ice: event.candidate });
          }
        };
        pc.ontrack = (event: RTCTrackEvent) => {
          // Mount the stream from peer
          const stream = (this.remoteStreams[id] ||= new MediaStream());
          stream.getTracks().forEach((t) => {
            if (t.kind === event.track.kind && t !== event.track) {
              stream.removeTrack(t);
            }
          });
          if (!stream.getTracks().includes(event.track)) {
            stream.addTrack(event.track);
          }
          if (event.track.kind === "video") {
            const attachWhenAvailable = () => {
              if (videoPCs[id] === pc) {
                this.attach(id);
              }
            };
            event.track.addEventListener("mute", attachWhenAvailable);
            event.track.addEventListener("unmute", attachWhenAvailable);
          }
          this.attach(id);
        };
        // Transport failed (permanently; a temporary drop would be "disconnected"):
        // tear down and attempt to re-establish. Chrome can set connectionState
        // "failed" while iceConnectionState stays "disconnected" forever (measured
        // round 52), and the two states fire different events — watch both or the
        // rebuild never runs. The guard keeps a second event from killing the
        // replacement PC that updateWebRTC already made.
        const rebuildFailed = () => {
          if (videoPCs[id] !== pc) {
            return;
          }
          pc.close();
          delete videoPCs[id];
          delete this.remoteStreams[id];
          delete this.elStreams[id];
          this.dropVoiceNode(id);
          this.updateWebRTC();
          // The peer's PC may have died so quietly that it never renegotiates
          // (frozen tab, killed app): offer ourselves after a beat even though
          // we are normally the answerer. Colliding offers are safe —
          // handleSignal rolls the larger id's half-offer back.
          const fresh = videoPCs[id];
          if (fresh) {
            window.setTimeout(() => {
              if (
                videoPCs[id] === fresh &&
                !fresh.currentRemoteDescription &&
                fresh.signalingState === "stable" &&
                this.props.participants.some(
                  (p) => p.id === id && p.isVideoChat,
                )
              ) {
                makingOffer.set(fresh, true);
                fresh
                  .createOffer()
                  .then(async (offer) => {
                    offer.sdp = hdVoiceSdp(offer.sdp);
                    // Their offer got in while ours was being built (the
                    // polite side): handleSignal answers it — drop ours
                    // instead of rolling it back under them
                    if (fresh.signalingState === "have-remote-offer") {
                      return;
                    }
                    await fresh.setLocalDescription(offer);
                    this.sendSignal(id, { sdp: fresh.localDescription });
                    this.armAnswerResend(id, fresh);
                  })
                  .catch(() => {})
                  .finally(() => makingOffer.set(fresh, false));
              }
            }, 3000);
          }
        };
        // For each pair, have the lexicographically smaller ID be the offerer.
        // Once connected either side may renegotiate (mic on/off in place)
        const isOfferer = selfId < id;
        let voiceDiscTimer = 0;
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === "failed") {
            rebuildFailed();
          } else if (pc.iceConnectionState === "disconnected") {
            // A wifi switch rebinds the NAT: the old pair never answers again
            // but ICE hangs at "disconnected" and Chrome only escalates to
            // "failed" ~25-30 s later (measured round 52) — one-way silence
            // that whole time. A short blip self-heals in ~1-2 s (measured
            // round 58, freeze test), so 6 s of dead air is a rebind: restart
            // ICE now instead of waiting for the failed rebuild. Either half
            // drives it (measured round 63: with the watchdog answerer-side an
            // offerer death recovers in ~18 s; without, the answerer waits for
            // the failed escalation — ~23 s). 6 s, not 10: Chrome escalates
            // "disconnected" to "failed" just 8-10 s later (measured round 74,
            // voicedead trace) and the 10 s watchdog lost that race half the
            // time — recovery then took the failed rebuild's extra 3 s wait and
            // landed at 20-25 s. The guards below keep a PC that never
            // connected from restarting: nothing to restart, the failed rebuild
            // owns that case.
            window.clearTimeout(voiceDiscTimer);
            voiceDiscTimer = window.setTimeout(() => {
              if (
                videoPCs[id] === pc &&
                pc.iceConnectionState === "disconnected" &&
                pc.signalingState === "stable" &&
                pc.currentRemoteDescription
              ) {
                // fires negotiationneeded: the handler below sends the offer
                pc.restartIce();
              }
            }, 6000);
          } else {
            window.clearTimeout(voiceDiscTimer);
          }
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") {
            rebuildFailed();
          }
        };
        pc.onnegotiationneeded = async () => {
          if (!isOfferer && !pc.currentRemoteDescription) return;
          // Start connection for peer's video. makingOffer marks the whole
          // build window so handleSignal sees the collision even while we are
          // still signaling-stable
          makingOffer.set(pc, true);
          try {
            const offer = await pc.createOffer();
            offer.sdp = hdVoiceSdp(offer.sdp);
            // Their offer got in while ours was being built (the polite
            // side): handleSignal answers it — drop ours instead of rolling
            // it back under them
            if (pc.signalingState === "have-remote-offer") {
              return;
            }
            await pc.setLocalDescription(offer);
            this.sendSignal(id, { sdp: pc.localDescription });
            this.armAnswerResend(id, pc);
          } catch (e) {
            // The PC can be closed out from under this offer (blip rebuild,
            // roster change): drop it, the replacement PC negotiates on its own
            console.warn("voice offer aborted", e);
          } finally {
            makingOffer.set(pc, false);
          }
        };
      }
    });
    // A PC built while muted (new peer, blip/InvalidAccessError rebuild) got
    // the disabled track on its senders via addTrack above: strip the muted
    // kinds before the offer goes out, or they stream silence/black again
    const audio0 = ourStream?.getAudioTracks()[0];
    if (audio0 && !audio0.enabled) this.applyMute("audio", true);
    const video0 = ourStream?.getVideoTracks()[0];
    if (video0 && !video0.enabled) this.applyMute("video", true);
    // PCs exist (or just did): the speaking poll has work again
    this.startSpeakTimer();
  };

  sendSignal = async (to: string, data: any) => {
    this.socket.emit("signal", { to, msg: data });
  };

  render() {
    const { participants, pictureMap, nameMap, tsMap, socket, owner } =
      this.props;
    const ourStream = window.watchparty.ourStream;
    const videoRefs = window.watchparty.videoRefs;
    // Fixed 180px gave one tile per row on phones where two would fit: the
    // People overlay is 372px at 390 portrait, and 2x180 + 4px gap misses it
    // by the overlay border + root padding (measured round 167). Shrink to
    // half the row (minus gap) when >2 members; 1-2 members keep 250 and
    // just clamp to the panel so a tile never overflows. Desktop panels are
    // wide enough that min() keeps the old sizes everywhere
    const contentW = this.state.peopleW ? this.state.peopleW - 8 : 0;
    const fit2Up = contentW > 0 ? Math.floor((contentW - 4) / 2) : Infinity;
    const videoChatSize = Math.min(
      participants.length > 2 ? 180 : 250,
      participants.length > 2 ? fit2Up : contentW > 0 ? contentW : Infinity,
    );
    const videoChatContentStyle: React.CSSProperties = {
      height: videoChatSize,
      width: videoChatSize,
      objectFit: "cover",
      position: "relative",
    };
    const selfId = getOrCreateClientId();
    // The host's options menu owns the tile's top-right corner; the local
    // audio menu sits next to it, so it must shift when that menu is shown
    const hostMenuVisible = Boolean(owner && owner === this.context.user?.uid);
    // Violet ring on seats whose mic is picking up sound right now
    const isSpeaking = (id: string) => this.state.speaking.includes(id);
    // Touch controls are 34px tall (coarse CSS), so on the self tile the
    // Leave/cam/mic row and the 3-dot member menu collide (measured round
    // 167: 26px overlap): drop the menu just below the row on touch. Desktop
    // icons are 28px and fit — keep desktop pixels identical
    const touchPrimary = isTouchPrimary();
    const speakingStyle: React.CSSProperties = {
      boxShadow: "0 0 0 3px #a78bfa",
    };
    // The select shows the mic actually capturing (the saved pick can have
    // fallen back to the default); when not capturing, the saved pick
    const micIds = this.state.mics.map((m) => m.id);
    const liveMic = ourStream?.getAudioTracks()[0]?.getSettings().deviceId;
    const micValue =
      [liveMic, this.state.micId].find((id) => id && micIds.includes(id)) ??
      SYSTEM_MIC;
    return (
      <div
        ref={(el) => {
          this.rootEl = el;
        }}
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "4px",
          padding: "4px",
        }}
      >
        {this.state.micNotice &&
          createPortal(
            <div
              role="status"
              style={{
                position: "fixed",
                top: 12,
                left: "50%",
                transform: "translateX(-50%)",
                maxWidth: "calc(100vw - 32px)",
                padding: "6px 14px",
                borderRadius: "8px",
                backgroundColor: "rgba(0,0,0,0.85)",
                color: "#ff8787",
                fontSize: "14px",
                fontWeight: 700,
                textAlign: "center",
                zIndex: 1000,
                pointerEvents: "none",
              }}
            >
              {this.state.micNotice}
            </div>,
            document.body,
          )}
        {this.state.playBlocked &&
          // The People panel can be collapsed, so this sits on the page itself
          createPortal(
            <Button
              style={{
                position: "fixed",
                bottom: 16,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 1000,
              }}
              onClick={this.retryPlay}
            >
              🔊 Click to hear voice chat
            </Button>,
            document.body,
          )}
        {ourStream && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              width: "100%",
              padding: "0 8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <IconVolume size={16} style={{ flexShrink: 0 }} />
              <Slider
                title="Voice volume (the others, vs the movie's own volume)"
                value={this.state.voiceVolume}
                onChange={this.setVoiceVolume}
                onChangeEnd={this.setVoiceVolume}
                min={0}
                max={MAX_VOICE_VOLUME}
                step={0.05}
                label={(v) => `${Math.round(v * 100)}%`}
                style={{ flexGrow: 1 }}
              />
            </div>
            <Select
              size="xs"
              aria-label="Microphone"
              title="Microphone"
              leftSection={<IconMicrophone size={14} />}
              allowDeselect={false}
              value={micValue}
              onChange={(v) => v && this.changeMic(v === SYSTEM_MIC ? "" : v)}
              data={[
                { value: SYSTEM_MIC, label: "System default" },
                ...this.state.mics.map((m, i) => ({
                  value: m.id,
                  label: m.label || `Microphone ${i + 1}`,
                })),
              ]}
            />
          </div>
        )}
        {participants.map((p) => {
          return (
            <div key={p.id}>
              <div
                data-speaking={isSpeaking(p.id) ? "true" : "false"}
                // The speaking ring is color-only: name it for screen readers
                aria-label={
                  isSpeaking(p.id)
                    ? `${nameMap[p.id] || p.id} is speaking`
                    : undefined
                }
                role={isSpeaking(p.id) ? "group" : undefined}
                style={{
                  position: "relative",
                }}
              >
                <div>
                  <UserMenu
                    displayName={nameMap[p.id] || p.id}
                    disabled={
                      !Boolean(owner && owner === this.context.user?.uid)
                    }
                    socket={socket}
                    userToManage={p.id}
                    trigger={
                      // A real icon button so keyboard users can open the
                      // member menu; transparent, same footprint as the bare
                      // icon it replaces
                      <ActionIcon
                        variant="transparent"
                        size={24}
                        aria-label={`Options for ${nameMap[p.id] || p.id}`}
                        style={{
                          position: "absolute",
                          right: 0,
                          top:
                            touchPrimary && ourStream && p.id === selfId
                              ? 34
                              : 0,
                          zIndex: 1,
                          color: "inherit",
                          visibility: Boolean(
                            owner && owner === this.context.user?.uid,
                          )
                            ? "visible"
                            : "hidden",
                        }}
                      >
                        <IconDotsVertical />
                      </ActionIcon>
                    }
                  />
                  {ourStream && p.id !== selfId && p.isVideoChat && (
                    // Local-only voice control for this member (round 180):
                    // mute their audio for me, never for the room
                    <VoiceTileMenu
                      id={p.id}
                      name={nameMap[p.id] || p.id}
                      muted={this.state.mutedForMe.includes(p.id)}
                      onToggle={this.toggleMutedForMe}
                      right={hostMenuVisible ? 30 : 0}
                    />
                  )}
                  <div
                    className={classes.controls}
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      gap: "4px",
                      position: "absolute",
                      top: 0,
                      left: 0,
                      zIndex: 1,
                      // Narrow two-up tiles (164px) can't fit Leave + both
                      // icons on one 34px row: wrap the overflow inside the
                      // tile instead of spilling into the neighbour
                      flexWrap: "wrap",
                    }}
                  >
                    {ourStream && p.id === selfId && (
                      <Button
                        size="xs"
                        color={"red"}
                        onClick={this.stopWebRTC}
                        leftSection={<IconX />}
                      >
                        Leave
                      </Button>
                    )}
                    {ourStream && p.id === selfId && (
                      <>
                        <ActionIcon
                          color={this.getVideoWebRTC() ? "green" : "red"}
                          onClick={this.toggleVideoWebRTC}
                          aria-label={
                            this.getVideoWebRTC()
                              ? "Turn off camera"
                              : "Turn on camera"
                          }
                        >
                          <IconVideo />
                        </ActionIcon>
                        <ActionIcon
                          color={this.getAudioWebRTC() ? "green" : "red"}
                          onClick={this.toggleAudioWebRTC}
                          aria-label={
                            this.getAudioWebRTC()
                              ? "Mute microphone"
                              : "Unmute microphone"
                          }
                        >
                          <IconMicrophone />
                        </ActionIcon>
                      </>
                    )}
                    {ourStream && p.id === selfId && this.state.deviceHint && (
                      <div
                        style={{
                          position: "absolute",
                          top: "32px",
                          left: "50%",
                          transform: "translateX(-50%)",
                          width: "max-content",
                          whiteSpace: "nowrap",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          // Semi-opaque pill instead of a text shadow: a shadow
                          // vanishes over bright video, 80% black keeps #ff8787
                          // >= 4.5:1 against anything behind it (white worst case
                          // measured 5.4:1; round 113)
                          backgroundColor: "rgba(0,0,0,0.8)",
                          textAlign: "center",
                          fontSize: "12px",
                          fontWeight: 700,
                          color: "#ff8787",
                          zIndex: 1,
                          pointerEvents: "none",
                        }}
                      >
                        {this.state.deviceHint}
                      </div>
                    )}
                    {p.id !== selfId && (
                      <>
                        {/* Color-only status icons: give screen readers the
                            state the color carries (round 102) */}
                        {p.isVideoChat && (
                          <IconVideo
                            color={p.isCameraOff ? "red" : softWhite}
                            role="img"
                            aria-label={`${nameMap[p.id] || p.id} camera ${
                              p.isCameraOff ? "off" : "on"
                            }`}
                          />
                        )}
                        {p.isVideoChat && (
                          <IconMicrophone
                            color={p.isMuted ? "red" : softWhite}
                            role="img"
                            aria-label={`${nameMap[p.id] || p.id} ${
                              p.isMuted ? "muted" : "microphone on"
                            }`}
                          />
                        )}
                      </>
                    )}
                    {p.isScreenShare && <IconScreenShare color={softWhite} />}
                  </div>
                  <div
                    style={{
                      position: "absolute",
                      bottom: "4px",
                      left: "0px",
                      width: "100%",
                      backgroundColor: "rgba(0,0,0,0)",
                      color: softWhite,
                      borderRadius: "4px",
                      fontSize: "12px",
                      fontWeight: 700,
                      display: "flex",
                      zIndex: 1,
                    }}
                  >
                    <div
                      title={nameMap[p.id] || p.id}
                      style={{
                        // Dark pill instead of backdropFilter brightness(): the
                        // filter only darkens by 20/40%, so whitesmoke on white
                        // video measured 1.5:1 / 2.6:1 (round 113); 70% black
                        // holds >= 7.8:1 over anything
                        backgroundColor: "rgba(0,0,0,0.7)",
                        padding: "4px",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        // Long names must ellipsize, not squeeze the timestamp
                        maxWidth: "65%",
                        display: "inline-block",
                      }}
                    >
                      {nameMap[p.id] || p.id}
                    </div>
                    <div
                      style={{
                        backgroundColor: "rgba(0,0,0,0.7)",
                        padding: "4px",
                        flexGrow: 1,
                        display: "flex",
                        justifyContent: "center",
                      }}
                    >
                      {formatTimestamp(tsMap[p.id] || 0)}{" "}
                      {/* {this.context.beta &&
                          `(${(
                            (tsMap[p.id] - this.props.getLeaderTime()) *
                            1000
                          ).toFixed(0)}ms)`} */}
                    </div>
                  </div>
                  {ourStream && p.isVideoChat ? (
                    <video
                      ref={(el) => {
                        if (el) {
                          // Inline refs re-run on every render; apply (and
                          // attach) only when the element itself is new — a
                          // changed volume/deaf/stream re-applies through
                          // applyAllVoiceOutputs (slider, deaf prop) and
                          // attach (ontrack), so a same-element rerun was
                          // pure overhead
                          const isNew = videoRefs[p.id] !== el;
                          videoRefs[p.id] = el;
                          if (isNew) {
                            // muted/volume come from here only (no React muted
                            // prop to fight it); self is always muted
                            this.applyVoiceOutput(p.id);
                            if (p.id !== selfId) {
                              this.attach(p.id);
                            }
                          }
                        } else {
                          // React re-invokes an inline ref (null then the el)
                          // on every render: only a real unmount leaves a
                          // detached element here, and that entry must go so
                          // applyAllVoiceOutputs never visits it (round 121)
                          const cur = videoRefs[p.id];
                          if (cur && !cur.isConnected) {
                            delete videoRefs[p.id];
                          }
                        }
                      }}
                      style={{
                        ...videoChatContentStyle,
                        ...(isSpeaking(p.id) ? speakingStyle : {}),
                        // mirror the video if it's our stream. this style mimics Zoom where your
                        // video is mirrored only for you)
                        transform: `scaleX(${p.id === selfId ? "-1" : "1"})`,
                      }}
                      autoPlay
                      data-id={p.id}
                    />
                  ) : (
                    <img
                      style={{
                        ...videoChatContentStyle,
                        ...(isSpeaking(p.id) ? speakingStyle : {}),
                      }}
                      alt={nameMap[p.id] || p.id}
                      src={
                        pictureMap[p.id] ||
                        getDefaultPicture(
                          nameMap[p.id],
                          getColorForStringHex(p.id),
                        )
                      }
                    />
                  )}
                  {ourStream &&
                    p.isVideoChat &&
                    p.id !== selfId &&
                    p.isCameraOff && (
                      // The camera-off member still streams a muted/black
                      // video track (audio rides the element, round 121), so
                      // the <video> stays mounted and this covers the black
                      // frame with the same avatar a non-voice member shows
                      <img
                        style={{
                          ...videoChatContentStyle,
                          position: "absolute",
                          top: 0,
                          left: 0,
                        }}
                        alt={nameMap[p.id] || p.id}
                        src={
                          pictureMap[p.id] ||
                          getDefaultPicture(
                            nameMap[p.id],
                            getColorForStringHex(p.id),
                          )
                        }
                      />
                    )}
                  {p.id !== selfId &&
                    this.state.reconnecting.includes(p.id) && (
                      <div
                        data-reconnecting={p.id}
                        title="Their voice link is down — reconnecting"
                        style={{
                          position: "absolute",
                          top: "4px",
                          left: "50%",
                          transform: "translateX(-50%)",
                          backgroundColor: "rgba(20,12,40,0.75)",
                          color: "#fbbf24",
                          fontSize: "12px",
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: "4px",
                          zIndex: 1,
                          whiteSpace: "nowrap",
                        }}
                      >
                        reconnecting…
                      </div>
                    )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
}
