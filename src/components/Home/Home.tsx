import React, { useContext } from "react";
import { Button, Stepper } from "@mantine/core";
import {
  IconBrandDiscordFilled,
  IconBrandYoutubeFilled,
  IconBrowser,
  IconFile,
  IconLink,
  IconList,
  IconMessageFilled,
  type IconProps,
  IconRefresh,
  IconScreenShare,
  IconVideo,
} from "@tabler/icons-react";
import { NewRoomButton } from "../TopBar/TopBar";
import styles from "./Home.module.css";
import { MetadataContext } from "../../MetadataContext";

export const Home = () => {
  const { user } = useContext(MetadataContext);
  return (
    <div>
      <div className={styles.container}>
        <Hero
          heroText={"Watch videos together with friends anywhere."}
          subText={"No registration or download required."}
          action={
            <div className={styles.heroAction}>
              <NewRoomButton size="xl" />
            </div>
          }
          image={"/screenshot4.png"}
        />
        <div className={styles.featureSection}>
          <Feature
            Icon={IconBrowser}
            title={`VBrowser`}
            text="Watch together on a virtual browser running in the cloud."
          />
          <Feature
            Icon={IconBrandYoutubeFilled}
            title={`YouTube`}
            text="Watch videos together from YouTube."
          />
          <Feature
            Icon={IconScreenShare}
            title={`Screensharing`}
            text="Share a browser tab or your desktop."
          />
          <Feature
            Icon={IconFile}
            title={`File`}
            text="Upload and stream your own file."
          />
          <Feature
            Icon={IconLink}
            title={`URL`}
            text="Paste in a video URL for everyone to watch from."
          />
        </div>

        <Hero
          heroText={"React to moments together."}
          subText={"Find moments of shared joy even when you're apart."}
          image={"/screenshot18.png"}
          color="green"
        />
        <div className={styles.featureSection}>
          <Feature
            Icon={IconRefresh}
            title="Synchronized Play"
            text="Starts, stops, and seeks are synchronized to everyone, so take those restroom and snack breaks without worrying about falling behind."
          />
          <Feature
            Icon={IconMessageFilled}
            title="Chat"
            text="Chat with others in your room. Memes and inside jokes encouraged."
          />
          <Feature
            Icon={IconList}
            title="Playlists"
            text="Set up a whole list of videos to play next, and rearrange to your heart's content."
          />
          <Feature
            Icon={IconVideo}
            title="Video chat"
            text="Jump into video chat if you'd rather be face-to-face."
          />
        </div>

        <Hero
          heroText={"Theater mode."}
          subText={
            "Bring video and chat front-and-center for minimal distractions."
          }
          image={"/screenshot14.png"}
        />
        <div
          style={{
            padding: "30px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <div className={styles.heroText}>Get started!</div>
          <div className={styles.featureSection}>
            {/* active=-1 + no step selection: these steps are a story, not
                buttons — clicking/focusing them did nothing but trap Tab */}
            <Stepper active={-1} allowNextStepsSelect={false}>
              <Stepper.Step label="Make a room" />
              <Stepper.Step label="Share link with friends" />
              <Stepper.Step label="Pick something to watch" />
              <Stepper.Step label="Success!" />
            </Stepper>
          </div>
          {/* <div style={{ width: '160px' }}>
            <NewRoomButton />
          </div> */}
        </div>
      </div>
      <DiscordBot />
    </div>
  );
};

const Feature = ({
  Icon,
  text,
  title,
}: {
  Icon: React.ForwardRefExoticComponent<IconProps>;
  text: string;
  title: string;
}) => {
  return (
    <div
      style={{
        display: "flex",
        flex: "1 1 0px",
        flexDirection: "column",
        alignItems: "center",
        padding: "10px",
        minWidth: "180px",
      }}
    >
      <Icon size={80} />
      <h4 className={styles.featureTitle}>{title}</h4>
      <div className={styles.featureText}>{text}</div>
    </div>
  );
};

// Intrinsic sizes for the layout-shift reservation (and they let the browser
// size the image before it loads on a slow connection).
const HERO_DIMS: Record<string, [number, number]> = {
  "/screenshot4.png": [2194, 1308],
  "/screenshot18.png": [2124, 904],
  "/screenshot14.png": [3000, 1993],
  "/screenshot5.png": [1254, 654],
};

export const Hero = ({
  heroText,
  subText,
  subText2,
  action,
  image,
  color,
}: {
  heroText?: string;
  subText?: string;
  subText2?: string;
  action?: React.ReactNode;
  image?: string;
  color?: string;
}) => {
  return (
    <div className={`${styles.hero} ${color === "green" ? styles.green : ""}`}>
      <div
        style={{ flexDirection: color === "green" ? "row-reverse" : undefined }}
        className={styles.heroInner}
      >
        <div style={{ padding: "30px", flex: "1 1 0" }}>
          <div className={styles.heroText}>{heroText}</div>
          <div className={styles.subText}>{subText}</div>
          <div className={styles.subText}>{subText2}</div>
          {action}
        </div>
        <div className={styles.heroImg}>
          <img
            alt="hero"
            width={HERO_DIMS[image ?? ""]?.[0]}
            height={HERO_DIMS[image ?? ""]?.[1]}
            style={{ width: "100%", height: "auto", borderRadius: "10px" }}
            src={image}
          />
        </div>
      </div>
    </div>
  );
};

export const DiscordBot = () => {
  return (
    <div>
      <Hero
        color="green"
        heroText={
          "Add the WatchParty Discord bot to your server to easily generate WatchParty links."
        }
        subText={"/watch to generate a new empty room"}
        subText2={"/watch video <URL_HERE> to create a room with a video"}
        action={
          <Button
            leftSection={<IconBrandDiscordFilled />}
            component="a"
            size="lg"
            target="_blank"
            href="https://discord.com/api/oauth2/authorize?client_id=1071394728513380372&permissions=2147485696&scope=bot"
          >
            Add to Discord
          </Button>
        }
        image={"/screenshot5.png"}
      />
    </div>
  );
};
