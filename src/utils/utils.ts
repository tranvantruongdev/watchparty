//@ts-expect-error
import canAutoplay from "can-autoplay";
import { MD5 } from "./md5";
import type firebase from "firebase/compat/app";
import config from "../config";
import { cyrb53 } from "./hash";
import React from "react";

export function formatTimestamp(input: any, zeroTime?: number): string {
  if (
    input === null ||
    input === undefined ||
    input === false ||
    Number.isNaN(input) ||
    input === Infinity
  ) {
    return "";
  }
  if (zeroTime) {
    return new Date((zeroTime + input) * 1000).toLocaleTimeString();
  }
  let hours = Math.abs(Math.trunc(Number(input) / 3600));
  let minutes = Math.abs(Math.trunc(Number(input) / 60) % 60)
    .toString()
    .padStart(2, "0");
  let seconds = Math.abs(Math.trunc(Number(input) % 60))
    .toString()
    .padStart(2, "0");
  return `${Number(input) < 0 ? "-" : ""}${hours ? `${hours}:` : ""}${minutes}:${seconds}`;
}

export function formatSpeed(input: number) {
  if (input >= 1000000) {
    return (input / 1000000).toFixed(2) + " MB/s";
  }
  if (input >= 1000) {
    return (input / 1000).toFixed(0) + " KB/s";
  }
  return input + " B/s";
}

export function formatSize(input: number) {
  if (input >= 1000000000) {
    return (input / 1000000000).toFixed(2) + " GB";
  }
  if (input >= 1000000) {
    return (input / 1000000).toFixed(2) + " MB";
  }
  if (input >= 1000) {
    return (input / 1000).toFixed(0) + " KB";
  }
  return input + " B";
}

export const colorMappings: StringDict = {
  red: "B03060",
  orange: "FE9A76",
  yellow: "FFD700",
  olive: "32CD32",
  green: "016936",
  teal: "008080",
  blue: "0E6EB8",
  violet: "EE82EE",
  purple: "B413EC",
  pink: "FF1493",
  brown: "A52A2A",
  grey: "A0A0A0",
};

export const softWhite = "whitesmoke";

let colorCache: NumberDict = {};
export function getColorForString(id: string) {
  let colors = Object.keys(colorMappings);
  if (colorCache[id]) {
    return colors[colorCache[id]];
  }
  colorCache[id] = Math.abs(cyrb53(id)) % colors.length;
  return colors[colorCache[id]];
}

export function getColorForStringHex(id: string) {
  return colorMappings[getColorForString(id)];
}

export const getFbPhoto = (fbId: string) =>
  `https://graph.facebook.com/${fbId}/picture?type=normal`;

export const isYouTube = (input: string) => {
  return (
    input.startsWith("https://www.youtube.com/") ||
    input.startsWith("https://youtu.be/")
  );
};

export const isHttp = (input: string) => {
  return input.startsWith("http");
};

export const isMagnet = (input: string) => {
  return input.startsWith("magnet:");
};

// Direct links to video files, i.e. things the browser can fetch and play (or convert) as a plain media file.
// Excludes pages/streams that are resolved or played by dedicated players (YouTube, HLS, DASH, Reddit/Twitch
// links that the server resolves, etc.)
export const isDirectVideoUrl = (input: string) => {
  return (
    isHttp(input) &&
    !isYouTube(input) &&
    !isHls(input) &&
    !isDash(input) &&
    !isMpegTs(input) &&
    !/^https?:\/\/(www\.|old\.)?(reddit|twitch)\.(com|tv)(\/|$)/.test(input)
  );
};

// Files smaller than this are assumed not to be the video we want (samples, subtitles, NFOs, etc.)
const MIN_VIDEO_FILE_BYTES = 10 * 1024 * 1024;

// If exactly one file in a multi-file source (e.g. a torrent) is big enough to plausibly be the video, return it
// so it can be played without asking the user to choose.
export const pickSingleLargeFile = <T extends { length: number }>(
  files: T[],
): T | undefined => {
  const large = files.filter((f) => f.length >= MIN_VIDEO_FILE_BYTES);
  return large.length === 1 ? large[0] : undefined;
};

export const isHls = (input: string) => {
  return input.includes(".m3u8");
};

export const isDash = (input: string) => {
  return input.includes(".mpd");
};

