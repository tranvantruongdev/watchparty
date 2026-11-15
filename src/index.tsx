import "@mantine/core/styles.css";
import "./index.css";

import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route } from "react-router-dom";

import { TopBar } from "./components/TopBar/TopBar";
import type firebase from "firebase/compat/app";
import {
  getRoomKey,
  loadIceServers,
  serverPath,
  softWhite,
} from "./utils/utils";

// Route components load on demand: the room page no longer downloads Home /
// Create / Pages / Discord code and vice versa. TopBar stays eager (it is on
// the room page too, via App).
const App = lazy(() =>
  import("./components/App/App").then((m) => ({ default: m.App })),
);
const Home = lazy(() =>
  import("./components/Home/Home").then((m) => ({ default: m.Home })),
);
const Create = lazy(() =>
  import("./components/Create/Create").then((m) => ({ default: m.Create })),
);
const Discord = lazy(() =>
  import("./components/Discord/Discord").then((m) => ({ default: m.Discord })),
);
const Terms = lazy(() =>
  import("./components/Pages/Pages").then((m) => ({ default: m.Terms })),
);
const Privacy = lazy(() =>
  import("./components/Pages/Pages").then((m) => ({ default: m.Privacy })),
);
const FAQ = lazy(() =>
  import("./components/Pages/Pages").then((m) => ({ default: m.FAQ })),
);
const Footer = lazy(() =>
  import("./components/Footer/Footer").then((m) => ({ default: m.Footer })),
);
import config from "./config";
import { getFirebase } from "./firebaseLazy";
import { DEFAULT_STATE, MetadataContext } from "./MetadataContext";
import { createTheme, MantineProvider } from "@mantine/core";

const theme = createTheme({
  white: softWhite,
  // Neon night look: violet accent, pill shapes, tinted translucent buttons
  primaryColor: "violet",
  defaultRadius: "xl",
  fontFamily: "'Be Vietnam Pro', system-ui, sans-serif",
  headings: { fontFamily: "'Be Vietnam Pro', system-ui, sans-serif" },
  components: {
    Button: { defaultProps: { variant: "light" } },
  },
});

const Debug = lazy(() => import("./components/Debug/Debug"));

const firebaseConfig = config.VITE_FIREBASE_CONFIG;
// initializeApp happens inside getFirebase (firebaseLazy), which is also what
// keeps the auth SDK out of the eager bundle until first auth use

// Store a ?key= room key before anything reads or drops the URL (this runs on
// every route: the landing page /?key=X must remember the key too, and the
// hash redirect below would otherwise lose it). Not on /debug: there the
// ?key= is the stats key, which must reach /stats in the URL and never
// becomes the room key.
// startsWith so /debug/ (trailing slash, which the route below also matches)
// doesn't store the stats key either
if (!window.location.pathname.startsWith("/debug")) {
  getRoomKey();
  // TURN relay credentials, ready before anyone opens voice or a share
  loadIceServers();
}

// Redirect old-style URLs
if (window.location.hash && window.location.pathname === "/") {
  const hashRoomId = window.location.hash.substring(1);
  window.location.href = "/watch/" + hashRoomId;
}

class WatchParty extends React.Component {
  public state = DEFAULT_STATE;
  async componentDidMount() {
    if (firebaseConfig) {
      const app = await getFirebase();
      app.auth().onAuthStateChanged(async (user: firebase.User | null) => {
        if (user) {
          // console.log(user);
          this.setState({ user });
          const token = await user.getIdToken();
          const response = await window.fetch(
            serverPath + `/metadata?uid=${user.uid}&token=${token}`,
          );
          const data = await response.json();
          this.setState({
            isSubscriber: data.isSubscriber,
            streamPath: data.streamPath,
            beta: data.beta,
          });
        }
      });
    } else {
      // Firebase isn't set up so enable subscriber features
      this.setState({
        isSubscriber: true,
      });
    }
  }
  render() {
    return (
      // <React.StrictMode>
      <MantineProvider theme={theme} forceColorScheme="dark">
        <MetadataContext.Provider value={this.state}>
          <BrowserRouter>
            <Suspense fallback={null}>
              <Route
                path="/"
                exact
                render={(props) => {
                  return (
                    <React.Fragment>
                      <TopBar hideNewRoom />
                      <Home />
                      <Footer />
                    </React.Fragment>
                  );
                }}
              />
              <Route
                path="/create"
                exact
                render={() => {
                  return <Create />;
                }}
              />
              <Route
                path="/watch/:roomId"
                exact
                render={(props) => {
                  return <App urlRoomId={props.match.params.roomId} />;
                }}
              />
              <Route
                path="/r/:vanity"
                exact
                render={(props) => {
                  return <App vanity={props.match.params.vanity} />;
                }}
              />
              <Route path="/terms">
                <TopBar />
                <Terms />
                <Footer />
              </Route>
              <Route path="/privacy">
                <TopBar />
                <Privacy />
                <Footer />
              </Route>
              <Route path="/faq">
                <TopBar />
                <FAQ />
                <Footer />
              </Route>
              <Route path="/discord/auth" exact>
                <Discord />
              </Route>
              <Route path="/debug">
                {/* hideNewRoom: creating a room from here would call getRoomKey
                  and store the ?key= stats key as the room key */}
                <TopBar hideNewRoom />
                <Suspense fallback={null}>
                  <Debug />
                </Suspense>
                <Footer />
              </Route>
            </Suspense>
          </BrowserRouter>
        </MetadataContext.Provider>
      </MantineProvider>
      // </React.StrictMode>
    );
  }
}
const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<WatchParty />);
