// Reads the text subtitle tracks (SRT, ASS/SSA, WebVTT) embedded in a local
// Matroska file. mediabunny drops subtitle tracks, so this walks the EBML
// itself: Segment -> Tracks for the subtitle TrackEntry elements, then the
// Clusters for the blocks of those tracks. Only the bytes it needs are read
// (Blob.slice), nothing leaves the browser.

export type MkvSubtitleCue = { start: number; end: number; text: string };

export type MkvSubtitleTrack = {
  number: number;
  language: string;
  name: string;
  codec: string;
  cues: MkvSubtitleCue[];
};

// EBML element ids (marker bits included, as written in the spec)
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_LANGUAGE = 0x22b59c;
const ID_LANGUAGE_BCP47 = 0x22b59d;
const ID_NAME = 0x536e;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;
// Children of the Segment: seeing one of these inside a Cluster (whose size
// may be unknown) means the Cluster is over
const SEGMENT_CHILDREN = new Set([
  ID_CLUSTER,
  ID_INFO,
  ID_TRACKS,
  0x114d9b74, // SeekHead
  0x1c53bb6b, // Cues
  0x1254c367, // Tags
  0x1043a770, // Chapters
  0x1941a469, // Attachments
]);

const TRACK_TYPE_SUBTITLE = 17;
const TEXT_CODECS = [
  "S_TEXT/UTF8",
  "S_TEXT/ASS",
  "S_TEXT/SSA",
  "S_TEXT/WEBVTT",
];
const READ_CHUNK = 256 * 1024;
// Limits for a file that lies about sizes: an element body read whole (Info,
// Tracks, a block) must stay small, a subtitle block is a line of text
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_CUE_BLOCK_BYTES = 64 * 1024;
const MAX_CUES_PER_TRACK = 100000;
// ContentEncoding: only zlib and header stripping are decoded
const ID_CONTENT_ENCODINGS = 0x6d80;
const ID_CONTENT_ENCODING = 0x6240;
const ID_CONTENT_ENCODING_SCOPE = 0x5032;
const ID_CONTENT_ENCODING_TYPE = 0x5033;
const ID_CONTENT_COMPRESSION = 0x5034;
const ID_CONTENT_COMP_ALGO = 0x4254;
const ID_CONTENT_COMP_SETTINGS = 0x4255;
const COMP_ZLIB = 0;
const COMP_HEADER_STRIP = 3;

// How the blocks of a track are packed (absent: plain)
type Comp = { algo: number; settings: Uint8Array };

type Header = { id: number; size: number; unknown: boolean; head: number };

// Element id: 1-4 bytes, the length marker stays part of the id
function readId(
  buf: Uint8Array,
  o: number,
): { id: number; len: number } | null {
  const first = buf[o];
  if (!first) {
    return null;
  }
  const len = Math.clz32(first) - 23;
  if (len > 4 || o + len > buf.length) {
    return null;
  }
  let id = 0;
  for (let i = 0; i < len; i++) {
    id = id * 256 + buf[o + i];
  }
  return { id, len };
}

// Size / track number: 1-8 bytes, the length marker is dropped. `unknown` is
// the reserved all-ones value
function readVint(
  buf: Uint8Array,
  o: number,
): { value: number; len: number; unknown: boolean } | null {
  const first = buf[o];
  if (!first) {
    return null;
  }
  const len = Math.clz32(first) - 23;
  if (o + len > buf.length) {
    return null;
  }
  let value = first & (0xff >> len);
  let ones = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[o + i];
    ones = ones && buf[o + i] === 0xff;
  }
  return { value, len, unknown: ones };
}

// The direct children (id, data range) of a small, fully loaded element body
function* children(
  buf: Uint8Array,
  from: number,
  to: number,
): Generator<{ id: number; from: number; to: number }> {
  let pos = from;
  while (pos < to) {
    const id = readId(buf, pos);
    const size = id && readVint(buf, pos + id.len);
    if (!id || !size || size.unknown) {
      return;
    }
    const dataFrom = pos + id.len + size.len;
    const dataTo = dataFrom + size.value;
    if (dataTo > to) {
      return;
    }
    yield { id: id.id, from: dataFrom, to: dataTo };
    pos = dataTo;
  }
}

function uint(buf: Uint8Array, from: number, to: number): number {
  let v = 0;
  for (let i = from; i < to; i++) {
    v = v * 256 + buf[i];
  }
  return v;
}