export const isMpegTs = (input: string) => {
  return input.includes(".mpegts");
};

export const isScreenShare = (input: string) => {
  return input.startsWith("screenshare://");
};

export const isFileShare = (input: string) => {
  return input.startsWith("fileshare://");
};

export const isLocalCopy = (input: string) => {
  return input.startsWith("localcopy://");
};

// Parses localcopy://<encoded name>@<sharer id>?size=<bytes> — the pseudo URL
// for "local copy" mode. Only the name, sharer, and size travel; the contents
// never leave each viewer's device
export const parseLocalCopy = (input: string) => {
  if (!isLocalCopy(input)) {
    return null;
  }
  const body = input.slice("localcopy://".length);
  const at = body.indexOf("@");
  const query = at >= 0 ? body.indexOf("?", at) : -1;
  if (at < 1 || query < 0) {
    return null;
  }
  let name: string;
  try {
    // decodeURIComponent throws on malformed %-sequences (e.g. %ZZ), and a
    // scripted guest can host one — it would crash every client's render
    // through the "changed the video to" chat line
    name = decodeURIComponent(body.slice(0, at));
  } catch {
    return null;
  }
  return {
    name,
    id: body.slice(at + 1, query),
    size: Number(new URLSearchParams(body.slice(query + 1)).get("size")),
  };
};

export const isVBrowser = (input: string) => {
  return input.startsWith("vbrowser://");
};

export async function testAutoplay() {
  const result = await canAutoplay.video();
  return result.result;
}

export function decodeEntities(input: string) {
  const doc = new DOMParser().parseFromString(input, "text/html");
  return doc.documentElement.textContent;
}

export const debounce = (callback: Function, wait = 500) => {
  let timeoutId: any = null;
  return (...args: any[]) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      callback(...args);
    }, wait);
  };
};

export const getDefaultPicture = (name: string, background = "a0a0a0") => {
  return `https://ui-avatars.com/api/?name=${name}&background=${background}&size=256&color=ffffff`;
};

export const isMobile = () => {
  return window.screen.width <= 600;
};

export function shuffle(array: any[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * i);
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
}

// Cloudflare TURN credentials from our server (POST /iceServers), fetched once at
// startup. Until they arrive, or when the server has no TURN key, the list below
// is used
let fetchedIceServers: RTCIceServer[] | null = null;
export const loadIceServers = async () => {
  try {
    const res = await fetch(serverPath + "/iceServers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomKey: getRoomKey() }),
    });
    if (res.ok) {
      fetchedIceServers = (await res.json()).iceServers;
    }
  } catch {
    // Network error: keep the fallback list
  }
};

export const iceServers = (): RTCIceServer[] =>
  fetchedIceServers ?? fallbackIceServers;

const fallbackIceServers: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  // Measured 2026-11-08 (relay candidate + relay-to-relay DataChannel, headless probe):
  // these two allocate a relay in ~0.5s and forward data; the other three upstream
  // entries are dead (TCP 3478 refused, no STUN answer, no relay ever) and stalled
  // every ICE gather ~15s, so they are removed. Add a TURN url here when new
  // credentials exist; keep only measured-working servers.
  {
    urls: "turn:5.161.207.54:3478",
    username: "username",
    credential: "password",
  },
  {
    urls: "turn:135.181.147.65:3478",
    username: "username",
    credential: "password",
  },
];

export const serverPath =
  config.VITE_SERVER_HOST ||
  `${window.location.protocol}//${
    config.NODE_ENV === "development"
      ? `${window.location.hostname}:8080`
      : window.location.host
  }`;

