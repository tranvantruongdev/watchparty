// This listener's own voice preferences, saved in localStorage so they survive
// reloads. Nothing here is sent to the server or the other members. Pure data
// plus storage (no React), so VideoChat and its small settings components share
// one definition of the keys, ranges and defaults.

const readJson = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
};
const writeJson = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

// Per-member volume: 0..200% of the global voice volume, keyed by clientId
// (a seat keeps its clientId across reconnects and page reloads). 100% = no
// entry. The product with the global volume feeds the one output path in
// VideoChat.applyVoiceOutput (element volume up to 100%, gain graph above)
export const MAX_MEMBER_VOLUME = 2;
const MEMBER_VOLUME_KEY = "watchparty-member-volumes";
let memberVolumes: Record<string, number> | undefined;

const loadMemberVolumes = () => {
  if (!memberVolumes) {
    memberVolumes = {};
    const saved = readJson(MEMBER_VOLUME_KEY);
    if (saved && typeof saved === "object") {
      Object.entries(saved).forEach(([id, v]) => {
        if (typeof v === "number" && Number.isFinite(v) && v !== 1) {
          memberVolumes![id] = Math.min(MAX_MEMBER_VOLUME, Math.max(0, v));
        }
      });
    }
  }
  return memberVolumes;
};

export const getMemberVolume = (id: string) => loadMemberVolumes()[id] ?? 1;

export const setMemberVolume = (id: string, volume: number) => {
  const all = loadMemberVolumes();
  const v = Math.min(
    MAX_MEMBER_VOLUME,
    Math.max(0, Math.round(volume * 100) / 100),
  );
  if (v === 1) {
    delete all[id];
  } else {
    all[id] = v;
  }
  writeJson(MEMBER_VOLUME_KEY, all);
  return v;
};

// What one seat plays at: global voice volume x that seat's own volume. Rounded
// so 0.8 x 1.25 cannot land a hair above 100% and switch on the gain graph
export const seatVoiceVolume = (id: string, globalVolume: number) =>
  Math.round(globalVolume * getMemberVolume(id) * 1000) / 1000;

// Some seat is saved above 100% of the global volume (the mic-on click can then
// start the audio context inside its gesture)
export const anySeatBoosted = (globalVolume: number) =>
  Object.values(loadMemberVolumes()).some((m) => globalVolume * m > 1);

// Voice processing the browser applies to our mic. Defaults are what the app
// captured with before these toggles existed: noise suppression and echo
// cancellation on, auto gain off (it would lift far-away sounds to speech level)
export interface VoiceProcessing {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}
const PROCESSING_KEY = "watchparty-voice-processing";
const DEFAULT_PROCESSING: VoiceProcessing = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: false,
};

export const getVoiceProcessing = (): VoiceProcessing => {
  const saved = readJson(PROCESSING_KEY) as
    Partial<VoiceProcessing> | undefined;
  const pick = (k: keyof VoiceProcessing) =>
    typeof saved?.[k] === "boolean"
      ? (saved[k] as boolean)
      : DEFAULT_PROCESSING[k];
  return {
    noiseSuppression: pick("noiseSuppression"),
    echoCancellation: pick("echoCancellation"),
    autoGainControl: pick("autoGainControl"),
  };
};

export const setVoiceProcessing = (patch: Partial<VoiceProcessing>) => {
  const next = { ...getVoiceProcessing(), ...patch };
  writeJson(PROCESSING_KEY, next);
  return next;
};

// The audio constraints for getUserMedia / applyConstraints. voiceIsolation is
// Chrome's ML voice filter (ignored where unsupported); it follows noise
// suppression so "off" really leaves the voice unfiltered
export const processingConstraints = (): MediaTrackConstraints => {
  const p = getVoiceProcessing();
  return {
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
    voiceIsolation: p.noiseSuppression,
  } as MediaTrackConstraints;
};

// Push-to-talk (off by default): the mic sends only while `code` is held.
// `code` is KeyboardEvent.code (layout independent)
export interface PushToTalk {
  enabled: boolean;
  code: string;
}
const PTT_KEY = "watchparty-ptt";

export const getPushToTalk = (): PushToTalk => {
  const saved = readJson(PTT_KEY) as Partial<PushToTalk> | undefined;
  return {
    enabled: saved?.enabled === true,
    code: typeof saved?.code === "string" && saved.code ? saved.code : "KeyV",
  };
};

export const setPushToTalk = (patch: Partial<PushToTalk>) => {
  const next = { ...getPushToTalk(), ...patch };
  writeJson(PTT_KEY, next);
  return next;
};

// "KeyV" -> "V", "Digit5" -> "5", "Space" stays
export const keyLabel = (code: string) =>
  code.replace(/^Key/, "").replace(/^Digit/, "");
