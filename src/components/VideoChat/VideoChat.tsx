import React from "react";
import { createPortal } from "react-dom";
import { ActionIcon, Button } from "@mantine/core";
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

export class VideoChat extends React.Component<
  VideoChatProps,
  { playBlocked: boolean }
> {
  state = { playBlocked: false };
  static contextType = MetadataContext;
  declare context: React.ContextType<typeof MetadataContext>;

  socket = this.props.socket;
  // One stream per peer that we fill with their tracks ourselves: a track
  // that starts on a recvonly transceiver (they were listening, then opened
  // their mic) arrives with no stream of its own
  remoteStreams: Record<string, MediaStream> = {};

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

  componentDidMount() {
    this.socket.on("signal", this.handleSignal);
  }

  componentWillUnmount() {
    this.socket.off("signal", this.handleSignal);
  }

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
    let pc = window.watchparty.videoPCs[from];
    if (!pc) {
      return;
    }
    console.log("recv", from, data);
    if (msg.ice !== undefined) {
      pc.addIceCandidate(new RTCIceCandidate(msg.ice));
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
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendSignal(from, { sdp: pc.localDescription });
    } else if (msg.sdp && msg.sdp.type === "answer") {
      pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
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
        const tr = pc
          .getTransceivers()
          .find((t) => t.receiver.track.kind === track.kind && !t.sender.track);
        if (tr) {
          tr.direction = "sendrecv";
          tr.sender.replaceTrack(track);
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
        audio: true,
        video: true,
      });
    } catch (e) {
      console.warn(e);
      try {
        console.log("attempt audio only stream");
        stream = await navigator?.mediaDevices?.getUserMedia({
          audio: true,
          video: false,
        });
      } catch (e) {
        console.warn(e);
      }
    }
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
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === "failed") {
            // ICE failed (permanently, not a temporary disconnection, which would be "disconnected"), tear down and attempt to re-establish
            pc.close();
            delete videoPCs[id];
            delete this.remoteStreams[id];
            this.updateWebRTC();
          }
        };
        // For each pair, have the lexicographically smaller ID be the offerer.
        // Once connected either side may renegotiate (mic on/off in place)
        const isOfferer = selfId < id;
        pc.onnegotiationneeded = async () => {
          if (!isOfferer && !pc.currentRemoteDescription) return;
          // Start connection for peer's video
          const offer = await pc.createOffer();
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
        {participants.map((p) => {
          return (
            <div key={p.id}>
              <div
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
                      style={videoChatContentStyle}
                      src={
                        pictureMap[p.id] ||
                        getDefaultPicture(
                          nameMap[p.id],
                          getColorForStringHex(p.id),
                        )
                      }
                    />
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
