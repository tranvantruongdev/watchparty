import styles from "./App.module.css";
import { getColorForStringHex } from "../../utils/utils";

// Stable per-user variety: one of 4 hair styles, from a hash of the user id
const hairStyle = (id: string) =>
  Math.abs(id.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) %
  4;

// A short row of seats under the screen, one 3D chibi per person in the room,
// shirt colored per person, hair varied per user, and a glowing headset while
// in voice chat.
export const TheaterSeats = (props: {
  participants: User[];
  nameMap: StringDict;
  pictureMap: StringDict;
  lightsDown: boolean;
}) => {
  if (props.participants.length === 0) {
    return null;
  }
  return (
    <div
      className={
        styles.theaterSeats + (props.lightsDown ? " " + styles.seatsDim : "")
      }
    >
      <div className={styles.seatRow}>
        {props.participants.map((p) => (
          <div key={p.id} className={styles.seat}>
            <div
              className={
                styles.chibi + (p.isVideoChat ? " " + styles.chibiVoice : "")
              }
              style={
                {
                  "--shirt": "#" + getColorForStringHex(p.id),
                } as React.CSSProperties
              }
              title={props.nameMap[p.id] || "?"}
            >
              <div
                className={
                  styles.chibiHair + " " + styles[`chibiHair${hairStyle(p.id)}`]
                }
              />
              <div className={styles.chibiHead} />
              <div className={styles.chibiEyes} />
              <div className={styles.chibiCheeks} />
              <div className={styles.chibiArm} />
              <div className={styles.chibiBody} />
              <div className={styles.chibiLegs} />
              {p.isVideoChat && <div className={styles.chibiHeadset} />}
            </div>
            <div className={styles.seatName}>
              {props.nameMap[p.id] || p.id.slice(0, 8)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
