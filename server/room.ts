import config from "./config.ts";
import axios from "axios";
import { Server, Socket } from "socket.io";
import { getUser, validateUserToken } from "./utils/firebase.ts";
import { redis, redisCount, redisCountDistinct } from "./utils/redis.ts";
import { getIsSubscriberByUid } from "./utils/stripe.ts";
import { type AssignedVM } from "./vm/base.ts";
import { isPoolRegion } from "./vm/utils.ts";
import { getStartOfDay } from "./utils/time.ts";
import { postgres, updateObject, upsertObject } from "./utils/postgres.ts";
import {
  fetchYoutubeVideo,
  getYoutubeVideoID,
  isYouTube,
} from "./utils/youtube.ts";
//@ts-expect-error
import twitch from "twitch-m3u8";
import { type QueryResult } from "pg";
import { Docker } from "./vm/docker.ts";
import { hasRoomKey } from "./utils/roomKey.ts";

// Stateless pool instance to use for VMs if full management isn't needed
let stateless: Docker | undefined = undefined;
if (!config.VM_MANAGER_CONFIG) {
  stateless = new Docker({
    provider: "Docker",
    isLarge: false,
    region: "US",
    limitSize: 0,
    minSize: 0,
    hostname: config.DOCKER_VM_HOST,
  });
}

// Max number of vBrowsers a single user can have assigned at once
const MAX_VBROWSERS_PER_USER = 2;

// The only emojis accepted for CMD:floatReaction, anything else is dropped
const FLOAT_REACTIONS = ["😂", "❤️", "😮", "😢", "👏", "🔥"];

// Buffer auto-pause recovery: how long the room waits for the stalled member's
// "data is back" report, and how many auto-resumes one stall episode gets (a
// member still offline re-stalls after each and the room re-pauses). 120 s, not
// 30: a paused YouTube embed only re-fetches 16-25 s after its network is back,
// so 30 s dropped the report after a 20 s outage (R17B, 2/6 missed)
const BUFFER_RESUME_WATCH_MS = 120000;
const BUFFER_RESUME_MAX_ATTEMPTS = 2;

// The only hostnames a CMD:siteUrl may announce: the streaming sites members'
// extensions watch, so the room can offer others "follow". Subdomains count
// (www.netflix.com); lookalike suffixes (evillnetflix.com) don't
const SITE_URL_HOSTS = [
  "netflix.com",
  "youtube.com",
  "disneyplus.com",
  "primevideo.com",
  "amazon.com",
];

// How long a dropped sharer's socket keeps the room's share alive before it
// counts as dead (tab closed / crash). Covers a network blip: the client
// reconnects within seconds of the link returning and re-announces
const SHARER_GRACE_MS = 10_000;

