import React from "react";
import type { Socket } from "socket.io-client";
import { getOrCreateClientId } from "../../utils/utils";
import styles from "./App.module.css";

const clientId = getOrCreateClientId();

// The floor is drawn on a W x H grid of big square "pixels"; positions sent
// over the socket are 0..1 of that grid (feet point)
const W = 96;
const H = 36;
const SPEED = 24; // grid units per second
const SEAT_W = 6;
const SEAT_H = 5;
// Seat-back top rows, and the x of every seat (center aisle 44..53)
const ROWS = [11, 23];
const SEAT_XS = [
  ...Array.from({ length: 5 }, (_, i) => 8 + i * 7),
  ...Array.from({ length: 5 }, (_, i) => 54 + i * 7),
];
// Character presets: six anime-chibi people (big head, big eyes, hair styles)
// plus eight original elemental creatures (bunny, cat, fox, ghost, ember
// kitten, leaf snail, thunder chick, water bunny) drawn at half-cell detail.
// Everything is drawn in code — no image files. The ids must mirror the CHARS
// allow-list in server/room.ts
type CharPreset = {
  id: string;
  name: string;
  // people
  skin?: string;
  hair?: string;
  hairShade?: string;
  style?: "bob" | "twin" | "long" | "spiky" | "ponytail" | "ahoge";
  shirt?: string;
  shirtShade?: string;
  // creatures
  creature?: "tho" | "meo" | "cao" | "ma" | "miu" | "oc" | "chim" | "suoi";
  fur?: string;
  furShade?: string;
  belly?: string;
  accent?: string; // second accent (inner-ear pink, flame, droplet…)
};

const CHARS: CharPreset[] = [
  {
    id: "mai",
    name: "Mai — đuôi sam tím",
    skin: "#ffd9c0",
    hair: "#3a2a4a",
    hairShade: "#241a33",
    style: "twin",
    shirt: "#ff7fa1",
    shirtShade: "#d95d80",
  },
  {
    id: "trung",
    name: "Trung — tóc dựng",
    skin: "#f2c7a5",
    hair: "#5a3720",
    hairShade: "#3d2514",
    style: "spiky",
    shirt: "#3fbfae",
    shirtShade: "#2a9688",
  },
  {
    id: "hoa",
    name: "Hoa — tóc dài hồng",
    skin: "#ffe3cd",
    hair: "#e07a9a",
    hairShade: "#b95d7c",
    style: "long",
    shirt: "#7c6cff",
    shirtShade: "#5a4cd0",
  },
  {
    id: "lan",
    name: "Lan — tóc bob vàng",
    skin: "#f2c7a5",
    hair: "#c9a24a",
    hairShade: "#a37e2e",
    style: "bob",
    shirt: "#2e4a8f",
    shirtShade: "#203564",
  },
  {
    id: "nam",
    name: "Nam — đuôi ngựa",
    skin: "#e8b48c",
    hair: "#2f5d3a",
    hairShade: "#1f4028",
    style: "ponytail",
    shirt: "#c9a24a",
    shirtShade: "#9c7c2f",
  },
  {
    id: "bi",
    name: "Bi — bob bạc",
    skin: "#ffd9c0",
    hair: "#c8ccd8",
    hairShade: "#9aa0b2",
    style: "ahoge",
    shirt: "#5a4cd0",
    shirtShade: "#4338a8",
  },
  {
    id: "tho",
    name: "Thỏ bánh bao",
    creature: "tho",
    fur: "#f4f0ff",
    furShade: "#cfc6ec",
    belly: "#ff9ec4",
  },
  {
    id: "meo",
    name: "Mèo kem",
    creature: "meo",
    fur: "#f2d8a8",
    furShade: "#d4b078",
    belly: "#fff3e0",
  },
  {
    id: "cao",
    name: "Cáo lửa nhỏ",
    creature: "cao",
    fur: "#e8875a",
    furShade: "#c2603a",
    belly: "#fff3e0",
  },
  {
    id: "ma",
    name: "Ma mụp",
    creature: "ma",
    fur: "#cfc0f0",
    furShade: "#a894d4",
    belly: "#241a33",
  },
  {
    id: "miu",
    name: "Mèo than hồng",
    creature: "miu",
    fur: "#6e6478",
    furShade: "#4e4658",
    belly: "#ffb066",
    accent: "#ff8c5a",
  },
  {
    id: "oc",
    name: "Ốc lá cuộn",
    creature: "oc",
    fur: "#6fbf5a",
    furShade: "#3f8f3c",
    belly: "#f6ecc8",
  },
  {
    id: "chim",
    name: "Gà sấm nhỏ",
    creature: "chim",
    fur: "#ffd95c",
    furShade: "#e0a83a",
    belly: "#ff8c3a",
  },
  {
    id: "suoi",
    name: "Thỏ suối",
    creature: "suoi",
    fur: "#8fc7e8",
    furShade: "#5f9cc4",
    belly: "#e8f6ff",
    accent: "#3f9cd4",
  },
];

const OUT = "#1b1428"; // silhouette rim
const BLUSH = "#f2a0a8";
const LEGS = "#2a2a3a";

