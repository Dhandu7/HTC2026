import "./style.css";
import { FaceTracker } from "./gaze/tracker";
import { GazeEngine, type GazeModel, type GazePoint } from "./gaze/engine";
import { estimateDistanceCm, type ErrorStats, type ViewingGeometry } from "./gaze/accuracy";
import { runCalibration, type CalibrationSize } from "./ui/calibration";
import { AccumulatingDwellSelector, BlinkSelector, TargetTracker, type Rect, type SelectionMode } from "./input/selection";
import { PredictionEngine } from "./predict/engine";
import { CORE_WORDS, SEED_PHRASES, BENCHMARK_SENTENCES } from "./predict/vocab";
import { llmAvailable } from "./predict/llm";
import { BaselineKeyboard, GazeTypeKeyboard, type KeyboardHost } from "./ui/keyboards";
import { TypingSession, normalizeText, type RunResult } from "./metrics/session";
import { startVoiceCommands } from "./input/voice";
import { download, recordSession } from "./record/recorder";
import { SessionTape } from "./record/tape";
import type { SessionMeta } from "./record/format";

// ---------- Electron bridge (absent in the browser) ----------
interface Bridge {
  setExpanded(expanded: boolean): void;
  setClickable(clickable: boolean): void;
  insertText(text: string): Promise<boolean>;
  onVisibility(cb: (expanded: boolean) => void): void;
  shortcut: string;
}
const bridge = (window as unknown as { gazetype?: Bridge }).gazetype;
const isOverlay = !!bridge;

// ---------- settings ----------
interface Settings {
  selectionMode: SelectionMode;
  dwellMs: number;
  baselineDwellMs: number;
  baselinePrediction: boolean;
  screenDiagonalIn: number;
  distanceCm: number; // 0 = estimate from iris size
  hfovDeg: number;
  calPoints: CalibrationSize;
  model: GazeModel;
  saveCalibrations: boolean;
  participant: string;
  showCursor: boolean;
  hotCorner: boolean;
  voice: boolean;
}
const DEFAULTS: Settings = {
  selectionMode: "dwell",
  dwellMs: 700,
  baselineDwellMs: 1000,
  baselinePrediction: false,
  screenDiagonalIn: 14,
  distanceCm: 0,
  hfovDeg: 60,
  calPoints: 25,
  model: "kernel",
  saveCalibrations: true,
  participant: "",
  showCursor: true,
  hotCorner: true,
  voice: false,
};
const load = <T>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? { ...d, ...JSON.parse(v) } : d;
  } catch {
    return d;
  }
};
const settings: Settings = load("gazetype.settings.v1", DEFAULTS);
const saveSettings = () => localStorage.setItem("gazetype.settings.v1", JSON.stringify(settings));

// ---------- DOM ----------
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const board = $("#board");
const output = $("#output");
const statusEl = $("#status");
const cursor = $("#cursor");
const calRoot = $("#calibration");
const home = $("#home");
const targetBar = $("#target-bar");
const toast = $("#toast");
const pill = $("#pill");
if (isOverlay) {
  document.documentElement.classList.add("overlay");
  document.body.classList.add("overlay");
}

function showToast(html: string, ms = 4000) {
  toast.innerHTML = html;
  toast.hidden = false;
  clearTimeout((showToast as unknown as { h?: number }).h);
  (showToast as unknown as { h?: number }).h = window.setTimeout(() => (toast.hidden = true), ms);
}

// ---------- core objects ----------
const gaze = new GazeEngine();
gaze.setModel(settings.model);
const tracker = new FaceTracker($("#video"));
tracker.onFrame = gaze.handleFrame;
const predictor = new PredictionEngine({
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
});
let lastError: ErrorStats | null = null;
let llmOn = false;

const host: KeyboardHost = { refresh: () => render(), action: (a) => void doAction(a), overlay: isOverlay };
const gazeKb = new GazeTypeKeyboard(predictor, host);
const baseKb = new BaselineKeyboard(predictor, host, settings.baselinePrediction);
let kb: GazeTypeKeyboard | BaselineKeyboard = gazeKb;

