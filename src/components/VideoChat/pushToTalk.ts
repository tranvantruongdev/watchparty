// Push-to-talk key tracking for VideoChat. This module only knows whether the
// key is held; VideoChat opens and closes the mic track from onChange.
import { getPushToTalk } from "./voicePrefs";

let held = false;

export const isPttHeld = () => held;

// The mic must be closed: push-to-talk is on and its key is not down
export const pttMicClosed = () => getPushToTalk().enabled && !held;

// Typing targets never trigger it (chat, name fields, the mic select). Inputs
// that take no text (the settings switches, sliders) do not count: a user who
// just clicked a switch must still be able to talk
const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "range",
  "button",
  "submit",
  "reset",
  "file",
  "color",
  "image",
]);
const isTypingTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
    return true;
  }
  return (
    el.tagName === "INPUT" &&
    !NON_TEXT_INPUTS.has((el as HTMLInputElement).type)
  );
};

// Start listening. The key, and whether the mode is on, are read from storage at
// each event, so changing them needs no restart. Anything that takes the page's
// keyboard focus away (window blur, tab hidden) releases the key: a keyup that
// never arrives must not leave the mic open. Returns the stop function, which
// releases too
export const startPushToTalk = (onChange: (held: boolean) => void) => {
  const set = (value: boolean) => {
    if (held !== value) {
      held = value;
      onChange(value);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const { enabled, code } = getPushToTalk();
    if (
      !enabled ||
      e.code !== code ||
      e.repeat ||
      e.defaultPrevented ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      isTypingTarget(e.target)
    ) {
      return;
    }
    set(true);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === getPushToTalk().code) {
      set(false);
    }
  };
  const release = () => set(false);
  const onVisibility = () => {
    if (document.hidden) {
      set(false);
    }
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", release);
    document.removeEventListener("visibilitychange", onVisibility);
    release();
  };
};
