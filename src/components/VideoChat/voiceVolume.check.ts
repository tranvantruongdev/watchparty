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

// mutedForMe: one seat silenced for this listener only (round 180). At every
// volume the element is muted and no gain node exists; clearing it restores the
// seat exactly to the volume/deaf rule
for (const volume of [0, 0.5, 1, 1.05, 2, 3]) {
  for (const deaf of [false, true]) {
    const o = voicePeerOutput({ self: false, deaf, volume, mutedForMe: true });
    eq(
      `mutedForMe ${volume} deaf=${deaf}`,
      [o.muted, o.gain, o.useGraph, o.elementVolume],
      [true, 0, false, 1],
    );
  }
  eq(
    `mutedForMe cleared ${volume}`,
    voicePeerOutput({ self: false, deaf: false, volume, mutedForMe: false }),
    out(false, false, volume),
  );
}
// self stays muted and unrouted even if a stale local mute is set for our id
for (const volume of [0, 1, 2]) {
  eq(
    `self mutedForMe ${volume}`,
    voicePeerOutput({ self: true, deaf: false, volume, mutedForMe: true }),
    out(true, false, volume),
  );
}

// routeBelowFull (iOS, element volume ignored): below 100% the gain node plays
// it at that level, element muted; exactly 100% stays on the element; above
// 100%, self and mutedForMe are unchanged
const ios = (volume: number, deaf = false, extra = {}) =>
  voicePeerOutput({
    self: false,
    deaf,
    volume,
    routeBelowFull: true,
    ...extra,
  });
eq("ios 0.3", ios(0.3), {
  useGraph: true,
  muted: true,
  elementVolume: 1,
  gain: 0.3,
});
eq("ios 0", ios(0), { useGraph: true, muted: true, elementVolume: 1, gain: 0 });
eq("ios deaf 0.3", ios(0.3, true).gain, 0);
eq("ios 1", ios(1), out(false, false, 1));
eq("ios 2", ios(2), out(false, false, 2));
eq("ios mutedForMe 0.3", ios(0.3, false, { mutedForMe: true }).useGraph, false);
eq(
  "ios self 0.3",
  voicePeerOutput({
    self: true,
    deaf: false,
    volume: 0.3,
    routeBelowFull: true,
  }),
  out(true, false, 0.3),
);

console.log("voiceVolume checks passed");
