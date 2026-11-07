import React, { useContext, useState } from "react";
import { Modal, Button, Table, SegmentedControl } from "@mantine/core";
import { SubscribeButton } from "../SubscribeButton/SubscribeButton";
import { MetadataContext } from "../../MetadataContext";

// Max bitrate of a direct share, per viewer. 16 can fill a home upload link
// and lag the sharer's own network, so the sharer picks it
const SHARE_MBPS = ["4", "8", "16"];
export const getShareMbps = () => {
  let v: string | null = null;
  try {
    v = window.localStorage.getItem("watchparty-share-mbps");
  } catch {}
  return Number(v && SHARE_MBPS.includes(v) ? v : "8");
};

export const ScreenShareModal = ({
  closeModal,
  startScreenShare,
}: {
  closeModal: () => void;
  startScreenShare: (useMediaSoup: boolean) => void;
}) => {
  const { isSubscriber } = useContext(MetadataContext);
  const subscribeButton = <SubscribeButton />;
  const [mbps, setMbps] = useState(String(getShareMbps()));
  return (
    <Modal
      opened={true}
      onClose={closeModal}
      title="Share your screen"
      centered
      size="auto"
    >
      <div>You're about to share your screen.</div>
      <ul>
        <li>This feature is only supported on Chrome and Edge on desktop.</li>
        <li>
          Audio sharing only works if sharing your entire screen or a browser
          tab, not an application.
        </li>
      </ul>
      <div>
        Quality (max upload per viewer):{" "}
        <SegmentedControl
          value={mbps}
          onChange={(v) => {
            setMbps(v);
            try {
              window.localStorage.setItem("watchparty-share-mbps", v);
            } catch {}
          }}
          data={[
            { value: "4", label: "Low 4 Mbps" },
            { value: "8", label: "Medium 8 Mbps" },
            { value: "16", label: "High 16 Mbps" },
          ]}
        />
      </div>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th />
            <Table.Th>WatchParty Free</Table.Th>
            <Table.Th>WatchParty Plus</Table.Th>
          </Table.Tr>
        </Table.Thead>

        <Table.Tbody>
          <Table.Tr>
            <Table.Td>Method</Table.Td>
            <Table.Td>
              Stream your video to each viewer from your device.
            </Table.Td>
            <Table.Td>
              Stream your video to our relay server, which sends it to each
              viewer, reducing bandwidth usage.
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>Latency</Table.Td>
            <Table.Td>{`<1s`}</Table.Td>
            <Table.Td>{`<1s`}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>Recommended Max Viewers</Table.Td>
            <Table.Td>5</Table.Td>
            <Table.Td>20</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td>Recommended Upload Speed</Table.Td>
            <Table.Td>5 Mbps per viewer</Table.Td>
            <Table.Td>5 Mbps</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td></Table.Td>
            <Table.Td>
              <Button
                onClick={() => {
                  startScreenShare(false);
                  closeModal();
                }}
              >
                Start Screenshare
              </Button>
            </Table.Td>
            <Table.Td>
              {isSubscriber ? (
                <Button
                  color="orange"
                  onClick={() => {
                    startScreenShare(true);
                    closeModal();
                  }}
                >
                  Start Screenshare w/Relay
                </Button>
              ) : (
                subscribeButton
              )}
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Modal>
  );
};
