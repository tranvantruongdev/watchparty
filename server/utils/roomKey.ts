import { createHash, timingSafeEqual } from "node:crypto";
import config from "../config.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

// With ROOM_KEY set, only clients that know it can create or join rooms
export function hasRoomKey(given: unknown) {
  if (!config.ROOM_KEY) {
    return true;
  }
  return (
    typeof given === "string" &&
    timingSafeEqual(digest(given), digest(config.ROOM_KEY))
  );
}
