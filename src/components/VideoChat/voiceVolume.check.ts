// Run: node src/components/VideoChat/voiceVolume.check.ts
// (no test runner in this repo; throws, so a non-zero exit, on a failed check)
const {
  MAX_VOICE_VOLUME,
  clampVoiceVolume,
  parseStoredVoiceVolume,
  voicePeerOutput,
}: typeof import("./voiceVolume") = await import(
  new URL("./voiceVolume.ts", import.meta.url).href
);

const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(
      `${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );
  }
};

// stored volume: missing / junk -> 1, otherwise clamped to 0..3
eq("max", MAX_VOICE_VOLUME, 3);
eq("null", parseStoredVoiceVolume(null), 1);
eq("undefined", parseStoredVoiceVolume(undefined), 1);
eq("empty", parseStoredVoiceVolume(""), 1);
eq("NaN text", parseStoredVoiceVolume("abc"), 1);
eq("0.5", parseStoredVoiceVolume("0.5"), 0.5);
eq("0 stays 0", parseStoredVoiceVolume("0"), 0);
eq("2.5", parseStoredVoiceVolume("2.5"), 2.5);
eq("above max", parseStoredVoiceVolume("9"), 3);
eq("negative", parseStoredVoiceVolume("-1"), 0);
eq("clamp NaN", clampVoiceVolume(NaN), 1);

// {self, deaf, volume} -> how the seat is played
const out = (self: boolean, deaf: boolean, volume: number) =>
  voicePeerOutput({ self, deaf, volume });
eq("1.0", out(false, false, 1), {
  useGraph: false,
  muted: false,
  elementVolume: 1,
  gain: 0,
});
eq("0.5", out(false, false, 0.5), {
  useGraph: false,
  muted: false,
  elementVolume: 0.5,
  gain: 0,
});
eq("0.0", out(false, false, 0), {
  useGraph: false,
  muted: false,
  elementVolume: 0,
  gain: 0,
});
eq("deaf 0.5", out(false, true, 0.5), {
  useGraph: false,
  muted: true,
  elementVolume: 0.5,
  gain: 0,
});
eq("boost 2", out(false, false, 2), {
  useGraph: true,
  muted: true,
  elementVolume: 1,
  gain: 2,
});
eq("boost 3", out(false, false, 3).gain, 3);
eq("boost over max", out(false, false, 5).gain, 3);
eq("deaf boost", out(false, true, 2), {
  useGraph: true,
  muted: true,
  elementVolume: 1,
  gain: 0,
});
// element and graph never play together: graph on => element muted
for (const volume of [0, 0.5, 1, 1.05, 2, 3]) {
  for (const deaf of [false, true]) {
    const o = out(false, deaf, volume);
    if (o.useGraph && !o.muted) {
      throw new Error(`double audio at ${volume} deaf=${deaf}`);
    }
  }
}
// self: always muted, never routed, whatever the volume
for (const volume of [0, 1, 2, 3]) {
  const o = out(true, false, volume);
  eq(`self ${volume}`, [o.useGraph, o.muted, o.gain], [false, true, 0]);
}

console.log("voiceVolume checks passed");
