import React, { useCallback, useContext, useState } from "react";
import {
  serverPath,
  getUserImage,
  softWhite,
  getRoomKey,
} from "../../utils/utils";
import { ActionIcon, Avatar, Button, Menu, Text } from "@mantine/core";
import type firebase from "firebase/compat/app";
import { LoginModal } from "../Modal/LoginModal";
import { SubscribeButton } from "../SubscribeButton/SubscribeButton";
import { ProfileModal } from "../Modal/ProfileModal";
import Announce from "../Announce/Announce";
import { InviteButton } from "../InviteButton/InviteButton";
import { MetadataContext } from "../../MetadataContext";
import config from "../../config";
import {
  IconBrandDiscord,
  IconBrandFacebookFilled,
  IconBrandGithub,
  IconBrandGoogleFilled,
  IconCirclePlusFilled,
  IconDatabase,
  IconLogin,
  IconMailFilled,
  IconTrash,
} from "@tabler/icons-react";
import styles from "./TopBar.module.css";

export async function createRoom(
  user: firebase.User | undefined,
  openNewTab: boolean | undefined,
  video: string = "",
) {
  const uid = user?.uid;
  const token = await user?.getIdToken();
  let response: Response;
  try {
    response = await fetch(serverPath + "/createRoom", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uid,
        token,
        video,
        roomKey: getRoomKey(),
      }),
    });
  } catch {
    alert("Could not reach the server. Check your connection and try again.");
    return;
  }
  if (response.status === 403) {
    alert("This theater is private. Open the invite link you were given.");
    return;
  }
  if (!response.ok) {
    // e.g. the shard is out of rooms — "/watch" + undefined would just confuse
    alert("Could not create a room. Try again in a moment.");
    return;
  }
  const data = await response.json();
  const { name } = data;
  if (openNewTab) {
    window.open("/watch" + name);
  } else {
    window.location.assign("/watch" + name);
  }
}

export const NewRoomButton = (props: {
  size?: string;
  openNewTab?: boolean;
}) => {
  const context = useContext(MetadataContext);
  const [pending, setPending] = useState(false);
  const onClick = useCallback(async () => {
    // A slow /createRoom + a second impatient click used to create two rooms.
    if (pending) return;
    setPending(true);
    try {
      await createRoom(context.user, props.openNewTab);
    } finally {
      setPending(false);
    }
  }, [context.user, props.openNewTab, pending]);
  return (
    <Button
      size={props.size}
      onClick={onClick}
      loading={pending}
      disabled={pending}
      leftSection={<IconCirclePlusFilled />}
    >
      New Room
    </Button>
  );
};

type SignInButtonProps = {};

export class SignInButton extends React.Component<SignInButtonProps> {
  static contextType = MetadataContext;
  declare context: React.ContextType<typeof MetadataContext>;
  public state = { isLoginOpen: false, isProfileOpen: false, userImage: null };

  async componentDidUpdate(prevProps: SignInButtonProps) {
    if (this.context.user && !this.state.userImage) {
      this.setState({ userImage: await getUserImage(this.context.user) });
    }
  }

  render() {
    if (this.context.user) {
      return (
        <div
          role="button"
          tabIndex={0}
          aria-label="Open profile"
          className="profileButton"
          onKeyDown={(e: React.KeyboardEvent) => {
            // Keys typed inside the profile modal bubble here through the portal
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              this.setState({ isProfileOpen: true });
            }
          }}
          style={{
            margin: "4px",
            minWidth: "40px",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <Avatar
            src={this.state.userImage}
            alt="Profile"
            onClick={() => this.setState({ isProfileOpen: true })}
          />
          {this.state.isProfileOpen && this.context.user && (
            <ProfileModal
              userImage={this.state.userImage}
              close={() => this.setState({ isProfileOpen: false })}
            />
          )}
        </div>
      );
    }
    return (
      <React.Fragment>
        {this.state.isLoginOpen && (
          <LoginModal
            closeModal={() => this.setState({ isLoginOpen: false })}
          />
        )}
        <Button
          leftSection={<IconLogin />}
          onClick={() => this.setState({ isLoginOpen: true })}
        >
          Sign in
        </Button>
      </React.Fragment>
    );
  }
}

export class ListRoomsButton extends React.Component<{}> {
  static contextType = MetadataContext;
  declare context: React.ContextType<typeof MetadataContext>;
  public state = { rooms: [] as PersistentRoom[] };

