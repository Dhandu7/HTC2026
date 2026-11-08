// The user's settings: what the screens change and what is synced to their account.
import type { SelectionMode } from "./input/selection";

export interface Settings {
  selectionMode: SelectionMode;
  /** Hold-to-select time for every gaze target. */
  dwellMs: number;
  baselineDwellMs: number;
  baselinePrediction: boolean;
  screenDiagonalIn: number;
  distanceCm: number; // 0 = estimate from iris size
  hfovDeg: number;
  showCursor: boolean;
  hotCorner: boolean;
  voice: boolean;
  /** Three quick blinks re-center a drifting pointer. */
  blinkRecenter: boolean;
  /** Extra hold time on suggestions and phrases, so reading one never selects it. */
  readExtraMs: number;
  theme: string;
  /** Glass themes: 1 = less see-through, 3 = more. */
  see: number;
  keyBig: boolean;
  highContrast: boolean;
  reduceMotion: boolean;
  textBig: boolean;
  /** AI sentence suggestions. Word prediction is always on. */
  ai: boolean;
  confirmClear: boolean;
  speechRate: number;
  /** 0..100 */
  volume: number;
  /** Technical status line under the keyboard (fps, error, latency). */
  showStats: boolean;
  /** Download every calibration as a replayable file (raw landmarks; npm run replay). */
  saveCalibrations: boolean;
  participant: string;
}

export const DEFAULTS: Settings = {
  selectionMode: "dwell",
  dwellMs: 1500,
  baselineDwellMs: 1500,
  baselinePrediction: false,
  screenDiagonalIn: 14,
  distanceCm: 0,
  hfovDeg: 60,
  showCursor: true,
  hotCorner: true,
  blinkRecenter: true,
  voice: false,
  readExtraMs: 1000,
  theme: "dusk",
  see: 2,
  keyBig: false,
  highContrast: false,
  reduceMotion: false,
  textBig: false,
  ai: true,
  confirmClear: false,
  speechRate: 1,
  volume: 80,
  showStats: false,
  saveCalibrations: true,
  participant: "",
};

export interface Theme {
  id: string;
  name: string;
  desc: string;
  /** Swatches: background, surface, brand, ring. */
  sw: [string, string, string, string];
  glass?: boolean;
}

export const THEMES: Theme[] = [
  { id: "dusk", name: "Dusk", desc: "Dim and gentle on the eyes all day. The default.", sw: ["#262D31", "#434E54", "#2C7682", "#F0936E"] },
  { id: "paper", name: "Paper", desc: "Warm light, softened so it never glares.", sw: ["#E5DED1", "#EFE9DF", "#0B4F5C", "#C2401B"] },
  { id: "night", name: "Night", desc: "Dark, for low light and tired eyes.", sw: ["#0A171B", "#22383F", "#167F8E", "#FF8F6B"] },
  { id: "sea", name: "Sea", desc: "Cool blues, airy and clear.", sw: ["#DCE7ED", "#E9F0F4", "#1F5F8B", "#C2401B"] },
  { id: "sand", name: "Sand", desc: "Earthy terracotta with a teal ring.", sw: ["#E9DECD", "#F1E9DC", "#9A4320", "#0B4F5C"] },
  { id: "sage", name: "Sage", desc: "Soft greens, quiet and natural.", sw: ["#E1E7DC", "#EBEFE7", "#2F5D3A", "#C2401B"] },
  { id: "contrast", name: "High contrast", desc: "Pure black and white, for low vision. Brightest.", sw: ["#FFFFFF", "#000000", "#003F4A", "#FFD24D"] },
  { id: "glass", name: "Liquid glass", desc: "Light frosted glass. The app behind shows through.", sw: ["#CFE5E8", "rgba(255,255,255,0.6)", "#0B4F5C", "#E4572E"], glass: true },
  { id: "smoke", name: "Smoked glass", desc: "Dark frosted glass, see-through.", sw: ["#24363C", "rgba(12,28,34,0.7)", "#167F8E", "#FF8F6B"], glass: true },
];

export const themeOf = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

/** The classes on <body> for these settings: theme, glass level, and the accessibility switches. */
export function lookClasses(s: Settings): string[] {
  const t = themeOf(s.theme);
  return [
    "ve",
    `t-${t.id}`,
    ...(t.glass ? ["glass", `see-${s.see}`] : []),
    ...(s.highContrast ? ["hc"] : []),
    ...(s.reduceMotion ? ["rm"] : []),
    ...(s.textBig ? ["textbig"] : []),
    ...(s.keyBig ? ["keybig"] : []),
  ];
}