// Switch 200 ms + accumulating dwell (decay 0.5): in dwell simulation on recordings this
// turned most timed-out looks into correct selections (77% -> 84% correct) without adding
// wrong ones. See VisualEyes/src/eval/dwell.ts.
const targetTracker = new TargetTracker(36, 200);
const dwell = new AccumulatingDwellSelector(settings.dwellMs, 0.5);
const blink = new BlinkSelector();
let session = new TypingSession(kb.name, settings.selectionMode);
let benchmark: { index: number; target: string } | null = null;
let benchIndex = 0;
let expanded = !isOverlay;

function geometry(): ViewingGeometry {
  const est = estimateDistanceCm(gaze.irisDiameter, settings.hfovDeg);
  return {
    screenDiagonalIn: settings.screenDiagonalIn,
    screenWidthPx: screen.width,
    screenHeightPx: screen.height,
    distanceCm: settings.distanceCm || (Number.isFinite(est) ? est : 60),
  };
}

// ---------- rendering ----------
let rects: Rect[] = [];
let rectsDirty = true;
function render() {
  kb.render(board);
  output.innerHTML = kb.displayHtml();
  rectsDirty = true;
  document.body.dataset.kb = kb.name;
  $("#kb-toggle").textContent = kb === gazeKb ? "Keyboard: GazeType" : "Keyboard: Baseline QWERTY";
}
function measure() {
  if (!rectsDirty) return;
  rects = [...board.querySelectorAll<HTMLElement>("[data-target]")].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.target!, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  rectsDirty = false;
}
window.addEventListener("resize", () => (rectsDirty = true));

function updateStatus() {
  const g = geometry();
  const parts = [
    gaze.source === "camera" ? (gaze.faceVisible ? `<b class="ok">● face</b>` : `<b class="bad">● no face</b>`) : `<b>🖱 mouse</b>`,
    gaze.source === "camera" ? `${tracker.fps} fps · ${gaze.inferMs.toFixed(0)} ms` : "",
    lastError ? `error ${lastError.meanDeg.toFixed(1)}° (±${lastError.precisionDeg.toFixed(1)}°)` : gaze.source === "camera" ? "not calibrated" : "",
    gaze.source === "camera" && gaze.calibrated
      ? gaze.lastPoint.confidence < 0.5
        ? `<b class="bad">● moved since calibrating</b>`
        : `<b class="ok">● posture ok</b>`
      : "",
    gaze.source === "camera" ? `${g.distanceCm.toFixed(0)} cm${settings.distanceCm ? "" : " est."}` : "",
    gaze.implicitCount ? `+${gaze.implicitCount} auto-cal` : "",
    `${settings.selectionMode}${settings.selectionMode === "dwell" ? ` ${kb === gazeKb ? settings.dwellMs : settings.baselineDwellMs} ms` : ""}`,
    settings.selectionMode === "blink" ? `blinks ✓${blink.accepted} ✗${blink.rejectedShort + blink.rejectedLong}` : "",
    llmOn ? "✨ LLM on" : "on-device only",
  ];
  statusEl.innerHTML = parts.filter(Boolean).join(" · ");
}
setInterval(updateStatus, 500);

// ---------- selection ----------
let pendingImplicit: { timer: number } | null = null;

function applySelection(id: string, t: number) {
  const el = board.querySelector<HTMLElement>(`[data-target="${CSS.escape(id)}"]`);
  const kind = kb.select(id);
  if (kind === "delete" && pendingImplicit) {
    clearTimeout(pendingImplicit.timer);
    pendingImplicit = null;
  }
  session.record(t, kind);
  // Implicit recalibration: if this selection isn't undone within 2 s, treat the
  // fixation before it as a labelled sample at the target's centre.
  if (gaze.source === "camera" && el && kind !== "delete") {
    const r = el.getBoundingClientRect();
    const win = settings.selectionMode === "blink" ? [t - 900, t - 400] : [t - 450, t - 50];
    const feats = gaze.meanFeatures(win[0], win[1]);
    if (feats) {
      if (pendingImplicit) clearTimeout(pendingImplicit.timer);
      pendingImplicit = {
        timer: window.setTimeout(() => {
          gaze.addImplicitSample(feats, r.left + r.width / 2, r.top + r.height / 2);
          pendingImplicit = null;
        }, 2000),
      };
    }
  }
  el?.classList.add("fired");
  render();
  checkBenchmark(t);
}

