import React, { useEffect, useState } from "react";
import { Switch, Tooltip } from "@mantine/core";

// The Convert switch, mounted only when this browser can transcode. The check
// mirrors isClientTranscodeSupported (clientTranscode.ts:81) so the
// clientTranscode module (mediabunny glue) is never imported just to render
// this switch; it is downloaded dynamically when a conversion actually starts
// (round 123).
export function ConvertToggle(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const w = window as any;
    setSupported(
      Boolean(
        w.VideoDecoder &&
        w.VideoEncoder &&
        w.AudioDecoder &&
        w.AudioEncoder &&
        w.MediaSource,
      ),
    );
  }, []);
  if (!supported) return null;
  return (
    <Tooltip
      multiline
      w={280}
      refProp="rootRef"
      label="Use CPU/GPU to convert content before playback (only with links, use if video or audio doesn't play, or to choose between audio tracks)"
    >
      <Switch
        label="Convert"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
        style={{ flexShrink: 0, alignSelf: "center" }}
      />
    </Tooltip>
  );
}
