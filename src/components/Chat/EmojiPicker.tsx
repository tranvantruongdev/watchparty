import Picker from "@emoji-mart/react";
import { init } from "emoji-mart";

// Runs on first import of this module (i.e. when the picker is opened), which
// is also when emoji-mart fetches its data set from the CDN
init({});

export default Picker;
