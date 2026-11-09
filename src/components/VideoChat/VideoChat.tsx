import React from "react";
import { createPortal } from "react-dom";
import { ActionIcon, Button, Slider } from "@mantine/core";
import { Socket } from "socket.io-client";

import {
  formatTimestamp,
  getOrCreateClientId,
  getColorForStringHex,
  getDefaultPicture,
  iceServers,
  softWhite,
} from "../../utils/utils";
import { UserMenu } from "../UserMenu/UserMenu";
import { MetadataContext } from "../../MetadataContext";
import {
  IconDotsVertical,
  IconMicrophone,
  IconScreenShare,
  IconVideo,
  IconVolume,
  IconX,
} from "@tabler/icons-react";

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

export class VideoChat extends React.Component<
  VideoChatProps,
  {
    playBlocked: boolean;
    voiceVolume: number;
    speaking: string[];
    reconnecting: string[];
  }
> {
  // Voice volume also lives on window.watchparty so it survives element
  // remounts and People-panel collapse (a fresh instance re-seeds from there)
  state = {
    playBlocked: false,
    voiceVolume: window.watchparty.voiceVolume ?? 1,
    speaking: [] as string[],
    reconnecting: [] as string[],
  };
  static contextType = MetadataContext;
  declare context: React.ContextType<typeof MetadataContext>;

  socket = this.props.socket;
  // One stream per peer that we fill with their tracks ourselves: a track
  // that starts on a recvonly transceiver (they were listening, then opened
  // their mic) arrives with no stream of its own
  remoteStreams: Record<string, MediaStream> = {};
  // Who is talking: clientId -> last poll where their incoming audio level
  // was above the speaking threshold (see pollSpeaking)
  speakSeen: { [id: string]: number } = {};
  speakTimer: NodeJS.Timeout | undefined = undefined;
  // Peers whose voice link came up once (so a later non-connected state is a
  // REconnection, not the normal first connect) — see pollSpeaking
  everConnected: { [id: string]: boolean } = {};

  // Show the peer's stream on their element (which can mount after the track
  // arrives, or remount) and play it. Autoplay with sound is refused until
  // the page has had a click, so retry on the next click or key press
  attach = (id: string) => {
    const el = window.watchparty.videoRefs[id];
    const stream = this.remoteStreams[id];
    if (!el || !stream) {
      return;
    }
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    // The chosen voice volume rides on every (re)mount of the element
    el.volume = window.watchparty.voiceVolume ?? 1;
    if (el.paused) {
      el.play().catch(() => {
        this.setState({ playBlocked: true });
        document.addEventListener("pointerdown", this.retryPlay, {
          once: true,
        });
        document.addEventListener("keydown", this.retryPlay, { once: true });
      });
    }
  };

  retryPlay = () => {
    this.setState({ playBlocked: false });
    Object.keys(this.remoteStreams).forEach((key) =>
      window.watchparty.videoRefs[key]?.play().catch(() => {}),
    );
  };

  // One "voice volume" for everyone else (the movie keeps its own slider).
  // State drives the slider thumb; window.watchparty drives attach() on every
  // (re)mount, so the setting outlives element remounts and panel collapse
  setVoiceVolume = (v: number) => {
    window.watchparty.voiceVolume = v;
    this.setState({ voiceVolume: v });
    Object.entries(window.watchparty.videoRefs).forEach(([id, el]) => {
      if (el && id !== getOrCreateClientId()) {
        el.volume = v;
      }
    });
  };

  componentDidMount() {
    this.socket.on("signal", this.handleSignal);
    // ~2 polls a second is plenty; Chrome updates audioLevel roughly that fast
    this.speakTimer = setInterval(this.pollSpeaking, 450);
  }

  componentWillUnmount() {
    this.socket.off("signal", this.handleSignal);
    if (this.speakTimer) {
      clearInterval(this.speakTimer);
    }
  }

  // Who is talking right now, so a dead mic or a half-broken route is visible
  // at a glance. Chrome publishes each receiver's incoming audio level
  // (RFC 6464) via getSynchronizationSources — polling it needs no
  // AudioContext, no permissions and no capture. Browsers without the API
  // just never light up. A source must have sent a packet recently too: a
  // muted peer stops (or silences) its packets, but the entry lingers with
  // its last audioLevel (s.timestamp is on the performance.now() clock).
  // A ring stays on ~600ms after the level drops so it doesn't flicker
  // between words. Our own mic is not shown; the mic button already shows
  // its own state
  pollSpeaking = () => {
    const videoPCs = window.watchparty.videoPCs ?? {};
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
            withSources
              .getSynchronizationSources?.()
              .some(
                (s) =>
                  (s.audioLevel ?? 0) > 0.01 &&
                  pageNow - (s.timestamp ?? -Infinity) < 2000,
              )
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
  };

  componentDidUpdate(prevProps: VideoChatProps) {
    if (
      this.props.rosterUpdateTS !== prevProps.rosterUpdateTS ||
      this.props.deaf !== prevProps.deaf
    ) {
      this.autoListen();
      this.updateWebRTC();
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
    this.socket.emit("CMD:userMute", { isMuted: !this.getAudioWebRTC() });
  };

  handleSignal = async (data: any) => {
    // Handle messages received from signaling server
    const msg = data.msg;
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
    console.log("recv", from, data);
    if (msg.ice !== undefined) {
      // Candidates can outlive the PC they belong to (rebuild races during a
      // network blip); dropping them is fine, throwing is not
      pc.addIceCandidate(new RTCIceCandidate(msg.ice)).catch(() => {});
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
      // Both peers opened their mic at once and both sent an offer: the peer
      // with the larger id rolls its own half-made offer back and answers
      // theirs, the other ignores the colliding offer and waits for the
      // answer to its own (else setRemoteDescription throws and one mic
      // never gets negotiated)
      try {
        if (pc.signalingState === "have-local-offer") {
          if (selfId < from) {
            return;
          }
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
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
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch((e) =>
        console.warn("stale voice answer dropped", e),
      );
    }
  };

  setupWebRTC = async (listenOnly = false) => {
    if (listenOnly) {
      window.watchparty.ourStream = new MediaStream();
      this.socket.emit("CMD:joinVideo");
      this.emitUserMute();
      return;
    }
    const stream = await this.getOwnStream();
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
          // SDP munge above still tells the peers what to send us
          const params = tr.sender.getParameters();
          if (!params.encodings || !params.encodings.length) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = HD_VOICE_BITRATE;
          tr.sender.setParameters(params).catch(() => {});
        } else {
          pc.addTrack(track, ourStream);
        }
      });
    });
    this.emitUserMute();
    this.forceUpdate();
  };

  // Mic off: keep listening while someone else is in voice, else leave
  micOff = () => {
    const ourStream = window.watchparty.ourStream;
    const selfId = getOrCreateClientId();
    const others = this.props.participants.some(
      (p) => p.isVideoChat && p.id !== selfId,
    );
    if (!ourStream || !others || this.props.deaf) {
      this.stopWebRTC();
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
        audio: micConstraints,
        video: true,
      });
    } catch (e) {
      console.warn(e);
      try {
        console.log("attempt audio only stream");
        stream = await navigator?.mediaDevices?.getUserMedia({
          audio: micConstraints,
          video: false,
        });
      } catch (e) {
        console.warn(e);
      }
    }
    // Mic unplugged or revoked by the OS: the track ends and would stream
    // silence forever behind a green mic icon — show the manual mic-off state
    // instead (keep listening if someone else is in voice, else leave)
    stream.getAudioTracks()[0]?.addEventListener("ended", () => this.micOff());
    return stream;
  };

  stopWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    const videoPCs = window.watchparty.videoPCs;
    ourStream &&
      ourStream.getTracks().forEach((track) => {
        track.stop();
      });
    window.watchparty.ourStream = undefined;
    this.remoteStreams = {};
    Object.keys(videoPCs).forEach((key) => {
      videoPCs[key].close();
      delete videoPCs[key];
    });
    this.socket.emit("CMD:leaveVideo");
  };

  toggleVideoWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    if (ourStream && ourStream.getVideoTracks()[0]) {
      ourStream.getVideoTracks()[0].enabled =
        !ourStream.getVideoTracks()[0]?.enabled;
    }
    this.forceUpdate();
  };

  getVideoWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    return ourStream && ourStream.getVideoTracks()[0]?.enabled;
  };

  toggleAudioWebRTC = () => {
    const ourStream = window.watchparty.ourStream;
    if (ourStream && ourStream.getAudioTracks()[0]) {
      ourStream.getAudioTracks()[0].enabled =
        !ourStream.getAudioTracks()[0]?.enabled;
    }
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
      }
    });

    this.props.participants.forEach((user) => {
      const id = user.id;
      if (!user.isVideoChat || videoPCs[id]) {
        // User isn't in video chat, or we already have a connection to them
        return;
      }
      if (id === selfId) {
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
                fresh
                  .createOffer()
                  .then((offer) => {
                    offer.sdp = hdVoiceSdp(offer.sdp);
                    return fresh.setLocalDescription(offer);
                  })
                  .then(() =>
                    this.sendSignal(id, { sdp: fresh.localDescription }),
                  )
                  .catch(() => {});
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
            // round 58, freeze test), so 10 s of dead air is a rebind: restart
            // ICE now instead of waiting for the failed rebuild. Either half
            // drives it (measured round 63: with the watchdog answerer-side an
            // offerer death recovers in ~18 s; without, the answerer waits for
            // the failed escalation — ~23 s). The guards below keep a PC that
            // never connected from restarting: nothing to restart, the failed
            // rebuild owns that case.
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
            }, 10000);
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
          // Start connection for peer's video
          const offer = await pc.createOffer();
          offer.sdp = hdVoiceSdp(offer.sdp);
          await pc.setLocalDescription(offer);
          this.sendSignal(id, { sdp: pc.localDescription });
        };
      }
    });
  };

  sendSignal = async (to: string, data: any) => {
    console.log("send", to, data);
    this.socket.emit("signal", { to, msg: data });
  };

  render() {
    const { participants, pictureMap, nameMap, tsMap, socket, owner } =
      this.props;
    const ourStream = window.watchparty.ourStream;
    const videoRefs = window.watchparty.videoRefs;
    const videoChatSize = participants.length > 2 ? 180 : 250;
    const videoChatContentStyle: React.CSSProperties = {
      height: videoChatSize,
      width: videoChatSize,
      objectFit: "cover",
      position: "relative",
    };
    const selfId = getOrCreateClientId();
    // Violet ring on seats whose mic is picking up sound right now
    const isSpeaking = (id: string) => this.state.speaking.includes(id);
    const speakingStyle: React.CSSProperties = {
      boxShadow: "0 0 0 3px #a78bfa",
    };
    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "4px",
          padding: "4px",
        }}
      >
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
              alignItems: "center",
              gap: "6px",
              width: "100%",
              padding: "0 8px",
            }}
          >
            <IconVolume size={16} style={{ flexShrink: 0 }} />
            <Slider
              title="Voice volume (the others, vs the movie's own volume)"
              value={this.state.voiceVolume}
              onChange={this.setVoiceVolume}
              onChangeEnd={this.setVoiceVolume}
              min={0}
              max={1}
              step={0.05}
              label={(v) => `${Math.round(v * 100)}%`}
              style={{ flexGrow: 1 }}
            />
          </div>
        )}
        {participants.map((p) => {
          return (
            <div key={p.id}>
              <div
                data-speaking={isSpeaking(p.id) ? "true" : "false"}
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
                      <IconDotsVertical
                        style={{
                          position: "absolute",
                          right: 0,
                          top: 0,
                          cursor: "pointer",
                          zIndex: 1,
                          visibility: Boolean(
                            owner && owner === this.context.user?.uid,
                          )
                            ? "visible"
                            : "hidden",
                        }}
                      />
                    }
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      gap: "4px",
                      position: "absolute",
                      top: 0,
                      left: 0,
                      zIndex: 1,
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
                        >
                          <IconVideo />
                        </ActionIcon>
                        <ActionIcon
                          color={this.getAudioWebRTC() ? "green" : "red"}
                          onClick={this.toggleAudioWebRTC}
                        >
                          <IconMicrophone />
                        </ActionIcon>
                      </>
                    )}
                    {p.id !== selfId && (
                      <>
                        {p.isVideoChat && <IconVideo color={softWhite} />}
                        {p.isVideoChat && (
                          <IconMicrophone
                            color={p.isMuted ? "red" : softWhite}
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
                      fontSize: "10px",
                      fontWeight: 700,
                      display: "flex",
                      zIndex: 1,
                    }}
                  >
                    <div
                      title={nameMap[p.id] || p.id}
                      style={{
                        backdropFilter: "brightness(80%)",
                        padding: "4px",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        display: "inline-block",
                      }}
                    >
                      {nameMap[p.id] || p.id}
                    </div>
                    <div
                      style={{
                        backdropFilter: "brightness(60%)",
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
                          videoRefs[p.id] = el;
                          if (p.id !== selfId) {
                            this.attach(p.id);
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
                      muted={p.id === selfId || this.props.deaf}
                      data-id={p.id}
                    />
                  ) : (
                    <img
                      style={{
                        ...videoChatContentStyle,
                        ...(isSpeaking(p.id) ? speakingStyle : {}),
                      }}
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
                          fontSize: "10px",
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
