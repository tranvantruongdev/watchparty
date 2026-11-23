import React from "react";
import { Button, Switch } from "@mantine/core";

import {
  getPushToTalk,
  getVoiceProcessing,
  keyLabel,
  setPushToTalk,
  setVoiceProcessing,
  VoiceProcessing,
} from "./voicePrefs";

// Voice processing toggles and push-to-talk for this listener's own mic. Local
// preferences only (voicePrefs.ts): nothing is sent to the room. VideoChat
// passes the two callbacks that apply a change to the live mic.
export const VoiceSettings = ({
  onProcessingChange,
  onPushToTalkChange,
}: {
  onProcessingChange: () => void;
  onPushToTalkChange: () => void;
}) => {
  const [processing, setProcessing] = React.useState(getVoiceProcessing);
  const [ptt, setPtt] = React.useState(getPushToTalk);
  // Waiting for the key that becomes the push-to-talk key
  const [binding, setBinding] = React.useState(false);

  React.useEffect(() => {
    if (!binding) {
      return undefined;
    }
    // Capture phase + stopPropagation: the chosen key must not also run as a
    // push-to-talk press or any other page shortcut
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape") {
        setPtt(setPushToTalk({ code: e.code }));
      }
      setBinding(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [binding]);

  const toggleProcessing = (key: keyof VoiceProcessing, value: boolean) => {
    setProcessing(setVoiceProcessing({ [key]: value }));
    onProcessingChange();
  };

  return (
    <div
      data-voice-settings
      style={{ display: "flex", flexDirection: "column", gap: "4px" }}
    >
      <Switch
        size="xs"
        label="Noise suppression"
        checked={processing.noiseSuppression}
        onChange={(e) =>
          toggleProcessing("noiseSuppression", e.currentTarget.checked)
        }
      />
      <Switch
        size="xs"
        label="Echo cancellation"
        checked={processing.echoCancellation}
        onChange={(e) =>
          toggleProcessing("echoCancellation", e.currentTarget.checked)
        }
      />
      <Switch
        size="xs"
        label="Auto gain"
        checked={processing.autoGainControl}
        onChange={(e) =>
          toggleProcessing("autoGainControl", e.currentTarget.checked)
        }
      />
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Switch
          size="xs"
          label="Push to talk"
          checked={ptt.enabled}
          onChange={(e) => {
            setPtt(setPushToTalk({ enabled: e.currentTarget.checked }));
            onPushToTalkChange();
          }}
        />
        <Button
          size="compact-xs"
          variant="default"
          aria-label="Push-to-talk key"
          title="Click, then press the key to hold while talking (Esc cancels)"
          onClick={() => setBinding((b) => !b)}
        >
          {binding ? "press a key…" : keyLabel(ptt.code)}
        </Button>
      </div>
    </div>
  );
};
