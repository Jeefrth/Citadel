// Keyboard shortcut that opens the command palette (search). Personal, per
// browser: kept in localStorage (try/catch: storage may be unavailable).
import { useEffect, useState } from "react";

export interface Shortcut {
  key: string; // KeyboardEvent.key, lower case (" " for space)
  mod?: boolean; // Cmd on macOS, Ctrl elsewhere
  ctrl?: boolean; // real Ctrl (also on macOS)
  shift?: boolean;
  alt?: boolean;
}

const STORAGE_KEY = "citadel.shortcut.palette";
const EVENT = "citadel-shortcut-change";
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const PRESETS: { id: string; label: string; value: Shortcut }[] = [
  { id: "mod-k", label: IS_MAC ? "Cmd+K" : "Ctrl+K", value: { key: "k", mod: true } },
  { id: "mod-shift-k", label: IS_MAC ? "Cmd+Maj+K" : "Ctrl+Maj+K", value: { key: "k", mod: true, shift: true } },
  { id: "slash", label: "/ (hors des champs de saisie)", value: { key: "/" } },
  { id: "ctrl-space", label: "Ctrl+Espace", value: { key: " ", ctrl: true } },
  { id: "mod-p", label: IS_MAC ? "Cmd+P" : "Ctrl+P", value: { key: "p", mod: true } },
];
export const DEFAULT_SHORTCUT: Shortcut = PRESETS[0].value;

export function loadShortcut(): Shortcut {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Shortcut;
      if (s && typeof s.key === "string" && s.key) return s;
    }
  } catch {
    /* storage unavailable or corrupt: default */
  }
  return DEFAULT_SHORTCUT;
}

export function saveShortcut(s: Shortcut | null): void {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* not persisted: still applied for this page */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: s ?? DEFAULT_SHORTCUT }));
}

export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return a.key === b.key && !!a.mod === !!b.mod && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest?.(".xterm");
}

/** A single character with no modifier ("/"): Shift is ignored (layouts differ). */
function isBareChar(s: Shortcut): boolean {
  return s.key.length === 1 && !s.mod && !s.ctrl && !s.alt;
}

export function matches(e: KeyboardEvent, s: Shortcut): boolean {
  if (e.key.toLowerCase() !== s.key) return false;
  if (isBareChar(s)) {
    return !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target);
  }
  if (e.shiftKey !== !!s.shift || e.altKey !== !!s.alt) return false;
  if (IS_MAC) return e.metaKey === !!s.mod && e.ctrlKey === !!s.ctrl;
  return !e.metaKey && e.ctrlKey === (!!s.mod || !!s.ctrl); // elsewhere Ctrl is the "mod" key
}

/** Shortcut from a key press (recording); null for a lone modifier or Escape. */
export function fromEvent(e: KeyboardEvent): Shortcut | null {
  if (["Meta", "Control", "Shift", "Alt", "Escape", "Tab", "CapsLock"].includes(e.key)) return null;
  const s: Shortcut = { key: e.key.toLowerCase() };
  if (IS_MAC ? e.metaKey : e.ctrlKey) s.mod = true;
  if (IS_MAC && e.ctrlKey) s.ctrl = true;
  if (e.altKey) s.alt = true;
  if (e.shiftKey && !(s.key.length === 1 && !s.mod && !s.ctrl && !s.alt)) s.shift = true;
  // A bare letter or digit would fire while reading: require a modifier (punctuation like "/" is fine)
  if (!s.mod && !s.ctrl && !s.alt && /^[a-z0-9]$/.test(s.key)) return null;
  return s;
}

const KEY_NAMES: Record<string, string> = {
  " ": "Espace", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", enter: "Entrée", backspace: "Retour",
};

export function formatShortcut(s: Shortcut): string {
  const key = KEY_NAMES[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key[0].toUpperCase() + s.key.slice(1));
  if (IS_MAC) {
    return `${s.ctrl ? "⌃" : ""}${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${s.mod ? "⌘" : ""}${key}`;
  }
  return [s.mod || s.ctrl ? "Ctrl" : "", s.alt ? "Alt" : "", s.shift ? "Maj" : "", key].filter(Boolean).join("+");
}

/** Current shortcut, updated live when changed in Mon compte (or in another tab). */
export function useShortcut(): [Shortcut, (s: Shortcut | null) => void] {
  const [s, setS] = useState<Shortcut>(loadShortcut);
  useEffect(() => {
    const onChange = () => setS(loadShortcut());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) onChange();
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [s, saveShortcut];
}
