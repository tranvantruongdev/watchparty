import axios from "axios";

// HTTP client errors (axios, gaxios) carry the request they failed on: headers
// such as Api-Key / Authorization and URLs with ?key=. util.inspect — so every
// console.warn(e) — prints all of it: one failed OpenSubtitles or YouTube call
// wrote the API key to the log (measured 2 and 4 copies). Hide those parts
// from inspect; code reading e.config / e.response.status still works.
export function hideRequest(e: unknown) {
  for (const o of [e, (e as { response?: unknown } | null)?.response]) {
    if (o && typeof o === "object") {
      for (const key of ["config", "request"]) {
        if (Object.hasOwn(o, key)) {
          Object.defineProperty(o, key, { enumerable: false });
        }
      }
    }
  }
  return e;
}

// Every axios call in this process (OpenSubtitles, Discord, VM providers) goes
// through the default instance, so one interceptor covers them all
axios.interceptors.response.use(undefined, (e) =>
  Promise.reject(hideRequest(e)),
);