// Creature sprites at half-cell detail: 14x22 sub-pixels filling the same
// 7x11 floor box as before (feet on the bottom rows), so seats, collisions,
// snuggles and emote positions are unchanged — just twice the resolution.
// All designs are original: no franchise character, name, color scheme or
// silhouette. Row strings, chars: O outline, f fur, s furShade, b belly,
// k accent, w white, . empty. Eyes, blush, mouth, tails and the ghost hem
// are painted over the body by paintChar
type CreatureArt = {
  art: string[];
  eyeY: number; // top row of the eyes
  eyeW?: number; // eye width in sub-pixels (4, or 3 on the narrow face)
  eyeL?: number; // left eye x (default 2; the right eye sits at 8)
  eyeR?: number;
  mouthY: number;
  mouthX?: number; // default 6 (a 2-sub-pixel mouth)
  blushY?: number; // blush row; omit for no blush
  blushX?: number; // default 1, mirrored on the right side
};
const CREATURE_ART: Record<string, CreatureArt> = {
  tho: {
    // Round bunny: tall pink-inner ears, dome head, white belly patch
    eyeY: 9,
    mouthY: 14,
    blushY: 14,
    art: [
      "..OO......OO..",
      "..ObO....ObO..",
      "..ObO....ObO..",
      "..ObO....ObO..",
      "..ObO....ObO..",
      "..ObO....ObO..",
      "..OOOOOOOOOO..",
      ".OfffffffffsO.",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      ".OsffffffffsO.",
      "..OwwwwwwssO..",
      "..OwwwwwwssO..",
      "..OwwwwwwssO..",
      "..OOssssssOO..",
      "..OfO....OfO..",
      "..OOO....OOO..",
    ],
  },
  meo: {
    // Cream cat loaf: triangle ears, forehead stripes, flat bottom
    eyeY: 9,
    mouthY: 15,
    blushY: 14,
    art: [
      "..O........O..",
      ".ObO......ObO.",
      ".ObO......ObO.",
      ".ObO......ObO.",
      ".OOOOOOOOOOOO.",
      "OffffffffffssO",
      "OfffssffssfffO",
      "OfffssffssfffO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OssffffffffssO",
      "OssffffffffssO",
      "OssssssssssssO",
      "OssssssssssssO",
      ".OOOOOOOOOOOO.",
    ],
  },
  cao: {
    // Fire fox: tall shaded-tip ears, cream muzzle, slim chest
    eyeY: 8,
    mouthY: 13,
    blushY: 13,
    art: [
      ".OsO......OsO.",
      ".OfO......OfO.",
      ".OfO......OfO.",
      ".OfO......OfO.",
      ".OfO......OfO.",
      ".OOOOOOOOOOOO.",
      "OfffffffffffsO",
      "OfffffffffffsO",
      "OfffffffffffsO",
      "OfffffffffffsO",
      "OfffffffffffsO",
      "OfffffffffffsO",
      "OfffbbbbbbffsO",
      "OffbbbbbbbbfsO",
      "OffbbbbbbbbfsO",
      ".OfffffffffsO.",
      "..ObbbbbbssO..",
      "..ObbbbbbssO..",
      "..OffffffssO..",
      "..OOssssssOO..",
      "..OfO....OfO..",
      "..OOO....OOO..",
    ],
  },
  ma: {
    // Ghost blob: bell dome; the wavy hem below is procedural
    eyeY: 8,
    mouthY: 14,
    blushY: 13,
    blushX: 2,
    art: [
      "....OOOOOO....",
      "..OOffffffOO..",
      ".OffffffffffO.",
      ".OffffffffffO.",
      "OffffffffffffO",
      "OffffffffffffO",
      "OffffffffffffO",
      "OffffffffffffO",
      "OffffffffffffO",
      "OffffffffffffO",
      "OffffffffffffO",
      "OffffffffffffO",
      "OffffffffffffO",
      ".OffffffffffO.",
      ".OsffffffffsO.",
      ".OsffffffffsO.",
      "..OssssssssO..",
      "...OssssssO...",
      "....OOOOOO....",
      "..............",
      "..............",
      "..............",
    ],
  },
  miu: {
    // Ember kitten: smoky gray dome, ember inner ears and chest
    eyeY: 9,
    mouthY: 14,
    blushY: 14,
    blushX: 2,
    art: [
      "..O........O..",
      ".ObO......ObO.",
      ".ObO......ObO.",
      ".ObO......ObO.",
      ".OfO......OfO.",
      ".OOOOOOOOOOOO.",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      ".OfffffffffsO.",
      ".OfffffffffsO.",
      "..ObbbbbbssO..",
      "..ObbbbbbssO..",
      "..OffffffssO..",
      "..OffffffssO..",
      "..OOssssssOO..",
      "..OfO....OfO..",
      "..OOO....OOO..",
    ],
  },
  oc: {
    // Leaf snail: rolled-leaf shell (spiral + stem) on a cream slug
    eyeY: 13,
    eyeW: 3,
    eyeL: 1,
    eyeR: 6,
    mouthY: 17,
    mouthX: 2,
    art: [
      "..........ss..",
      ".........OOO..",
      "........OwwO..",
      "........OfffO.",
      "........OffffO",
      "........OsssfO",
      "........OsffsO",
      "........OsffsO",
      "........OsffsO",
      "........OfssfO",
      "...OOOOOOffffO",
      "..OffffOOOffOO",
      ".OffffffOOOO..",
      "OffffffffO....",
      "OffffffffO....",
      "OffffffffO....",
      "OffffffffO....",
      "OffffffffO....",
      ".OOOOOOOObbbbO",
      "ObbbbbbbbbbbbO",
      "ObbbbbbbbbbbbO",
      ".OOOOOOOOOOOO.",
    ],
  },
  chim: {
    // Thunder chick: round bird, sprout crest, orange beak and legs,
    // wing stubs, chest bolt
    eyeY: 8,
    mouthY: 14,
    blushY: 13,
    blushX: 3,
    art: [
      "......ss......",
      ".....OOOOOO...",
      "...OOffffOO...",
      "..OffffffffO..",
      ".OffffffffffO.",
      "OffffffffffffO",
      "OffffffffffffO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OffffffffffssO",
      "OsffffffffffsO",
      "OssfffffffffsO",
      "OssfffffffffsO",
      "OssfffbbfffssO",
      "OssfffbbfffssO",
      "ObbbbbbbbbbssO",
      "ObbbbbssbbbssO",
      "ObbbbssbbbbssO",
      "ObbbbsbbbbbssO",
      "ObsssssssssssO",
      "....bb....bb..",
      "...bbb....bbb.",
    ],
  },
  suoi: {
    // Water bunny: lop ears down the sides, forehead droplet
    eyeY: 9,
    mouthY: 14,
    blushY: 14,
    blushX: 2,
    art: [
      "...OOOOOOOO...",
      "..OffffffffO..",
      ".OffffffffffO.",
      ".OffffffffffO.",
      "OsffffffffffsO",
      "OsffffkkffffsO",
      "OsffffkkffffsO",
      "OsffffkkffffsO",
      "OsffffffffffsO",
      "OsffffffffffsO",
      "OsffffffffffsO",
      "OsffffffffffsO",
      "OsffffffffffsO",
      "OOffffffffffOO",
      ".OffffffffffO.",
      ".OfffffffffsO.",
      "..ObbbbbbssO..",
      "..ObbbbbbssO..",
      "..ObbbbbbssO..",
      "..OOssssssOO..",
      "..OfO....OfO..",
      "..OOO....OOO..",
    ],
  },
};

