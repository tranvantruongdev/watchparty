import React, { useContext, useEffect, useRef } from "react";
import { createRoom } from "../TopBar/TopBar";
import { Loader } from "@mantine/core";
import { MetadataContext } from "../../MetadataContext";

export const Create = () => {
  const { user } = useContext(MetadataContext);
  const buttonEl = useRef<HTMLButtonElement>(null);
  // One auto-click per mount: a timer created in the render body fired again on
  // every re-render (StrictMode, MetadataContext updates) and created extra rooms.
  useEffect(() => {
    const timer = setTimeout(() => {
      buttonEl?.current?.click();
    }, 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        width: "100vw",
        height: "100vh",
      }}
    >
      <Loader></Loader>
      <div>Creating room. . .</div>
      <button
        style={{ display: "none" }}
        ref={buttonEl}
        onClick={() => {
          const params = new URLSearchParams(window.location.search);
          const subtitles = params.get("subtitles") ?? undefined;
          createRoom(
            user,
            false,
            params.get("video") ?? undefined,
            // a subtitle URL only: the same http(s) shape the room would load
            subtitles && /^https?:\/\//i.test(subtitles)
              ? subtitles
              : undefined,
          );
        }}
      />
    </div>
  );
};