function utf8(buf: Uint8Array, from: number, to: number): string {
  let end = to;
  while (end > from && buf[end - 1] === 0) {
    end--;
  }
  return new TextDecoder("utf-8").decode(buf.subarray(from, end));
}

// A sliding window over the file: ensure() loads from `pos` when the bytes
// asked for are not in it, so skipping a big block costs one read of the next
// header instead of the block
class Reader {
  file: Blob;
  buf = new Uint8Array(0);
  start = 0;
  constructor(file: Blob) {
    this.file = file;
  }
  async ensure(pos: number, n: number): Promise<boolean> {
    const size = this.file.size;
    if (pos >= size) {
      return false;
    }
    const end = Math.min(pos + n, size);
    if (pos >= this.start && end <= this.start + this.buf.length) {
      return true;
    }
    const len = Math.min(Math.max(n, READ_CHUNK), size - pos);
    this.buf = new Uint8Array(
      await this.file.slice(pos, pos + len).arrayBuffer(),
    );
    this.start = pos;
    return true;
  }
  async header(pos: number): Promise<Header | null> {
    if (!(await this.ensure(pos, 12))) {
      return null;
    }
    const o = pos - this.start;
    const id = readId(this.buf, o);
    const size = id && readVint(this.buf, o + id.len);
    if (!id || !size) {
      return null;
    }
    return {
      id: id.id,
      size: size.value,
      unknown: size.unknown,
      head: id.len + size.len,
    };
  }
  // The body of an element as a view into the window
  async body(pos: number, size: number): Promise<Uint8Array | null> {
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    await this.ensure(pos, size);
    const o = pos - this.start;
    return o + size <= this.buf.length ? this.buf.subarray(o, o + size) : null;
  }
}

// The packing of a track's blocks from its ContentEncodings: undefined for
// plain, null for one we can't undo (encryption, bzlib, lzo, several layers)
function parseContentEncodings(
  buf: Uint8Array,
  from: number,
  to: number,
): Comp | null | undefined {
  const encodings = [...children(buf, from, to)].filter(
    (c) => c.id === ID_CONTENT_ENCODING,
  );
  if (encodings.length > 1) {
    return null;
  }
  if (!encodings.length) {
    return undefined;
  }
  let scope = 1;
  let type = 0;
  let algo = COMP_ZLIB;
  let settings = new Uint8Array(0);
  for (const c of children(buf, encodings[0].from, encodings[0].to)) {
    if (c.id === ID_CONTENT_ENCODING_SCOPE) {
      scope = uint(buf, c.from, c.to);
    } else if (c.id === ID_CONTENT_ENCODING_TYPE) {
      type = uint(buf, c.from, c.to);
    } else if (c.id === ID_CONTENT_COMPRESSION) {
      for (const k of children(buf, c.from, c.to)) {
        if (k.id === ID_CONTENT_COMP_ALGO) {
          algo = uint(buf, k.from, k.to);
        } else if (k.id === ID_CONTENT_COMP_SETTINGS) {
          settings = buf.slice(k.from, k.to);
        }
      }
    }
  }
  if (!(scope & 1)) {
    // Only the codec private data is packed, the blocks are plain
    return undefined;
  }
  if (type !== 0 || (algo !== COMP_ZLIB && algo !== COMP_HEADER_STRIP)) {
    return null;
  }
  return { algo, settings };
}

// Inflates a zlib stream, giving up (null) past maxOut bytes
async function inflate(
  data: Uint8Array,
  maxOut: number,
): Promise<Uint8Array | null> {
  const reader = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxOut) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function parseTrackEntry(
  buf: Uint8Array,
  from: number,
  to: number,
):
  | {
      number: number;
      language: string;
      name: string;
      codec: string;
      comp: Comp | null | undefined;
    }
  | undefined {
  let number = 0;
  let type = 0;
  let codec = "";
  let language = "eng";
  let bcp47 = "";
  let name = "";
  let comp: Comp | null | undefined;
  for (const c of children(buf, from, to)) {
    if (c.id === ID_CONTENT_ENCODINGS) {
      comp = parseContentEncodings(buf, c.from, c.to);
    } else if (c.id === ID_TRACK_NUMBER) {
      number = uint(buf, c.from, c.to);
    } else if (c.id === ID_TRACK_TYPE) {
      type = uint(buf, c.from, c.to);
    } else if (c.id === ID_CODEC_ID) {
      codec = utf8(buf, c.from, c.to);
    } else if (c.id === ID_LANGUAGE) {
      language = utf8(buf, c.from, c.to);
    } else if (c.id === ID_LANGUAGE_BCP47) {
      bcp47 = utf8(buf, c.from, c.to);
    } else if (c.id === ID_NAME) {
      name = utf8(buf, c.from, c.to);
    }
  }
  if (type !== TRACK_TYPE_SUBTITLE || !number) {
    return undefined;
  }
  return { number, language: bcp47 || language, name, codec, comp };
}

