// Small shared pieces for the screens: escaping, the VisualEyes mark, and the one gaze-target markup.
//
// Every interactive element is a `.g` (the ring the dwell fills) around a `.face` (the keycap). main.ts finds
// targets by `data-target` in whichever layer is on top, so a screen only has to render this markup and handle ids.

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The Eye Bubble mark from brand/logo/kit. Colours come from the theme unless given. */
export function logo(a = "var(--logoA)", b = "var(--logoB)", label = "VisualEyes logo"): string {
  return `<svg viewBox="0 0 256 256" role="img" aria-label="${label}"><path style="fill:${a}" fill-rule="evenodd" d="M24 108 A112.26 112.26 0 0 1 232 108 A112.26 112.26 0 0 1 150.0 175.82 L45.56 217.88 L62 156.55 A112.26 112.26 0 0 1 24 108 Z M96 108 A38 38 0 1 0 172 108 A38 38 0 1 0 96 108 Z"/><path style="fill:${b}" d="M121 108 A17 17 0 1 0 155 108 A17 17 0 1 0 121 108 Z"/></svg>`;
}

export const brand = () => `<div class="brand">${logo()}<span>VisualEyes</span></div>`;

export interface GOpts {
  /** Classes on the ring (`.g`), e.g. "round" or a layout class. */
  cls?: string;
  /** Classes on the face. Default "btn". */
  face?: string;
  style?: string;
  faceStyle?: string;
  /** Selected/active look. */
  on?: boolean;
  /** Shown but not selectable. */
  off?: boolean;
  /** Text to read before choosing (suggestions, phrases): gets the extra reading time. */
  read?: boolean;
}

/** One gaze target. `inner` is trusted markup; escape any user text before passing it. */
export function g(id: string, inner: string, o: GOpts = {}): string {
  return `<div class="g${o.cls ? ` ${o.cls}` : ""}${o.off ? " is-off" : ""}" data-target="${esc(id)}"${o.read ? " data-read" : ""}${o.style ? ` style="${o.style}"` : ""} role="button" aria-disabled="${o.off ? "true" : "false"}"><div class="face ${o.face ?? "btn"}${o.on ? " on" : ""}"${o.faceStyle ? ` style="${o.faceStyle}"` : ""}>${inner}</div></div>`;
}

export const honeycomb = (big = false) => `<div class="honeycomb${big ? " big" : ""}">${"<div></div>".repeat(7)}</div>`;
export const bars = (still = false) => `<div class="bars${still ? " still" : ""}">${"<i></i>".repeat(7)}</div>`;

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
