import React from "react";
import { Avatar } from "@mantine/core";
import styles from "./App.module.css";

// A short row of cinema seats under the screen, one occupant per person in the
// room. The shared velvet bench reads as a couple seat when there are two.
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
            <Avatar
              src={props.pictureMap[p.id] || undefined}
              alt={props.nameMap[p.id] || "?"}
              size={28}
              radius="xl"
            />
            <div className={styles.seatName}>
              {props.nameMap[p.id] || p.id.slice(0, 8)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
