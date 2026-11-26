import React from "react";
import {
  Modal,
  Button,
  Radio,
  Switch,
  Title,
  Text,
  TextInput,
  ActionIcon,
  Divider,
  SegmentedControl,
} from "@mantine/core";
import { getCurrentSettings, updateSettings } from "../Settings/LocalSettings";
import { Socket } from "socket.io-client";
import { openFileSelector, serverPath, getRoomKey } from "../../utils/utils";
import config from "../../config";
import { MetadataContext } from "../../MetadataContext";
import {
  MkvSubtitleTrack,
  mkvTrackLabel,
  mkvTrackToVtt,
  readMkvSubtitlesOnce,
} from "../../utils/mkvSubtitles";
import {
  IconDownload,
  IconSearch,
  IconUpload,
  IconX,
} from "@tabler/icons-react";

export class SubtitleModal extends React.Component<{
  closeModal: () => void;
  roomSubtitle: string | undefined;
  haveLock: () => boolean;
  roomMedia: string;
  socket: Socket;
  getMediaDisplayName: (input: string) => string;
  setSubtitleMode: (mode?: TextTrackMode) => void;
  getSubtitleMode: () => TextTrackMode;
  loadLocalSubtitle: (file: File) => Promise<void>;
  getLocalMediaFile: () => File | undefined;
  applySubtitleStyle: () => void;
}> {
  static contextType = MetadataContext;
  declare context: React.ContextType<typeof MetadataContext>;
  state = {
    loading: false,
    uploadFailed: false,
    localFailed: false,
    localUrl: "",
    localUrlLoading: false,
    localUrlFailed: false,
    searchFailed: false,
    searchResults: [],
    // Text subtitle tracks inside the local video file playing here (MKV)
    embeddedTracks: [] as MkvSubtitleTrack[],
    embeddedFailed: false,
    titleQuery: this.props
      .getMediaDisplayName(this.props.roomMedia)
      .split("/")
      .slice(-1)[0],
  };

  // The file the embedded tracks were read from
  scannedFile?: File;

  async componentDidMount() {
    const localFile = this.props.getLocalMediaFile();
    this.scannedFile = localFile;
    if (localFile) {
      readMkvSubtitlesOnce(localFile)
        .then((embeddedTracks) => this.setState({ embeddedTracks }))
        .catch(() => this.setState({ embeddedFailed: true }));
    }
    if (this.props.roomMedia.includes("/stream?torrent=magnet")) {
      const re = /&fileIndex=(\d+)$/;
      const match = re.exec(this.props.roomMedia);
      if (match) {
        const fileIndex = match[1];
        if (fileIndex) {
          // Fetch title from the data endpoint
          try {
            const response = await fetch(
              this.props.roomMedia.replace("/stream", "/data"),
            );
            const data = await response.json();
            this.setState({ titleQuery: data?.files[fileIndex]?.name });
          } catch {
            // The file name guess from the media URL stays as the fallback
          }
        }
      }
    }
  }

  uploadSubtitle = async () => {
    const files = await openFileSelector(".srt,.vtt");
    if (!files) {
      return;
    }
    const file = files[0];
    const reader = new FileReader();
    reader.addEventListener("load", async (event) => {
      const subData = event.target?.result;
      // Upload to server
      try {
        const resp = await fetch(serverPath + "/subtitle", {
          method: "POST",
          body: subData,
          headers: { "Content-Type": "text/plain", "X-Room-Key": getRoomKey() },
        });
        if (!resp.ok) {
          // Deployments without subtitle storage reject uploads; the local
          // option below still works
          this.setState({ uploadFailed: true });
          return;
        }
        this.setState({ uploadFailed: false });
        // Once URL obtained, make those the room subtitles
        const json = await resp.json();
        this.props.socket.emit(
          "CMD:subtitle",
          serverPath + "/subtitle/" + json.hash,
        );
      } catch {
        this.setState({ uploadFailed: true });
      }
    });
    reader.readAsText(file);
  };
  loadLocalSubtitle = async () => {
    const files = await openFileSelector(".srt,.vtt");
    if (!files) {
      return;
    }
    try {
      await this.props.loadLocalSubtitle(files[0]);
      this.setState({ localFailed: false });
    } catch {
      this.setState({ localFailed: true });
    }
  };
  // A track inside the video file: turned into WebVTT here and handed to the
  // same local loader as a device file
  loadEmbedded = async (track: MkvSubtitleTrack) => {
    // The media changed since the scan: these tracks belong to another file
    if (this.props.getLocalMediaFile() !== this.scannedFile) {
      return;
    }
    try {
      const name = `Embedded: ${mkvTrackLabel(track)}.vtt`;
      await this.props.loadLocalSubtitle(
        new File([mkvTrackToVtt(track)], name, { type: "text/vtt" }),
      );
      this.setState({ embeddedFailed: false });
    } catch {
      this.setState({ embeddedFailed: true });
    }
  };
  // A subtitle URL just for me: fetched here and handed to the same local
  // loader as a device file, so nothing is sent to the room
  loadLocalSubtitleUrl = async () => {
    const url = this.state.localUrl.trim();
    if (!url) {
      return;
    }
    this.setState({ localUrlLoading: true });
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(String(resp.status));
      }
      const blob = await resp.blob();
      const name = new URL(url).pathname.split("/").pop() || "subtitle.vtt";
      await this.props.loadLocalSubtitle(new File([blob], name));
      this.setState({ localUrlFailed: false });
    } catch {
      this.setState({ localUrlFailed: true });
    } finally {
      this.setState({ localUrlLoading: false });
    }
  };
  // Local only: saved in this browser and applied to our own player
  setStyle = (change: Partial<Settings>) => {
    updateSettings(JSON.stringify({ ...getCurrentSettings(), ...change }));
    this.props.applySubtitleStyle();
    this.forceUpdate();
  };
  render() {
    const { closeModal } = this.props;
    const { subtitleSize, subtitlePosition } = getCurrentSettings();
    return (
      <Modal
        closeButtonProps={{ "aria-label": "Close" }}
        opened
        onClose={closeModal}
        centered
        title="Subtitles"
        size="50rem"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <Switch
            checked={this.props.getSubtitleMode() === "showing"}
            label="Toggle subtitles for myself"
            onClick={() => {
              this.props.setSubtitleMode();
            }}
          />
          <Text size="sm" mt="xs">
            Size (only for me)
          </Text>
          <SegmentedControl
            aria-label="Subtitle size"
            value={String(subtitleSize ?? 100)}
            onChange={(v) => this.setStyle({ subtitleSize: Number(v) })}
            data={["75", "100", "125", "150", "200"].map((v) => ({
              value: v,
              label: `${v}%`,
            }))}
          />
          <Text size="sm" mt="xs">
            Position (only for me)
          </Text>
          <SegmentedControl
            aria-label="Subtitle position"
            value={subtitlePosition ?? "bottom"}
            onChange={(v) =>
              this.setStyle({
                subtitlePosition: v as Settings["subtitlePosition"],
              })
            }
            data={[
              { value: "bottom", label: "Bottom" },
              { value: "higher", label: "Higher" },
              { value: "top", label: "Top" },
            ]}
          />
          <Divider my="lg" />
          <Title order={6}>Room subtitles</Title>
          <div style={{ display: "flex", gap: "4px", flexDirection: "column" }}>
            <TextInput
              placeholder="Subtitle URL"
              value={this.props.roomSubtitle}
              disabled={!this.props.haveLock()}
              onChange={(e) =>
                this.props.socket.emit("CMD:subtitle", e.target.value)
              }
              rightSection={
                <ActionIcon
                  color="red"
                  disabled={!this.props.haveLock()}
                  onClick={() => {
                    this.props.socket.emit("CMD:subtitle", "");
                  }}
                >
                  <IconX />
                </ActionIcon>
              }
            />
            <Button
              color="violet"
              onClick={() => this.uploadSubtitle()}
              disabled={!this.props.haveLock()}
              leftSection={<IconUpload />}
            >
              Upload (.srt / .vtt)
            </Button>
            <Button
              variant="default"
              onClick={() => this.loadLocalSubtitle()}
              leftSection={<IconUpload />}
            >
              Load subtitle file from this device
            </Button>
            {this.state.embeddedTracks.map((track) => (
              <Button
                key={track.number}
                variant="default"
                onClick={() => this.loadEmbedded(track)}
                leftSection={<IconUpload />}
              >
                Embedded: {mkvTrackLabel(track)}
              </Button>
            ))}
            {this.state.embeddedFailed && (
              <Text c="red" size="xs">
                Could not read the subtitles inside this video file.
              </Text>
            )}
            <TextInput
              placeholder="Subtitle URL just for me (.vtt / .srt)"
              aria-label="Subtitle URL just for me"
              value={this.state.localUrl}
              onChange={(e) => this.setState({ localUrl: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  this.loadLocalSubtitleUrl();
                }
              }}
              rightSectionWidth={80}
              rightSection={
                <Button
                  size="compact-sm"
                  variant="default"
                  loading={this.state.localUrlLoading}
                  disabled={!this.state.localUrl.trim()}
                  onClick={() => this.loadLocalSubtitleUrl()}
                >
                  Load
                </Button>
              }
            />
            {this.state.localUrlFailed && (
              <Text c="red" size="xs">
                Could not load that subtitle URL (check the link, and that the
                host allows cross-origin requests).
              </Text>
            )}
            {this.state.localFailed && (
              <Text c="red" size="xs">
                Could not read that subtitle file. Try picking it again.
              </Text>
            )}
            {this.state.uploadFailed && (
              <Text c="red" size="xs">
                Upload to the server failed (subtitle storage unavailable). Use
                "Load subtitle file from this device" instead — it only affects
                your own player.
              </Text>
            )}
            {this.state.searchFailed && (
              <Text c="red" size="xs">
                Subtitle search/download failed. Try again, or use "Load
                subtitle file from this device" instead — it only affects your
                own player.
              </Text>
            )}
            <Divider my="lg" />
            <Title order={6}>OpenSubtitles</Title>
            <TextInput
              value={this.state.titleQuery}
              onChange={(e) => this.setState({ titleQuery: e.target.value })}
              disabled={!this.props.haveLock()}
              rightSectionWidth={230}
              rightSection={
                <div style={{ display: "flex", gap: "4px" }}>
                  <Button
                    loading={this.state.loading}
                    color="green"
                    disabled={!this.props.haveLock()}
                    onClick={async () => {
                      this.setState({ loading: true, searchFailed: false });
                      try {
                        const resp = await fetch(
                          serverPath +
                            "/searchSubtitles?title=" +
                            this.state.titleQuery,
                          { headers: { "X-Room-Key": getRoomKey() } },
                        );
                        const json = await resp.json();
                        this.setState({ searchResults: json });
                      } catch {
                        // A failed search must not leave the spinner running forever
                        this.setState({ searchFailed: true });
                      } finally {
                        this.setState({ loading: false });
                      }
                    }}
                    leftSection={<IconSearch />}
                  >
                    By title
                  </Button>
                  {/* <Button
                    loading={this.state.loading}
                    color="blue"
                    disabled={!this.props.haveLock()}
                    onClick={async () => {
                      this.setState({ loading: true });
                      const resp = await fetch(
                        serverPath +
                          "/searchSubtitles?url=" +
                          this.props.roomMedia,
                      );
                      const json = await resp.json();
                      this.setState({ searchResults: json });
                      this.setState({ loading: false });
                    }}
                    leftSection={<IconSearch />}
                  >
                    By hash
                  </Button> */}
                </div>
              }
            ></TextInput>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              {this.state.searchResults.map(
                (result: {
                  id: string;
                  type: string;
                  attributes: Record<string, any>;
                }) => (
                  <div key={result.id} style={{ display: "flex", gap: "4px" }}>
                    <ActionIcon
                      disabled={!this.props.haveLock()}
                      onClick={async (e) => {
                        try {
                          const resp = await fetch(
                            serverPath +
                              "/downloadSubtitles?file_id=" +
                              result.attributes.files[0]?.file_id,
                            { headers: { "X-Room-Key": getRoomKey() } },
                          );
                          const data = await resp.json();
                          if (!data.link) {
                            // The download endpoint can fail (quota, upstream);
                            // say so instead of loading a dead subtitle URL
                            this.setState({ searchFailed: true });
                            return;
                          }
                          this.setState({ searchFailed: false });
                          this.props.socket.emit(
                            "CMD:subtitle",
                            serverPath + data.link,
                          );
                        } catch {
                          this.setState({ searchFailed: true });
                        }
                      }}
                    >
                      <IconDownload />
                    </ActionIcon>
                    <span>{result.attributes.release}</span>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </Modal>
    );
  }
}