board.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target]");
  if (el) applySelection(el.dataset.target!, performance.now());
});

let lastHover: HTMLElement | null = null;
let hotCornerSince: number | null = null;

function onGaze(g: GazePoint) {
  if (!expanded) {
    hotCorner(g);
    return;
  }
  postureWatch(g);
  const show = settings.showCursor && g.valid && Number.isFinite(g.x);
  cursor.hidden = !show;
  if (show) {
    const r = Math.max(14, lastError ? Math.min(lastError.meanPx, 200) : 14);
    cursor.style.transform = `translate(${g.x - r}px, ${g.y - r}px)`;
    cursor.style.width = cursor.style.height = `${2 * r}px`;
  }
  if (!calRoot.hidden || !home.hidden) return;
  measure();
  // Low confidence (face lost, or head far from the calibration pose): don't let dwell
  // build up on whatever the drifting cursor happens to cross.
  const target = g.valid && g.confidence >= 0.3 ? targetTracker.update(g.t, rects, g.x, g.y) : null;
  let out;
  if (settings.selectionMode === "blink" && g.source === "camera") out = blink.update(g.t, target, g.blinkL, g.blinkR);
  else if (settings.selectionMode === "click") out = { selected: null, progress: 0, target };
  else {
    dwell.dwellMs = kb === gazeKb ? settings.dwellMs : settings.baselineDwellMs;
    out = dwell.update(g.t, target);
  }
  const el = out.target ? board.querySelector<HTMLElement>(`[data-target="${CSS.escape(out.target)}"]`) : null;
  if (lastHover && lastHover !== el) {
    lastHover.classList.remove("hover");
    lastHover.style.removeProperty("--p");
  }
  if (el) {
    el.classList.add("hover");
    el.style.setProperty("--p", String(out.progress));
  }
  lastHover = el;
  if (out.selected) applySelection(out.selected, g.t);
}
gaze.onGaze(onGaze);

// ---------- overlay: show/hide ----------
function setExpanded(v: boolean, fromMain = false) {
  expanded = v;
  document.body.classList.toggle("collapsed", !v);
  cursor.hidden = !v;
  if (v) {
    targetTracker.reset();
    dwell.reset();
    rectsDirty = true;
  }
  if (!fromMain) bridge?.setExpanded(v);
}
bridge?.onVisibility((v) => setExpanded(v, true));
// The 👁 badge: hover makes the click-through window clickable, click opens the keyboard.
pill.addEventListener("mouseenter", () => bridge?.setClickable(true));
pill.addEventListener("mouseleave", () => bridge?.setClickable(false));
pill.addEventListener("click", () => setExpanded(true));

/** Look at the top-right corner for 1.5 s to open the overlay — no hands or voice needed. */
function hotCorner(g: GazePoint) {
  if (!settings.hotCorner || g.source !== "camera" || !gaze.calibrated || !g.valid) {
    hotCornerSince = null;
    pill.style.setProperty("--p", "0");
    return;
  }
  const inCorner = g.x > innerWidth - 160 && g.y < 160;
  if (!inCorner) {
    hotCornerSince = null;
    pill.style.setProperty("--p", "0");
    return;
  }
  hotCornerSince ??= g.t;
  const p = Math.min(1, (g.t - hotCornerSince) / 1500);
  pill.style.setProperty("--p", String(p));
  if (p >= 1) {
    hotCornerSince = null;
    setExpanded(true);
  }
}