export async function getMediaPathResults(
  mediaPath: string,
  query: string,
): Promise<SearchResult[]> {
  let results: SearchResult[] = [];
  // if (mediaPath.includes('s3.')) {
  //   const response = await fetch(mediaPath);
  //   // S3-style buckets return data in XML
  //   const xml = await response.text();
  //   const parser = new XMLParser();
  //   const data = parser.parse(xml);
  //   let filtered = data.ListBucketResult.Contents.filter(
  //     // Exclude subdirectories
  //     (file: any) => !file.Key.includes('/'),
  //   );
  //   results = filtered.map((file: any) => ({
  //     url: mediaPath + '/' + file.Key,
  //     name: mediaPath + '/' + file.Key,
  //   }));
  // } else
  if (mediaPath.startsWith("https://www.youtube.com/playlist?list=")) {
    // https://www.youtube.com/playlist?list=<playlist ID>
    const playlistID = mediaPath.split(
      "https://www.youtube.com/playlist?list=",
    )[1];
    const response = await fetch(serverPath + "/youtubePlaylist/" + playlistID);
    results = await response.json();
  } else {
    // Assume it's a text list of URLs
    const response = await fetch(mediaPath);
    const text = await response.text();
    results = text
      .split("\n")
      .map((line) => ({ url: line, name: line, duration: 0, type: "file" }));
  }
  return results.filter((res) => res.url);
}

export async function getStreamPathResults(
  streamPath: string,
  query: string,
): Promise<SearchResult[]> {
  const response = await fetch(
    streamPath + `/${query ? "search" : "top"}?q=` + encodeURIComponent(query),
  );
  const data = await response.json();
  return data.map((d: any, i: number) => ({
    ...d,
    url: d.magnet ?? String(i),
  }));
}

export async function getYouTubeResults(
  query: string,
): Promise<SearchResult[]> {
  const response = await fetch(
    serverPath + "/youtube?q=" + encodeURIComponent(query),
  );
  const data = await response.json();
  return data.map((d: any) => ({ ...d, type: "youtube" }));
}

export async function openFileSelector(accept?: string) {
  return new Promise<FileList | null>((resolve) => {
    // Create an input element
    const inputElement = document.createElement("input");

    // Set its type to file
    inputElement.type = "file";

    // Set accept to the file types you want the user to select.
    // Include both the file extension and the mime type
    if (accept) {
      inputElement.accept = accept;
    }

    // set onchange event to call callback when user has selected file
    inputElement.addEventListener("change", () => {
      resolve(inputElement.files);
    });

    // dispatch a click event to open the file dialog
    inputElement.dispatchEvent(new MouseEvent("click"));
  });
}

export function getOrCreateClientId() {
  let clientId = window.localStorage.getItem("watchparty-clientid");
  if (!clientId) {
    // Generate a new clientID and save it
    // This requires https, so fallback to JS implementation if needed
    clientId = createUuid();
    window.localStorage.setItem("watchparty-clientid", clientId);
  }
  return clientId;
}

export function getOrCreateSessionId() {
  let sessionId = window.localStorage.getItem("watchparty-sessionid");
  if (!sessionId) {
    // Generate a new sessionID and save it
    // This requires https, so fallback to JS implementation if needed
    sessionId = createUuid();
    window.localStorage.setItem("watchparty-sessionid", sessionId);
  }
  return sessionId;
}

// The server's ROOM_KEY, taken once from a ?key= link and kept out of the address bar after that
export function getRoomKey() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("key");
  if (fromUrl) {
    window.localStorage.setItem("watchparty-roomkey", fromUrl);
    url.searchParams.delete("key");
    window.history.replaceState(null, "", url);
  }
  return window.localStorage.getItem("watchparty-roomkey") ?? "";
}

// Invite links must carry the key so a new viewer's browser can store it
export function withRoomKey(link: string) {
  const key = getRoomKey();
  if (!key) {
    return link;
  }
  const url = new URL(link);
  url.searchParams.set("key", key);
  return url.toString();
}

export function addAndSavePassword(roomId: string, password: string) {
  const newPasswords = {
    ...getSavedPasswords(),
    [roomId]: password,
  };
  window.localStorage.setItem(
    "watchparty-passwords",
    JSON.stringify(newPasswords),
  );
}

export function getSavedPasswords(): Record<string, string> {
  try {
    const savedPasswordsString =
      window.localStorage.getItem("watchparty-passwords") ?? "{}";
    const savedPasswords = JSON.parse(savedPasswordsString);
    return savedPasswords;
  } catch (e) {
    console.warn("[ALERT] Could not parse saved passwords");
  }
  return {};
}

