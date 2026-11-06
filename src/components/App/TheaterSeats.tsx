import styles from "./App.module.css";
import { getColorForStringHex } from "../../utils/utils";

// A short row of seats under the screen, one 3D chibi per person in the room,
// shirt colored per person and a glowing headset while in voice chat.
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
              <div className={styles.chibiHair} />
              <div className={styles.chibiHead} />
              <div className={styles.chibiEyes} />
              <div className={styles.chibiBody} />
              <div className={styles.chibiLegs} />
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