// ---------- actions ----------
function speak(text: string) {
  if (!text.trim()) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

async function doAction(a: string) {
  const text = kb.text().trim();
  switch (a) {
    case "speak":
      speak(text);
      if (!benchmark && text) {
        predictor.learn(text);
        kb.clear();
      }
      break;
    case "insert":
      if (text && bridge) {
        predictor.learn(text);
        const ok = await bridge.insertText(text);
        showToast(ok ? "Inserted into the focused app" : "Copied — press ⌘V / Ctrl+V to paste (grant Accessibility for auto-paste)");
        kb.clear();
      }
      break;
    case "copy":
      if (text) {
        await navigator.clipboard.writeText(text).catch(() => {});
        predictor.learn(text);
        showToast("Copied to clipboard");
      }
      break;
    case "hide":
      setExpanded(false);
      break;
    case "recal":
      await calibrate();
      break;
    case "settings":
      openSettings();
      break;
    case "benchmark-done":
      if (benchmark) finishRun(performance.now());
      else showToast("No benchmark run active — start one from the top bar.");
      break;
  }
  render();
}

function smallestTargetPx() {
  rectsDirty = true;
  measure();
  return rects.length ? Math.round(Math.min(...rects.map((r) => Math.min(r.right - r.left, r.bottom - r.top)))) : 0;
}

// ---------- calibration ----------
async function calibrate() {
  if (gaze.source !== "camera") {
    showToast("Calibration needs the camera. You're in mouse mode.");
    return;
  }
  const tape = settings.saveCalibrations ? new SessionTape(gaze) : null;
  const stats = await runCalibration(gaze, calRoot, geometry, settings.calPoints, tape ?? undefined);
  tape?.stop();
  if (stats && tape) {
    // Save the calibration as a replayable session (frames + targets), for offline evaluation.
    const g = geometry();
    const session = tape.toSession(
      {
        participant: settings.participant || "anon",
        glasses: false,
        lighting: "",
        notes: `app calibration, ${settings.calPoints} pts, model ${settings.model}, hit6 ${Math.round(stats.hit6 * 100)}%`,
        mode: "calibration",
        distanceCm: settings.distanceCm,
        screenDiagonalIn: g.screenDiagonalIn,
        hfovDeg: settings.hfovDeg,
      },
      tracker,
    );
    const stamp = session.createdAt.replace(/[:.]/g, "-");
    download(new Blob([JSON.stringify(session)], { type: "application/json" }), `gazecal-${(settings.participant || "anon").replace(/[^\w-]+/g, "_")}-${stamp}.json`);
  }
  if (!stats) {
    showToast("Calibration cancelled or failed.");
    return;
  }
  lastError = stats;
  const g = geometry();
  showToast(
    `<b>Calibrated (${stats.points} points).</b> Hit rate on check points: <b>${Math.round(stats.hit6 * 100)}%</b> for 6 large buttons, ${Math.round(
      stats.hit16 * 100,
    )}% for a 4×4 grid.<br>Mean error ${stats.meanDeg.toFixed(2)}° (${stats.meanPx.toFixed(0)} px), precision ±${stats.precisionDeg.toFixed(2)}°, n=${stats.n}.<br><small>Assumes ${settings.screenDiagonalIn}" screen at ${g.distanceCm.toFixed(0)} cm${
      settings.distanceCm ? "" : " (estimated from iris size)"
    }. Smallest target here: ${smallestTargetPx()} px.</small>`,
    9000,
  );
  localStorage.setItem("gazetype.lastError.v1", JSON.stringify(stats));
}

// ---------- posture ----------
let lowSince: number | null = null;
let lastPostureToast = 0;
/** If confidence stays low for 2 s, suggest recalibrating (at most every 20 s). */
function postureWatch(g: GazePoint) {
  if (g.source !== "camera" || !gaze.calibrated || !calRoot.hidden) return;
  if (g.confidence >= 0.5) {
    lowSince = null;
    return;
  }
  lowSince ??= g.t;
  if (g.t - lowSince > 2000 && g.t - lastPostureToast > 20_000) {
    lastPostureToast = g.t;
    showToast("You've moved a long way from where you calibrated, so tracking may be off. Move back, or press <b>◎ Calibrate</b>.", 6000);
  }
}

// ---------- start ----------
async function startCamera() {
  home.querySelector<HTMLElement>(".home-msg")!.textContent = "Loading face model…";
  try {
    const where = await tracker.init();
    await tracker.start();
    gaze.source = "camera";
    home.hidden = true;
    showToast(`Camera on (${where}). Video stays on this device.`);
    await calibrate();
  } catch (err) {
    home.querySelector<HTMLElement>(".home-msg")!.textContent = `Camera failed: ${(err as Error).message}. Try mouse mode.`;
  }
}

function startMouse() {
  gaze.source = "mouse";
  home.hidden = true;
  showToast("Mouse mode: hover to dwell-select, or click. Same UI and metrics as gaze.");
}

$("#start-camera").addEventListener("click", () => void startCamera());
$("#start-mouse").addEventListener("click", startMouse);
$("#kb-toggle").addEventListener("click", () => {
  kb = kb === gazeKb ? baseKb : gazeKb;
  kb.clear();
  if (benchmark) startRun(benchmark.index);
  else session = new TypingSession(kb.name, settings.selectionMode);
  render();
});
$("#recal").addEventListener("click", () => void calibrate());
$("#record-btn").addEventListener("click", openRecord);

// ---------- session recording (offline evaluation) ----------
function openRecord() {
  if (gaze.source !== "camera") {
    showToast("Recording needs the camera. You're in mouse mode.");
    return;
  }
  const dlg = $<HTMLDialogElement>("#record");
  const form = dlg.querySelector("form")!;
  dlg.onclose = async () => {
    if (dlg.returnValue !== "ok") return;
    const fd = new FormData(form);
    const g = geometry();
    const meta: SessionMeta = {
      participant: String(fd.get("participant") ?? "").trim(),
      mode: fd.get("mode") === "short" ? "short" : fd.get("mode") === "quick" ? "quick" : "full",
      glasses: fd.get("glasses") === "on",
      lighting: String(fd.get("lighting") ?? ""),
      notes: String(fd.get("notes") ?? ""),
      distanceCm: Number(fd.get("distanceCm")) || 0,
      screenDiagonalIn: g.screenDiagonalIn,
      hfovDeg: settings.hfovDeg,
    };
    const n = await recordSession(gaze, tracker, calRoot, { meta, video: fd.get("video") === "on" });
    showToast(
      n === null
        ? "Recording cancelled before validation finished; nothing saved."
        : `Saved session (${n} frames) to your Downloads. Move it to VisualEyes/recordings/ and run <code>npm run replay -- recordings/*.json</code>.`,
      9000,
    );
  };
  dlg.showModal();
}
$("#settings-btn").addEventListener("click", openSettings);
$("#bench-btn").addEventListener("click", () => startRun(benchIndex));
$("#results-btn").addEventListener("click", showResults);

// ---------- benchmark ----------
const RUNS_KEY = "gazetype.runs.v1";
const runs = (): RunResult[] => {
  try {
    return JSON.parse(localStorage.getItem(RUNS_KEY) ?? "[]");
  } catch {
    return [];
  }
};

function startRun(index: number) {
  const target = BENCHMARK_SENTENCES[index % BENCHMARK_SENTENCES.length];
  benchmark = { index, target };
  kb.clear();
  session = new TypingSession(kb.name, gaze.source === "mouse" ? `${settings.selectionMode}+mouse` : settings.selectionMode, target);
  targetBar.hidden = false;
  targetBar.innerHTML = `Type: <b>${target}</b> <small>(timer starts on first selection · ${kb === gazeKb ? "GazeType" : "Baseline"})</small> <button id="next-sentence" type="button">⏭ Next sentence</button>`;
  $("#next-sentence").addEventListener("click", () => startRun(++benchIndex));
  blink.accepted = blink.rejectedShort = blink.rejectedLong = 0;
  render();
}

function checkBenchmark(t: number) {
  if (benchmark && normalizeText(kb.text()) === normalizeText(benchmark.target)) finishRun(t);
}

function finishRun(t: number) {
  if (!benchmark) return;
  const r = session.finish(t, kb.text(), {
    rejectedBlinks: settings.selectionMode === "blink" ? blink.rejectedShort + blink.rejectedLong : undefined,
  });
  localStorage.setItem(RUNS_KEY, JSON.stringify([...runs(), r]));
  showToast(
    `<b>Run done:</b> ${r.wpm.toFixed(1)} WPM · ${r.selections} selections (${r.selectionsPerChar.toFixed(2)}/char) · ${(r.errorRate * 100).toFixed(
      0,
    )}% error · ${r.likelyFalseSelections} likely false selections`,
    8000,
  );
  benchmark = null;
  targetBar.hidden = true;
  kb.clear();
  render();
}

function showResults() {
  const all = runs();
  const groups = new Map<string, RunResult[]>();
  for (const r of all) {
    const k = `${r.keyboard} · ${r.selectionMode}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const avg = (rs: RunResult[], f: (r: RunResult) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  const rows = [...groups]
    .map(
      ([k, rs]) =>
        `<tr><td>${k}</td><td>${rs.length}</td><td><b>${avg(rs, (r) => r.wpm).toFixed(1)}</b></td><td>${avg(rs, (r) => r.selectionsPerChar).toFixed(
          2,
        )}</td><td>${(avg(rs, (r) => r.errorRate) * 100).toFixed(1)}%</td><td>${avg(rs, (r) => r.likelyFalseSelections).toFixed(1)}</td></tr>`,
    )
    .join("");
  const dlg = $<HTMLDialogElement>("#results");
  dlg.querySelector(".body")!.innerHTML = all.length
    ? `<table><thead><tr><th>Keyboard · selection</th><th>Runs</th><th>WPM</th><th>Sel/char</th><th>Error</th><th>False sel.</th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>No runs yet. Use <b>⏱ Benchmark</b> to start one on each keyboard.</p>";
  dlg.showModal();
}
$("#export-runs").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ runs: runs(), calibration: lastError, settings }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `gazetype-runs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});
$("#clear-runs").addEventListener("click", () => {
  localStorage.removeItem(RUNS_KEY);
  showResults();
});

// ---------- settings dialog ----------
function openSettings() {
  const dlg = $<HTMLDialogElement>("#settings");
  const form = dlg.querySelector("form")!;
  for (const [k, v] of Object.entries(settings)) {
    const input = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) continue;
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = !!v;
    else input.value = String(v);
  }
  dlg.showModal();
}
$<HTMLFormElement>("#settings form").addEventListener("submit", () => {
  const form = $<HTMLFormElement>("#settings form");
  const prevVoice = settings.voice;
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const input = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) continue;
    const d = DEFAULTS[k];
    (settings as unknown as Record<string, unknown>)[k] =
      typeof d === "boolean" ? (input as HTMLInputElement).checked : typeof d === "number" ? Number(input.value) : input.value;
  }
  baseKb.withPrediction = settings.baselinePrediction;
  gaze.setModel(settings.model);
  saveSettings();
  if (settings.voice && !prevVoice) void enableVoice();
  if (!settings.voice && prevVoice) stopVoice?.();
  render();
});

// ---------- voice ----------
let stopVoice: (() => void) | null = null;
async function enableVoice() {
  try {
    stopVoice = await startVoiceCommands((cmd, heard) => {
      showToast(`🎙 “${heard}”`, 1500);
      if (cmd === "show") setExpanded(true);
      else if (cmd === "hide") setExpanded(false);
      else speak(kb.text());
    });
    showToast("Voice commands on: say “gaze type” / “open keyboard” or “hide keyboard”.");
  } catch (err) {
    showToast(`Voice commands unavailable: ${(err as Error).message}`);
    settings.voice = false;
    saveSettings();
  }
}

// ---------- boot ----------
async function boot() {
  const words = await fetch("./data/words-10k.txt").then((r) => r.text());
  predictor.load(words.split("\n"), CORE_WORDS, SEED_PHRASES);
  gazeKb.update();
  render();
  llmOn = await llmAvailable();
  try {
    const le = localStorage.getItem("gazetype.lastError.v1");
    if (le) lastError = JSON.parse(le);
  } catch {
    /* ignore */
  }
  if (settings.voice) void enableVoice();
  if (bridge) $("#shortcut-hint").textContent = `Toggle: ${bridge.shortcut} · say “gaze type” · or look at the top-right corner`;
  updateStatus();
}
void boot();