  componentDidMount() {
    this.refreshRooms();
  }

  refreshRooms = async () => {
    if (this.context.user) {
      const token = await this.context.user.getIdToken();
      const response = await fetch(
        serverPath + `/listRooms?uid=${this.context.user?.uid}&token=${token}`,
      );
      this.setState({ rooms: await response.json() });
    }
  };

  deleteRoom = async (roomId: string) => {
    if (this.context.user) {
      const token = await this.context.user.getIdToken();
      await fetch(
        serverPath +
          `/deleteRoom?uid=${this.context.user?.uid}&token=${token}&roomId=${roomId}`,
        { method: "DELETE" },
      );
      this.setState({
        rooms: this.state.rooms.filter((room) => room.roomId !== roomId),
      });
      this.refreshRooms();
    }
  };

  render() {
    return (
      <Menu>
        <Menu.Target>
          <Button
            color="grey"
            onClick={this.refreshRooms}
            leftSection={<IconDatabase />}
          >
            My rooms
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {this.state.rooms.length === 0 && (
            <Menu.Item disabled>You have no permanent rooms.</Menu.Item>
          )}
          {this.state.rooms.map((room: any) => {
            return (
              <Menu.Item
                key={room.roomId}
                component="a"
                href={
                  room.vanity ? "/r/" + room.vanity : "/watch" + room.roomId
                }
              >
                <div style={{ display: "flex", alignItems: "center" }}>
                  <div>
                    <Text>
                      {room.vanity
                        ? `/r/${room.vanity}`
                        : `/watch${room.roomId}`}
                    </Text>
                    <Text size="xs" c="grey">
                      {room.roomId}
                    </Text>
                  </div>
                  <div style={{ marginLeft: "auto", paddingLeft: "20px" }}>
                    <ActionIcon
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        e.nativeEvent.stopImmediatePropagation();
                        e.preventDefault();
                        this.deleteRoom(room.roomId);
                      }}
                      color="red"
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </div>
                </div>
              </Menu.Item>
            );
          })}
        </Menu.Dropdown>
      </Menu>
    );
  }
}

export const TopBar = (props: {
  hideNewRoom?: boolean;
  hideSignin?: boolean;
  hideMyRooms?: boolean;
  roomTitle?: string;
  roomDescription?: string;
  roomTitleColor?: string;
}) => {
  const context = useContext(MetadataContext);
  const subscribeButton = <SubscribeButton />;
  return (
    <React.Fragment>
      <div className={styles.bar}>
        <a href="/" style={{ display: "flex" }}>
          <img className={styles.logo} src="/logo192.png" alt="WatchParty" />
        </a>
        {props.roomTitle || props.roomDescription ? (
          <div className={styles.titleBlock}>
            <div
              className={styles.title}
              style={{ color: props.roomTitleColor || softWhite }}
            >
              {props.roomTitle?.toUpperCase()}
            </div>
            <Text size="sm">{props.roomDescription}</Text>
          </div>
        ) : (
          <React.Fragment>
            <a href="/" className={styles.wordmark}>
              <div className={styles.wordmarkInner}>
                <div
                  className={styles.wordmarkPart}
                  style={{ color: "#a78bfa" }}
                >
                  Watch
                </div>
                <div
                  className={styles.wordmarkPart}
                  style={{ color: "#f472b6" }}
                >
                  Party
                </div>
              </div>
            </a>
          </React.Fragment>
        )}
        <Announce />
        <div className={styles.actions}>
          <div className={styles.socials}>
            <ActionIcon
              component="a"
              color="gray"
              size="lg"
              href="https://discord.gg/3rYj5HV"
              target="_blank"
              rel="noopener noreferrer"
              title="Discord"
              aria-label="Discord"
            >
              <IconBrandDiscord />
            </ActionIcon>
            <ActionIcon
              component="a"
              color="gray"
              size="lg"
              href="https://github.com/howardchung/watchparty"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
              aria-label="GitHub"
            >
              <IconBrandGithub />
            </ActionIcon>
          </div>
          {!props.hideNewRoom && <NewRoomButton openNewTab />}
          {!props.hideMyRooms && context.user && <ListRoomsButton />}
          {subscribeButton}
          {!props.hideSignin && <SignInButton />}
        </div>
      </div>
    </React.Fragment>
  );
};