// Paint one character through a px(x, y, w, h, color) helper, inside the
// 7x11 box whose top-left is (fx, fy) (feet on its bottom row). Chibi rules
// taken from the research table: dark rim around the silhouette, head ~2/3 of
// the height, two tones per material, big 2x2 eyes with a white highlight, a
// blink every ~3.4s, an idle head-bob (people) or hop (creatures). Fills stay
// inside columns fx+1..fx+5 so the rim and the 7-wide seat footprint hold
const paintChar = (
  px: (x: number, y: number, w: number, h: number, c: string) => void,
  c: CharPreset,
  o: {
    fx: number;
    fy: number;
    dir: Position["dir"];
    sit: boolean;
    walking: boolean;
    step: number;
    lean: number;
    headset: boolean;
    now: number;
  },
) => {
  const blink = o.now % 3400 < 140;
  // One 2x2 eye, white highlight top-left (light from the top-left); a blink
  // squashes it to a 1px closed lid
  const eye = (ex: number, ey: number) => {
    px(ex, ey, 2, blink ? 1 : 2, OUT);
    if (!blink) px(ex, ey, 1, 1, "#fff");
  };
  if (!c.creature) {
    const skin = c.skin || "#f2c7a5";
    const hair = c.hair || "#2b1a12";
    const hairShade = c.hairShade || "#1d1409";
    const shirt = c.shirt || "#5a4cd0";
    const shirtShade = c.shirtShade || "#4338a8";
    const back = o.dir === "u";
    const lift = o.walking ? o.step : 0;
    // Body first so a dipped (idle-bob) head overlaps the collar, not air
    px(o.fx + 1, o.fy + 9, 2, 2 - lift, LEGS);
    px(o.fx + 4, o.fy + 9, 2, 1 + lift, LEGS);
    px(o.fx + 1, o.fy + 6, 5, 3, shirt);
    px(o.fx + 1, o.fy + 8, 5, 1, shirtShade);
    // Long hair drapes over the shirt shoulders
    if (c.style === "long" && !back) {
      px(o.fx + 1, o.fy + 6, 1, 3, hair);
      px(o.fx + 5, o.fy + 6, 1, 3, hair);
    }
    px(o.fx, o.fy + 7, 1, 2, skin); // hands
    px(o.fx + 6, o.fy + 7, 1, 2, skin);
    // Head (leans 1px toward a snuggle neighbour; the body stays put)
    const hx = o.fx + o.lean;
    const bob = !o.walking && !o.sit && Math.floor(o.now / 700) % 2 ? 1 : 0;
    const hy = o.fy + bob;
    px(hx, hy - 1, 7, 1, OUT); // rim over the hair
    px(hx, hy, 1, 6, OUT); // rim beside the face
    px(hx + 6, hy, 1, 6, OUT);
    px(hx + 1, hy, 5, 6, skin);
    px(hx + 1, hy, 5, 2, hair); // fringe
    if (back) {
      px(hx + 1, hy + 2, 5, 4, hair);
      px(hx + 1, hy + 5, 5, 1, hairShade);
    }
    if (c.style === "bob") {
      px(hx + 1, hy, 1, 3, hair);
      px(hx + 5, hy, 1, 3, hair);
    } else if (c.style === "twin") {
      px(hx - 1, hy + 2, 1, 4, hair); // tails past the rim
      px(hx + 7, hy + 2, 1, 4, hair);
      px(hx - 1, hy + 2, 1, 1, shirt); // scrunchies
      px(hx + 7, hy + 2, 1, 1, shirt);
    } else if (c.style === "long") {
      px(hx + 1, hy + 1, 1, 5, hair);
      px(hx + 5, hy + 1, 1, 5, hair);
    } else if (c.style === "spiky") {
      px(hx + 1, hy - 1, 1, 1, hair); // spikes on the rim row
      px(hx + 3, hy - 1, 1, 1, hair);
      px(hx + 5, hy - 1, 1, 1, hair);
      px(hx + 2, hy, 1, 1, hairShade);
      px(hx + 4, hy, 1, 1, hairShade);
    } else if (c.style === "ponytail") {
      px(hx + 6, hy + 1, 1, 6, hair);
      px(hx + 7, hy + 3, 1, 3, hair);
      px(hx + 6, hy + 1, 1, 1, shirt); // tie
    } else if (c.style === "ahoge") {
      px(hx + 3, hy - 1, 1, 1, hair);
    }
    // Face: big eyes, tiny mouth, blush; a profile keeps one eye
    if (!back) {
      if (o.dir === "d") {
        eye(hx + 1, hy + 2);
        eye(hx + 4, hy + 2);
        px(hx + 3, hy + 4, 1, 1, "#b3544a");
        px(hx + 1, hy + 4, 1, 1, BLUSH);
        px(hx + 5, hy + 4, 1, 1, BLUSH);
      } else {
        px(o.dir === "r" ? hx + 1 : hx + 5, hy + 2, 1, 3, hair); // skull side
        eye(o.dir === "r" ? hx + 3 : hx + 1, hy + 2);
        px(o.dir === "r" ? hx + 4 : hx + 2, hy + 4, 1, 1, "#b3544a");
        px(o.dir === "r" ? hx + 2 : hx + 4, hy + 4, 1, 1, BLUSH);
      }
    }
    if (o.headset) {
      px(hx, hy - 1, 7, 1, "#7cf5c8");
      px(hx, hy, 1, 3, "#7cf5c8");
      px(hx + 6, hy, 1, 3, "#7cf5c8");
    }
  } else {
    // Creatures: half-cell sprites from CREATURE_ART (14x22 sub-pixels in
    // the same 7x11 box). They hop while walking, squash-bob when idle (the
    // ghost floats instead), glance 1 sub-pixel toward their facing
    const fur = c.fur || "#f4f0ff";
    const furShade = c.furShade || "#cfc6ec";
    const belly = c.belly || "#fff";
    const accent = c.accent || BLUSH;
    const a = CREATURE_ART[c.creature];
    const fy = o.fy - (o.walking && o.step ? 1 : 0); // hop frame
    const fx = o.fx;
    const back = o.dir === "u";
    // sp paints in sprite coords: one sub-pixel is half a floor cell
    const sp = (x: number, y: number, w: number, h: number, col: string) =>
      px(fx + x / 2, fy + y / 2, w / 2, h / 2, col);
    const pal: Record<string, string> = {
      O: OUT,
      f: fur,
      s: furShade,
      b: belly,
      k: accent,
      w: "#fff",
    };
    // Idle: the body sinks 1 sub-pixel onto its planted feet every other
    // beat (same 700ms rhythm as the people bob); the ghost has no feet,
    // so it floats 1 unit up instead
    const beat = Math.floor(o.now / 700) % 2;
    const bob = c.creature === "ma" ? (beat ? -2 : 0) : beat ? 1 : 0;
    a.art.forEach((row, y) => {
      const dy = y < 20 ? bob : 0; // the bottom 2 rows are the feet
      for (let x = 0; x < 14; x++) {
        const ch = row[x];
        if (ch !== ".") sp(x, y + dy, 1, 1, pal[ch] || fur);
      }
    });
    // Ghost hem: 8 scallops waving under the bell
    if (c.creature === "ma") {
      for (let i = 0; i < 8; i++) {
        const h = ((i + beat) % 2) + 2;
        sp(3 + i, 22 - h + bob, 1, h, fur);
      }
    }
    // Tail (or flame) poking past the right edge of the box, wagging on a
    // 2-frame cycle; tho, ma, oc and chim have none
    const wag = Math.floor(o.now / 400) % 2;
    if (c.creature === "meo") {
      sp(14, 11 + wag * 2 + bob, 2, 6, fur);
      sp(14, 11 + wag * 2 + bob, 2, 2, furShade);
    } else if (c.creature === "cao") {
      sp(14, 12 + wag * 2 + bob, 2, 6, fur);
      sp(14, 12 + wag * 2 + bob, 2, 2, belly);
    } else if (c.creature === "miu") {
      sp(14, 9 + wag * 2 + bob, 2, 5, accent);
      sp(14, 14 + wag * 2 + bob, 2, 2, furShade);
    } else if (c.creature === "suoi") {
      sp(14, 12 + wag * 2 + bob, 2, 4, fur);
    }
    // Face: big glossy eyes (a blink squashes them to a line), blush, tiny
    // mouth; a back view keeps the body and drops the face
    if (!back) {
      const ew = a.eyeW || 4;
      const eh = a.eyeW ? 4 : 5;
      const shift = o.dir === "l" ? -1 : o.dir === "r" ? 1 : 0;
      const seye = (ex: number) => {
        if (blink) {
          sp(ex + shift, a.eyeY + bob + (eh >> 1), ew, 1, OUT);
          return;
        }
        sp(ex + shift, a.eyeY + bob, ew, eh, OUT);
        sp(ex + shift, a.eyeY + bob, 2, 2, "#fff"); // highlight, light top-left
      };
      seye(a.eyeL ?? 2);
      seye(a.eyeR ?? 8);
      const bx = a.blushX ?? 1;
      if (a.blushY !== undefined) {
        sp(bx, a.blushY + bob, 2, 1, BLUSH);
        sp(12 - bx, a.blushY + bob, 2, 1, BLUSH);
      }
      const mx = a.mouthX ?? 6;
      sp(mx, a.mouthY + bob, 2, 1, OUT);
    }
    if (o.headset) {
      px(fx, fy - 1, 7, 1, "#7cf5c8");
      px(fx, fy, 1, 2, "#7cf5c8");
      px(fx + 6, fy, 1, 2, "#7cf5c8");
    }
  }
};

