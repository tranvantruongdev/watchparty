// Pure voice-volume rules for VideoChat (kept free of React/DOM so
// voiceVolume.check.ts can run them with plain node)

// HTMLMediaElement.volume stops at 1, so anything above 100% is applied as a
// Web Audio gain instead
export const MAX_VOICE_VOLUME = 3;

// Anything unusable (NaN, missing, empty) means the default 100%; the rest is
// clamped into 0..MAX_VOICE_VOLUME
export const clampVoiceVolume = (v: number) =>
  Number.isNaN(v) ? 1 : Math.min(MAX_VOICE_VOLUME, Math.max(0, v));

// localStorage hands back a string or null (nothing saved yet)
export const parseStoredVoiceVolume = (raw: string | null | undefined) =>
  raw == null || raw.trim() === "" ? 1 : clampVoiceVolume(Number(raw));

export interface VoicePeerOutput {
  // Route the peer's stream through a GainNode (volume > 1 only)
  useGraph: boolean;
  // What the peer's <video> element's muted must be
  muted: boolean;
  // What the element's volume must be (0..1)
  elementVolume: number;
  // The GainNode value when useGraph (0 while deafened)
  gain: number;
}

// The single place that decides how one seat's voice is played. Up to 100% the
// element plays it (today's behaviour); above 100% the element is kept muted
// (it still has to carry the stream: Chrome gives Web Audio no remote WebRTC
// audio otherwise) and the gain node plays it, so never both at once. Self is
// never played back
export const voicePeerOutput = ({
  self,
  deaf,
  volume,
}: {
  self: boolean;
  deaf: boolean;
  volume: number;
}): VoicePeerOutput => {
  const v = clampVoiceVolume(volume);
  if (self) {
    return { useGraph: false, muted: true, elementVolume: 1, gain: 0 };
  }
  if (v > 1) {
    return {
      useGraph: true,
      muted: true,
      elementVolume: 1,
      gain: deaf ? 0 : v,
    };
  }
  return { useGraph: false, muted: deaf, elementVolume: v, gain: 0 };
};