// Ticket stubs of the memory wall, one list per room. The stored value may
// be corrupt (hand-edited, older shape): validate it so callers never see a
// non-object (App.init indexes into it) or stubs missing fields (PixelFloor
// draws url/title/at every animation frame)
export function getSavedStubs(): Record<string, TicketStub[]> {
  try {
    const savedStubsString =
      window.localStorage.getItem("watchparty-stubs") ?? "{}";
    const parsed = JSON.parse(savedStubsString);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const clean: Record<string, TicketStub[]> = {};
    for (const [roomId, stubs] of Object.entries(parsed)) {
      if (!Array.isArray(stubs)) continue;
      const valid = stubs.filter(
        (s) =>
          !!s &&
          typeof s.url === "string" &&
          typeof s.title === "string" &&
          typeof s.at === "number" &&
          Number.isFinite(s.at),
      );
      if (valid.length) {
        clean[roomId] = valid;
      }
    }
    return clean;
  } catch (e) {
    console.warn("[ALERT] Could not parse saved ticket stubs");
  }
  return {};
}

export function saveStubs(roomId: string, stubs: TicketStub[]) {
  // Called from onVideoEnded before the playlist advances: a blocked or full
  // storage must not throw there
  try {
    window.localStorage.setItem(
      "watchparty-stubs",
      JSON.stringify({ ...getSavedStubs(), [roomId]: stubs }),
    );
  } catch (e) {
    console.warn("[ALERT] Could not save ticket stubs");
  }
}

// Where this device last watched in each room, so a room that lost its place
// (free-tier deploy waking up empty) can offer "continue from where we left
// off". Per device on purpose: rooms reset without a database, same as the
// ticket stubs above. The stored value may be corrupt (hand-edited, older
// shape): validate it so callers never see a non-object or a bad entry
export interface SavedResume {
  media: string;
  pos: number;
  at: number;
}

export function getSavedResume(): Record<string, SavedResume> {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem("watchparty-resume") ?? "{}",
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const clean: Record<string, SavedResume> = {};
    for (const [roomId, entry] of Object.entries(parsed)) {
      const r = entry as Partial<SavedResume>;
      if (
        !!r &&
        typeof r.media === "string" &&
        typeof r.pos === "number" &&
        Number.isFinite(r.pos) &&
        typeof r.at === "number"
      ) {
        clean[roomId] = { media: r.media, pos: r.pos, at: r.at };
      }
    }
    return clean;
  } catch (e) {
    console.warn("[ALERT] Could not parse saved resume points");
  }
  return {};
}

export function saveResume(roomId: string, entry: SavedResume) {
  try {
    // Keep the most recently watched rooms only
    const entries = Object.entries({
      ...getSavedResume(),
      [roomId]: entry,
    })
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 8);
    window.localStorage.setItem(
      "watchparty-resume",
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch (e) {
    console.warn("[ALERT] Could not save resume point");
  }
}

export function createUuid() {
  return crypto.randomUUID ? crypto.randomUUID() : uuidv4();
}

export function calculateMedian(array: number[]): number {
  // Check If Data Exists
  if (array.length >= 1) {
    // Sort Array
    array = array.sort((a: number, b: number) => {
      return a - b;
    });

    // Array Length: Even
    if (array.length % 2 === 0) {
      // Average Of Two Middle Numbers
      return (array[array.length / 2 - 1] + array[array.length / 2]) / 2;
    }
    // Array Length: Odd
    else {
      // Middle Number
      return array[(array.length - 1) / 2];
    }
  }
  return 0;
}

export async function getUserImage(
  user: firebase.User,
): Promise<string | null> {
  // Check if user has a Gravatar
  const hash = user.email ? MD5.hash(user.email) : "";
  if (user.email) {
    const gravatar = `https://www.gravatar.com/avatar/${hash}?d=404&s=256`;
    const response = await fetch(gravatar);
    if (response.ok) {
      return gravatar;
    }
  }
  if (user.photoURL) {
    return user.photoURL + "?height=256&width=256";
  }
  return `https://www.gravatar.com/avatar/${hash}?d=identicon`;
}

export const getFileName = (input: string) => {
  return input.split("/").slice(-1)[0];
};

export const isEmojiString = (input?: string): boolean => {
  return /^(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])+$/g.test(
    input ?? "",
  );
};

function uuidv4() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (
      +c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))
    ).toString(16),
  );
}

// Subtract header, URL row, button row, 3 gaps, controls
export const VIDEO_MAX_HEIGHT_CSS =
  "calc(100vh - 64px - 36px - 36px - 4px - 4px - 4px - 32px)";
