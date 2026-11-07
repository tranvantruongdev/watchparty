import type firebase from "firebase/compat/app";
import config from "./config";

// The compat auth SDK is only needed for sign-in; a signed-out viewer never
// touches it, so keep it out of the eager main chunk and load it on first
// auth use. initializeApp must run before any auth call, so the memoized
// getter does it before resolving.
let fb: Promise<(typeof import("firebase/compat/app"))["default"]> | undefined;
export const getFirebase = () => {
  if (!fb) {
    fb = Promise.all([
      import("firebase/compat/app"),
      import("firebase/compat/auth"),
    ]).then(([app]) => {
      if (config.VITE_FIREBASE_CONFIG) {
        app.default.initializeApp(JSON.parse(config.VITE_FIREBASE_CONFIG));
      }
      return app.default;
    });
  }
  return fb;
};
