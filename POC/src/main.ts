import "./style.css";
import { FaceTracker } from "./gaze/tracker";
import { GazeEngine, type GazePoint } from "./gaze/engine";
import { estimateDistanceCm, type ErrorStats, type ViewingGeometry } from "./gaze/accuracy";
import { runCalibration } from "./ui/calibration";
import { BlinkSelector, DwellSelector, TargetTracker, type Rect, type SelectionMode } from "./input/selection";
import { PredictionEngine } from "./predict/engine";
import { CORE_WORDS, SEED_PHRASES, BENCHMARK_SENTENCES } from "./predict/vocab";
import { llmAvailable, llmStatus, llmWarm, setLlmProfile } from "./predict/llm";
import { splitSentences } from "./predict/engine";
import { ProfileManager, pickSamples, type Profile } from "./profile/profiles";
import { BaselineKeyboard, GazeTypeKeyboard, type KeyboardHost } from "./ui/keyboards";
import { TypingSession, normalizeText, type RunResult } from "./metrics/session";
import { startVoiceCommands } from "./input/voice";
import { cloudVoiceAvailable, speakText } from "./voice/elevenlabsVoice";

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
const tracker = new FaceTracker($("#video"));
tracker.onFrame = gaze.handleFrame;
const profiles = new ProfileManager(localStorage);
const predictor = new PredictionEngine(profiles.store(profiles.active.id));
const CAL_KEY = "gazetype.calibration.v1";
gaze.storageKey = profiles.keyFor(profiles.active.id, CAL_KEY);
let lastError: ErrorStats | null = null;
let llmOn = false;

const host: KeyboardHost = {
  refresh: () => render(),
  action: (a) => void doAction(a),
  overlay: isOverlay,
  profiles: () => profiles.list(),
  activeProfileId: () => profiles.active.id,
};
const gazeKb = new GazeTypeKeyboard(predictor, host);
const baseKb = new BaselineKeyboard(predictor, host, settings.baselinePrediction);
let kb: GazeTypeKeyboard | BaselineKeyboard = gazeKb;

const targetTracker = new TargetTracker(36, 90);
const dwell = new DwellSelector(settings.dwellMs);
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
    gaze.source === "camera" ? `${g.distanceCm.toFixed(0)} cm${settings.distanceCm ? "" : " est."}` : "",
    gaze.implicitCount ? `+${gaze.implicitCount} auto-cal` : "",
    `${settings.selectionMode}${settings.selectionMode === "dwell" ? ` ${kb === gazeKb ? settings.dwellMs : settings.baselineDwellMs} ms` : ""}`,
    settings.selectionMode === "blink" ? `blinks ✓${blink.accepted} ✗${blink.rejectedShort + blink.rejectedLong}` : "",
    `👤 ${esc(profiles.active.name)}`,
    kb === gazeKb ? `predict ${gazeKb.lastSuggestMs.toFixed(1)} ms` : "",
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
  const show = settings.showCursor && g.valid && Number.isFinite(g.x);
  cursor.hidden = !show;
  if (show) {
    const r = Math.max(14, lastError ? Math.min(lastError.meanPx, 200) : 14);
    cursor.style.transform = `translate(${g.x - r}px, ${g.y - r}px)`;
    cursor.style.width = cursor.style.height = `${2 * r}px`;
  }
  if (!calRoot.hidden || !home.hidden) return;
  measure();
  const target = g.valid ? targetTracker.update(g.t, rects, g.x, g.y) : null;
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
/** Speak in the user's cloned voice (ElevenLabs via the local server), else the system voice. */
function speak(text: string) {
  if (!text.trim()) return;
  speakText(text);
}

