import React from "react";
import type { Socket } from "socket.io-client";
import { getColorForStringHex, getOrCreateClientId } from "../../utils/utils";
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
const HAIR = ["#2b1a12", "#5a3720", "#c9a24a", "#1d1d2b"];
const SKIN = "#f2c7a5";

// Emote bubbles over the characters, keys 1-6 (server relays CMD:emote with
// these and only these)
const EMOTES = ["❤️", "😂", "😢", "😮", "👏", "🍿"];

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
    this.props.socket?.off("connect", this.resend);
    this.props.socket?.off("REC:together", this.onTogether);
    cancelAnimationFrame(this.raf);
  }

  componentDidUpdate(prev: Readonly<PixelFloor["props"]>) {
    // App creates its socket after the first render (and anew on reconnect)
    if (prev.socket !== this.props.socket) {
      prev.socket?.off("REC:move", this.onRemoteMove);
      prev.socket?.off("REC:emote", this.onRemoteEmote);
      prev.socket?.off("connect", this.resend);
      prev.socket?.off("REC:together", this.onTogether);
      this.props.socket?.on("REC:move", this.onRemoteMove);
      this.props.socket?.on("REC:emote", this.onRemoteEmote);
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
  };

  onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    // Clicking a seat back walks to that seat's cushion
    this.walkTo = seatAt(x, y + SEAT_H / 2) || seatAt(x, y) || { x, y };
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
    const px = (x: number, y: number, w: number, h: number, c: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x) * u, Math.round(y) * u, w * u, h * u);
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
      const hair = HAIR[hash(id) % 4];
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
      const hx = x + 1 + lean;
      px(hx, top, 5, 2, hair);
      px(hx, top + 2, 5, 3, SKIN);
      if (p.dir === "u") {
        px(hx, top + 2, 5, 2, hair); // back of the head
      } else if (p.dir === "d") {
        px(hx + 1, top + 3, 1, 1, "#1b1b1b");
        px(hx + 3, top + 3, 1, 1, "#1b1b1b");
      } else {
        px(p.dir === "l" ? hx : hx + 4, top + 3, 1, 1, "#1b1b1b");
      }
      px(x, top + 5, 7, 4, "#" + getColorForStringHex(id)); // shirt
      px(x, top + 6, 1, 2, SKIN); // hands
      px(x + 6, top + 6, 1, 2, SKIN);
      const lift = this.walking.has(id) ? step : 0;
      px(x + 1, top + 9, 2, 2 - lift, "#2a2a3a"); // legs
      px(x + 4, top + 9, 2, 1 + lift, "#2a2a3a");
      if (user?.isVideoChat) {
        px(x, top + 1, 1, 3, "#7cf5c8"); // headset
        px(x + 6, top + 1, 1, 3, "#7cf5c8");
      }
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
      ctx.fillStyle = "#241536";
      ctx.fillRect(
        tagX - (lean > 0 ? tagW : lean < 0 ? 0 : tagW / 2) - u * 0.4,
        (top - 1) * u - em, // alphabetic baseline: plate from ~1em above it
        tagW + u * 0.8,
        em * 1.25, // down to ~0.25em below it
      );
      ctx.fillStyle = id === clientId ? "#ffe08a" : "#e9e0ff";
      ctx.fillText(name, tagX, (top - 1) * u);
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
        // Above the name tags (baseline at y - 12), clamped to the canvas
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
          title="WASD hoặc bấm để đi, dừng trên ghế để ngồi, 1-6 để biểu cảm"
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
      </React.Fragment>
    );
  }
}