// How long a departed visitor's in-memory session claim (sessionMap) stays
// kept. It must outlive them — deleting it on disconnect would let an
// onlooker claim their clientId with their own secret — but not the room's
// whole life: a permanent room with rotating visitors grew one entry per
// visitor forever (measured 1000 join/leave cycles = 1000 stale entries).
// 7 days matches the redis claim's TTL above; swept entries re-claim on the
// real client's next connect (their own secret), an attacker cannot.
// Overridable via env for a fast leak test (r161 measured with 5000)
const SESSION_TTL_MS = Number(config.SESSION_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

// Media values only the server sets: vbrowser:// carries a VM's password and
// host (startVBrowser), screenshare:// / fileshare:// name the sharer
// (joinScreenSharing / resumeSharing). Sent by a client (CMD:host, playlist,
// createRoom preload) they pointed every member's player at a host of the
// sender's choosing, or made another member the "sharer"
export const isServerOnlyMedia = (media: string) =>
  /^(vbrowser|screenshare|fileshare):\/\//.test(media);

// Positions (CMD:ts / CMD:seek) beyond ~115 days are garbage: CMD:ts only
// ever raises videoTS, so one 1e308 froze every late joiner at the end
const MAX_MEDIA_SECONDS = 1e7;

// The YouTube Data API key has a daily quota (videos.list 1 unit, search 100,
// 10,000/day) shared by every room: one member spamming playlist adds at the
// 25/s relay cap spent it in minutes (measured 100 adds = 100 lookups). Past
// this budget an item is added untitled, the same fallback as a failed lookup.
// ponytail: one process-wide window; per-room budgets if titles go missing
// for normal use
const YT_LOOKUPS_PER_10_MIN = 60;
let ytLookupTimes: number[] = [];
const allowYoutubeLookup = () => {
  const now = Date.now();
  ytLookupTimes = ytLookupTimes.filter((t) => now - t < 10 * 60 * 1000);
  if (ytLookupTimes.length >= YT_LOOKUPS_PER_10_MIN) {
    return false;
  }
  ytLookupTimes.push(now);
  return true;
};

// Extend the interface
declare module "socket.io" {
  interface Socket {
    clientId: string;
    uid: string;
    isSub: boolean;
  }
}

export class Room {
  // Serialized state
  public video: string | null = "";
  public videoTS = 0;
  public subtitle = "";
  public playbackRate = 1;
  public paused = false;
  public loop = false;
  private chat: ChatMessage[] = [];
  private nameMap: StringDict = {};
  private pictureMap: StringDict = {};
  public vBrowser: AssignedVM | undefined = undefined;
  public creator: string | undefined = undefined; // email of the user who created the room (just used for stats)
  public lock: string | undefined = undefined; // uid of the user who locked the room
  public playlist: PlaylistVideo[] = [];

  // Non-serialized state
  public roomId: string;
  public roster: User[] = [];
  private lastTsMap = Date.now();
  private tsMap: NumberDict = {};
  private io: Server;
  private socketIdMap: StringDict = {};
  // clientId -> per-page-load id from the handshake (r220, see getRosterForApp)
  private pageIdMap: StringDict = {};
  // clientId -> sessionId secret. In-memory version of the redis session map,
  // so clientId spoofing is also blocked when redis isn't configured.
  // lastSeen drives the TTL sweep below (entries expire after SESSION_TTL_MS)
  private sessionMap: {
    [clientId: string]: { sessionId: string; lastSeen: number };
  } = {};
  // Counts the 1s tsInterval ticks so the session sweep runs once a minute
  private sessionTick = 0;
  // clientId -> timestamps of the float reactions they sent in the last second
  private floatReactionTimes: { [clientId: string]: number[] } = {};
  // clientId -> true while that viewer reports being stuck buffering
  private bufferingMap: BooleanDict = {};
  // the subset of bufferingMap that may auto-pause the room: in a locked room
  // only the lock holder's claims count (a guest's still shows in the roster)
  private bufferPauseMap: BooleanDict = {};
  // clientId -> timestamps of accepted buffering changes in the last second
  private bufferingChangeTimes: { [clientId: string]: number[] } = {};
  // The active intermission ("BRB"): who started it and when it ends
  // (until null = no end time). In-memory only
  public intermission: { by: string; until: number | null } | null = null;
  // clientId -> timestamps of accepted intermission changes in the last second
  private intermissionTimes: { [clientId: string]: number[] } = {};
  // Sleep timer: pauses the room for the night if nobody answers the
  // "still watching?" check within a minute of the deadline. askedAt is
  // when that check began (0 until it does). In-memory only, like
  // intermission
  public sleepTimer: {
    by: string;
    at: number;
    askedAt: number;
    asking: boolean;
  } | null = null;
  // clientId -> timestamps of accepted sleep-timer changes in the last second
  private sleepTimes: { [clientId: string]: number[] } = {};
  // clientId -> timestamps of accepted broadcast/relay events (chat, seek,
  // host, roster updates, playlist, reactions) in the last second. One shared
  // budget: every accepted event makes the server emit to the room, and a
  // legit client only ever sends a handful per second
  private relayTimes: { [clientId: string]: number[] } = {};
  // clientId -> timestamps of accepted picture changes in the last minute.
  // A login sets the avatar once, so a legit client sends a handful per
  // minute at most; every accepted picture re-broadcasts the whole map
  // (up to 10KB per member) to everyone, so the shared 25/s relay budget
  // still let one client push ~220KB/s into every peer's socket
  private pictureTimes: { [clientId: string]: number[] } = {};
  // clientId -> timestamps of relayed WebRTC signaling in the last second.
  // Own, higher budget: connection setup trickles dozens of candidates
  private signalTimes: { [clientId: string]: number[] } = {};
  // clientId -> timestamps of accepted typing notices in the last second
  private typingTimes: { [clientId: string]: number[] } = {};
  // clientId -> timestamps of accepted site-url announcements in the last 5s.
  // A legit extension announces when its member opens a new title, not a stream
  private siteUrlTimes: { [clientId: string]: number[] } = {};
  // The last announced streaming title (CMD:siteUrl): who sent it and the url,
  // so a new joiner can be offered "follow". In-memory only, like intermission
  public siteUrl: { by: string; url: string } | null = null;
  // "One person drives" mode (CMD:extControl): the clientId currently holding
  // playback control, or null when it is free. In-memory only, like siteUrl
  public extController: string | null = null;
  // clientId -> timestamps of accepted control take/release toggles in the last second
  private extControlTimes: { [clientId: string]: number[] } = {};
  private tsInterval: NodeJS.Timeout | undefined = undefined;
  // Fires when a stalled viewer needs the room paused so nobody watches ahead
  private bufferPauseTimer: NodeJS.Timeout | undefined = undefined;
  // Who the last buffer auto-pause paused the room for: once every one of them
  // has sent CMD:buffering false (sent once they have data buffered again) or
  // left, the room resumes. null when a person paused, or the watch fired /
  // expired / was cancelled
  private bufferResumeWatch: { clientIds: string[]; pausedAt: number } | null =
    null;
  // Auto-resumes since the last manual play / new media (cap above)
  private bufferResumeAttempts = 0;
  // Ends a dead sharer's share (round 44) after a grace window: a network
  // blip can drop the sharer's socket while their capture keeps running, and
  // they re-announce with CMD:resumeShare when the socket comes back
  private sharerGraceTimer: NodeJS.Timeout | undefined = undefined;
  public isChatDisabled: boolean | undefined = undefined;
  public lastUpdateTime: Date = new Date();
  private preventTSUpdate = false;
  // Not really a queue since there's no ordering, we just retry as long as this is set
  // If we want a real queue then we need external processing of the jobs and a way to update the room from outside
  public vBrowserQueue:
    | {
        roomId: string;
        queueTime: Date;
        isLarge: boolean;
        region: string;
        uid: string;
        clientId: string;
      }
    | undefined = undefined;

  constructor(
    io: Server,
    roomId: string,
    roomData?: string | null | undefined,
  ) {
    this.roomId = roomId;
    this.io = io;

    if (roomData) {
      this.deserialize(roomData);
    }

    this.tsInterval = setInterval(async () => {
      // console.log(roomId, this.video, this.roster, this.tsMap, this.nameMap);
      // Sleep timer: at the deadline, ask "still watching?" for one minute;
      // no answer means everyone dozed off, so pause for the night. A pause
      // spanning the deadline must not kill the timer (someone pressing play
      // afterwards would keep it playing all night): it stays armed and the
      // check begins on the first tick the room is playing again
      if (
        this.sleepTimer &&
        !this.sleepTimer.asking &&
        Date.now() >= this.sleepTimer.at
      ) {
        if (!this.paused) {
          this.sleepTimer.asking = true;
          // Measure the answer window from the ask, not the deadline, so a
          // late resume always gets the full minute
          this.sleepTimer.askedAt = Date.now();
          this.io.of(this.roomId).emit("REC:sleep", this.sleepTimer);
        }
      }
      if (
        this.sleepTimer &&
        this.sleepTimer.asking &&
        Date.now() >= this.sleepTimer.askedAt + 60000
      ) {
        const by = this.sleepTimer.by;
        this.sleepTimer = null;
        this.io.of(this.roomId).emit("REC:sleep", null);
        this.paused = true;
        // The room pause means nobody is falling behind; drop any pending one
        this.clearBufferPause();
        this.bufferResumeWatch = null;
        this.io.of(this.roomId).emit("REC:pause");
        // REC:pause unstalls every player, so stale stuck claims must not
        // re-pause the room after someone wakes up and presses play (same
        // consumption as the buffer auto-pause below)
        this.bufferingMap = {};
        this.bufferPauseMap = {};
        this.io.of(this.roomId).emit("roster", this.getRosterForApp());
        this.addChatMessage(null, {
          id: by,
          cmd: "sleepFire",
          msg: Math.round(this.videoTS).toString(),
        });
      }
      // Clean up the data of users who aren't in the room anymore
      const memberIds = this.roster.map((p) => p.id);
      Object.keys(this.tsMap).forEach((key) => {
        if (!memberIds.includes(key)) {
          delete this.tsMap[key];
        }
      });
      // Expire stale session claims once a minute: the room's tick already
      // runs every second, so piggyback the sweep on every 60th pass
      this.sessionTick = (this.sessionTick + 1) % 60;
      if (this.sessionTick === 0) {
        const cutoff = Date.now() - SESSION_TTL_MS;
        Object.keys(this.sessionMap).forEach((id) => {
          if (this.sessionMap[id].lastSeen < cutoff) {
            delete this.sessionMap[id];
          }
        });
      }
      if (this.video) {
        this.lastTsMap = Date.now();
        // This 1 s broadcast is the client sync heartbeat while the room
        // PLAYS: App.tsx only consumes tsMap ticks when !roomPaused (sync
        // pbr, catch-up chip, auto-resync), and every viewer's entry moves
        // each tick while playing. A paused room — the state overnight and
        // BRB rooms sit in for hours — rebuilt an identical map every tick
        // and still broadcast it: measured 8 frames/s (~3.4 KB/s) for a
        // paused 8-member room. Skip it while paused; the join-time and
        // cmdHost emits still fire, so a joiner keeps their snapshot, and
        // the first tick after a resume broadcasts again.
        if (!this.paused) {
          io.of(roomId).emit("REC:tsMap", this.tsMap);
        }
      }
    }, 1000);

    io.of(roomId).use(async (socket, next) => {
      try {
        // Cap concurrent connections on this process. Join bursts broadcast
        // roster to every socket (O(n²) frames), so one client opening
        // thousands of sockets with a valid roomKey would stall every room
        // sharing this server long before the heap fills. The joining client
        // is already counted, so reject when the room is at the cap.
        const maxConnections = Number(config.MAX_CONNECTIONS);
        if (maxConnections && io.engine.clientsCount >= maxConnections) {
          next(new Error("Server full"));
          return;
        }
        if (!hasRoomKey(socket.handshake.auth.roomKey)) {
          next(new Error("roomKey"));
          return;
        }
        // The engine connection's query is fixed when the transport opens: a
        // socket.io client that multiplexes a second room namespace over an
        // existing engine arrives here with handshake.query still naming the
        // FIRST room, so registering the query clientId below (measured round
        // 79) would hand the second client the first user's identity — roster,
        // voice and share actions under their id — with no session proof. The
        // client always sends a roomId matching the namespace it connects to;
        // reject anything else
        if (socket.handshake.query?.roomId !== this.roomId.slice(1)) {
          next(new Error("roomId does not match the namespace"));
          return;
        }
        if (postgres) {
          const result = await postgres.query(
            `SELECT password, owner, "isSubRoom" FROM room where "roomId" = $1`,
            [this.roomId],
          );
          const password = socket.handshake.query?.password;
          // Check if user has the password
          const roomPassword = result.rows[0]?.password;
          if (roomPassword && password !== roomPassword) {
            next(new Error("password"));
            return;
          }
          // Check if room is at capacity
          const isSubRoom = result.rows[0]?.isSubRoom;
          const roomCapacity = isSubRoom
            ? config.ROOM_CAPACITY_SUB
            : config.ROOM_CAPACITY;
          // A client that's already in the roster (e.g. reconnecting after a network drop
          // before the old socket timed out) doesn't take an additional slot
          const queryClientId = socket.handshake.query?.clientId;
          const isReconnect =
            typeof queryClientId === "string" &&
            this.roster.some((user) => user.id === queryClientId);
          if (
            roomCapacity &&
            !isReconnect &&
            this.roster.length >= roomCapacity
          ) {
            next(new Error("This room is full"));
            return;
          }
        }
        // clientId is meant for things that shouldn't require login
        // Anything sensitive (e.g. subscriber features, room lock) should be validated with uid and require login
        // vbrowser controller, identify chat messages, video chat/screenshare signaling
        // Used as keys for ephemeral room state (e.g. name, picture, timestamp)

        // redis-based clientId spoof protection (session)
        // Keep a map of clientIds to sessionIDs (a secret generated by client and stored in localstorage)
        // If a clientId already exists in map, a matching sessionId must be provided, otherwise fail
        // Otherwise, store it with some expiry
        // Refresh the expiry on each successful connection
        // Attacker can't spoof unless the user doesn't connect for a long time

        // ALTERNATIVE: using crypto?
        // What if we send back the client an encrypt or hmac of their clientID?
        // Client can store in localstorage
        // Can't be spoofed without the server's encryption key
        // Attacker could try to bruteforce the key by trying all possibilities
        // Client sends both the clear clientId and the hmac
        // During transition, accept requests with no hmac
        // We would need to turn on enforcement after a while (after all clients have updated)
        // On connection, compute hmac of clear clientId and verify it matches what client sent
        // We can accept query param clientHmac?

        const clientId = socket.handshake.query?.clientId;
        const sessionId = socket.handshake.auth.sessionId;
        if (typeof clientId !== "string") {
          next(new Error("Invalid clientId type"));
          return;
        }
        // validate clientId is UUID, prevents prototype pollution
        if (!isValidUUID(clientId)) {
          next(new Error("Invalid clientId format"));
          return;
        }
        // clientIds are visible to everyone in the room, so a session secret is mandatory,
        // otherwise anyone could connect as (and kick) another user
        if (
          typeof sessionId !== "string" ||
          sessionId.length < 16 ||
          sessionId.length > 200
        ) {
          next(new Error("Missing or invalid sessionId"));
          return;
        }
        // The first connection of a clientId claims its sessionId; later ones must match.
        // Lives only as long as the room is in memory, so it never outlasts the redis claim
        if (this.sessionMap[clientId] === undefined) {
          this.sessionMap[clientId] = { sessionId, lastSeen: Date.now() };
        } else if (this.sessionMap[clientId].sessionId !== sessionId) {
          next(new Error("Incorrect sessionId"));
          return;
        } else {
          // Same client back again: their claim stays fresh
          this.sessionMap[clientId].lastSeen = Date.now();
        }
        if (redis) {
          const key = "session:" + clientId;
          const ttlSeconds = 60 * 60 * 24 * 7;
          // Atomically claim the clientId if nobody has yet (avoids a get/set race)
          const claimed = await redis.set(
            key,
            sessionId,
            "EX",
            ttlSeconds,
            "NX",
          );
          if (!claimed) {
            // Already claimed, passed ID must match
            const savedSession = await redis.get(key);
            if (savedSession !== sessionId) {
              next(new Error("Incorrect sessionId"));
              return;
            }
            // Refresh expiry
            await redis.expire(key, ttlSeconds);
          }
        }

        // Disconnect other sockets with this clientId. The kicked socket gets
        // the same "back to home" flow as an owner kick: that's the second tab
        // of the same browser (localStorage identity), not a dropped
        // connection — reconnects kick a transport that is already dead, so
        // the emit never reaches the reconnecting client
        const superseded = this.socketIdMap[clientId]
          ? io.of(roomId).sockets.get(this.socketIdMap[clientId])
          : undefined;
        // Assign the map FIRST (r92): .disconnect() runs the old socket's
        // onDisconnect synchronously, and that handler only skips cleanup when
        // its socket is no longer the one in socketIdMap — disconnecting
        // before the reassign would delete the roster entry (voice/mute flags
        // with it) instead of leaving it to the reconnecting socket
        this.socketIdMap[clientId] = socket.id;
        const pageId = socket.handshake.query?.pageId;
        // Relayed in every roster frame; the client's id is ~10 chars
        if (typeof pageId === "string" && pageId.length <= 64) {
          this.pageIdMap[clientId] = pageId;
        } else {
          delete this.pageIdMap[clientId];
        }
        if (superseded) {
          superseded.emit("kicked");
          superseded.disconnect();
        }
        if (!this.roster.find((user) => user.id === clientId)) {
          this.roster.push({ id: clientId });
        }

        next();
      } catch (e) {
        // e.g. the DB or Redis is unavailable, refuse the connection instead of leaving it hanging
        console.warn("socket auth failed for room %s:", this.roomId, e);
        next(new Error("Internal error"));
      }
    });
    io.of(roomId).on("connection", async (socket: Socket) => {
      const clientId = socket.handshake.query?.clientId;
      if (typeof clientId !== "string") {
        // We already validated in middleware above, this is just to satisfy TS
        return;
      }

      redisCount("connectStarts");
      redisCountDistinct("connectStartsDistinct", clientId);

      socket.emit("REC:host", this.getHostState());
      socket.emit("REC:nameMap", this.nameMap);
      socket.emit("REC:pictureMap", this.pictureMap);
      socket.emit("REC:tsMap", this.tsMap);
      socket.emit("REC:lock", this.lock);
      if (this.extController) {
        socket.emit("REC:extControl", { id: this.extController });
      }
      socket.emit("REC:intermission", this.intermission);
      socket.emit("REC:sleep", this.sleepTimer);
      socket.emit("chatinit", this.chat);
      socket.emit("playlist", this.playlist);
      if (this.siteUrl) {
        socket.emit("REC:siteUrl", {
          id: this.siteUrl.by,
          url: this.siteUrl.url,
        });
      }
      this.getRoomState(socket);
      io.of(roomId).emit("roster", this.getRosterForApp());

      socket.clientId = clientId;
      socket.uid = "";
      socket.isSub = false;

      // Check if this socket matches this.lock UID
      const validateLock = () => {
        return !this.lock || socket.uid === this.lock;
      };

      // "One person drives" mode (CMD:extControl): while a controller is set, only their
      // play / pause / seek / speed commands pass; everyone else's are dropped, web app
      // members included — one person drives. CMD:buffering stays open to all; CMD:ts
      // still records every member's position, but only a member who may drive moves
      // the room position (mayDriveTs)
      const extCtlAllows = () =>
        !this.extController || socket.clientId === this.extController;

      // Who may move the room position with CMD:ts (videoTS — what joiners and
      // CMD:askHost get): the same lock + controller gate as CMD:seek. The lock
      // is a uid that outlives its holder's disconnect (see `lock` above), so
      // while no connected member carries the lock uid the lock part falls
      // open — otherwise nobody could move the position again. Everyone's
      // tsMap entry is still recorded either way (roster / sync heartbeat)
      const mayDriveTs = () =>
        (validateLock() || !this.lockHolderPresent()) && extCtlAllows();

      // Check if this socket matches the room owner UID
      const validateOwner = async () => {
        if (!postgres) {
          // Without a database there is no owner model, so nobody gets owner powers
          // (otherwise `!owner` below is always true and any guest could kick)
          return false;
        }
        const result = await postgres.query(
          'SELECT owner FROM room where "roomId" = $1',
          [this.roomId],
        );
        const owner = result?.rows[0]?.owner;
        return !owner || socket.uid === owner;
      };

      // Handlers run on untrusted input. Contain any throw/rejection so one bad
      // message can't crash the whole process (and every room with it).
      const on = (event: string, handler: (...args: any[]) => unknown) => {
        socket.on(event, async (...args: any[]) => {
          try {
            await handler(...args);
          } catch (e) {
            console.warn("[%s] handler failed:", event, e);
          }
        });
      };

      // Shared per-socket gate for every handler that broadcasts or relays
      // data: returns false once the socket sent `cap` of them in the last
      // second, so one flooded client can't make the server emit unbounded
      const allowRelay = (
        cap = 25,
        map: { [clientId: string]: number[] } = this.relayTimes,
        windowMs = 1000,
      ) => {
        const now = Date.now();
        const times = (map[socket.clientId] || []).filter(
          (t) => now - t < windowMs,
        );
        if (times.length >= cap) {
          return false;
        }
        times.push(now);
        map[socket.clientId] = times;
        return true;
      };

      on(
        "CMD:name",
        (data: unknown) =>
          allowRelay() && this.changeUserName(socket, String(data)),
      );
      on(
        "CMD:picture",
        (data: unknown) =>
          allowRelay(3, this.pictureTimes, 60000) &&
          this.changeUserPicture(socket, String(data)),
      );
      on("CMD:uid", async (raw: unknown) => {
        // A login happens once per session; uncapped, each call costs a
        // Firebase token verification (and, with postgres, a subscriber query)
        if (!allowRelay()) {
          return;
        }
        let data = raw as { uid: string; token: string };
        // Called when the user logs in, sets the socket's auth state
        if (!data || !data.uid || !data.token) {
          return;
        }
        const decoded = await validateUserToken(data.uid, data.token);
        if (decoded?.uid) {
          // This socket is now confirmed to be this UID
          socket.uid = decoded?.uid;
        }
        const isSubscriber = await getIsSubscriberByUid(decoded?.uid);
        if (isSubscriber) {
          socket.isSub = true;
        }
      });
      on("CMD:host", (data: unknown) => {
        // String(undefined) used to host the literal "undefined"
        typeof data === "string" &&
          validateLock() &&
          allowRelay() &&
          this.startHosting(socket, data);
      });
      on("CMD:play", () => {
        validateLock() && extCtlAllows() && allowRelay() && this.playVideo(socket);
      });
      on("CMD:pause", () => {
        validateLock() && extCtlAllows() && allowRelay() && this.pauseVideo(socket);
      });
      on("CMD:seek", (data: unknown) => {
        validateLock() && extCtlAllows() && allowRelay() && this.seekVideo(socket, data);
      });
      on("CMD:playbackRate", (data: unknown) => {
        validateLock() && extCtlAllows() && allowRelay() && this.setPlaybackRate(socket, data);
      });
      on("CMD:loop", (data: unknown) => {
        validateLock() && allowRelay() && this.setLoop(data);
      });
      on("CMD:ts", (data: unknown) =>
        this.setTimestamp(socket, data, mayDriveTs()),
      );
      on(
        "CMD:chat",
        (data: unknown) =>
          allowRelay() && this.sendChatMessage(socket, String(data)),
      );
      on(
        "CMD:chatV2",
        (data: unknown) => allowRelay() && this.sendChatMessage(socket, data),
      );
      on(
        "CMD:addReaction",
        (data: unknown) => allowRelay() && this.addReaction(socket, data),
      );
      on("CMD:removeReaction", (data: unknown) => {
        allowRelay() && this.removeReaction(socket, data);
      });
      on("CMD:floatReaction", (data: unknown) =>
        this.floatReaction(socket, data),
      );
      // Pauses the room like CMD:pause, so it needs the lock like CMD:pause
      on(
        "CMD:intermission",
        (data: unknown) => validateLock() && this.setIntermission(socket, data),
      );
      // Scheduling the sleep timer pauses the room later, so that needs the
      // lock like CMD:pause; answering the check / cancelling it (0) is open
      // to everyone because it only prevents a pause
      on("CMD:sleep", (data: unknown) =>
        this.setSleepTimer(socket, data, validateLock()),
      );
      on("CMD:joinVideo", () => {
        allowRelay() && this.joinVideo(socket);
      });
      on("CMD:leaveVideo", () => {
        allowRelay() && this.leaveVideo(socket);
      });
      on("CMD:joinScreenShare", (data) => {
        validateLock() && allowRelay() && this.joinScreenSharing(socket, data);
      });
      on("CMD:userMute", (data: unknown) => {
        allowRelay() && this.setUserMute(socket, data);
      });
      on("CMD:leaveScreenShare", () => {
        allowRelay() && this.leaveScreenSharing(socket);
      });
      // The slow path (room media empty) re-hosts via cmdHost, so it changes
      // room media and needs the lock like CMD:host
      on("CMD:resumeShare", (data: unknown) =>
        validateLock() && allowRelay() && this.resumeSharing(socket, data),
      );
      on("CMD:startVBrowser", (data: unknown) => {
        // Rate gate like the sibling handlers: a flooded socket must not get a
        // Firebase getUser / redis / postgres round trip per message
        validateLock() && allowRelay() && this.startVBrowser(socket, data);
      });
      on("CMD:stopVBrowser", () => {
        validateLock() && this.stopVBrowser();
      });
      on("CMD:changeController", (data: unknown) => {
        validateLock() && allowRelay() && this.changeController(String(data));
      });
      on("CMD:subtitle", (data: unknown) => {
        // String(null) stored and broadcast "null" as the room's subtitle (R16H)
        typeof data === "string" &&
          validateLock() &&
          allowRelay() &&
          this.addSubtitles(data);
      });
      on("CMD:lock", async (data: unknown) => {
        // Rate gate before the owner check: a flooded socket must not get a
        // postgres query per message (same result for an allowed call)
        const hasLock = validateLock();
        allowRelay() &&
          (hasLock || (await validateOwner())) &&
          this.lockRoom(socket, data);
      });
      // Arming the buffer auto-pause pauses the room like CMD:pause, so it
      // needs the lock like CMD:pause (CMD:sleep passes the same check);
      // a guest's buffering is still recorded and shown in the roster
      on("CMD:buffering", (data: unknown) =>
        this.setBuffering(socket, data, validateLock()),
      );
      // Typing indicator from the browser extension: relayed to the other
      // members only, never stored, no chat line
      on("CMD:typing", (data: unknown) => {
        if (typeof data !== "boolean") {
          return;
        }
        if (allowRelay(3, this.typingTimes, 1000)) {
          socket.broadcast.emit("REC:typing", {
            id: socket.clientId,
            typing: data,
          });
        }
      });
      // The streaming title a member's extension is on (e.g.
      // https://www.netflix.com/watch/81234567), so the room can offer others
      // "follow". Validated against SITE_URL_HOSTS, stored on the room for
      // late joiners, broadcast to the whole namespace (sender included)
      on("CMD:siteUrl", (data: unknown) => {
        if (typeof data !== "string" || data.length > 300) {
          return;
        }
        let parsed: URL;
        try {
          parsed = new URL(data);
        } catch {
          return;
        }
        if (
          parsed.protocol !== "https:" ||
          !SITE_URL_HOSTS.some(
            (host) =>
              parsed.hostname === host ||
              parsed.hostname.endsWith("." + host),
          )
        ) {
          return;
        }
        if (!allowRelay(2, this.siteUrlTimes, 5000)) {
          return;
        }
        this.siteUrl = { by: socket.clientId, url: data };
        io.of(roomId).emit("REC:siteUrl", { id: socket.clientId, url: data });
      });
      // "One person drives" toggle (extension round 4B): true = I take playback control,
      // false = I release it. No stealing — control can only be taken when it is free
      // (or when the current holder is no longer in the roster); releasing only works
      // for the controller. Broadcast to the whole namespace on change, so every panel
      // shows who drives and mutes its own playback emits; sent to new connections too
      on("CMD:extControl", (data: unknown) => {
        if (typeof data !== "boolean") {
          return;
        }
        if (!allowRelay(3, this.extControlTimes, 1000)) {
          return;
        }
        if (data) {
          const held = this.extController;
          if (
            held &&
            held !== socket.clientId &&
            this.roster.some((user) => user.id === held)
          ) {
            return;
          }
        } else if (this.extController !== socket.clientId) {
          return;
        }
        const next = data ? socket.clientId : null;
        if (this.extController === next) {
          return;
        }
        this.extController = next;
        io.of(roomId).emit("REC:extControl", { id: this.extController });
      });
      on("CMD:askHost", () => {
        // Same per-socket cap as every relaying handler: uncapped, a member
        // could have the server serialize a 60 KB host state 300x in a burst
        allowRelay() && socket.emit("REC:host", this.getHostState());
      });
      on("CMD:getRoomState", () => allowRelay() && this.getRoomState(socket));
      on("CMD:setRoomState", async (data: unknown) => {
        // Rate gate before the owner check (same reason as CMD:lock): a
        // flooded socket must not get a postgres query per message
        allowRelay() &&
          (await validateOwner()) &&
          this.setRoomState(socket, data);
      });
      on("CMD:setRoomOwner", async (data: unknown) => {
        allowRelay() &&
          (await validateOwner()) &&
          this.setRoomOwner(socket, data);
      });
      on("CMD:playlistNext", (data: unknown) => {
        // The client only ever sends the ended video's url. An empty/missing
        // payload would skip playlistNext's url validation entirely and force
        // the list forward, so it is rejected here; the server's own
        // auto-advance calls playlistNext(null) directly, never this handler.
        // A non-string ({x:1} -> "[object Object]") skipped the url match
        // whenever no video was hosted and advanced the list (R16H)
        typeof data === "string" &&
          !!data &&
          validateLock() &&
          allowRelay() &&
          this.playlistNext(data);
      });
      on("CMD:playlistAdd", (data: unknown) => {
        validateLock() &&
          allowRelay() &&
          this.playlistAdd(socket, String(data));
      });
      on("CMD:playlistMove", (data: unknown) => {
        validateLock() && allowRelay() && this.playlistMove(data);
      });
      on("CMD:playlistDelete", (data: unknown) => {
        validateLock() && allowRelay() && this.playlistDelete(data);
      });
      on("CMD:kickUser", async (data: unknown) => {
        allowRelay() && (await validateOwner()) && this.kickUser(data);
      });
      on("CMD:deleteChatMessages", async (data: unknown) => {
        allowRelay() &&
          (await validateOwner()) &&
          this.deleteChatMessages(data);
      });

      // Signaling is unicast to one peer and bursts during connection setup
      // (ICE trickling), so it gets its own higher budget. Real frames are
      // small (an SDP offer ~5KB, an ICE candidate ~200B); at the old 100/s ×
      // 100KB budget a member measured 6.1 MB/s unicast into one victim's
      // socket, so the size cap is cut to 20KB (4× the largest real frame). The
      // rate stays 100/s: a sharer signals every viewer from this one budget
      on(
        "signal",
        (data: unknown) =>
          allowRelay(100, this.signalTimes) &&
          this.sendSignal(socket, data, "signal"),
      );
      on(
        "signalSS",
        (data: unknown) =>
          allowRelay(100, this.signalTimes) &&
          this.sendSignal(socket, data, "signalSS"),
      );

      on("disconnect", () => this.onDisconnect(socket));
    });
  }

  public serialize = () => {
    // Get the set of IDs with messages in chat
    // Only serialize roster and picture ID for those people, to save space
    const chatIDs = new Set(this.chat.map((msg) => msg.id));
    const abbrNameMap: StringDict = {};
    Object.keys(this.nameMap).forEach((id) => {
      if (chatIDs.has(id)) {
        abbrNameMap[id] = this.nameMap[id];
      }
    });
    const abbrPictureMap: StringDict = {};
    Object.keys(this.pictureMap).forEach((id) => {
      if (chatIDs.has(id)) {
        abbrPictureMap[id] = this.pictureMap[id];
      }
    });
    return JSON.stringify({
      video: this.video,
      videoTS: this.videoTS,
      subtitle: this.subtitle,
      playbackRate: this.playbackRate,
      paused: this.paused,
      chat: this.chat,
      nameMap: abbrNameMap,
      pictureMap: abbrPictureMap,
      vBrowser: this.vBrowser,
      lock: this.lock,
      creator: this.creator,
      playlist: this.playlist,
      loop: this.loop,
    });
  };

  private deserialize = (roomData: string) => {
    const roomObj = JSON.parse(roomData);
    this.video = roomObj.video;
    this.videoTS = roomObj.videoTS;
    if (roomObj.subtitle) {
      this.subtitle = roomObj.subtitle;
    }
    if (roomObj.paused) {
      this.paused = roomObj.paused;
    }
    if (roomObj.chat) {
      this.chat = roomObj.chat;
    }
    if (roomObj.nameMap) {
      this.nameMap = roomObj.nameMap;
    }
    if (roomObj.pictureMap) {
      this.pictureMap = roomObj.pictureMap;
    }
    if (roomObj.vBrowser) {
      this.vBrowser = roomObj.vBrowser;
    }
    if (roomObj.lock) {
      this.lock = roomObj.lock;
    }
    if (roomObj.creator) {
      this.creator = roomObj.creator;
    }
    if (roomObj.playlist) {
      this.playlist = roomObj.playlist;
    }
    if (roomObj.playbackRate) {
      this.playbackRate = roomObj.playbackRate;
    }
    if (roomObj.loop) {
      this.loop = roomObj.loop;
    }
  };

  public saveRoom = async () => {
    if (postgres) {
      try {
        const roomString = this.serialize();
        await postgres.query(
          `UPDATE room SET
          "lastUpdateTime" = $1, data = $2
          WHERE "roomId" = $3`,
          [this.lastUpdateTime ?? new Date(), roomString, this.roomId],
        );
      } catch (e) {
        console.warn(e);
      }
    }
  };

  public destroy = () => {
    if (this.tsInterval) {
      clearInterval(this.tsInterval);
    }
    this.clearBufferPause();
    // A pending trailing map send would re-create the namespace via io.of()
    Object.values(this.mapEmitTimers).forEach((t) => clearTimeout(t));
    // Unregister the namespace so it doesn't linger (or get duplicated on reload)
    this.io._nsps.delete(this.roomId);
  };

  public getRosterForStats = () => {
    return this.roster.map((p) => ({
      id: p.id,
      name: this.nameMap[p.id] || p.id,
      ts: this.tsMap[p.id],
      // TODO this will not work behind nginx reverse proxy, pass it and read from X-Real-IP instead
      // socket.handshake.headers["x-real-ip"]
      // ip: this.io.of(this.roomId).sockets.get(p.id)?.request?.socket
      //   ?.remoteAddress,
    }));
  };

  protected getSharerId = (): string => {
    let sharerId = "";
    if (this.video?.startsWith("screenshare://")) {
      sharerId = this.video?.slice("screenshare://".length).split("@")[0];
    } else if (this.video?.startsWith("fileshare://")) {
      sharerId = this.video?.slice("fileshare://".length).split("@")[0];
    }
    return sharerId;
  };

  // r220: each entry carries the member's per-page-load id so the sharer can
  // tell a reopened tab (same clientId — the supersede path keeps the roster
  // entry) from a live page, and rebuild that publisher PC at once instead of
  // waiting for ICE dead-detection + the 6 s watchdog. Additive field: older
  // clients never read it, so they behave exactly as before
  protected getRosterForApp = (): (User & { pageId?: string })[] => {
    return this.roster.map((p) => {
      return {
        ...p,
        isScreenShare: p.id === this.getSharerId(),
        buffering: this.bufferingMap[p.id],
        pageId: this.pageIdMap[p.id],
      };
    });
  };

  private getHostState = (): HostState => {
    return {
      video: this.video ?? "",
      videoTS: this.videoTS,
      subtitle: this.subtitle,
      playbackRate: this.playbackRate,
      paused: this.paused,
      isVBrowserLarge: Boolean(this.vBrowser && this.vBrowser.large),
      controller: this.vBrowser?.controllerClient,
      loop: this.loop,
    };
  };

  public stopVBrowserInternal = async () => {
    const assignTime = this.vBrowser && this.vBrowser.assignTime;
    const id = this.vBrowser?.id;
    const provider = this.vBrowser?.provider;
    const isLarge = this.vBrowser?.large ?? false;
    const region = this.vBrowser?.region ?? "";
    const uid = this.vBrowser?.creatorUID ?? "";
    this.vBrowser = undefined;
    this.cmdHost(null, "");
    // Force a save because this might change in unattended rooms
    this.lastUpdateTime = new Date();
    this.saveRoom();
    if (redis && assignTime) {
      await redis.lpush("vBrowserSessionMS", Date.now() - assignTime);
      await redis.ltrim("vBrowserSessionMS", 0, 19);
    }

    if (id) {
      await this.releaseVM({ id, provider, large: isLarge, region });
    }
  };

  // Give a VM back to the pool (or terminate it if we're running stateless)
  private releaseVM = async (vm: {
    id?: string;
    provider?: string;
    large?: boolean;
    region?: string;
  }) => {
    if (!vm.id) {
      return;
    }
    try {
      if (stateless) {
        await stateless.terminateVM(vm.id);
      } else {
        await axios.post(
          "http://localhost:" + config.VMWORKER_PORT + "/releaseVM",
          {
            provider: vm.provider,
            isLarge: vm.large ?? false,
            region: vm.region ?? "",
            id: vm.id,
            roomId: this.roomId,
          },
        );
      }
    } catch (e) {
      console.warn(e);
    }
  };

  private cmdHost = (socket: Socket | null, data: string) => {
    if (data && data.length > 50000) {
      return;
    }
    // Any pending dead-sharer grace is stale the moment the room's video is
    // replaced by a command: a sharer who reconnects and starts a share again
    // (or anyone whose share legitimately changes hands or ends) must not
    // have their fresh state cleared when the old timer fires and sees
    // clientId === getSharerId() true again
    clearTimeout(this.sharerGraceTimer);
    this.sharerGraceTimer = undefined;
    this.video = data;
    this.videoTS = 0;
    this.paused = false;
    this.subtitle = "";
    this.loop = false;
    this.playbackRate = 1;
    this.tsMap = {};
    this.bufferingMap = {};
    this.bufferPauseMap = {};
    this.bufferResumeWatch = null;
    this.bufferResumeAttempts = 0;
    // New media ends any intermission
    if (this.intermission) {
      this.intermission = null;
      this.io.of(this.roomId).emit("REC:intermission", null);
    }
    this.clearBufferPause();
    this.preventTSUpdate = true;
    setTimeout(() => (this.preventTSUpdate = false), 1000);
    this.io.of(this.roomId).emit("REC:tsMap", this.tsMap);
    this.io.of(this.roomId).emit("REC:host", this.getHostState());
    if (socket && data) {
      const chatMsg = { id: socket.clientId, cmd: "host", msg: data };
      this.addChatMessage(socket, chatMsg);
    }
    if (data === "") {
      this.playlistNext(null);
    }
    // The room video is changing so remove room from vbrowser queue
    this.vBrowserQueue = undefined;
    // Resend the roster (updates screenshare state etc)
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  public addChatMessage = (socket: Socket | null, chatMsg: ChatMessageBase) => {
    if (this.isChatDisabled && !chatMsg.cmd) {
      return;
    }
    const chatWithTime: ChatMessage = {
      ...chatMsg,
      // Command lines (host, playlistAdd) carry the media URL, up to 50 KB;
      // chat text is capped at 2,000 (isValidChatMessage), so are they —
      // 100 of them made every joiner's chatinit ~5 MB
      msg:
        typeof chatMsg.msg === "string"
          ? chatMsg.msg.slice(0, 2000)
          : chatMsg.msg,
      timestamp: new Date().toISOString(),
      videoTS: socket?.clientId ? this.tsMap[socket.clientId] : undefined,
    };
    if (socket?.isSub) {
      chatWithTime.isSub = true;
    }
    this.chat.push(chatWithTime);
    this.chat = this.chat.splice(-100);
    this.io.of(this.roomId).emit("REC:chat", chatWithTime);
  };

  private changeUserName = (socket: Socket, data: string) => {
    if (!data) {
      return;
    }
    if (data && data.length > 50) {
      return;
    }
    this.nameMap[socket.clientId] = data;
    this.emitMap("REC:nameMap");
  };

  private changeUserPicture = (socket: Socket, data: string) => {
    // Real pictures are https Gravatar / Google-account URLs (getUserImage in
    // src/utils/utils.ts); anything else (javascript:, data:, junk) has no use
    // in <Avatar src> and React warns it will block javascript: URLs. Those
    // sources are all https; a plain-http URL only served as a beacon that
    // logs every member's IP, so it is refused too
    if (data.length > 2048 || !/^https:\/\/\S+$/i.test(data)) {
      return;
    }
    this.pictureMap[socket.clientId] = data;
    this.emitMap("REC:pictureMap");
  };

  // Each name/picture change re-sends the WHOLE map to every member, and the
  // relay cap is per socket: 4 sockets renaming made 120 full-map frames in
  // 1.4 s. Send at most one per map per 500 ms per room — the first at once,
  // later ones folded into a trailing send that carries the latest state
  private mapEmitAt: Record<string, number> = {};
  private mapEmitTimers: Record<string, NodeJS.Timeout | undefined> = {};
  private emitMap = (event: "REC:nameMap" | "REC:pictureMap") => {
    if (this.mapEmitTimers[event]) {
      return;
    }
    const fire = () => {
      this.mapEmitTimers[event] = undefined;
      this.mapEmitAt[event] = Date.now();
      this.io
        .of(this.roomId)
        .emit(event, event === "REC:nameMap" ? this.nameMap : this.pictureMap);
    };
    const wait = (this.mapEmitAt[event] ?? 0) + 500 - Date.now();
    if (wait <= 0) {
      fire();
    } else {
      this.mapEmitTimers[event] = setTimeout(fire, wait);
    }
  };

  private startHosting = async (socket: Socket, data: string) => {
    if (this.vBrowser) {
      socket.emit(
        "errorMessage",
        `Can't update the video while vbrowser is running`,
      );
      return;
    }
    if (isServerOnlyMedia(data)) {
      return;
    }
    // localcopy:// is synthesized by our own client and carries only the file
    // name, sharer id, and size (the contents never leave each viewer's
    // device), so accept only that exact shape
    if (
      data?.startsWith("localcopy://") &&
      !/^localcopy:\/\/[^@?\s]{1,1500}@[^\s?@]{1,100}\?size=\d{1,15}$/.test(
        data,
      )
    ) {
      return;
    }
    redisCount("urlStarts");
    if (config.STREAM_PATH && data?.startsWith(config.STREAM_PATH)) {
      redisCount("streamStarts");
    }
    // The resolved stream is only playable through TWITCH_PROXY_PATH; without
    // it new URL("") below always threw after two outbound requests per
    // CMD:host (a library with no timeout), so the URL is hosted as typed
    if (
      config.TWITCH_PROXY_PATH &&
      (data?.startsWith("https://www.twitch.tv") ||
        data?.startsWith("https://twitch.tv"))
    ) {
      try {
        // Extract m3u8 data
        // Note this won't work directly since Twitch will reject requests from the wrong origin--need to proxy the m3u8 playlist
        const channel = data.split("/").slice(-1)[0];
        const isStream = isNaN(Number(channel));
        let streams = [];
        if (isStream) {
          streams = await twitch.getStream(channel);
        } else {
          streams = await twitch.getVod(channel);
        }
        // console.log(streams);
        const target =
          streams.find((str: any) => str.quality.includes("(source)")) ||
          streams[0];
        const parsed = new URL(target?.url);
        const newUrl = new URL(config.TWITCH_PROXY_PATH);
        newUrl.pathname = "/proxy" + parsed.pathname;
        newUrl.searchParams.set("host", parsed.host);
        newUrl.searchParams.set("displayName", data);
        newUrl.search = newUrl.searchParams.toString();
        data = newUrl.toString();
      } catch (e) {
        console.warn(e);
      }
    }
    this.cmdHost(socket, data);
  };

  private playlistNext = (raw: unknown) => {
    const data = raw ? String(raw) : null;
    // We just changed the video: an ENDED carrying the new url is the old
    // player's late event, not the end of the video that has barely started
    if (data && this.preventTSUpdate) {
      return;
    }
    // Clients may pass the URL that should be the current one.
    // If we've already advanced the playlist, we can ignore duplicate calls.
    // Same video = the exact url, or two YouTube links for the same video
    // (a non-YouTube url pairs with null on both sides, which must NOT count
    // as "same" — any garbage payload would advance the playlist)
    if (data && this.video && data !== this.video) {
      const ytEnded = getYoutubeVideoID(data);
      const ytCurrent = getYoutubeVideoID(this.video);
      if (!(ytEnded && ytEnded === ytCurrent)) {
        // Validation didn't match
        return;
      }
    }
    const next = this.playlist.shift();
    this.io.of(this.roomId).emit("playlist", this.playlist);
    if (next) {
      this.cmdHost(null, next.url);
    }
  };

  public playlistAdd = async (socket: Socket | null, data: string) => {
    // Every change re-broadcasts the whole list: 500 items x 20 KB made each
    // frame ~10 MB. 4 KB still fits long signed URLs and magnet links
    if (
      typeof data !== "string" ||
      !data ||
      data.length > 4096 ||
      isServerOnlyMedia(data)
    ) {
      return;
    }
    // ponytail: cap the playlist so one spammy guest can't grow it (and every
    // full-playlist re-broadcast) without bound; chat history is capped at 100
    if (this.playlist.length >= 500) {
      return;
    }
    // Count and item size are capped apart, but every change re-sends the
    // whole list: 500 x 4 KB was still a 2 MB frame (measured 200 items =
    // 1.6 MB). 500 typical YouTube entries serialize to ~100 KB
    if (JSON.stringify(this.playlist).length + 2 * data.length > 256 * 1024) {
      return;
    }
    redisCount("playlistAdds");
    const youtubeVideoId = getYoutubeVideoID(data);
    const item = {
      name: data,
      channel: "Video URL",
      duration: 0,
      url: data,
      type: data.startsWith("magnet:") ? "magnet" : "file",
    };
    let video: PlaylistVideo | null = null;
    try {
      if (youtubeVideoId && allowYoutubeLookup()) {
        video = await fetchYoutubeVideo(youtubeVideoId);
      }
    } catch (e) {
      // Failed to fetch YouTube video info but can still add the URL
      console.warn(e);
    }
    if (video) {
      this.playlist.push(video);
    } else {
      this.playlist.push(item);
    }
    this.io.of(this.roomId).emit("playlist", this.playlist);
    const clientId = socket?.clientId;
    if (clientId) {
      const chatMsg = {
        id: clientId,
        cmd: "playlistAdd",
        msg: data,
      };
      this.addChatMessage(socket, chatMsg);
    }
    if (!this.video) {
      this.playlistNext(null);
    }
  };

  private playlistDelete = (raw: unknown) => {
    // The client sends the item's url alongside the index. Two people can edit
    // the playlist at once (rooms without a lock have no editor exclusivity),
    // and an index computed against a stale list silently kills the wrong
    // item — the url must still match the item at that index.
    const data = raw as { index: number; url: string } | null;
    if (
      !data ||
      !Number.isInteger(data.index) ||
      typeof data.url !== "string"
    ) {
      return;
    }
    const index = data.index;
    if (index < 0 || index >= this.playlist.length) {
      return;
    }
    if (this.playlist[index].url !== data.url) {
      return;
    }
    this.playlist.splice(index, 1);
    this.io.of(this.roomId).emit("playlist", this.playlist);
  };

  private playlistMove = (raw: unknown) => {
    const data = raw as { index: number; toIndex: number; url: string } | null;
    if (!data) {
      return;
    }
    const { index, toIndex } = data;
    const len = this.playlist.length;
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(toIndex) ||
      typeof data.url !== "string" ||
      index < 0 ||
      index >= len ||
      toIndex < 0 ||
      toIndex >= len
    ) {
      return;
    }
    // Same stale-list protection as playlistDelete
    if (this.playlist[index].url !== data.url) {
      return;
    }
    const [item] = this.playlist.splice(index, 1);
    this.playlist.splice(toIndex, 0, item);
    this.io.of(this.roomId).emit("playlist", this.playlist);
  };

  private playVideo = (socket: Socket) => {
    socket.broadcast.emit("REC:play", this.video);
    const chatMsg = {
      id: socket.clientId,
      cmd: "play",
      msg: this.tsMap[socket.clientId]?.toString(),
    };
    this.paused = false;
    // A person resumed: no auto-resume pending, and a new stall gets its own budget
    this.bufferResumeWatch = null;
    this.bufferResumeAttempts = 0;
    // Resuming the show ends any intermission
    if (this.intermission) {
      this.intermission = null;
      this.io.of(this.roomId).emit("REC:intermission", null);
    }
    // Resuming with a viewer still stuck buffers them behind again — keep watching
    this.armBufferPause();
    this.addChatMessage(socket, chatMsg);
  };

  private pauseVideo = (socket: Socket) => {
    socket.broadcast.emit("REC:pause");
    const chatMsg = {
      id: socket.clientId,
      cmd: "pause",
      msg: this.tsMap[socket.clientId]?.toString(),
    };
    this.paused = true;
    // A manual pause means nobody is falling behind; drop any pending one
    this.clearBufferPause();
    // and an auto-resume must not override the person who paused
    this.bufferResumeWatch = null;
    this.addChatMessage(socket, chatMsg);
  };

  private seekVideo = (socket: Socket, data: unknown) => {
    // Must be a real number: Number(null), Number("") etc. would silently become 0, and
    // NaN/Infinity serialize to null and break clients
    if (
      typeof data !== "number" ||
      !Number.isFinite(data) ||
      Math.abs(data) > MAX_MEDIA_SECONDS
    ) {
      return;
    }
    // While the room is switching videos, a seek still in flight belongs to the
    // old one: treat it like a lagging CMD:ts (see setTimestamp) so it can't
    // seed the new video's tsMap/videoTS
    if (!this.preventTSUpdate) {
      this.videoTS = data;
      // Everyone is being moved to the new position now; tsMap would otherwise
      // keep pre-seek entries until the next 1s CMD:ts tick, and a joiner's
      // first play would snap back to them
      Object.keys(this.tsMap).forEach((key) => {
        this.tsMap[key] = data;
      });
    }
    // A seek moves everyone: resuming a buffer-paused room is the people's
    // call again, the stalled member's data was for the old position
    this.bufferResumeWatch = null;
    socket.broadcast.emit("REC:seek", data);
    const chatMsg = { id: socket.clientId, cmd: "seek", msg: data?.toString() };
    this.addChatMessage(socket, chatMsg);
  };

  private setPlaybackRate = (socket: Socket, data: unknown) => {
    // Browsers only support rates in roughly this range, anything else is garbage
    if (
      typeof data !== "number" ||
      !Number.isFinite(data) ||
      data < 0.0625 ||
      data > 16
    ) {
      return;
    }
    this.playbackRate = data;
    this.io.of(this.roomId).emit("REC:playbackRate", data);
    const chatMsg = {
      id: socket.clientId,
      cmd: "playbackRate",
      msg: data?.toString(),
    };
    this.addChatMessage(socket, chatMsg);
  };

  private setLoop = (data: unknown) => {
    if (typeof data !== "boolean") {
      return;
    }
    this.loop = data;
    this.io.of(this.roomId).emit("REC:loop", data);
  };

  private setTimestamp = (socket: Socket, data: unknown, mayDrive: boolean) => {
    if (
      typeof data !== "number" ||
      !Number.isFinite(data) ||
      Math.abs(data) > MAX_MEDIA_SECONDS
    ) {
      return;
    }
    // Prevent lagging TS updates from the old video from messing up our timestamps
    if (this.preventTSUpdate) {
      return;
    }
    // This is negative for live streams, so allow overwriting
    // Otherwise, only increment this value to prevent a lagging viewer from holding up the room state
    // Only a member who may drive moves the room position: in a locked room /
    // one-driver room a guest's CMD:ts must not set what joiners get
    if (mayDrive && (data < 0 || data > this.videoTS)) {
      this.videoTS = data;
    }
    // Normalize the received TS based on how long since the last tsMap emit
    // Later sends will have higher values so subtract the difference
    // Add 1 as we will emit 1 second from the last one
    const timeSinceTsMap = Date.now() - this.lastTsMap;
    // console.log(socket.clientId, 'offset', offset, 'ms');
    this.tsMap[socket.clientId] = data - timeSinceTsMap / 1000 + 1;
  };

  private isValidChatMessage = (msg: string | undefined) => {
    // linkify-it 2.2.0 (the client's chat renderer) has quadratic worst-case
    // behavior (GHSA-22p9-wv53-3rq4, e.g. "a@b.com\n" repeated): measured
    // 10,000 chars = 68ms per message on one receiver thread, and CMD:chat
    // allows 25/s — enough to freeze every tab in the room. 2,000 chars costs
    // ~3ms and still leaves room for any normal message
    return Boolean(msg && msg.length <= 2000);
  };

  private sendChatMessage = (socket: Socket, raw: unknown) => {
    // Support legacy string and V2 object chat payloads.
    const payload = typeof raw === "string" ? { msg: raw } : raw;
    if (!payload || typeof payload !== "object") {
      return;
    }

    // Validate supported fields.
    const data = payload as Record<string, unknown>;
    const msg = typeof data.msg === "string" ? data.msg : undefined;
    const replyToId =
      typeof data.replyToId === "string" ? data.replyToId : undefined;
    const replyToTimestamp =
      typeof data.replyToTimestamp === "string"
        ? data.replyToTimestamp
        : undefined;

    if (!msg || !this.isValidChatMessage(msg)) {
      return;
    }

    // Require both reply fields or neither.
    if (Boolean(replyToId) !== Boolean(replyToTimestamp)) {
      return;
    }

    const baseMsg: ChatMessageBase = { id: socket.clientId, msg };
    const emitChatMessage = (chatMsg: ChatMessageBase) => {
      redisCount("chatMessages");
      this.addChatMessage(socket, chatMsg);
    };

    // No reply metadata -> regular message.
    if (!replyToId || !replyToTimestamp) {
      emitChatMessage(baseMsg);
      return;
    }

    const target = this.chat.find(
      (m) => m.id === replyToId && m.timestamp === replyToTimestamp,
    );
    // Missing target -> fall back to regular message.
    if (!target) {
      emitChatMessage(baseMsg);
      return;
    }

    emitChatMessage({
      ...baseMsg,
      replyToId,
      replyToTimestamp,
      replyToUserId: replyToId,
      replyToMsg: target.msg || "",
    });
  };

  private addReaction = (socket: Socket, raw: unknown) => {
    const data = raw as { value: string; msgId: string; msgTimestamp: string };
    if (!data || !data.value || !data.msgId || !data.msgTimestamp) {
      return;
    }
    // Emojis can be multiple bytes; value must be a string or its coerced
    // key ("[object Object]", "123") would be stored and broadcast room-wide.
    // R116: real picker emojis run long in UTF-16 units (👨‍👩‍👧‍👦 = 11,
    // 🧑🏻‍🤝‍🧑🏽 = 12, 👩🏻‍❤️‍💋‍👨🏽 = 14) and the old 8-unit cap silently
    // dropped them; still bounded — 24 units AND at most 8 grapheme clusters
    if (typeof data.value !== "string" || data.value.length > 24) {
      return;
    }
    if (
      [
        ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
          data.value,
        ),
      ].length > 8
    ) {
      return;
    }
    // The reactions map is a plain object keyed by this string: "toString" or
    // "valueOf" would resolve on its prototype and turn the stored value (and
    // the handler's .includes call) into a TypeError
    if (data.value in Object.prototype) {
      return;
    }
    const msg = this.chat.find(
      (m) => m.id === data.msgId && m.timestamp === data.msgTimestamp,
    );
    if (!msg) {
      return;
    }
    msg.reactions = msg.reactions || {};
    // Cap distinct reaction values per message so one spammy guest can't bloat
    // chat history; joining/removing an existing value is still allowed
    if (!msg.reactions[data.value] && Object.keys(msg.reactions).length >= 20) {
      return;
    }
    msg.reactions[data.value] = msg.reactions[data.value] || [];

    // Bound reactors per value like the 20-value cap above: the ids outlive
    // their members (a departed member's reaction stays visible on purpose —
    // the UI counts these ids), so a message that sits in history in a
    // high-traffic room would otherwise grow one id per visitor forever.
    // Joining/removing an existing id is still allowed
    const joined = msg.reactions[data.value].includes(socket.clientId);
    if (!joined && msg.reactions[data.value].length >= 50) {
      return;
    }
    if (!joined) {
      msg.reactions[data.value].push(socket.clientId);
      // Named fields only, sender last: spreading the client payload in let a
      // "user" field forge who the reaction belongs to (every client applies
      // data.user verbatim) and smuggle arbitrary extra keys into the room
      const reaction: Reaction = {
        msgId: data.msgId,
        msgTimestamp: data.msgTimestamp,
        value: data.value,
        user: socket.clientId,
      };
      redisCount("addReaction");
      this.io.of(this.roomId).emit("REC:addReaction", reaction);
    }
  };

  private removeReaction = (socket: Socket, raw: unknown) => {
    const data = raw as { value: string; msgId: string; msgTimestamp: string };
    if (!data || !data.value || !data.msgId || !data.msgTimestamp) {
      return;
    }
    // Emojis can be multiple bytes; value must be a string (same rule as
    // addReaction, including the inherited-key refusal)
    if (typeof data.value !== "string" || data.value.length > 24) {
      return;
    }
    if (
      [
        ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
          data.value,
        ),
      ].length > 8
    ) {
      return;
    }
    if (data.value in Object.prototype) {
      return;
    }
    const msg = this.chat.find(
      (m) => m.id === data.msgId && m.timestamp === data.msgTimestamp,
    );
    if (!msg || !msg.reactions?.[data.value]) {
      return;
    }
    msg.reactions[data.value] = msg.reactions[data.value].filter(
      (id) => id !== socket.clientId,
    );
    // Same named-fields rule as addReaction
    const reaction: Reaction = {
      msgId: data.msgId,
      msgTimestamp: data.msgTimestamp,
      value: data.value,
      user: socket.clientId,
    };
    this.io.of(this.roomId).emit("REC:removeReaction", reaction);
  };

  // Floating emoji over the video: relayed to everyone (sender included) with
  // the sender's id, but never stored in chat history
  private floatReaction = (socket: Socket, raw: unknown) => {
    if (typeof raw !== "string" || !FLOAT_REACTIONS.includes(raw)) {
      return;
    }
    // Max 5 per second per socket so one guest can't flood the room
    const now = Date.now();
    const times = (this.floatReactionTimes[socket.clientId] || []).filter(
      (t) => now - t < 1000,
    );
    if (times.length >= 5) {
      return;
    }
    times.push(now);
    this.floatReactionTimes[socket.clientId] = times;
    this.io.of(this.roomId).emit("REC:floatReaction", {
      user: socket.clientId,
      value: raw,
    });
  };

  // Intermission: one of us steps out, the whole room pauses and shows a
  // countdown until someone presses play (playVideo and cmdHost clear it).
  // minutes 0 = no end time ("back whenever"). This is
  // relayed to everyone including the sender (like the buffer auto-pause),
  // so every player pauses together; capped at 2/s per socket (one click
  // per break, re-clicking just changes the duration)
  private setIntermission = (socket: Socket, raw: unknown) => {
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < 0 ||
      raw > 30
    ) {
      return;
    }
    const now = Date.now();
    const times = (this.intermissionTimes[socket.clientId] || []).filter(
      (t) => now - t < 1000,
    );
    if (times.length >= 2) {
      return;
    }
    times.push(now);
    this.intermissionTimes[socket.clientId] = times;
    this.intermission = {
      by: socket.clientId,
      until: raw > 0 ? now + raw * 60000 : null,
    };
    this.paused = true;
    // A manual pause means nobody is falling behind; drop any pending one
    this.clearBufferPause();
    this.bufferResumeWatch = null;
    this.io.of(this.roomId).emit("REC:pause");
    this.io.of(this.roomId).emit("REC:intermission", this.intermission);
    this.addChatMessage(socket, {
      id: socket.clientId,
      cmd: "intermission",
      msg: raw.toString(),
    });
  };

  // Sleep timer: at the deadline the tick asks "still watching?" for one
  // minute, and nobody answering pauses the room for the night. minutes
  // 1..240 schedules (lock-gated, see the registration), 0 cancels or
  // answers the check. Capped at 2/s per socket like intermission. The
  // deadline survives media changes and resumes on purpose — only an
  // explicit cancel or a new timer ends it, so falling asleep mid-episode
  // still stops the room
  private setSleepTimer = (socket: Socket, raw: unknown, hasLock: boolean) => {
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < 0 ||
      raw > 240
    ) {
      return;
    }
    if (raw > 0 && !hasLock) {
      return;
    }
    // Cancelling when nothing is scheduled: nothing to announce
    if (raw === 0 && !this.sleepTimer) {
      return;
    }
    const now = Date.now();
    const times = (this.sleepTimes[socket.clientId] || []).filter(
      (t) => now - t < 1000,
    );
    if (times.length >= 2) {
      return;
    }
    times.push(now);
    this.sleepTimes[socket.clientId] = times;
    this.sleepTimer =
      raw === 0
        ? null
        : {
            by: socket.clientId,
            at: now + raw * 60000,
            askedAt: 0,
            asking: false,
          };
    // Like intermission, relayed to everyone including the sender
    this.io.of(this.roomId).emit("REC:sleep", this.sleepTimer);
    this.addChatMessage(socket, {
      id: socket.clientId,
      cmd: "sleep",
      msg: raw.toString(),
    });
  };

  private setBuffering = (socket: Socket, data: unknown, canPause: boolean) => {
    // Accept only booleans; ignore no-op updates so the roster isn't re-emitted
    if (typeof data !== "boolean") {
      return;
    }
    // A member the buffer auto-pause was for has data again: resume once the
    // last of them has (two stuck at once: R17A resumed for the first while
    // the second was still offline). Before the no-op check, since the pause
    // consumed their claims
    const watch = this.bufferResumeWatch;
    if (
      data === false &&
      watch?.clientIds.includes(socket.clientId) &&
      Date.now() - watch.pausedAt < BUFFER_RESUME_WATCH_MS
    ) {
      watch.clientIds = watch.clientIds.filter((id) => id !== socket.clientId);
      if (!watch.clientIds.length) {
        this.bufferResumeWatch = null;
        this.fireBufferResume(socket.clientId);
      }
    }
    if (Boolean(this.bufferingMap[socket.clientId]) === data) {
      return;
    }
    // Every accepted change re-broadcasts the roster, so cap at 5/s per socket
    // like floatReaction; legit clients report ~2 transitions per stall/recovery
    const now = Date.now();
    const times = (this.bufferingChangeTimes[socket.clientId] || []).filter(
      (t) => now - t < 1000,
    );
    if (times.length >= 5) {
      return;
    }
    times.push(now);
    this.bufferingChangeTimes[socket.clientId] = times;
    this.bufferingMap[socket.clientId] = data;
    if (canPause) {
      this.bufferPauseMap[socket.clientId] = data;
    } else {
      delete this.bufferPauseMap[socket.clientId];
    }
    // Jellyfin SyncPlay behavior: if a viewer stays stuck too long while the
    // room plays, pause everyone so nobody watches ahead of the stuck viewer.
    // CMD:buffering is already capped and validated above, so no new event.
    // Re-arm on false too: with two stuck viewers, one recovering must not
    // cancel the timer for the other.
    // Pausing is playback control: in a locked room only the lock holder's
    // claims arm it (same check CMD:pause uses) and only theirs can land it
    // (bufferPauseMap), so a guest's claim can't ride a play's re-arm either;
    // it still shows in the roster below
    if (canPause) {
      this.armBufferPause();
    }
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  // The stall window: the client reports only after 1.5s of true buffering, so
  // this adds ~2.5s grace before pausing (~4s of stall total) to ride out blips
  private armBufferPause = () => {
    this.clearBufferPause();
    if (this.paused || !Object.values(this.bufferPauseMap).some(Boolean)) {
      return;
    }
    this.bufferPauseTimer = setTimeout(() => {
      const stuckIds = Object.keys(this.bufferPauseMap).filter(
        (id) => this.bufferPauseMap[id],
      );
      const stuck = stuckIds[0];
      if (this.paused || !stuck) {
        return;
      }
      this.paused = true;
      this.io.of(this.roomId).emit("REC:pause");
      // REC:pause pauses every player, so a genuinely stuck viewer un-stalls
      // and reports false on its next tick, re-reporting true only if it
      // stalls again after a resume. Consuming the claims here means a resume
      // can only re-pause on a new report; a client that went silent with
      // true still in the map would otherwise re-pause the room after every
      // play, forever.
      this.bufferingMap = {};
      this.bufferPauseMap = {};
      this.io.of(this.roomId).emit("roster", this.getRosterForApp());
      this.addChatMessage(null, {
        id: stuck,
        cmd: "bufferPause",
        msg: Math.round(this.videoTS).toString(),
      });
      if (this.bufferResumeAttempts < BUFFER_RESUME_MAX_ATTEMPTS) {
        this.bufferResumeWatch = { clientIds: stuckIds, pausedAt: Date.now() };
      }
    }, 2500);
  };

  // Resume a buffer-paused room once the member it waited for has data again.
  // Not playVideo(): no socket to attribute it to, and REC:play goes to
  // everyone, the recovered member too. Re-arms like playVideo does, so
  // someone still stuck pauses it again
  private fireBufferResume = (clientId: string) => {
    if (!this.paused || this.intermission) {
      return;
    }
    this.bufferResumeAttempts += 1;
    this.paused = false;
    this.io.of(this.roomId).emit("REC:play", this.video);
    this.armBufferPause();
    this.addChatMessage(null, {
      id: clientId,
      cmd: "bufferResume",
      msg: Math.round(this.videoTS).toString(),
    });
  };

  private clearBufferPause = () => {
    if (this.bufferPauseTimer) {
      clearTimeout(this.bufferPauseTimer);
      this.bufferPauseTimer = undefined;
    }
  };

  private joinVideo = async (socket: Socket) => {
    const match = this.roster.find((user) => user.id === socket.clientId);
    if (match) {
      match.isVideoChat = true;
      redisCount("videoChatStarts");
    }
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  private leaveVideo = async (socket: Socket) => {
    const match = this.roster.find((user) => user.id === socket.clientId);
    if (match) {
      match.isVideoChat = false;
      // The mute flag belongs to the voice session that just ended: kept, the
      // next join's first roster would carry it until that join's CMD:userMute
      // lands (a live mic shown muted, red icon rendered)
      delete match.isMuted;
      delete match.isCameraOff;
    }
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  private setUserMute = (socket: Socket, raw: unknown) => {
    const data = raw as { isMuted: boolean; isCameraOff?: boolean };
    // isMuted rides the roster broadcast verbatim, so only a real boolean
    if (!data || typeof data.isMuted !== "boolean") {
      return;
    }
    // The camera flag rides the same event; an old client that omits it never
    // touches it here (absent = camera on / unchanged)
    if (
      data.isCameraOff !== undefined &&
      typeof data.isCameraOff !== "boolean"
    ) {
      return;
    }
    const match = this.roster.find((user) => user.id === socket.clientId);
    if (match) {
      match.isMuted = data.isMuted;
      if (data.isCameraOff !== undefined) {
        match.isCameraOff = data.isCameraOff;
      }
    }
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  private joinScreenSharing = (socket: Socket, raw: unknown) => {
    const data = raw as { file: boolean; mediasoup?: boolean };
    if (!data) {
      return;
    }
    const sharer = this.getRosterForApp().find((user) => user.isScreenShare);
    if (sharer) {
      // Someone's already sharing
      socket.emit(
        "errorMessage",
        "There is already an active share in this room",
      );
      socket.emit("REC:shareRejected");
      return;
    }
    let mediasoupSuffix = "";
    // Without a relay server, a relay request falls back to a direct share
    if (data?.mediasoup && config.MEDIASOUP_SERVER) {
      // TODO validate the user has permissions to ask for a mediasoup
      // TODO set up the room on the remote server rather than letting the remote server create
      mediasoupSuffix =
        "@" + config.MEDIASOUP_SERVER + "/" + crypto.randomUUID();
      redisCount("mediasoupStarts");
    }
    if (data && data.file) {
      this.cmdHost(socket, "fileshare://" + socket.clientId + mediasoupSuffix);
      redisCount("fileShareStarts");
    } else {
      this.cmdHost(
        socket,
        "screenshare://" + socket.clientId + mediasoupSuffix,
      );
      redisCount("screenShareStarts");
    }
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  private leaveScreenSharing = (socket: Socket) => {
    const sharer = this.getRosterForApp().find((user) => user.isScreenShare);
    if (!sharer) {
      // The share is already gone (someone else changed the media while we
      // were sharing, or the grace timer cleared it): the caller's client
      // stops its capture on the REC:host that says so and then sends this
      // as cleanup — an error banner here would blame a correct client
      return;
    }
    if (sharer.id !== socket.clientId) {
      // The caller's client believed it was the sharer and stopped its
      // capture: someone else owns the share now (the dead-sharer grace
      // cleared ours and they took over). The client learns the same fact
      // from REC:host and drops the capture on its side — a banner here would
      // blame a correct client
      return;
    }
    this.cmdHost(socket, "");
    this.io.of(this.roomId).emit("roster", this.getRosterForApp());
  };

  // A sharer whose socket dropped and came back re-announces their share.
  // Fast path: the grace timer hasn't fired, the room media is untouched —
  // just cancel the pending clear. Slow path: the grace already fired and the
  // room is empty — put their share back without a re-pick. A room that moved
  // on (someone else hosts now) refuses, and the client stops its capture
  private resumeSharing = (socket: Socket, raw: unknown) => {
    const data = raw as { media?: string };
    if (typeof data?.media !== "string" || !data.media) {
      return;
    }
    // Only their own share value, exact (no mediasoup suffix) or with one
    const own =
      data.media === "screenshare://" + socket.clientId ||
      data.media === "fileshare://" + socket.clientId ||
      data.media.startsWith("screenshare://" + socket.clientId + "@") ||
      data.media.startsWith("fileshare://" + socket.clientId + "@");
    if (!own) {
      return;
    }
    if (socket.clientId === this.getSharerId()) {
      clearTimeout(this.sharerGraceTimer);
      this.sharerGraceTimer = undefined;
      return;
    }
    if (!this.video) {
      this.cmdHost(socket, data.media);
    }
  };

  private startVBrowser = async (socket: Socket, raw: unknown) => {
    const data = raw as {
      options?: { size: string; region: string; provider: string };
    };
    if (!data) {
      socket.emit("errorMessage", "Invalid vBrowser input");
      return;
    }
    // options.region is handed to the VM workers verbatim and they match pools
    // by exact region, so it must name a region a pool actually runs in (see
    // POOL_REGIONS in vm/utils.ts); no region (undefined, or "" which the
    // VBrowserModal sends for "any") stays valid, workers then match any pool
    const reqRegion = data.options?.region;
    if (
      reqRegion !== undefined &&
      reqRegion !== "" &&
      (typeof reqRegion !== "string" || !isPoolRegion(reqRegion))
    ) {
      socket.emit("errorMessage", "Invalid vBrowser region");
      return;
    }
    const { clientId, uid, isSub } = socket;
    // Only one VM per room: a second start would leak whichever VM is assigned first
    if (this.vBrowser || this.vBrowserQueue) {
      socket.emit(
        "errorMessage",
        "A vBrowser is already running or starting in this room.",
      );
      return;
    }
    // these checks are skipped if firebase not provided
    if (config.FIREBASE_ADMIN_SDK_CONFIG) {
      // VMs are assigned per user, anonymous users can't get one
      if (!uid) {
        socket.emit(
          "errorMessage",
          "You must be logged in to start a vBrowser.",
        );
        return;
      }
      let user: Awaited<ReturnType<typeof getUser>> = null;
      try {
        user = await getUser(uid);
      } catch (e) {
        console.warn(e);
        socket.emit("errorMessage", "Could not verify your account.");
        return;
      }
      // Validate verified email if not a third-party auth provider
      if (
        user?.providerData?.[0]?.providerId === "password" &&
        !user?.emailVerified
      ) {
        socket.emit(
          "errorMessage",
          "A verified email is required to start a VBrowser.",
        );
        return;
      }

      // Log the vbrowser creation by uid and clientid
      if (redis) {
        const expireTime = getStartOfDay() / 1000 + 86400;
        if (clientId) {
          const clientCount = await redis.zincrby(
            "vBrowserClientIDs",
            1,
            clientId,
          );
          redis.expireat("vBrowserClientIDs", expireTime);
          const clientMinutes = await redis.zincrby(
            "vBrowserClientIDMinutes",
            1,
            clientId,
          );
          redis.expireat("vBrowserClientIDMinutes", expireTime);
        }
        if (uid) {
          const uidCount = await redis.zincrby("vBrowserUIDs", 1, uid);
          redis.expireat("vBrowserUIDs", expireTime);
          const uidMinutes = await redis.zincrby("vBrowserUIDMinutes", 1, uid);
          redis.expireat("vBrowserUIDMinutes", expireTime);
          // TODO limit users based on client or uid usage
        }
      }
      // check if the user already has a VM already in postgres
      if (postgres) {
        const { rows } = await postgres.query(
          "SELECT count(1) from vbrowser WHERE uid = $1",
          [uid],
        );
        if (Number(rows[0].count) >= MAX_VBROWSERS_PER_USER) {
          socket.emit(
            "errorMessage",
            "There is already an active vBrowser for this user.",
          );
          return;
        }
      }
    }
    let isLarge = false;
    let region = "";
    // Check if user is subscriber or firebase not configured, if so allow sub options
    if (isSub || !config.FIREBASE_ADMIN_SDK_CONFIG) {
      isLarge = data.options?.size === "large";
      if (data.options?.region) {
        region = data.options?.region;
      }
    }

    // Re-check: another start (or a host change) may have gotten in while we awaited above
    if (this.vBrowser || this.vBrowserQueue) {
      socket.emit(
        "errorMessage",
        "A vBrowser is already running or starting in this room.",
      );
      return;
    }
    redisCount("vBrowserStarts");
    this.cmdHost(socket, "vbrowser://");
    // Put the room in the vbrowser queue
    const queue = {
      roomId: this.roomId,
      queueTime: new Date(),
      isLarge,
      region,
      uid,
      clientId,
    };
    this.vBrowserQueue = queue;
    try {
      // Check if a vbrowser is available
      // Keep going only while this request is still the active one. Stopping the vBrowser,
      // changing the video or starting another one replaces/clears the queue entry.
      while (this.vBrowserQueue === queue) {
        const { queueTime, isLarge, region, uid, roomId, clientId } = queue;
        let assignment: AssignedVM | undefined = undefined;
        try {
          if (stateless) {
            const pass = crypto.randomUUID();
            const id = await stateless.startVM(pass);
            assignment = {
              ...(await stateless.getVM(id)),
              pass,
              assignTime: Date.now(),
            };
          } else {
            const { data } = await axios.post<AssignedVM>(
              "http://localhost:" + config.VMWORKER_PORT + "/assignVM",
              {
                isLarge,
                region,
                uid,
                roomId,
              },
            );
            assignment = data;
          }
        } catch (e) {
          console.warn(e);
        }
        if (this.vBrowserQueue !== queue) {
          // The request was cancelled while we were waiting for the VM, don't leak it
          if (assignment) {
            await this.releaseVM(assignment);
          }
          return;
        }
        if (assignment) {
          this.vBrowser = assignment;
          this.vBrowser.controllerClient = clientId;
          this.vBrowser.creatorUID = uid;
          this.vBrowser.creatorClientID = clientId;
          const assignEnd = Date.now();
          const assignElapsed = assignEnd - Number(queueTime);
          try {
            await redis?.lpush("vBrowserStartMS", assignElapsed);
            await redis?.ltrim("vBrowserStartMS", 0, 19);
          } catch (e) {
            // Metrics only, must not prevent the room from getting its VM
            console.warn(e);
          }
          console.log(
            "[ASSIGN] %s to %s in %s",
            assignment.provider + ":" + assignment.id,
            roomId,
            assignElapsed + "ms",
          );
          // Also clears the queue, which ends the loop
          this.cmdHost(
            null,
            "vbrowser://" + this.vBrowser.pass + "@" + this.vBrowser.host,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      // Never leave a stale queue entry behind, it would block future starts
      if (this.vBrowserQueue === queue) {
        this.vBrowserQueue = undefined;
      }
    }
  };

  private stopVBrowser = async () => {
    if (!this.vBrowser && this.video !== "vbrowser://") {
      return;
    }
    await this.stopVBrowserInternal();
    redisCount("vBrowserTerminateManual");
  };

  private changeController = (data: string) => {
    if (data && data.length > 100) {
      return;
    }
    if (this.vBrowser) {
      this.vBrowser.controllerClient = data;
      this.io.of(this.roomId).emit("REC:changeController", data);
    }
  };

  private addSubtitles = async (data: string) => {
    if (data && data.length > 10000) {
      return;
    }
    this.subtitle = data;
    this.io.of(this.roomId).emit("REC:subtitle", this.subtitle);
  };

  private lockRoom = async (socket: Socket, raw: unknown) => {
    const data = raw as { locked?: unknown } | null;
    if (!data) {
      return;
    }
    const locked = data.locked === true;
    const { uid, clientId } = socket;
    // The lock is stored as the locker's uid. An anonymous user has none, so "locking"
    // would silently do nothing while still announcing to the room that it was locked.
    if (locked && !uid) {
      socket.emit("errorMessage", "You must be logged in to lock the room.");
      return;
    }
    this.lock = locked ? uid : "";
    this.io.of(this.roomId).emit("REC:lock", this.lock);
    const chatMsg = {
      id: clientId,
      cmd: locked ? "lock" : "unlock",
      msg: "",
    };
    this.addChatMessage(socket, chatMsg);
  };

  // Whether any connected socket in the room currently carries the lock uid.
  // The lock outlives its holder (see `lock`), so CMD:ts falls open while
  // nobody in the room holds it — otherwise a locked room whose holder left
  // could never move its position again. Unlike the lock, extController is
  // already cleared in onDisconnect, so it needs no such fallback
  private lockHolderPresent = (): boolean => {
    if (!this.lock) {
      return false;
    }
    for (const socket of this.io.of(this.roomId).sockets.values()) {
      if (socket.uid === this.lock) {
        return true;
      }
    }
    return false;
  };

  private setRoomOwner = async (socket: Socket, raw: unknown) => {
    const data = raw as {
      undo: boolean;
    };
    if (!data) {
      return;
    }
    if (!postgres) {
      socket.emit("errorMessage", "Database is not available");
      return;
    }
    const { uid, isSub } = socket;
    if (data.undo) {
      await updateObject(
        postgres,
        "room",
        {
          password: null,
          owner: null,
          vanity: null,
          isChatDisabled: null,
          isSubRoom: null,
          roomTitle: null,
          roomDescription: null,
          roomTitleColor: null,
          mediaPath: null,
        },
        { roomId: this.roomId },
      );
      socket.emit("REC:getRoomState", {});
    } else {
      // validate room count
      const roomCount = (
        await postgres.query(
          'SELECT count(1) from room where owner = $1 AND "roomId" != $2',
          [uid, this.roomId],
        )
      ).rows[0].count;
      const limit = isSub
        ? config.SUBSCRIBER_ROOM_LIMIT
        : config.FREE_ROOM_LIMIT;
      if (roomCount >= limit) {
        socket.emit(
          "errorMessage",
          `You've exceeded the permanent room limit. Subscribe for additional permanent rooms.`,
        );
        return;
      }
      const roomObj = {
        roomId: this.roomId,
        owner: uid,
        isSubRoom: isSub,
      };
      let result: QueryResult | null = null;
      result = await upsertObject(postgres, "room", roomObj, {
        roomId: true,
      });
      const row = result?.rows?.[0];
      // console.log(result, row);
      socket.emit("REC:getRoomState", {
        password: row?.password,
        vanity: row?.vanity,
        owner: row?.owner,
      });
    }
  };

  private getRoomState = async (socket: Socket) => {
    if (!postgres) {
      return;
    }
    const result = await postgres.query(
      `SELECT password, vanity, owner, "isChatDisabled", "roomTitle", "roomDescription", "roomTitleColor", "mediaPath" FROM room where "roomId" = $1`,
      [this.roomId],
    );
    const first = result.rows[0];
    if (this.isChatDisabled === undefined) {
      this.isChatDisabled = Boolean(first?.isChatDisabled);
    }
    // The password goes only to the owner (the settings UI is the one consumer);
    // everyone else gets the same state without it
    const isOwner = Boolean(first?.owner) && socket.uid === first?.owner;
    socket.emit("REC:getRoomState", {
      password: isOwner ? first?.password : undefined,
      vanity: first?.vanity,
      owner: first?.owner,
      isChatDisabled: first?.isChatDisabled,
      roomTitle: first?.roomTitle,
      roomDescription: first?.roomDescription,
      roomTitleColor: first?.roomTitleColor,
      mediaPath: first?.mediaPath,
    });
  };

  private setRoomState = async (socket: Socket, raw: unknown) => {
    const data = raw as {
      password?: string | null;
      vanity?: string | null;
      isChatDisabled?: boolean | null;
      roomTitle?: string | null;
      roomDescription?: string | null;
      roomTitleColor?: string | null;
      mediaPath?: string | null;
    } | null;
    if (!postgres) {
      socket.emit("errorMessage", "Database is not available");
      return;
    }
    if (!data || typeof data !== "object") {
      return;
    }
    const {
      password,
      vanity,
      isChatDisabled,
      roomTitle,
      roomDescription,
      roomTitleColor,
      mediaPath,
    } = data;
    const { isSub, uid } = socket;
    const isOptionalString = (v: unknown) => v == null || typeof v === "string";
    if (
      ![
        password,
        vanity,
        roomTitle,
        roomDescription,
        roomTitleColor,
        mediaPath,
      ].every(isOptionalString) ||
      (isChatDisabled != null && typeof isChatDisabled !== "boolean")
    ) {
      socket.emit("errorMessage", "Invalid room settings");
      return;
    }
    if (password && password.length > 100) {
      socket.emit("errorMessage", "Password too long");
      return;
    }
    if (vanity && vanity.length > 100) {
      socket.emit("errorMessage", "Custom URL too long");
      return;
    }
    if (roomTitle && roomTitle.length > 50) {
      socket.emit("errorMessage", "Room title too long");
      return;
    }
    if (roomDescription && roomDescription.length > 120) {
      socket.emit("errorMessage", "Room description too long");
      return;
    }
    // The color is only a subscriber setting, so only validate (and require) it for them
    // check if is valid hex color representation
    if (
      isSub &&
      roomTitleColor != null &&
      !/^#([0-9a-f]{3}){1,2}$/i.test(roomTitleColor)
    ) {
      socket.emit("errorMessage", "Invalid color code");
      return;
    }
    if (mediaPath && mediaPath.length > 1000) {
      socket.emit("errorMessage", "Media source too long");
      return;
    }
    const roomObj: any = {
      password: password,
      isChatDisabled: isChatDisabled,
      mediaPath: mediaPath,
    };
    if (isSub) {
      // user must be sub to set certain properties
      // If empty vanity, reset to null
      roomObj.vanity = vanity ? vanity : null;
      roomObj.roomTitle = roomTitle;
      roomObj.roomDescription = roomDescription;
      roomObj.roomTitleColor = roomTitleColor;
    }
    try {
      const query = `UPDATE room
        SET ${Object.keys(roomObj).map((k, i) => `"${k}" = $${i + 1}`)}
        WHERE "roomId" = $${Object.keys(roomObj).length + 1}
        AND owner = $${Object.keys(roomObj).length + 2}
        RETURNING *`;
      const result = await postgres.query(query, [
        ...Object.values(roomObj),
        this.roomId,
        uid,
      ]);
      const row = result.rows[0];
      if (!row) {
        // Nothing matched, so the caller isn't the owner. Don't touch any state or tell
        // the room the settings changed (that would e.g. re-enable chat for everyone).
        socket.emit(
          "errorMessage",
          "Only the room owner can change these settings",
        );
        return;
      }
      this.isChatDisabled = Boolean(row.isChatDisabled);
      // The password stays owner-only: the room gets the state without it, and
      // the caller — the UPDATE above matched on owner = uid — gets it privately
      const roomState = {
        vanity: row.vanity,
        owner: row.owner,
        isChatDisabled: row.isChatDisabled,
        roomTitle: row.roomTitle,
        roomDescription: row.roomDescription,
        roomTitleColor: row.roomTitleColor,
        mediaPath: row.mediaPath,
      };
      this.io.of(this.roomId).emit("REC:getRoomState", roomState);
      socket.emit("REC:getRoomState", { ...roomState, password: row.password });
      socket.emit("successMessage", "Saved admin settings");
    } catch (e) {
      console.warn(e);
    }
  };

  private sendSignal = (
    socket: Socket,
    raw: unknown,
    eventName: "signal" | "signalSS",
  ) => {
    const data = raw as { to: string; msg: unknown; sharer?: boolean };
    // msg is the SDP/ICE object the peers exchange; cap the relay size
    // (real payloads sit far below this)
    if (!data || data.msg == null || JSON.stringify(data.msg).length > 20000) {
      return;
    }
    const fromClientId = socket.clientId;
    let sharerFlag = data.sharer;
    // Voice signaling only flows between voice members: socketIdMap holds
    // every connected socket, so without this check any guest can relay
    // frames (up to 100 msgs/s × 20KB) straight into a non-voice peer's
    // socket by aiming "signal" at them. Screen-share signaling (signalSS)
    // is exempt — a sharer needn't be in voice — but it must stay between
    // the sharer and their viewers, and which side of the PC map the
    // receiver installs a frame into is decided here: a forged `sharer`
    // flag (client-controlled before) let a member pose as the sharer and
    // overwrite a viewer's share PC with their own SDP
    if (eventName === "signal") {
      const sender = this.roster.find((u) => u.id === fromClientId);
      const target = this.roster.find((u) => u.id === data.to);
      if (!sender?.isVideoChat || !target?.isVideoChat) {
        return;
      }
    } else {
      const sharerId = this.getSharerId();
      if (!sharerId || (fromClientId !== sharerId && data.to !== sharerId)) {
        return;
      }
      sharerFlag = fromClientId === sharerId;
    }
    const toId = this.socketIdMap[data.to];
    if (toId) {
      this.io.of(this.roomId).to(toId).emit(eventName, {
        from: fromClientId,
        msg: data.msg,
        sharer: sharerFlag,
      });
    }
  };

  private onDisconnect = (socket: Socket) => {
    const { clientId } = socket;
    // Disconnecting socket is the current one
    if (socket.id === this.socketIdMap[clientId]) {
      let index = this.roster.findIndex((user) => user.id === clientId);
      if (index > -1) {
        this.roster.splice(index, 1);
      }
      // A sharer who dropped (tab closed, reload, crash) can't send
      // CMD:leaveScreenShare; without this the room stays stuck on their dead
      // screenshare:// media, which nobody can watch or unpause. A short
      // network blip drops the socket the same way while the capture keeps
      // running: give the sharer a grace window to reconnect and re-announce
      // (CMD:resumeShare) before declaring the share dead
      if (clientId === this.getSharerId()) {
        clearTimeout(this.sharerGraceTimer);
        this.sharerGraceTimer = setTimeout(() => {
          this.sharerGraceTimer = undefined;
          if (clientId === this.getSharerId()) {
            this.cmdHost(null, "");
          }
        }, SHARER_GRACE_MS);
      }
      this.io.of(this.roomId).emit("roster", this.getRosterForApp());
      // A controller who dropped the socket can't send the release; free the room
      // at once so someone else can take over (no grace needed: control isn't
      // state anyone waits on)
      if (this.extController === clientId) {
        this.extController = null;
        this.io.of(this.roomId).emit("REC:extControl", { id: null });
      }
      delete this.tsMap[clientId];
      delete this.bufferingMap[clientId];
      delete this.bufferPauseMap[clientId];
      // A stuck member leaving drops out of the watch; when nobody it waited
      // for is left, the room stays paused (nobody to have caught up)
      const watch = this.bufferResumeWatch;
      if (watch?.clientIds.includes(clientId)) {
        watch.clientIds = watch.clientIds.filter((id) => id !== clientId);
        if (!watch.clientIds.length) {
          this.bufferResumeWatch = null;
        }
      }
      delete this.bufferingChangeTimes[clientId];
      delete this.socketIdMap[clientId];
      delete this.pageIdMap[clientId];
      delete this.floatReactionTimes[clientId];
      delete this.intermissionTimes[clientId];
      delete this.sleepTimes[clientId];
      delete this.relayTimes[clientId];
      delete this.pictureTimes[clientId];
      delete this.signalTimes[clientId];
      delete this.typingTimes[clientId];
      delete this.siteUrlTimes[clientId];
      delete this.extControlTimes[clientId];
      // Prune name/picture entries nobody renders anymore. Chat history is
      // the only reason to keep a departed visitor's name/picture (the same
      // rule serialize() uses), and the roster keeps live seats labeled.
      // Without this the maps grow forever with every visitor (a 10KB
      // picture stays until the room is unloaded) and every new joiner
      // re-downloads all of it. Reconnects restore their own values: the
      // client re-emits CMD:name on connect and CMD:picture on login.
      const keep = new Set([
        ...this.chat.map((msg) => msg.id),
        ...this.roster.map((user) => user.id),
      ]);
      Object.keys(this.nameMap).forEach((id) => {
        if (!keep.has(id)) {
          delete this.nameMap[id];
        }
      });
      Object.keys(this.pictureMap).forEach((id) => {
        if (!keep.has(id)) {
          delete this.pictureMap[id];
        }
      });
    }
  };

  private kickUser = async (raw: unknown) => {
    const data = raw as { userToBeKicked: string };
    if (!data) {
      return;
    }
    const userToBeKickedSocket = this.io
      .of(this.roomId)
      .sockets.get(this.socketIdMap[data.userToBeKicked]);
    if (userToBeKickedSocket) {
      userToBeKickedSocket.emit("kicked");
      userToBeKickedSocket.disconnect();
    }
  };

  private deleteChatMessages = async (raw: unknown) => {
    const data = raw as {
      author: string;
      timestamp: string | undefined;
    };
    if (!data) {
      return;
    }
    if (!data.timestamp && !data.author) {
      this.chat.length = 0;
    } else {
      this.chat = this.chat.filter((msg) => {
        if (data.timestamp) {
          return msg.id !== data.author || msg.timestamp !== data.timestamp;
        }
        return msg.id !== data.author;
      });
    }
    this.io.of(this.roomId).emit("chatinit", this.chat);
    return;
  };
}

function isValidUUID(id: string) {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[4][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(
    id,
  );
}