async function doAction(a: string) {
  const text = kb.text().trim();
  if (a.startsWith("profile:")) {
    switchProfile(a.slice("profile:".length));
    showToast(`Now typing as <b>${esc(profiles.active.name)}</b>`);
    render();
    return;
  }
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
  const stats = await runCalibration(gaze, calRoot, geometry);
  if (!stats) {
    showToast("Calibration cancelled or failed.");
    return;
  }
  lastError = stats;
  const g = geometry();
  showToast(
    `<b>Calibrated.</b> Mean error <b>${stats.meanDeg.toFixed(2)}°</b> (${stats.meanPx.toFixed(0)} px), precision ±${stats.precisionDeg.toFixed(
      2,
    )}°, n=${stats.n}.<br><small>Assumes ${settings.screenDiagonalIn}" screen at ${g.distanceCm.toFixed(0)} cm${
      settings.distanceCm ? "" : " (estimated from iris size)"
    }. Smallest target here: ${smallestTargetPx()} px.</small>`,
    9000,
  );
  localStorage.setItem("gazetype.lastError.v1", JSON.stringify(stats));
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

// ---------- profiles ----------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Everything that depends on who is typing: prediction data, calibration, LLM context. */
function applyProfile(p: Profile) {
  gaze.storageKey = profiles.keyFor(p.id, CAL_KEY);
  setLlmProfile({ id: p.id, name: p.name, about: p.about, people: p.people, samples: p.samples });
  $("#profile-btn").textContent = `👤 ${p.name}`;
  fillProfileSelect($<HTMLSelectElement>("#profile-select"), p.id);
  void llmWarm();
}

function switchProfile(id: string) {
  if (id === profiles.active.id) return;
  const p = profiles.setActive(id);
  predictor.useStore(profiles.store(p.id));
  applyProfile(p);
  // Each person's eyes need their own calibration.
  if (gaze.source === "camera" && !gaze.loadSavedCalibration()) showToast(`No calibration saved for ${esc(p.name)} yet: choose ◎ Calibrate.`);
  kb.clear();
}

function fillProfileSelect(sel: HTMLSelectElement, selected: string) {
  sel.innerHTML = profiles
    .list()
    .map((p) => `<option value="${p.id}"${p.id === selected ? " selected" : ""}>${esc(p.name)}</option>`)
    .join("");
}

const pfDlg = $<HTMLDialogElement>("#profile-dlg");
const pf = {
  select: $<HTMLSelectElement>("#pf-select"),
  name: $<HTMLInputElement>("#pf-name"),
  about: $<HTMLTextAreaElement>("#pf-about"),
  people: $<HTMLInputElement>("#pf-people"),
  samples: $<HTMLTextAreaElement>("#pf-samples"),
  learned: $("#pf-learned"),
};
let editingId = profiles.active.id;

function loadProfileForm(id: string) {
  editingId = id;
  const p = profiles.list().find((x) => x.id === id)!;
  fillProfileSelect(pf.select, id);
  pf.name.value = p.name;
  pf.about.value = p.about;
  pf.people.value = p.people.join(", ");
  pf.samples.value = "";
  pf.learned.textContent = p.samples.length ? `${p.samples.length} of their own sentences are used as examples for AI suggestions.` : "";
}

function openProfiles() {
  loadProfileForm(profiles.active.id);
  pfDlg.showModal();
}

/** Save the form into the profile being edited and start using it. */
function saveProfileForm() {
  const people = pf.people.value.split(",").map((s) => s.trim()).filter(Boolean);
  profiles.update(editingId, { name: pf.name.value.trim() || "Me", about: pf.about.value.trim(), people });
  switchProfile(editingId);
  predictor.setPinned(people);
  applyProfile(profiles.active);
  render();
}

pf.select.addEventListener("change", () => loadProfileForm(pf.select.value));
$("#pf-save").addEventListener("click", () => {
  saveProfileForm();
  pfDlg.close();
  showToast(`Typing as <b>${esc(profiles.active.name)}</b>`);
});
$("#pf-new").addEventListener("click", () => {
  const p = profiles.create(`User ${profiles.list().length + 1}`);
  loadProfileForm(p.id);
  pf.name.select();
});
$("#pf-delete").addEventListener("click", () => {
  const p = profiles.list().find((x) => x.id === editingId)!;
  if (profiles.list().length <= 1) return void (pf.learned.textContent = "You can't delete the only profile.");
  if (!confirm(`Delete ${p.name} and everything they've taught the keyboard? This can't be undone.`)) return;
  const wasActive = p.id === profiles.active.id;
  profiles.remove(p.id);
  if (wasActive) {
    predictor.useStore(profiles.store(profiles.active.id));
    applyProfile(profiles.active);
    kb.clear();
  }
  loadProfileForm(profiles.active.id);
  render();
});
$<HTMLInputElement>("#pf-file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) pf.samples.value = await file.text();
});
$("#pf-learn").addEventListener("click", () => {
  const text = pf.samples.value;
  if (!text.trim()) return void (pf.learned.textContent = "Paste some text or choose a .txt file first.");
  saveProfileForm(); // learning goes into the profile being edited, so make it active
  const n = predictor.ingest(text);
  const p = profiles.active;
  const samples = pickSamples([...p.samples, ...splitSentences(text)]);
  profiles.update(p.id, { samples });
  applyProfile(profiles.active);
  pf.samples.value = "";
  pf.learned.textContent = `Learned from ${n} sentences. ${samples.length} are used as examples for AI suggestions.`;
});
$("#pf-export").addEventListener("click", () => {
  const p = profiles.list().find((x) => x.id === editingId)!;
  const blob = new Blob([profiles.exportProfile(p.id)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `gazetype-profile-${p.name.replace(/\W+/g, "-").toLowerCase()}.json`;
  a.click();
});
$<HTMLInputElement>("#pf-import").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const p = profiles.importProfile(await file.text());
    loadProfileForm(p.id);
    pf.learned.textContent = `Imported ${p.name}. Choose Save & use to switch to them.`;
  } catch (err) {
    pf.learned.textContent = `Couldn't import: ${(err as Error).message}`;
  }
});
$("#profile-btn").addEventListener("click", openProfiles);
$("#profile-manage").addEventListener("click", openProfiles);
$<HTMLSelectElement>("#profile-select").addEventListener("change", (e) => {
  switchProfile((e.target as HTMLSelectElement).value);
  render();
});

// ---------- boot ----------
async function boot() {
  const words = await fetch("./data/words-10k.txt").then((r) => r.text());
  predictor.load(words.split("\n"), CORE_WORDS, SEED_PHRASES);
  applyProfile(profiles.active);
  gazeKb.update();
  render();
  void cloudVoiceAvailable(); // check once now so the first Speak doesn't wait on it
  llmOn = await llmAvailable();
  const st = llmStatus();
  const llmEl = $("#llm-status");
  llmEl.className = `llm-status ${st.on ? "on" : "off"}`;
  llmEl.textContent =
    (st.on
      ? `✨ AI suggestions on${st.fastModel ? ` (${st.fastModel})` : ""}`
      : st.reason === "no-key"
        ? "AI suggestions off: the LLM server has no API key. Add ANTHROPIC_API_KEY to POC/.env and restart it."
        : "AI suggestions off: LLM server not running (npm run dev:all). On-device prediction still works.") +
    (st.voice ? " · 🗣 Speaking in your voice (ElevenLabs)" : "");
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