// Emote bubbles over the characters, keys 1-6 (server relays CMD:emote with
// these and only these)
const EMOTES = ["❤️", "😂", "😢", "😮", "👏", "🍿"];

// Scoops in a full popcorn bucket (the server counts what is left)
const POPCORN = 12;

// Seat whose cushion the feet at (x, y) are on, if any
const seatAt = (x: number, y: number) => {
  for (const row of ROWS) {
    if (Math.abs(y - (row + SEAT_H)) > 3) continue;
    for (const sx of SEAT_XS) {
      if (x >= sx && x < sx + SEAT_W) {
        return { x: sx + SEAT_W / 2, y: row + SEAT_H };
      }
    }
  }
  return undefined;
};

// Two characters are snuggling: both sat down, same row, neighbouring seats
// (seat centres are SEAT_W + 1 apart; the aisle is far wider than that)
const isSnuggle = (a: Position, b: Position) =>
  a.sit &&
  b.sit &&
  Math.abs(a.y - b.y) <= 1 &&
  Math.abs(a.x - b.x) >= SEAT_W &&
  Math.abs(a.x - b.x) <= SEAT_W + 2;

const hash = (id: string) =>
  Math.abs(id.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));

// The pixel theater floor under the screen: rows of seats seen from behind and
// one walking character per person. WASD or click/tap to walk; stop on a seat
// to sit. Your own position goes to the room as CMD:move.
export class PixelFloor extends React.Component<{
  participants: User[];
  nameMap: StringDict;
  socket?: Socket;
  lightsDown: boolean;
  // Ticket stubs of the videos that ran to the end here (App keeps them in
  // this device's localStorage and passes the room's list)
  stubs: TicketStub[];
}> {
  canvasRef = React.createRef<HTMLCanvasElement>();
  // Where each character is drawn (remote ones ease toward their target)
  shown: Record<string, Position> = {};
  targets: Record<string, Position> = {};
  walking = new Set<string>();
  // Emote bubble per character: what it says and when it fades (performance.now)
  emotes: Record<string, { value: string; until: number }> = {};
  // Scoops left in the shared popcorn bucket, as the server last said
  scoops = POPCORN;
  // The current walkTo is a walk to the popcorn bucket: grab on arrival
  grabWalk = false;
  // My character preset, remembered on this device (per person, like the
  // name); people who never picked get a stable preset from their clientId
  char = (() => {
    const saved = window.localStorage.getItem("watchparty-char");
    return saved && CHARS.some((c) => c.id === saved)
      ? saved
      : CHARS[hash(clientId) % CHARS.length].id;
  })();
  state = { picker: false };
  // Spawn anywhere along the bottom edge: a narrow corner band would stack
  // two people joining at the same time on top of each other (7-unit-wide
  // characters), garbling their name tags
  me: Position = {
    x: 4 + Math.random() * (W - 8),
    y: H - 2,
    dir: "u",
    sit: false,
  };
  walkTo?: { x: number; y: number };
  keys = new Set<string>();
  lastSent = 0;
  raf = 0;
  last = performance.now();

  componentDidMount() {
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    window.addEventListener("blur", this.clearKeys);
    this.componentDidUpdate({ ...this.props, socket: undefined });
    this.raf = requestAnimationFrame(this.tick);
  }

  componentWillUnmount() {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("blur", this.clearKeys);
    this.props.socket?.off("REC:move", this.onRemoteMove);
    this.props.socket?.off("REC:emote", this.onRemoteEmote);
    this.props.socket?.off("REC:popcorn", this.onRemotePopcorn);
    this.props.socket?.off("connect", this.resend);
    this.props.socket?.off("REC:together", this.onTogether);
    cancelAnimationFrame(this.raf);
  }

  componentDidUpdate(prev: Readonly<PixelFloor["props"]>) {
    // App creates its socket after the first render (and anew on reconnect)
    if (prev.socket !== this.props.socket) {
      prev.socket?.off("REC:move", this.onRemoteMove);
      prev.socket?.off("REC:emote", this.onRemoteEmote);
      prev.socket?.off("REC:popcorn", this.onRemotePopcorn);
      prev.socket?.off("connect", this.resend);
      prev.socket?.off("REC:together", this.onTogether);
      this.props.socket?.on("REC:move", this.onRemoteMove);
      this.props.socket?.on("REC:emote", this.onRemoteEmote);
      this.props.socket?.on("REC:popcorn", this.onRemotePopcorn);
      this.props.socket?.on("REC:together", this.onTogether);
      // The server forgets positions on disconnect: re-announce on reconnect
      this.props.socket?.on("connect", this.resend);
      this.send(true);
    }
    this.syncRoster();
  }

  // Seconds this room has played with 2+ people in it (server counts)
  together = 0;
  onTogether = (seconds: number) => {
    this.together = seconds;
  };

  // The roster carries everyone's last position, so late joiners see where
  // people already are
  syncRoster = () => {
    // Drop people who left; nothing else ever deletes from targets/shown, so
    // without this they ease in the rAF loop forever
    const here = new Set(this.props.participants.map((p) => p.id));
    for (const id of Object.keys(this.targets)) {
      if (!here.has(id)) {
        delete this.targets[id];
        delete this.shown[id];
        this.walking.delete(id);
      }
    }
    for (const p of this.props.participants) {
      if (p.id !== clientId && p.pos && !this.targets[p.id]) {
        this.targets[p.id] = { ...p.pos, x: p.pos.x * W, y: p.pos.y * H };
      }
    }
  };

  onRemoteMove = (data: Position & { id: string }) => {
    this.targets[data.id] = { ...data, x: data.x * W, y: data.y * H };
  };

  // Emote bubble over your character: drawn here right away, the server
  // relays it to everyone else as REC:emote
  emote = (value: string) => {
    this.showEmote(clientId, value);
    this.props.socket?.emit("CMD:emote", value);
  };

  onRemoteEmote = (data: { id: string; value: string }) => {
    this.showEmote(data.id, data.value);
  };

  // The bucket's scoop count, on join (no id) or after someone's grab (own
  // grabs come back too)
  onRemotePopcorn = (data: { id?: string; scoops: number }) => {
    this.scoops = data.scoops;
    if (data.id) this.showEmote(data.id, "🍿");
  };

  showEmote = (id: string, value: string) => {
    if (!EMOTES.includes(value)) return;
    this.emotes[id] = { value, until: performance.now() + 2500 };
  };

  clearKeys = () => this.keys.clear();

  onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    // 1-6: emote bubble over your character; ignore key repeats so holding a
    // key can't flood the room (the server also caps at 5/s)
    const slot = Number(e.key);
    if (
      e.type === "keydown" &&
      !e.repeat &&
      slot >= 1 &&
      slot <= EMOTES.length
    ) {
      // Same rule as App's shortcuts: never steal keys from an input
      if (document.activeElement && document.activeElement.tagName !== "BODY") {
        return;
      }
      this.emote(EMOTES[slot - 1]);
      return;
    }
    if (!["w", "a", "s", "d"].includes(k)) return;
    if (e.type === "keyup") {
      this.keys.delete(k);
      return;
    }
    // Same rule as App's shortcuts: never steal keys from an input
    if (document.activeElement && document.activeElement.tagName !== "BODY") {
      return;
    }
    this.keys.add(k);
    this.walkTo = undefined;
    this.grabWalk = false;
  };

  onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    // Clicking the popcorn bucket walks over and grabs a handful; any other
    // click is a plain walk (and cancels a pending grab)
    this.grabWalk = x >= 0 && x <= 5 && y >= 11 && y <= 17;
    this.walkTo = this.grabWalk
      ? { x: 6, y: 14 }
      : seatAt(x, y + SEAT_H / 2) || seatAt(x, y) || { x, y };
  };

  resend = () => this.send(true);

  send = (force = false) => {
    const now = performance.now();
    if (!force && now - this.lastSent < 100) return;
    this.lastSent = now;
    this.props.socket?.emit("CMD:move", {
      x: this.me.x / W,
      y: this.me.y / H,
      dir: this.me.dir,
      sit: this.me.sit,
      ch: this.char,
    });
  };

  // The preset a character is drawn with: remote ones carry theirs on the
  // move payload (server-validated), mine is this.char; anything unknown
  // (e.g. an id this older tab doesn't know) falls back to a stable pick
  charOf = (id: string, p: Position): CharPreset =>
    CHARS.find((c) => c.id === (p.ch || (id === clientId ? this.char : ""))) ??
    CHARS[hash(id) % CHARS.length];

  // Picking saves to this device and announces it right away
  pick = (id: string) => {
    this.char = id;
    window.localStorage.setItem("watchparty-char", id);
    this.me.ch = id; // shown[clientId] is me: redraw with the new preset now
    this.send(true);
    this.setState({ picker: false });
  };

  // Picker previews use the same painter as the floor: static front pose on
  // a 9x12 canvas (1 unit spare around the 7-wide box for tails/ears)
  paintPreview = (el: HTMLCanvasElement | null, c: CharPreset) => {
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const u = 4;
    // px accepts half-unit coords: creature sprites draw at half-cell detail
    const px = (x: number, y: number, w: number, h: number, col: string) => {
      ctx.fillStyle = col;
      ctx.fillRect(
        (Math.round(x * 2) / 2) * u,
        (Math.round(y * 2) / 2) * u,
        w * u,
        h * u,
      );
    };
    ctx.clearRect(0, 0, el.width, el.height);
    paintChar(px, c, {
      fx: 1,
      fy: 1,
      dir: "d",
      sit: false,
      walking: false,
      step: 0,
      lean: 0,
      headset: false,
      now: 200, // awake, not mid-blink, no idle bob
    });
  };

  tick = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const me = this.me;
    let dx = 0;
    let dy = 0;
    if (this.keys.has("a")) dx -= 1;
    if (this.keys.has("d")) dx += 1;
    if (this.keys.has("w")) dy -= 1;
    if (this.keys.has("s")) dy += 1;
    if (!dx && !dy && this.walkTo) {
      const ex = this.walkTo.x - me.x;
      const ey = this.walkTo.y - me.y;
      if (Math.hypot(ex, ey) < 1) {
        me.x = this.walkTo.x;
        me.y = this.walkTo.y;
        this.walkTo = undefined;
        if (this.grabWalk) {
          this.grabWalk = false;
          this.props.socket?.emit("CMD:popcorn");
        }
      } else {
        dx = ex;
        dy = ey;
      }
    }
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      me.x = Math.min(W - 4, Math.max(4, me.x + (dx / len) * SPEED * dt));
      me.y = Math.min(H - 1, Math.max(11, me.y + (dy / len) * SPEED * dt));
      me.dir =
        Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "l" : "r") : dy < 0 ? "u" : "d";
      me.sit = false;
      this.walking.add(clientId);
      this.send();
    } else if (this.walking.has(clientId)) {
      // Just stopped: sit if standing on a seat, and send the final spot
      this.walking.delete(clientId);
      const seat = seatAt(me.x, me.y);
      if (seat) {
        Object.assign(me, seat, { sit: true, dir: "u" });
      }
      this.send(true);
    }
    // Remote characters ease toward their last reported spot
    for (const [id, t] of Object.entries(this.targets)) {
      const s = (this.shown[id] ||= { ...t });
      s.x += (t.x - s.x) * Math.min(1, dt * 12);
      s.y += (t.y - s.y) * Math.min(1, dt * 12);
      s.dir = t.dir;
      s.sit = t.sit;
      if (Math.hypot(t.x - s.x, t.y - s.y) > 0.3) {
        this.walking.add(id);
      } else {
        this.walking.delete(id);
      }
    }
    this.shown[clientId] = me;
    for (const [id, e] of Object.entries(this.emotes)) {
      if (e.until <= now) delete this.emotes[id];
    }
    this.draw(now);
    this.raf = requestAnimationFrame(this.tick);
  };

  draw = (now: number) => {
    const canvas = this.canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const u = Math.max(2, Math.floor(canvas.clientWidth / W)); // px per unit
    if (canvas.width !== W * u) {
      canvas.width = W * u;
      canvas.height = H * u;
    }
    // px accepts half-unit coords: creature sprites draw at half-cell detail
    const px = (x: number, y: number, w: number, h: number, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(
        (Math.round(x * 2) / 2) * u,
        (Math.round(y * 2) / 2) * u,
        w * u,
        h * u,
      );
    };
    // Carpet with a checker weave, red aisle runner in the middle
    px(0, 0, W, H, "#1a1030");
    for (let y = 0; y < H; y += 2) {
      for (let x = (y / 2) % 2 ? 0 : 2; x < W; x += 4)
        px(x, y, 1, 1, "#22163d");
    }
    px(44, 0, 9, H, "#4a1022");
    for (let y = 0; y < H; y += 4) px(48, y, 1, 2, "#c9a24a");

    // Memory wall: ticket stubs of the videos that ran to the end here,
    // pinned to a board on the back wall (characters draw over it, the way
    // they'd sit in front of it). The stubs live in this device's
    // localStorage — see App.addTicketStub
    px(57, 0, 38, 10, "#c9a24a"); // gold frame
    px(58, 1, 36, 8, "#241536"); // cork
    const stubs = this.props.stubs.slice(-3);
    for (let i = 0; i < stubs.length; i++) {
      const s = stubs[i];
      const x = 60 + i * 11;
      const y = 2;
      px(x, y, 10, 6, "#fff"); // stub paper
      px(x - 1, y + 3, 1, 1, "#241536"); // perforation notches
      px(x + 10, y + 3, 1, 1, "#241536");
      px(x + 4, y, 1, 1, "#c23345"); // pin
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#1b1b1b";
      ctx.font = `bold ${Math.max(8, u * 1.5)}px monospace`;
      // Shorten until it fits on the 10-unit paper
      let label = s.title;
      while (label.length > 1 && ctx.measureText(label).width > 9 * u) {
        label = label.slice(0, -2) + "…";
      }
      ctx.fillText(label, (x + 5) * u, (y + 2.3) * u);
      ctx.font = `${Math.max(7, u * 1.2)}px monospace`;
      ctx.fillStyle = "#c23345";
      ctx.fillText(
        new Date(s.at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        (x + 5) * u,
        (y + 4.6) * u,
      );
    }
    ctx.textBaseline = "alphabetic";

    const users = new Map(this.props.participants.map((p) => [p.id, p]));
    const step = Math.floor(now / 150) % 2;
    const drawChar = ([id, p]: [string, Position]) => {
      const user = users.get(id);
      const x = Math.round(p.x) - 3;
      const top = Math.round(p.y) - 11;
      // Head leans 1px toward a seated neighbour
      let lean = 0;
      for (const q of Object.values(this.shown)) {
        if (q !== p && isSnuggle(p, q)) {
          lean = q.x >= p.x ? 1 : -1;
          break;
        }
      }
      paintChar(px, this.charOf(id, p), {
        fx: x,
        fy: top,
        dir: p.dir,
        sit: p.sit,
        walking: this.walking.has(id),
        step,
        lean,
        headset: !!user?.isVideoChat,
        now,
      });
      // Name tag in real pixels so it stays readable, on a dark plate so two
      // characters sharing a spot keep readable tags (back-to-front draw
      // order puts the closer tag — plate and all — on top)
      const name =
        (user?.buffering ? "⏳ " : "") +
        (this.props.nameMap[id] || id.slice(0, 6));
      ctx.font = `bold ${Math.max(10, u * 2.5)}px monospace`;
      // Seated neighbours: each name grows away from the other so they don't overlap
      ctx.textAlign = lean > 0 ? "right" : lean < 0 ? "left" : "center";
      const tagX = (lean > 0 ? x + 6 : lean < 0 ? x + 1 : x + 3.5) * u;
      const tagW = ctx.measureText(name).width;
      const em = Math.max(10, u * 2.5);
      // Keep the plate on the canvas: at the walls (the popcorn bucket spot
      // sits at x=6) a long centered name would clip off the edge
      const tagOff = lean > 0 ? tagW : lean < 0 ? 0 : tagW / 2;
      const tagL = Math.max(
        0,
        Math.min(W * u - tagW - u * 0.8, tagX - tagOff - u * 0.4),
      );
      ctx.fillStyle = "#241536";
      ctx.fillRect(
        tagL,
        (top - 2) * u - em, // alphabetic baseline: plate from ~1em above it
        tagW + u * 0.8,
        em * 1.25, // down to ~0.25em below it
      );
      ctx.fillStyle = id === clientId ? "#ffe08a" : "#e9e0ff";
      ctx.fillText(name, tagL + tagOff + u * 0.4, (top - 2) * u);
    };
    // Back to front: lower on screen is closer to the viewer, and a seat row
    // hides the legs of whoever sits in it
    const order = Object.entries(this.shown)
      .filter(([id]) => id === clientId || users.has(id))
      .sort((a, b) => a[1].y - b[1].y);
    let i = 0;
    for (const row of ROWS) {
      while (i < order.length && order[i][1].y <= row + SEAT_H) {
        drawChar(order[i++]);
      }
      for (const sx of SEAT_XS) {
        px(sx, row, SEAT_W, SEAT_H, "#8f1d2c"); // velvet seat back
        px(sx, row, SEAT_W, 1, "#c23345");
        px(sx + 1, row + SEAT_H - 1, SEAT_W - 2, 1, "#5e1220");
      }
      // Shared popcorn bucket beside the front row: click it to walk over and
      // grab a handful. Drawn with the row it stands next to, so characters
      // behind it are hidden by it
      if (row === ROWS[0]) {
        px(1, 16, 4, 1, "#120a24"); // shadow on the carpet
        px(1, 14, 4, 2, "#c23345"); // striped bucket
        px(2, 14, 1, 2, "#fff");
        px(4, 14, 1, 2, "#fff");
        const heap = this.scoops > POPCORN / 2 ? 2 : this.scoops > 0 ? 1 : 0;
        if (heap) {
          px(1, 14 - heap, 4, heap, "#fff7e0");
          px(2, 14 - heap, 1, 1, "#f2c7a5");
          px(3, 14 - heap, 1, 1, "#e8c86a");
        }
      }
    }
    while (i < order.length) drawChar(order[i++]);
    if (this.props.lightsDown) {
      ctx.fillStyle = "rgba(5, 3, 12, 0.35)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Emote bubbles over heads, drawn after the dim so they stay readable
    for (const [id, e] of Object.entries(this.emotes)) {
      const p = this.shown[id];
      if (!p) continue;
      const bx = Math.round(p.x) - 3;
      // Clamped so a character at the top edge still shows its bubble
      const by = Math.max(0, Math.round(p.y) - 18);
      px(bx, by, 6, 5, "#241536"); // border
      px(bx + 1, by + 1, 4, 3, "#fff");
      px(bx + 2, by + 5, 1, 1, "#241536"); // tail pointing at the head
      ctx.font = `${Math.max(8, u * 2.5)}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#1b1b1b";
      ctx.fillText(e.value, (bx + 3) * u, (by + 2.5) * u);
    }
    // Snuggle hearts: neighbours who sat down together get a pulsing pixel
    // heart between their heads, drawn after the dim so it stays bright
    const seated = Object.values(this.shown);
    for (let a = 0; a < seated.length; a++) {
      for (let b = a + 1; b < seated.length; b++) {
        if (!isSnuggle(seated[a], seated[b])) continue;
        const hx = Math.round((seated[a].x + seated[b].x) / 2) - 2;
        // Above the name tags (baseline at y - 13), clamped to the canvas
        const hy = Math.max(
          0,
          Math.min(Math.round(seated[a].y), Math.round(seated[b].y)) - 19,
        );
        const c = Math.floor(now / 400) % 2 ? "#ff4d6d" : "#c9184a";
        px(hx + 1, hy, 1, 1, c);
        px(hx + 3, hy, 1, 1, c);
        px(hx, hy + 1, 5, 1, c);
        px(hx + 1, hy + 2, 3, 1, c);
        px(hx + 2, hy + 3, 1, 1, c);
      }
    }
    ctx.textBaseline = "alphabetic";
    if (this.together >= 60) {
      const m = Math.floor(this.together / 60);
      ctx.font = `bold ${Math.max(10, u * 2.5)}px monospace`;
      ctx.textAlign = "left";
      ctx.fillStyle = "#c9a24a";
      ctx.fillText(
        `♥ together ${m >= 60 ? Math.floor(m / 60) + "h " : ""}${m % 60}m`,
        u,
        u * 3,
      );
    }
  };

  render() {
    return (
      <React.Fragment>
        <canvas
          ref={this.canvasRef}
          onClick={this.onClick}
          title="WASD hoặc bấm để đi, dừng trên ghế để ngồi, 1-6 để biểu cảm, bấm xô bắp rang bơ để lấy bắp, nút dưới sàn để đổi nhân vật"
          style={{
            width: "100%",
            // Short enough to leave the screen room on a laptop
            maxWidth: `calc(24vh * ${W / H})`,
            margin: "0 auto",
            aspectRatio: `${W} / ${H}`,
            imageRendering: "pixelated",
            display: "block",
            cursor: "pointer",
          }}
        />
        {/* Touch has no 1-6 keys: tap these instead (hidden on mouse devices) */}
        <div className={styles.emoteRow}>
          {EMOTES.map((e) => (
            <button key={e} type="button" onClick={() => this.emote(e)}>
              {e}
            </button>
          ))}
        </div>
        {/* Character picker: previews are drawn with the same painter as the
            floor; the choice is saved on this device and sent to the room */}
        <div className={styles.charRow}>
          <button
            type="button"
            onClick={() => this.setState({ picker: !this.state.picker })}
          >
            ✦ {this.charOf(clientId, this.me).name}
          </button>
        </div>
        {this.state.picker && (
          <div className={styles.charGrid}>
            {CHARS.map((c) => (
              <button
                key={c.id}
                type="button"
                title={c.name}
                className={this.char === c.id ? styles.charPicked : ""}
                onClick={() => this.pick(c.id)}
              >
                <canvas
                  width={36}
                  height={48}
                  ref={(el) => this.paintPreview(el, c)}
                  style={{ imageRendering: "pixelated" }}
                />
              </button>
            ))}
          </div>
        )}
      </React.Fragment>
    );
  }
}