// ASS/SSA event payload: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,
// Effect,Text. Returns the plain text, "" for a drawing or an empty line
function assText(payload: string): string {
  let idx = -1;
  for (let i = 0; i < 8; i++) {
    idx = payload.indexOf(",", idx + 1);
    if (idx < 0) {
      return "";
    }
  }
  const raw = payload.slice(idx + 1);
  // [^{}] keeps both patterns linear on an override block that never closes
  if (/\{[^{}]*\\p[1-9]/.test(raw)) {
    return "";
  }
  return raw
    .replace(/\{[^{}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

function cueText(codec: string, payload: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(payload).replace(/\r\n?/g, "\n");
  if (codec === "S_TEXT/ASS" || codec === "S_TEXT/SSA") {
    return assText(text);
  }
  return text.trim();
}

// One Cluster: returns the position after it (known size) or of the next
// Segment-level element (unknown size)
async function readCluster(
  r: Reader,
  body: number,
  h: Header,
  limit: number,
  tracks: Map<number, MkvSubtitleTrack>,
  comps: Map<number, Comp>,
  scale: number,
): Promise<number> {
  const end = h.unknown ? limit : Math.min(body + h.size, limit);
  let clusterTime = 0;
  const addBlock = async (at: number, size: number, duration: number) => {
    if (!(await r.ensure(at, 12))) {
      return;
    }
    const num = readVint(r.buf, at - r.start);
    const track = num && tracks.get(num.value);
    if (
      !num ||
      !track ||
      size < num.len + 3 ||
      size > MAX_CUE_BLOCK_BYTES ||
      track.cues.length >= MAX_CUES_PER_TRACK
    ) {
      return;
    }
    const block = await r.body(at, size);
    // Laced blocks are not used for subtitles; skip what we can't parse
    if (!block || block[num.len + 2] & 0x06) {
      return;
    }
    let rel = (block[num.len] << 8) | block[num.len + 1];
    if (rel & 0x8000) {
      rel -= 0x10000;
    }
    let payload: Uint8Array | null = block.subarray(num.len + 3);
    const comp = comps.get(track.number);
    if (comp?.algo === COMP_ZLIB) {
      payload = await inflate(payload, MAX_CUE_BLOCK_BYTES);
    } else if (comp) {
      const joined = new Uint8Array(comp.settings.length + payload.length);
      joined.set(comp.settings);
      joined.set(payload, comp.settings.length);
      payload = joined;
    }
    if (!payload) {
      return;
    }
    const text = cueText(track.codec, payload);
    if (!text) {
      return;
    }
    const start = ((clusterTime + rel) * scale) / 1e9;
    track.cues.push({ start, end: start + (duration * scale) / 1e9, text });
  };

  let pos = body;
  while (pos < end) {
    const c = await r.header(pos);
    if (!c) {
      return end;
    }
    if (SEGMENT_CHILDREN.has(c.id)) {
      return pos;
    }
    const cbody = pos + c.head;
    if (c.unknown) {
      return end;
    }
    if (c.id === ID_CLUSTER_TIMECODE) {
      const data = await r.body(cbody, c.size);
      clusterTime = data ? uint(data, 0, data.length) : 0;
    } else if (c.id === ID_SIMPLE_BLOCK) {
      await addBlock(cbody, c.size, 0);
    } else if (c.id === ID_BLOCK_GROUP) {
      const gend = cbody + c.size;
      let gpos = cbody;
      let blockAt = -1;
      let blockSize = 0;
      let duration = 0;
      while (gpos < gend) {
        const g = await r.header(gpos);
        if (!g || g.unknown) {
          break;
        }
        const gbody = gpos + g.head;
        if (g.id === ID_BLOCK) {
          blockAt = gbody;
          blockSize = g.size;
        } else if (g.id === ID_BLOCK_DURATION) {
          const data = await r.body(gbody, g.size);
          duration = data ? uint(data, 0, data.length) : 0;
        }
        gpos = gbody + g.size;
      }
      if (blockAt >= 0) {
        await addBlock(blockAt, blockSize, duration);
      }
    }
    pos = cbody + c.size;
  }
  return end;
}

// Walks the file; each subtitle track's cues come back sorted by start time.
// A file that is not Matroska, or has no text subtitle track we can decode,
// gives []
export async function readMkvSubtitles(
  file: Blob,
): Promise<MkvSubtitleTrack[]> {
  const r = new Reader(file);
  const limit = file.size;
  const top = await r.header(0);
  if (!top || top.id !== ID_EBML || top.unknown) {
    return [];
  }
  let pos = top.head + top.size;
  let segment = await r.header(pos);
  while (segment && segment.id !== ID_SEGMENT) {
    if (segment.unknown) {
      return [];
    }
    pos += segment.head + segment.size;
    segment = await r.header(pos);
  }
  if (!segment) {
    return [];
  }
  pos += segment.head;

  let scale = 1000000;
  const tracks = new Map<number, MkvSubtitleTrack>();
  const comps = new Map<number, Comp>();
  let sawTracks = false;

  // Segment level: Info and Tracks are read whole, Clusters are walked
  while (pos < limit) {
    const h = await r.header(pos);
    if (!h) {
      break;
    }
    const body = pos + h.head;
    if (h.unknown) {
      // Only a Cluster may be of unknown size
      if (h.id !== ID_CLUSTER || !sawTracks) {
        break;
      }
    } else if (h.id !== ID_CLUSTER) {
      if (h.id === ID_INFO || h.id === ID_TRACKS) {
        const buf = await r.body(body, h.size);
        if (!buf) {
          break;
        }
        for (const c of children(buf, 0, buf.length)) {
          if (h.id === ID_INFO && c.id === ID_TIMECODE_SCALE) {
            scale = uint(buf, c.from, c.to) || scale;
          } else if (h.id === ID_TRACKS && c.id === ID_TRACK_ENTRY) {
            const info = parseTrackEntry(buf, c.from, c.to);
            // comp === null: packed in a way we can't undo, no track
            if (
              info &&
              info.comp !== null &&
              TEXT_CODECS.includes(info.codec)
            ) {
              const { comp, ...track } = info;
              tracks.set(info.number, { ...track, cues: [] });
              if (comp) {
                comps.set(info.number, comp);
              }
            }
          }
        }
        if (h.id === ID_TRACKS) {
          sawTracks = true;
          if (!tracks.size) {
            return [];
          }
        }
      }
      pos = body + h.size;
      continue;
    }
    if (!sawTracks) {
      // Clusters before Tracks: not something muxers write
      return [];
    }
    pos = await readCluster(r, body, h, limit, tracks, comps, scale);
  }

  const out = [...tracks.values()];
  for (const t of out) {
    t.cues.sort((a, b) => a.start - b.start);
    // A block without a duration ends where the next cue starts
    t.cues.forEach((cue, i) => {
      if (cue.end <= cue.start) {
        cue.end = t.cues[i + 1]?.start ?? cue.start + 2;
      }
    });
  }
  return out;
}

function vttTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)}.${p(ms % 1000, 3)}`;
}

// The track as a WebVTT document, ready for a <track> element
export function mkvTrackToVtt(track: MkvSubtitleTrack): string {
  // ASS text is plain once the override tags are gone; SRT keeps <i>, <b>
  const plain = track.codec === "S_TEXT/ASS" || track.codec === "S_TEXT/SSA";
  let out = "WEBVTT\n\n";
  track.cues.forEach((cue, i) => {
    // "-->" or a blank line inside the text would start a new cue / settings
    let text = cue.text
      .replace(/\r\n?/g, "\n")
      .replace(/--+>/g, "->")
      .replace(/\n(?:[ \t]*\n)+/g, "\n");
    if (plain) {
      text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    }
    out += `${i + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${text}\n\n`;
  });
  return out;
}

export function mkvTrackLabel(track: MkvSubtitleTrack): string {
  return [track.language, track.name].filter(Boolean).join(" / ") || "track";
}

// One scan per file: reopening the dialog must not read a big file again
const scans = new WeakMap<Blob, Promise<MkvSubtitleTrack[]>>();
export function readMkvSubtitlesOnce(file: Blob): Promise<MkvSubtitleTrack[]> {
  let scan = scans.get(file);
  if (!scan) {
    scan = readMkvSubtitles(file);
    scans.set(file, scan);
  }
  return scan;
}
