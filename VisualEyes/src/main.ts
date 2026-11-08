import { containsSlur, SLUR_NOTICE } from "./safety/slurs";
import "./style.css";
import { FaceTracker } from "./gaze/tracker";
import { GazeEngine, type GazePoint } from "./gaze/engine";
import { estimateDistanceCm, type ErrorStats, type ViewingGeometry } from "./gaze/accuracy";
import { runCalibration, runRecenter } from "./ui/calibration";
import { BlinkBurstDetector } from "./input/gestures";
import { POINTER_FEATURE_NAMES, pointerVector } from "./gaze/features";
import { SessionTape } from "./record/tape";
import { runTargetTest } from "./record/targetTest";
import { SessionRecorder } from "./metrics/recorder";
import { BlinkSelector, DwellSelector, TargetTracker, type Rect } from "./input/selection";
import { PredictionEngine } from "./predict/engine";
import { CORE_WORDS, SEED_PHRASES, BENCHMARK_SENTENCES } from "./predict/vocab";
import { llmAvailable, llmPredict, llmStatus, llmWarm, setLlmProfile, setLlmToken } from "./predict/llm";
import { splitSentences } from "./predict/engine";
import { ProfileManager, pickSamples, type Profile } from "./profile/profiles";
import { BaselineKeyboard, GazeTypeKeyboard, type KeyboardHost, HOME_CHIPS } from "./ui/keyboards";
import { TypingSession, normalizeText, type RunResult } from "./metrics/session";
import { VoiceRouter } from "./voice/router";
import { SystemVoice } from "./voice/system";
import { HostedVoiceApi } from "./voice/hostedApi";
import { HostedVoiceController, friendlyReason } from "./voice/hostedController";
import { HostedVoice, BrowserAudioSink } from "./voice/hostedVoice";
import { apiConfigFrom, loadVoiceApiSettings, saveVoiceApiSettings, setTokenProvider, usingDevLogin, type VoiceApiSettings } from "./voice/hostedConfig";
import { AccountApi, PrefsSync, setSkippedSignIn, type SyncedPrefs } from "./account/account";
import { Auth0Session, auth0Config, canRedirect, type SignedInUser } from "./account/auth0";
import { mountMyVoice } from "./ui/myVoice";
import { startVoiceCommands } from "./input/voice";
import { download, recordSession } from "./record/recorder";
import { Conversation, homeItems } from "./listen/conversation";
import { eraseLocalData } from "./account/erase";
import { PartnerListener, type ListenState } from "./listen/partner";
import type { SessionMeta } from "./record/format";
import { DEFAULTS, lookClasses, type Settings } from "./settings";
import { bars, brand, esc, g, honeycomb, logo } from "./ui/dom";
import { makeScreens, type ScreenName, type Screen } from "./ui/screens";
import { makeVoiceScreens } from "./ui/voiceScreens";
import { Onboarding, emptyDraft, type Draft } from "./ui/onboarding";

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
const load = <T>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? { ...d, ...JSON.parse(v) } : d;
  } catch {
    return d;
  }
};
const settings: Settings = load("gazetype.settings.v1", DEFAULTS);
/** Set once the account code below is ready: sends changed preferences to the signed-in account. */
let prefsChanged: () => void = () => {};
const storeSettings = () => localStorage.setItem("gazetype.settings.v1", JSON.stringify(settings));
const saveSettings = () => {
  storeSettings();
  applyLook();
  sink.setVolume(settings.volume / 100);
  baseKb.withPrediction = settings.baselinePrediction;
  prefsChanged();
  syncListener();
  render();
};

// ---------- DOM ----------
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const appRoot = $("#app");
const topbar = $("#topbar");
const talk = $("#talk");
const panel = $("#panel");
const board = $("#board");
const screenRoot = $("#screen");
const statusEl = $("#status");
const cursor = $("#cursor");
const calRoot = $("#calibration");
const onboardRoot = $("#onboard");
const sheetRoot = $("#sheet");
const targetBar = $("#target-bar");
const toast = $("#toast");
const pill = $("#pill");
pill.querySelector("span")!.innerHTML = logo();

/** Theme and accessibility classes on <body>, keeping the overlay's own classes. */
function applyLook() {
  const keep = ["overlay", "collapsed"].filter((c) => document.body.classList.contains(c));
  document.body.className = [...lookClasses(settings), ...keep].join(" ");
}
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
const rec = new SessionRecorder();
rec.featureNames = POINTER_FEATURE_NAMES;
const video = $<HTMLVideoElement>("#video");
const tracker = new FaceTracker(video);
let cameraStarted = false;
// The pointer gets the 10 pointer features (see POINTER_FLOOR in engine.ts).
tracker.onFrame = (f) => {
  if (!f) return gaze.handleFrame(f);
  gaze.handleFrame({ ...f, vector: pointerVector(f.vector) });
};
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
  notice: (m) => showToast(m, 3500),
  aiEnabled: () => settings.ai,
  benchmarking: () => !!benchmark,
};
const gazeKb = new GazeTypeKeyboard(predictor, host);
// The home screen: the AI's replies to what the partner just said first, then the user's usual phrases.
gazeKb.homeSource = (n) => {
  const replies = settings.listen ? convo.replies : [];
  return homeItems(replies, predictor.topPhrases(n), n).map((t) => (replies.includes(t) ? { text: t, sub: "reply" } : t));
};
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

// ---------- speech: the voice router, plus the generating / playing / paused states the panel shows ----------
// Speaking goes through the voice router: the user's own hosted voice (ElevenLabs, via our service, one voice per
// user from "My voice") when they have one and it is active, otherwise the system voice. A slow, failing, paused or
// missing voice never leaves the user silent. See docs/VOICE_ENGINE_FLOW.md and docs/AWS_VOICE_HANDOFF.md.
type SpPhase = "idle" | "generating" | "playing" | "paused";
const sp = { phase: "idle" as SpPhase, text: "", start: 0, dur: 0, el: 0, seq: 0 };
const sink = new BrowserAudioSink();
sink.setVolume(settings.volume / 100);
let voiceApiSettings: VoiceApiSettings = loadVoiceApiSettings(localStorage);
const voiceApi = new HostedVoiceApi(apiConfigFrom(() => voiceApiSettings));
const voiceCtl = new HostedVoiceController(voiceApi, async (text) => (await voice.speak(text).done));
const voice = new VoiceRouter({
  providers: [new HostedVoice(voiceApi, sink, () => voiceCtl.usable()), new SystemVoice()],
  // The service is the source of truth for consent: the cloned tier is allowed only while the voice is active there.
  policy: () => ({ allows: (tier) => tier === "system" || (tier === "cloned" && voiceCtl.usable()) }),
  // Over the network the first sound takes longer than a local clip; past this the system voice speaks instead.
  startBudgetMs: { cloned: 2500 },
  pace: () => settings.speechRate,
  volume: () => settings.volume / 100,
  onStart: (_tier, text) => {
    if (sp.phase !== "generating" || sp.text !== text) return;
    sp.phase = "playing";
    sp.start = performance.now();
    sp.dur = Math.max(1500, (text.trim().split(/\s+/).length * 430 + 600) / settings.speechRate);
    renderPanel();
  },
  onResult: () => updateStatus(),
});
const myVoice = mountMyVoice({
  dialog: $<HTMLDialogElement>("#myvoice"),
  controller: voiceCtl,
  getApiSettings: () => voiceApiSettings,
  saveApiSettings: (s) => {
    voiceApiSettings = s;
    saveVoiceApiSettings(localStorage, s);
  },
  usingDevLogin,
});

const voiceName = () => (voiceCtl.usable() ? "My voice" : "Standard voice");

/** Speak through the router and show it on the panel. `record` adds it to Recent. */
function say(text: string, record = true) {
  const t = text.trim();
  if (!t) return;
  if (containsSlur(t)) return void showToast(SLUR_NOTICE, 3500); // also covers voice commands
  if (record) pushHistory(t);
  // The microphone would hear this through the speakers: ignore it until the voice has finished.
  convo.spoke(t);
  listener.mute((t.split(/\s+/).length * 430 + 2500) / settings.speechRate + 1500);
  const seq = ++sp.seq;
  Object.assign(sp, { phase: "generating", text: t, start: performance.now(), el: 0 });
  sink.resume();
  if (typeof speechSynthesis !== "undefined") speechSynthesis.resume();
  const h = voice.speak(t);
  void h.done.then(() => {
    if (sp.seq !== seq) return;
    sp.phase = "idle";
    // Keep the microphone off for a moment longer: the room may still be echoing.
    setTimeout(() => {
      if (sp.seq === seq) listener.unmute();
    }, 700);
    renderPanel();
  });
  renderPanel();
}

function pauseSpeech() {
  if (sp.phase === "playing") {
    sp.phase = "paused";
    sp.el = performance.now() - sp.start;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.pause();
    sink.pause();
  } else if (sp.phase === "paused") {
    sp.phase = "playing";
    sp.start = performance.now() - sp.el;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.resume();
    sink.resume();
  }
  renderPanel();
}

function stopSpeech() {
  sp.seq++;
  voice.cancel();
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  sink.resume();
  sp.phase = "idle";
  renderPanel();
}

// The progress bar while speaking.
setInterval(() => {
  if (sp.phase !== "playing") return;
  const b = panel.querySelector<HTMLElement>(".spbar > i");
  if (b) b.style.width = `${Math.min(100, ((performance.now() - sp.start) / sp.dur) * 100)}%`;
}, 100);

/** Add a sentence end, so speech sounds finished: a question mark for questions, a full stop otherwise. */
function punctuate(text: string): string {
  const t = text.replace(/\s+$/, "");
  if (!t || /[.!?]$/.test(t)) return t;
  const first = (t.split(/[.!?]\s+/).pop() ?? "").trim().split(/\s+/)[0].toLowerCase();
  const Q = ["who", "what", "when", "where", "why", "how", "can", "could", "would", "will", "do", "does", "did", "is", "are", "am", "should", "may", "shall", "have", "has", "was", "were", "which"];
  return t + (Q.includes(first) ? "?" : ".");
}

// ---------- recent messages (per profile, this computer only) ----------
const HIST_KEY = "visualeyes.history.v1";
let history: string[] = [];

// ---------- the other side of the conversation: the partner is transcribed, the AI proposes replies ----------
// What the partner says is heard through the browser's speech recognition (listen/partner.ts), each sentence
// becomes a turn (listen/conversation.ts), and the AI's replies take over the home screen chips. Off until the
// user turns "Listen to the other person" on in Settings. The microphone is muted while the app speaks.
const convo = new Conversation();
let replyAbort: AbortController | null = null;
let replySeq = 0;
const listener = new PartnerListener({
  onFinal: (text) => {
    const turn = convo.heard(text);
    if (!turn) return;
    void askForReplies(turn.text);
    render();
  },
  onInterim: (text) => {
    convo.interim = text;
    if (!screenName && sp.phase === "idle") renderPanel();
  },
  onState: (st) => {
    if (st === "denied") {
      settings.listen = false;
      saveSettings();
      showToast("Microphone access was refused, so listening is off. Allow the microphone in the browser to use it.", 7000);
    } else if (st === "unsupported") {
      settings.listen = false;
      saveSettings();
      showToast("This browser can't transcribe speech. Chrome or Edge can.", 6000);
    } else if (st === "error") {
      settings.listen = false;
      saveSettings();
      showToast(
        listener.lastError === "network"
          ? "This browser can't reach its speech service, so listening is off. Brave blocks it; Chrome or Edge work."
          : listener.lastError === "language-not-supported"
            ? "This browser can't transcribe English speech, so listening is off."
            : "No microphone was found, so listening is off.",
        8000,
      );
    }
    if (!appRoot.hidden) renderHeader();
  },
});
async function askForReplies(heard: string) {
  replyAbort?.abort();
  const ctrl = (replyAbort = new AbortController());
  const seq = ++replySeq;
  if (!llmOn || !settings.ai) return;
  const transcript = convo.transcript(8).slice(0, -1);
  const replies = await llmPredict({ task: "reply", heard, transcript, n: HOME_CHIPS }, ctrl.signal);
  if (seq !== replySeq || convo.latest()?.text !== heard) return;
  convo.replies = replies;
  render();
}
/** Start or stop listening to match the setting; called whenever settings are saved. */
function syncListener() {
  if (settings.listen && listener.state === "off") listener.start();
  else if (!settings.listen && listener.state !== "off" && listener.state !== "unsupported") {
    listener.stop();
    convo.replies = [];
    convo.interim = "";
  }
}
function listenStatus(): string {
  switch (listener.state) {
    case "on":
    case "muted":
      return "Listening now.";
    case "starting":
      return "Starting the microphone…";
    case "denied":
      return "The browser refused the microphone.";
    case "unsupported":
      return "Not available in this browser (use Chrome or Edge).";
    case "error":
      return listener.lastError === "network" ? "This browser blocks the speech service (use Chrome or Edge)." : "No microphone found.";
    default:
      return llmOn && settings.ai ? "" : "Needs AI suggestions on for replies; what they say still shows.";
  }
}
const loadHistory = () => {
  try {
    history = JSON.parse(localStorage.getItem(profiles.keyFor(profiles.active.id, HIST_KEY)) ?? "[]");
  } catch {
    history = [];
  }
};
function pushHistory(t: string) {
  history = [t, ...history.filter((h) => h !== t)].slice(0, 20);
  localStorage.setItem(profiles.keyFor(profiles.active.id, HIST_KEY), JSON.stringify(history));
}
loadHistory();

// ---------- screens ----------
let screenName: ScreenName | null = null;
const screens = makeScreens({
  settings,
  saveSettings,
  toast: showToast,
  open: (n) => openScreen(n),
  insertPhrase: (t) => {
    kb.appendText(t);
    render();
  },
  sayAgain: (t) => say(t),
  speak: (t) => say(t),
  history: () => history,
  frequent: (n) => predictor.topPhrases(n),
  recalibrate: () => void calibrate(),
  aiPrefs: () => onboard.edit(draftFor(profiles.active)),
  account: () => ({
    line: account ? `Signed in as ${account.name || account.email || "a caretaker"}.` : "Not signed in: settings stay on this computer.",
    signedIn: !!account,
    available: !!auth,
  }),
  signIn: () => void auth?.signIn(false),
  signOut: () => void signOut(),
  tools: () => caretakerTools(),
  aiStatus: () =>
    llmOn ? "The AI is connected." : llmStatus().reason === "sign-in" ? "A caretaker signs in to turn the AI on." : "The AI server isn't running, so only word prediction works.",
  listenStatus,
  eraseData: () =>
    showSheet({
      kind: "confirm",
      title: "Delete everything VisualEyes knows about you?",
      body: `Profiles, phrases, calibration, settings and recent messages on this computer${account ? ", and your settings and voice in your account" : ""}. This can't be undone.`,
      yes: "Delete it all",
      onYes: () => void eraseMyData(),
    }),
});

/**
 * "Delete my data" (Settings, after the confirmation): the account's copy first (the voice at ElevenLabs and in our
 * service, the synced settings and profile), then everything on this computer, then signed out so nothing is synced
 * back. Ends on the start screen as a first run.
 */
async function eraseMyData() {
  showToast("Deleting your data…", 10000);
  listener.stop();
  if (account) {
    if (voiceCtl.status()) await voiceCtl.remove().catch(() => false);
    const t = await token().catch(() => null);
    if (t) await accountApi.putPreferences(t, { settings: { ...DEFAULTS }, profile: { name: "", about: "", people: [], samples: [] } }).catch(() => {});
  }
  prefsChanged = () => {}; // the erased state must not be synced to the account
  eraseLocalData(localStorage);
  if (auth && account) {
    account = null;
    setTokenProvider(null);
    setLlmToken(null);
    await auth.signOut(); // ends the Auth0 session too, then comes back to this page as a first run
  } else {
    location.reload();
  }
}
const voiceScreens = makeVoiceScreens({
  controller: voiceCtl,
  toast: showToast,
  open: (n) => openScreen(n),
  confirm: (title, body, yes, onYes) => showSheet({ kind: "confirm", title, body, yes, onYes }),
  rerender: () => render(),
  speakSystem: (t) => void new SystemVoice().speak(t, { pace: settings.speechRate, volume: settings.volume / 100 }),
  advanced: () => myVoice.open(),
});
const allScreens: Record<ScreenName, Screen> = { ...screens, voice: voiceScreens.voice, voiceSetup: voiceScreens.voiceSetup };

function openScreen(n: ScreenName | null) {
  screenName = n;
  talk.hidden = !!n;
  screenRoot.hidden = !n;
  if (n === "voice" || n === "voiceSetup") void voiceCtl.refresh();
  render();
}

// Caretaker buttons on the Settings and voice screens (ordinary clicks, not gaze targets).
function caretakerTools() {
  return [
    { label: "Advanced settings", run: openSettings },
    { label: "Profiles", run: openProfiles },
    { label: "Voice service and fine-tuning", run: () => myVoice.open() },
    { label: "Run setup again", run: () => onboard.begin() },
    { label: `Keyboard: ${kb === gazeKb ? "VisualEyes" : "Baseline QWERTY"}`, run: toggleKeyboard },
    { label: "Start a benchmark", run: () => (openScreen(null), startRun(benchIndex)) },
    { label: "Benchmark results", run: showResults },
    { label: "Record a session", run: openRecord },
    { label: "Export data", run: exportData },
    { label: "Import calibration", run: importCalibration },
  ];
}
screenRoot.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tool],[data-act]");
  if (!t) return;
  if (t.dataset.act === "advanced") return myVoice.open();
  if (t.dataset.tool === "account") {
    if (account) return void signOut();
    if (!auth) return showToast(esc(onboardAuthWhy()), 7000);
    return void auth.signIn(false).catch((err) => showToast(`Couldn't open sign-in: ${esc((err as Error).message)}`, 6000));
  }
  caretakerTools()[Number(t.dataset.tool)]?.run();
});

// ---------- sheets: rest, help alarm, confirm ----------
type Sheet = { kind: "rest" } | { kind: "alarm" } | { kind: "confirm"; title: string; body: string; yes: string; onYes: () => void };
let sheet: Sheet | null = null;
let alarm: { ac: AudioContext | null; timer: number } | null = null;

function showSheet(s: Sheet) {
  sheet = s;
  sheetRoot.className = s.kind === "rest" ? "rest" : s.kind === "alarm" ? "alarm" : "";
  sheetRoot.hidden = false;
  if (s.kind === "alarm") startAlarm();
  renderSheet();
}

function hideSheet() {
  if (sheet?.kind === "alarm") stopAlarm();
  sheet = null;
  sheetRoot.hidden = true;
  sheetRoot.innerHTML = "";
  dwell.reset();
  targetTracker.reset();
}

function renderSheet() {
  if (!sheet) return;
  if (sheet.kind === "rest") {
    sheetRoot.innerHTML = `<div class="centre">${logo().replace("<svg", '<svg style="width:7.5rem;height:7.5rem"')}
      <h1 class="h1" style="font-size:3.5rem">Resting</h1>
      <p class="sub" style="font-size:1.75rem">Eye tracking is paused. Nothing will be selected by accident.</p>
      <div class="row" style="gap:.625rem">${g("h:wake", "I'm back", { face: "btn-main", faceStyle: "width:32.5rem;min-height:11.875rem;font-size:3.375rem" })}${g("h:help", "Help", { face: "help", faceStyle: "width:16.25rem;min-height:11.875rem;font-size:3rem" })}</div>
      <p class="sub" style="font-size:1.25rem">Help works even while resting.</p></div>`;
  } else if (sheet.kind === "alarm") {
    sheetRoot.innerHTML = `<div class="centre"><h1 class="h1" style="font-size:5rem;color:#FFFFFF">Calling for help</h1>
      <p style="margin:0;font-size:2rem;font-weight:800;color:#FFFFFF">An alarm is sounding so someone comes to you.</p>
      ${g("h:stop", "I'm OK. Stop the alarm", { face: "btn", faceStyle: "width:37.5rem;min-height:10rem;font-size:2.625rem;font-weight:900" })}</div>`;
  } else {
    sheetRoot.innerHTML = `<div class="sheet" style="width:51.25rem;text-align:center"><h2 style="margin:0 0 .625rem;font-size:2.5rem;font-weight:900">${esc(sheet.title)}</h2>
      <p class="sub" style="font-size:1.5625rem;margin:0 0 1.5rem">${esc(sheet.body)}</p>
      <div style="display:flex;justify-content:center">${g("h:no", "Keep it", { face: "btn xl", faceStyle: "width:18.75rem" })}${g("h:yes", esc(sheet.yes), { face: "btn xl", faceStyle: "width:18.75rem;background:#A8321A;color:#fff" })}</div></div>`;
  }
}

function sheetSelect(id: string) {
  const s = sheet;
  if (!s) return;
  if (id === "h:wake") {
    hideSheet();
    showToast("Welcome back.", 2000);
  } else if (id === "h:help") showSheet({ kind: "alarm" });
  else if (id === "h:stop") {
    hideSheet();
    showToast("Alarm stopped.", 2500);
  } else if (id === "h:no") hideSheet();
  else if (id === "h:yes" && s.kind === "confirm") {
    hideSheet();
    s.onYes();
  }
}

function startAlarm() {
  say("I need help.", false);
  let ac: AudioContext | null = null;
  try {
    ac = new AudioContext();
  } catch {
    /* the screen still flashes */
  }
  const beep = () => {
    if (!ac) return;
    const o = ac.createOscillator();
    const gn = ac.createGain();
    o.type = "square";
    o.frequency.value = 880;
    gn.gain.value = 0.08;
    o.connect(gn);
    gn.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.25);
  };
  beep();
  alarm = { ac, timer: window.setInterval(beep, 600) };
}

function stopAlarm() {
  if (!alarm) return;
  clearInterval(alarm.timer);
  void alarm.ac?.close().catch(() => {});
  alarm = null;
}

// ---------- rendering ----------
let rects: Rect[] = [];
let readTargets = new Set<string>();
let rectsDirty = true;
let measuredRoot: HTMLElement | null = null;

/** The dot on the Listen chip: live, muted while the app speaks, or off. */
function listenDot(): string {
  const st: ListenState = listener.state;
  return st === "on" ? " live" : st === "muted" || st === "starting" ? "" : " off";
}

function renderHeader() {
  const on = (n: ScreenName) => screenName === n;
  topbar.innerHTML = `${brand()}
    <div class="chip" id="track-chip"><i class="ve-dot"></i><span></span></div>
    ${g("u:voice", `<i class="ve-dot${voiceCtl.usable() ? "" : " off"}" style="${voiceCtl.usable() ? "background:var(--brandText)" : ""}"></i><span>Voice: ${voiceName()}</span>`, { face: "nav", faceStyle: "gap:.625rem", on: on("voice") || on("voiceSetup") })}
    <div class="spacer"></div>
    ${g("u:listen", `<i class="ve-dot${listenDot()}"></i><span>${listener.state === "on" || listener.state === "muted" || listener.state === "starting" ? "Listening" : "Listen"}</span>`, { face: "nav", faceStyle: "gap:.625rem", on: settings.listen })}
    ${g("u:phrases", "Phrases", { face: "nav", on: on("phrases") })}
    ${g("u:access", "Accessibility", { face: "nav", on: on("access") })}
    ${g("u:settings", "Settings", { face: "nav", on: on("settings") || on("theme") })}
    ${g("u:rest", "Rest", { face: "nav" })}
    ${g("u:help", "Help", { face: "nav help" })}`;
  updateTrackChip();
}

function renderPanel() {
  const text = kb.text();
  const empty = !text.trim() && !(kb === gazeKb && gazeKb.slots.length);
  let line = "";
  const heard = settings.listen ? convo.latest() : null;
  if (sp.phase === "idle" && settings.listen && (heard || convo.interim || listener.state === "on"))
    line = heard || convo.interim
      ? `<span class="eyebrow">They said</span><span class="heard${heard && !convo.interim ? "" : " interim"}">${esc(convo.interim || heard!.text)}</span>${
          heard && !convo.interim && convo.replies.length ? `<span class="hint" style="flex:none">Replies are on the home screen.</span>` : ""
        }`
      : `<span class="eyebrow">Listening</span><span class="hint">When they speak, replies appear on the home screen.</span>`;
  else if (sp.phase === "idle")
    line = `<span class="eyebrow">Your message</span><span class="hint">Look at a key and hold for ${(settings.dwellMs / 1000).toFixed(1)} s to select it.</span>`;
  else if (sp.phase === "generating") line = `<div class="hcw">${honeycomb()}</div><span class="lbl" style="font-size:1.375rem">Getting your voice ready…</span>`;
  else
    line = `${bars(sp.phase === "paused")}<span class="lbl" style="font-size:1.375rem">${sp.phase === "paused" ? "Paused" : `Speaking in ${voiceName()}`}</span>
      <div class="bar spbar" style="width:18.75rem"><i style="width:${Math.min(100, ((sp.phase === "paused" ? sp.el : performance.now() - sp.start) / (sp.dur || 1)) * 100)}%"></i></div>`;
  const speaking = sp.phase === "playing" || sp.phase === "paused";
  panel.innerHTML = `
    <div class="msgcol">
      <div class="spline">${line}</div>
      <div id="output" aria-live="polite"><div class="msg">${kb.displayHtml()}</div></div>
      <div class="acts">
        ${g("u:undo", "Undo", { off: !kb.canUndo(), style: "width:9.375rem" })}
        ${g("u:delword", "Delete word", { off: empty, style: "width:12.5rem" })}
        ${g("u:clear", "Clear", { off: empty, style: "width:9.375rem" })}
        ${g("u:again", "Say again", { off: !history.length, style: "width:11.875rem" })}
      </div>
    </div>
    <div class="yn">${g("u:yes", "Yes", { style: "flex:1" })}${g("u:no", "No", { style: "flex:1" })}</div>
    <div class="spk">
      ${g("u:speak", "Speak", { face: "btn-main", style: "flex:1" })}
      <div class="row2">${g("u:pause", sp.phase === "paused" ? "Resume" : "Pause", { face: "btn lg", off: !speaking })}${g("u:stop", "Stop", { face: "btn lg", off: sp.phase === "idle" })}</div>
    </div>`;
  rectsDirty = true;
}

function renderScreen() {
  if (!screenName) return;
  const s = allScreens[screenName];
  const back = s.back === "settings" ? g("u:backset", "Back to settings", { face: "btn xl" }) : g("u:back", "Back to message", { face: "btn xl" });
  screenRoot.innerHTML = `<div class="screenhead">${back}<div><h1 class="h1">${esc(s.title)}</h1><p class="sub">${esc(s.sub)}</p></div></div>${s.render()}`;
}

function render() {
  if (screenName) renderScreen();
  else {
    kb.render(board);
    renderPanel();
  }
  renderHeader();
  statusEl.hidden = !settings.showStats;
  rectsDirty = true;
  document.body.dataset.kb = kb.name;
}

// Any change to the page can move targets: measure again before the next gaze frame.
new MutationObserver(() => (rectsDirty = true)).observe(document.body, { childList: true, subtree: true });
window.addEventListener("resize", () => (rectsDirty = true));

/** Which layer the gaze talks to: sheets first, then onboarding, then the app. None while calibrating. */
function activeLayer(): { id: "app" | "onboard" | "sheet"; root: HTMLElement } | null {
  if (!calRoot.hidden) return null;
  if (!sheetRoot.hidden) return { id: "sheet", root: sheetRoot };
  if (!onboardRoot.hidden) return { id: "onboard", root: onboardRoot };
  if (expanded && !appRoot.hidden) return { id: "app", root: appRoot };
  return null;
}

function measure(root: HTMLElement) {
  if (!rectsDirty && root === measuredRoot) return;
  readTargets = new Set();
  rects = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-target]:not(.is-off)")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    rects.push({ id: el.dataset.target!, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    if (el.hasAttribute("data-read")) readTargets.add(el.dataset.target!);
  }
  measuredRoot = root;
  rectsDirty = false;
}

function updateTrackChip() {
  const chip = topbar.querySelector("#track-chip");
  if (!chip) return;
  const [txt, cls] =
    gaze.source !== "camera" ? ["Mouse mode", "off"] : !gaze.faceVisible ? ["Can't see your face", "bad"] : !gaze.calibrated ? ["Not calibrated", "bad"] : ["Tracking good", ""];
  chip.innerHTML = `<i class="ve-dot ${cls}"></i><span>${txt}</span>`;
}

function updateStatus() {
  updateTrackChip();
  if (!settings.showStats) return;
  const g2 = geometry();
  const parts = [
    gaze.source === "camera" ? (gaze.faceVisible ? `<b class="ok">● face</b>` : `<b class="bad">● no face</b>`) : `<b>mouse</b>`,
    gaze.source === "camera" ? `${tracker.fps} fps · ${gaze.inferMs.toFixed(0)} ms` : "",
    lastError ? `error ${lastError.meanDeg.toFixed(1)}° (±${lastError.precisionDeg.toFixed(1)}°)` : gaze.source === "camera" ? "not calibrated" : "",
    gaze.source === "camera" ? `${g2.distanceCm.toFixed(0)} cm${settings.distanceCm ? "" : " est."}` : "",
    gaze.implicitCount ? `+${gaze.implicitCount} auto-cal` : "",
    `${settings.selectionMode}${settings.selectionMode === "dwell" ? ` ${kb === gazeKb ? settings.dwellMs : settings.baselineDwellMs} ms` : ""}`,
    settings.selectionMode === "blink" ? `blinks ✓${blink.accepted} ✗${blink.rejectedShort + blink.rejectedLong}` : "",
    esc(profiles.active.name),
    kb === gazeKb ? `predict ${gazeKb.lastSuggestMs.toFixed(1)} ms` : "",
    llmOn && settings.ai ? "AI on" : "on-device only",
    voiceStatusText(),
  ];
  statusEl.innerHTML = parts.filter(Boolean).join(" · ");
}
setInterval(updateStatus, 500);

function voiceStatusText(): string {
  const st = voiceCtl.status();
  const last = voice.last;
  if (st === "active" && !voiceCtl.usable()) return "my voice needs verifying";
  if (st === "active") {
    return last && last.tier === "system" && last.fellBack ? `system voice: ${friendlyReason(last.reason) || "my voice unavailable"}` : last?.tier === "cloned" ? `my voice · ${last.ttfaMs} ms` : "my voice ready";
  }
  return st === "paused" ? "my voice paused" : "";
}

// ---------- selection: the one dwell mechanism for every target on every screen ----------
let pendingImplicit: { timer: number } | null = null;

/**
 * Auto-calibration samples from the sentence being typed. They only teach the gaze model once
 * the user accepts the sentence (speaks, inserts or copies it): selections made while the
 * pointer was drifting, then fixed or abandoned, would otherwise make the drift worse.
 */
let sentenceSamples: { features: number[]; x: number; y: number }[] = [];

function acceptSentenceSamples() {
  // A selection far from where the model thought the eyes were is more likely a mistake than a correction.
  const limit = Math.max(150, 2.5 * (lastError?.meanPx ?? 60));
  const off = gaze.driftOffset;
  for (const s of sentenceSamples) {
    const p = gaze.predictRaw(s.features);
    if (Math.hypot(p.x + off.x - s.x, p.y + off.y - s.y) <= limit) gaze.addImplicitSample(s.features, s.x, s.y);
  }
  sentenceSamples = [];
}

/** A keyboard key was chosen (ids without a prefix). */
function applySelection(id: string, t: number) {
  const el = board.querySelector<HTMLElement>(`[data-target="${CSS.escape(id)}"]`);
  const r = el?.getBoundingClientRect();
  const kind = kb.select(id);
  rec.event("select", { id, kind });
  if (kind === "delete" && pendingImplicit) {
    clearTimeout(pendingImplicit.timer);
    pendingImplicit = null;
  }
  // Cleared the whole sentence: nothing typed in it was right, so learn nothing from it.
  if (kind === "delete" && !kb.text().trim()) sentenceSamples = [];
  session.record(t, kind);
  // Implicit recalibration: if this selection isn't undone within 2 s, treat the
  // fixation before it as a labelled sample at the target's centre.
  if (gaze.source === "camera" && r && kind !== "delete") {
    const win = settings.selectionMode === "blink" ? [t - 900, t - 400] : [t - 450, t - 50];
    const feats = gaze.meanFeatures(win[0], win[1]);
    if (feats) {
      if (pendingImplicit) clearTimeout(pendingImplicit.timer);
      pendingImplicit = {
        timer: window.setTimeout(() => {
          sentenceSamples.push({ features: feats, x: r.left + r.width / 2, y: r.top + r.height / 2 });
          pendingImplicit = null;
        }, 2000),
      };
    }
  }
  render();
  checkBenchmark(t);
}

/** Show the activated state on whatever now carries this id (the screen may have re-rendered). */
function flash(root: HTMLElement, id: string) {
  const el = root.querySelector<HTMLElement>(`[data-target="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.remove("is-focus", "is-dwell");
  el.classList.add("is-active");
  setTimeout(() => el.classList.remove("is-active"), 450);
}

function dispatch(layer: "app" | "onboard" | "sheet", id: string, t: number) {
  if (layer === "sheet") sheetSelect(id);
  else if (layer === "onboard") onboard.select(id);
  else if (id.startsWith("u:")) uiAction(id.slice(2));
  else if (id.startsWith("s:") && screenName) {
    allScreens[screenName].select(id);
    if (screenName) render();
  } else applySelection(id, t);
  const after = activeLayer();
  if (after) flash(after.root, id);
}

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target]");
  if (!el || el.classList.contains("is-off")) return;
  const layer = activeLayer();
  if (!layer || !layer.root.contains(el)) return;
  dispatch(layer.id, el.dataset.target!, performance.now());
});

let lastHover: HTMLElement | null = null;
let hotCornerSince: number | null = null;

function clearHover() {
  if (!lastHover) return;
  lastHover.classList.remove("is-focus", "is-dwell");
  lastHover.style.removeProperty("--p");
  lastHover = null;
}

function onGaze(g2: GazePoint) {
  if (g2.source === "camera" && gaze.dbg.frame) {
    rec.frame(
      {
        phase: calRoot.hidden ? 0 : 1,
        rawX: gaze.dbg.raw?.x ?? NaN, rawY: gaze.dbg.raw?.y ?? NaN,
        curX: g2.x, curY: g2.y, valid: g2.valid ? 1 : 0,
        blinkL: g2.blinkL, blinkR: g2.blinkR,
      },
      gaze.dbg.frame.vector,
    );
  }
  if (!expanded) {
    hotCorner(g2);
    return;
  }
  const show = settings.showCursor && g2.source === "camera" && g2.valid && Number.isFinite(g2.x);
  cursor.hidden = !show;
  if (show) {
    // Hints at accuracy without covering what the user is trying to read.
    const r = Math.max(8, lastError ? Math.min(lastError.meanPx * 0.4, 50) : 8);
    cursor.style.transform = `translate(${g2.x - r}px, ${g2.y - r}px)`;
    cursor.style.width = cursor.style.height = `${2 * r}px`;
  }
  cursor.classList.toggle("lost", !!g2.offscreen);
  const layer = activeLayer();
  if (!layer) {
    hideLostHint();
    return clearHover();
  }
  if (layer.id === "app") updateLostHint(g2);
  else hideLostHint();
  measure(layer.root);
  // An off-screen estimate is pinned to the edge; selecting from there would hit an edge key by accident.
  const target = g2.valid && !g2.offscreen ? targetTracker.update(g2.t, rects, g2.x, g2.y) : null;
  let out;
  if (settings.selectionMode === "blink" && g2.source === "camera") out = blink.update(g2.t, target, g2.blinkL, g2.blinkR);
  else if (settings.selectionMode === "click") out = { selected: null, progress: 0, target };
  else {
    const keyboardKey = layer.id === "app" && !!target && !/^[us]:/.test(target);
    dwell.dwellMs = (keyboardKey && kb === baseKb ? settings.baselineDwellMs : settings.dwellMs) + (target && readTargets.has(target) ? settings.readExtraMs : 0);
    out = dwell.update(g2.t, target);
  }
  const el = out.target ? layer.root.querySelector<HTMLElement>(`[data-target="${CSS.escape(out.target)}"]`) : null;
  if (lastHover && lastHover !== el) clearHover();
  if (el && !el.classList.contains("is-active")) {
    el.classList.toggle("is-dwell", out.progress > 0.02);
    el.classList.toggle("is-focus", out.progress <= 0.02);
    el.style.setProperty("--p", String(out.progress));
    lastHover = el;
  }
  if (out.selected) {
    clearHover();
    dispatch(layer.id, out.selected, g2.t);
  }
}
gaze.onGaze(onGaze);

// ---------- re-centering a drifting pointer ----------
const gazeHint = $("#gaze-hint");
const blinkBurst = new BlinkBurstDetector();
let lostSince: number | null = null;
let recentering = false;

function hideLostHint() {
  lostSince = null;
  gazeHint.hidden = true;
}

/** After the pointer has been off the screen for 2 s, say how to get it back. */
function updateLostHint(g2: GazePoint) {
  if (g2.source !== "camera" || !g2.offscreen) {
    lostSince = null;
    gazeHint.hidden = true;
    return;
  }
  lostSince ??= g2.t;
  if (g2.t - lostSince < 2000 || !gazeHint.hidden) return;
  gazeHint.textContent = settings.blinkRecenter
    ? "Pointer lost. Blink 3 times quickly to re-centre."
    : "Pointer lost. Press R to re-centre, or turn on blink re-centring in Accessibility.";
  gazeHint.hidden = false;
}

// Three quick blinks re-center the pointer, wherever it has drifted to.
gaze.onRaw((f) => {
  if (!f || !settings.blinkRecenter || gaze.source !== "camera" || !gaze.calibrated) return;
  if (!expanded || recentering || !calRoot.hidden || !onboardRoot.hidden || sheet) return;
  if (blinkBurst.update(f.t, f.blinkL, f.blinkR)) void recenter();
});

// A caregiver can also press R.
window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
  if ((e.key === "r" || e.key === "R") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector("dialog[open]") && onboardRoot.hidden) void recenter();
});

async function recenter() {
  if (gaze.source !== "camera" || !gaze.calibrated) {
    showToast("Re-centring needs the camera and a calibration first.");
    return;
  }
  if (recentering || !calRoot.hidden) return;
  recentering = true;
  // Selections made while drifting must not become calibration samples.
  if (pendingImplicit) {
    clearTimeout(pendingImplicit.timer);
    pendingImplicit = null;
  }
  sentenceSamples = [];
  gazeHint.hidden = true;
  lostSince = null;
  try {
    const r = await runRecenter(gaze, calRoot);
    const small = Math.min(innerWidth, innerHeight);
    if (!r.ok)
      showToast(
        r.reason === "no-face"
          ? "Couldn't see your eyes. Check the light and camera, then try again."
          : "Couldn't get a steady look at the dot. Try again and keep your eyes on it.",
        5000,
      );
    else if (r.shiftPx! > small * 0.25)
      showToast(`Re-centred. That was a big drift: Recalibrate (in Settings) will track better.`, 6000);
    else showToast(`Re-centred.`, 2500);
  } finally {
    recentering = false;
    blinkBurst.reset();
    dwell.reset();
    targetTracker.reset();
  }
}

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
// The badge: hover makes the click-through window clickable, click opens the keyboard.
pill.addEventListener("mouseenter", () => bridge?.setClickable(true));
pill.addEventListener("mouseleave", () => bridge?.setClickable(false));
pill.addEventListener("click", () => setExpanded(true));

/** Look at the top-right corner for 1.5 s to open the overlay — no hands or voice needed. */
function hotCorner(g2: GazePoint) {
  if (!settings.hotCorner || g2.source !== "camera" || !gaze.calibrated || !g2.valid) {
    hotCornerSince = null;
    pill.style.setProperty("--p", "0");
    return;
  }
  const inCorner = g2.x > innerWidth - 160 && g2.y < 160;
  if (!inCorner) {
    hotCornerSince = null;
    pill.style.setProperty("--p", "0");
    return;
  }
  hotCornerSince ??= g2.t;
  const p = Math.min(1, (g2.t - hotCornerSince) / 1500);
  pill.style.setProperty("--p", String(p));
  if (p >= 1) {
    hotCornerSince = null;
    setExpanded(true);
  }
}

// ---------- actions ----------
/** Buttons on the message screen and header (ids "u:…"). */
function uiAction(a: string) {
  const empty = !kb.text().trim() && !(kb === gazeKb && gazeKb.slots.length);
  switch (a) {
    case "speak":
      return void doAction("speak");
    case "yes":
      return say("Yes.", false);
    case "no":
      return say("No.", false);
    case "undo":
      if (kb.undo()) render();
      return;
    case "delword":
      kb.deleteWord();
      return render();
    case "clear":
      if (empty) return;
      if (settings.confirmClear)
        return showSheet({ kind: "confirm", title: "Clear your whole message?", body: "Undo can bring it back.", yes: "Clear it", onYes: () => { kb.clearUndoable(); render(); } });
      kb.clearUndoable();
      render();
      return showToast("Message cleared. Undo brings it back.", 2500);
    case "again":
      if (history[0]) say(history[0]);
      return;
    case "pause":
      return pauseSpeech();
    case "stop":
      return stopSpeech();
    case "voice":
      return openScreen(screenName === "voice" ? null : "voice");
    case "phrases":
    case "access":
    case "settings":
    case "recent":
    case "local":
      return openScreen(screenName === a ? null : (a as ScreenName));
    case "back":
      return openScreen(null);
    case "backset":
      return openScreen("settings");
    case "rest":
      return showSheet({ kind: "rest" });
    case "help":
      return showSheet({ kind: "alarm" });
    case "listen":
      settings.listen = !settings.listen;
      saveSettings();
      return showToast(
        settings.listen
          ? "Listening to the other person. Replies to what they say appear on the home screen."
          : "Stopped listening.",
        3500,
      );
  }
}

function smallestTargetPx() {
  rectsDirty = true;
  measure(appRoot);
  return rects.length ? Math.round(Math.min(...rects.map((r) => Math.min(r.right - r.left, r.bottom - r.top)))) : 0;
}

/** Keyboard menu actions (Done panel) and actions shared with voice commands. */
async function doAction(a: string) {
  const raw = kb.text().trim();
  const text = punctuate(raw);
  // Last line of defence for anything that leaves the app (works for every keyboard, typed any way).
  if ((a === "speak" || a === "insert" || a === "copy") && containsSlur(raw)) {
    showToast(SLUR_NOTICE, 3500);
    return;
  }
  if (a.startsWith("profile:")) {
    switchProfile(a.slice("profile:".length));
    showToast(`Now typing as <b>${esc(profiles.active.name)}</b>`);
    render();
    return;
  }
  switch (a) {
    case "speak":
      if (!raw) {
        showToast("Write something first, then look at Speak.", 2800);
        break;
      }
      say(text);
      acceptSentenceSamples();
      if (!benchmark) {
        predictor.learn(raw);
        kb.clearUndoable();
      }
      break;
    case "insert":
      if (raw && bridge) {
        acceptSentenceSamples();
        predictor.learn(raw);
        const ok = await bridge.insertText(raw);
        showToast(ok ? "Inserted into the focused app" : "Copied. Press ⌘V or Ctrl+V to paste (grant Accessibility for auto-paste).");
        kb.clearUndoable();
      }
      break;
    case "copy":
      if (raw) {
        await navigator.clipboard.writeText(raw).catch(() => {});
        acceptSentenceSamples();
        predictor.learn(raw);
        showToast("Copied to clipboard");
      }
      break;
    case "hide":
      setExpanded(false);
      break;
    case "recal":
      await calibrate();
      break;
    case "recenter":
      await recenter();
      break;
    case "voice":
    case "phrases":
    case "recent":
    case "local":
    case "access":
    case "settings":
      uiAction(a);
      return;
    case "rest":
      showSheet({ kind: "rest" });
      break;
    case "benchmark-done":
      if (benchmark) finishRun(performance.now());
      else showToast("No benchmark run active. Start one from Settings, For caretakers.");
      break;
  }
  render();
}

// ---------- calibration ----------
/** Full calibration. Resolves true when it finished (mouse mode needs none). */
async function calibrate(): Promise<boolean> {
  if (gaze.source !== "camera") {
    showToast("Calibration needs the camera. You're in mouse mode.");
    return gaze.source === "mouse";
  }
  const tape = settings.saveCalibrations ? new SessionTape(gaze) : null;
  const stats = await runCalibration(gaze, calRoot, geometry, "Look at each dot until it disappears.", tape ?? undefined);
  tape?.stop();
  dwell.reset();
  targetTracker.reset();
  if (stats && tape) {
    // Save the calibration as a replayable session (raw frames + dots) for offline evaluation.
    const g = geometry();
    const id = (settings.participant || "anon").replace(/[^\w-]+/g, "_");
    const session = tape.toSession(
      {
        participant: settings.participant || "anon",
        pointer: "pointer",
        glasses: false,
        lighting: "",
        notes: `app calibration, pointer, hit6 ${Math.round(stats.hit6 * 100)}%, hit16 ${Math.round(stats.hit16 * 100)}%`,
        mode: "calibration",
        distanceCm: settings.distanceCm,
        screenDiagonalIn: g.screenDiagonalIn,
        hfovDeg: settings.hfovDeg,
      },
      tracker,
    );
    download(new Blob([JSON.stringify(session)], { type: "application/json" }), `gazecal-pointer-${id}-${session.createdAt.replace(/[:.]/g, "-")}.json`);
  }
  if (!stats) {
    showToast("Calibration cancelled or failed.");
    return false;
  }
  lastError = stats;
  rec.event("calibrated", { model: "pointer", error: stats, samples: gaze.calibrationSamples.length });
  const g2 = geometry();
  // Face lost during the check: the numbers would be fake, so say so instead.
  if (stats.lostCheckDots * 2 >= stats.checkDots) {
    showToast(
      `<b>Your face wasn't found during the accuracy check</b> (${stats.lostCheckDots} of ${stats.checkDots} check dots). The calibration may be fine, but it couldn't be measured. Stay in view of the camera and Recalibrate from Settings.`,
      15000,
    );
    localStorage.setItem("gazetype.lastError.v1", JSON.stringify(stats));
    return true;
  }
  const weakDir = !(stats.dirX > 0.7 && stats.dirY > 0.7);
  showToast(
    `${weakDir ? `<b>The pointer may move the wrong way.</b> Recalibrate from Settings.<br>` : "<b>Calibrated.</b> "}Hit rate: <b>${Math.round(stats.hit6 * 100)}%</b> for 6 large buttons, <b>${Math.round(stats.hit16 * 100)}%</b> for the 4×4 keyboard.<br><small>Mean error ${stats.meanDeg.toFixed(2)}° (${stats.meanPx.toFixed(0)} px), precision ±${stats.precisionDeg.toFixed(2)}°, n=${stats.n}. Assumes ${settings.screenDiagonalIn}" screen at ${g2.distanceCm.toFixed(0)} cm${
      settings.distanceCm ? "" : " (estimated)"
    }. Smallest target: ${smallestTargetPx()} px.</small>`,
    weakDir ? 12000 : 6000,
  );
  localStorage.setItem("gazetype.lastError.v1", JSON.stringify(stats));
  return true;
}

// ---------- start ----------
async function startCamera(mode: "eye" | "head" | "mouse"): Promise<boolean> {
  // Only the pointer tracker exists now; "eye" and "head" both start it.
  if (mode === "mouse") {
    gaze.source = "mouse";
    showToast("Mouse mode: hover to select, or click. Same screens as with the eyes.");
    return true;
  }
  try {
    rec.event("start", { model: "pointer" });
    const where = await tracker.init();
    await tracker.start();
    gaze.source = "camera";
    cameraStarted = true;
    showToast(`Pointer tracker on (${where}). Video stays on this device.`, 3000);
    return true;
  } catch (err) {
    showToast(`Camera failed: ${esc((err as Error).message)}. Check the camera permission, or try mouse mode.`, 7000);
    return false;
  }
}

function showMain() {
  onboard.hide();
  appRoot.hidden = false;
  render();
}

/** After the camera starts: set up a new profile, or calibrate and go to the keyboard. */
function afterCamera() {
  if (!isOnboarded(profiles.active)) return onboard.begin();
  showMain();
  if (gaze.source === "camera") void calibrate();
}

function toggleKeyboard() {
  kb = kb === gazeKb ? baseKb : gazeKb;
  kb.clear();
  if (benchmark) startRun(benchmark.index);
  else session = new TypingSession(kb.name, settings.selectionMode);
  render();
}

// ---------- session recording (offline evaluation) ----------
function openRecord() {
  if (gaze.source !== "camera") {
    showToast("Recording needs the camera. You're in mouse mode.");
    return;
  }
  const dlg = $<HTMLDialogElement>("#record");
  const form = dlg.querySelector("form")!;
  const pid = form.elements.namedItem("participant") as HTMLInputElement;
  if (!pid.value) pid.value = settings.participant;
  dlg.querySelector<HTMLElement>(".record-mode")!.textContent = "Pointer tracker: look at each dot until it disappears.";
  dlg.onclose = async () => {
    if (dlg.returnValue !== "ok") return;
    const fd = new FormData(form);
    const g2 = geometry();
    const mode = fd.get("mode");
    const meta: SessionMeta = {
      participant: String(fd.get("participant") ?? "").trim(),
      pointer: "pointer",
      mode: mode === "short" ? "short" : mode === "full" ? "full" : mode === "target" ? "target" : "quick",
      glasses: fd.get("glasses") === "on",
      lighting: String(fd.get("lighting") ?? ""),
      notes: String(fd.get("notes") ?? ""),
      distanceCm: Number(fd.get("distanceCm")) || 0,
      screenDiagonalIn: g2.screenDiagonalIn,
      hfovDeg: settings.hfovDeg,
    };
    if (meta.mode === "target") {
      // Closed loop: needs a calibration, then the user steers the visible pointer onto each button.
      if (!gaze.calibrated) return showToast("Calibrate first, then run the Target test.");
      const s = await runTargetTest(gaze, tracker, calRoot, { meta, dwellMs: settings.dwellMs });
      if (!s) return showToast("Target test cancelled; nothing saved.");
      const id = (meta.participant || "anon").replace(/[^\w-]+/g, "_");
      download(new Blob([JSON.stringify(s)], { type: "application/json" }), `gazetarget-${meta.pointer}-${id}-${s.createdAt.replace(/[:.]/g, "-")}.json`);
      const trials = s.targetTest!.trials;
      const by = (layout: string) => {
        const t = trials.filter((x) => x.layout.startsWith(layout));
        return t.length ? `${Math.round((t.filter((x) => x.outcome === "correct").length / t.length) * 100)}% right, ${t.filter((x) => x.outcome === "wrong").length} wrong` : "–";
      };
      return showToast(`<b>Target test saved.</b> 6 buttons: ${by("6")} · 4×4 grid: ${by("16")}. Move it to VisualEyes/recordings/ and run npm run replay.`, 12000);
    }
    const n = await recordSession(gaze, tracker, calRoot, { meta, video: fd.get("video") === "on" });
    showToast(
      n === null
        ? "Recording cancelled before the check dots finished; nothing saved."
        : `Saved session (${n} frames) to your Downloads. Move it to VisualEyes/recordings/ and run <code>npm run replay -- recordings/*.json</code>.`,
      9000,
    );
  };
  dlg.showModal();
}
function exportData() {
  const data = rec.toJSON({
    model: "pointer",
    featureNames: rec.featureNames,
    settings,
    lastError,
    calibration: gaze.calibrationSamples.map((s) => ({ f: s.features.map((v) => Math.round(v * 1e5) / 1e5), x: Math.round(s.x), y: Math.round(s.y) })),
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = `visualeyes-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  showToast(`Exported ${rec.frameCount} frames + events. Numbers only, no video.`);
}
// Import a pointer-tracker calibration made in the other build. Accepts either that app's "Export data" JSON
// ({calibration: [{f, x, y}], window}) or its saved calibration object ({samples: [{features, x, y}], w, h}).
function importCalibration() {
  if (gaze.source !== "camera") return showToast("Start the pointer tracker first, then import.");
  $<HTMLInputElement>("#import-file").click();
}
$<HTMLInputElement>("#import-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    const raw: { f: number[]; x: number; y: number }[] = (d.calibration ?? d.samples ?? []).map((s: { f?: number[]; features?: number[]; x: number; y: number }) => ({ f: s.f ?? s.features ?? [], x: s.x, y: s.y }));
    const srcW: number = d.window?.w ?? d.w ?? innerWidth;
    const srcH: number = d.window?.h ?? d.h ?? innerHeight;
    if (d.model && d.model !== "pointer") return showToast(`That file is from the "${esc(String(d.model))}" model, not the pointer tracker.`);
    if (raw.length < 30 || raw.some((s) => s.f.length !== 10)) return showToast("Not a pointer-tracker calibration (expected 10 pointer features per sample).");
    // Samples are in screen pixels; rescale if the window size differs from when they were recorded.
    const sx = innerWidth / srcW;
    const sy = innerHeight / srcH;
    gaze.setCalibration(raw.map((s) => ({ features: s.f, x: s.x * sx, y: s.y * sy })));
    showToast(`Imported ${raw.length} calibration samples${Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02 ? ` (rescaled from ${srcW}x${srcH})` : ""}. Sit as you did when you calibrated.`, 7000);
  } catch (err) {
    showToast(`Import failed: ${esc((err as Error).message)}`);
  }
});

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
  gazeKb.useHome = false;
  kb.clear();
  session = new TypingSession(kb.name, gaze.source === "mouse" ? `${settings.selectionMode}+mouse` : settings.selectionMode, target);
  targetBar.hidden = false;
  targetBar.innerHTML = `Type: <b>${target}</b> <small>(timer starts on first selection · ${kb === gazeKb ? "GazeType" : "Baseline"} · finish from Done)</small> <button id="next-sentence" type="button">Next sentence</button> <button id="stop-bench" type="button">Stop</button>`;
  $("#next-sentence").addEventListener("click", () => startRun(++benchIndex));
  $("#stop-bench").addEventListener("click", () => {
    benchmark = null;
    gazeKb.useHome = true;
    targetBar.hidden = true;
    kb.clear();
    render();
  });
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
  gazeKb.useHome = true;
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
    : "<p>No runs yet. Start one from Settings, For caretakers, on each keyboard.</p>";
  dlg.showModal();
}
$("#export-runs").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ runs: runs(), calibration: lastError, settings }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `visualeyes-runs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});
$("#clear-runs").addEventListener("click", () => {
  localStorage.removeItem(RUNS_KEY);
  showResults();
});

// ---------- advanced settings dialog (caretaker) ----------
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
  saveSettings();
  if (settings.voice && !prevVoice) void enableVoice();
  if (!settings.voice && prevVoice) stopVoice?.();
});

// ---------- voice commands ----------
let stopVoice: (() => void) | null = null;
async function enableVoice() {
  try {
    stopVoice = await startVoiceCommands((cmd, heard) => {
      showToast(`“${esc(heard)}”`, 1500);
      if (cmd === "show") setExpanded(true);
      else if (cmd === "hide") setExpanded(false);
      else void doAction("speak");
    });
    showToast("Voice commands on: say “gaze type” or “open keyboard”, or “hide keyboard”.");
  } catch (err) {
    showToast(`Voice commands unavailable: ${esc((err as Error).message)}`);
    settings.voice = false;
    saveSettings();
  }
}

// ---------- profiles ----------
const ONBOARDED = "visualeyes.onboarded.v1";
const DRAFT = "visualeyes.aiprefs.v1";

/** Has this profile been through onboarding? Profiles from before onboarding count if they already have an AI profile. */
function isOnboarded(p: Profile): boolean {
  return localStorage.getItem(profiles.keyFor(p.id, ONBOARDED)) === "1" || !!(p.about.trim() || p.people.length || p.samples.length);
}

/** What onboarding last saved for this profile, or a draft made from the profile itself. */
function draftFor(p: Profile): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(profiles.keyFor(p.id, DRAFT)) ?? "null") as Draft | null;
    if (d) return { ...emptyDraft(), ...d, people: p.people, ai: settings.ai };
  } catch {
    /* fall through */
  }
  return { ...emptyDraft(), call: p.name === "Me" ? "" : p.name, extra: p.about, people: p.people, ai: settings.ai };
}

/** Everything that depends on who is typing: prediction data, calibration, LLM context. */
function applyProfile(p: Profile) {
  gaze.storageKey = profiles.keyFor(p.id, CAL_KEY);
  setLlmProfile({ id: p.id, name: p.name, about: p.about, people: p.people, samples: p.samples });
  loadHistory();
  if (settings.ai) void llmWarm();
}

function switchProfile(id: string) {
  if (id === profiles.active.id) return;
  const p = profiles.setActive(id);
  predictor.useStore(profiles.store(p.id));
  applyProfile(p);
  // Each person's eyes need their own calibration.
  if (gaze.source === "camera" && !gaze.loadSavedCalibration()) showToast(`No calibration saved for ${esc(p.name)} yet: choose Recalibrate.`);
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
  predictor.setTopics(pf.about.value);
  applyProfile(profiles.active);
  render();
  prefsChanged();
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
  prefsChanged();
  pf.samples.value = "";
  pf.learned.textContent = `Learned from ${n} sentences. ${samples.length} are used as examples for AI suggestions.`;
});
$("#pf-export").addEventListener("click", () => {
  const p = profiles.list().find((x) => x.id === editingId)!;
  const blob = new Blob([profiles.exportProfile(p.id)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `visualeyes-profile-${p.name.replace(/\W+/g, "-").toLowerCase()}.json`;
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

// ---------- service status (AI and voice), shown on the start screen ----------
let llmLine = { text: "Checking AI suggestions…", on: false };
let ttsLine = { text: "Checking voice…", on: false };

function updateTtsLine() {
  const st = voiceCtl.status();
  const on = st === "active" && voiceCtl.usable();
  ttsLine = {
    on,
    text: on
      ? "Speaking in your own voice"
      : st === "active"
        ? "Your voice needs verifying at elevenlabs.io first (open My voice). The standard voice speaks until then."
        : st === "paused"
          ? "Your voice is paused: the standard voice speaks."
          : "Standard voice. Open My voice to create one that sounds like you.",
  };
  if (onboard.visible && onboard.step === "start") onboard.render();
}

/**
 * Check the local server for AI suggestions and voice. `npm run dev:all` starts the page and the server together,
 * so the first check can beat the server: while it isn't reachable, check again every 2 s for up to a minute.
 */
async function refreshServices(attempt = 0) {
  await llmAvailable(attempt > 0);
  const ai = llmStatus();
  llmOn = ai.on;
  llmLine = {
    on: ai.on,
    text: ai.on
      ? `AI suggestions on${ai.fastModel ? ` (${ai.fastModel})` : ""}`
      : ai.reason === "sign-in"
        ? "AI suggestions: a caretaker signs in to turn them on. Word prediction works without an account."
        : ai.reason === "no-key"
        ? "AI suggestions off: the AI server has no API key. Add ANTHROPIC_API_KEY to VisualEyes/.env and restart it."
        : "AI suggestions off: the AI server isn't running (npm run dev:all). Word prediction still works.",
  };
  updateTtsLine();
  if (ai.on && settings.ai) void llmWarm();
  if (ai.reason === "no-server" && attempt < 30) setTimeout(() => void refreshServices(attempt + 1), 2000);
}

// ---------- account: Auth0 sign-in, preferences and voice in the cloud ----------
// Auth0 signs people in (passwords, sign-up, resets, social logins). Its access token goes to our hosted service (the
// same one as "My voice"), which keys each person's preferences and voice in DynamoDB by their Auth0 user id.
// In VisualEyes the account belongs to the caretaker, who signs in during onboarding or from Settings.
const auth0Cfg = auth0Config((import.meta as unknown as { env: Record<string, string | undefined> }).env);
const auth = auth0Cfg && canRedirect() ? new Auth0Session(auth0Cfg) : null;
const accountApi = new AccountApi(() => voiceApiSettings.baseUrl);
let account: SignedInUser | null = null;
const ACCOUNT_PROFILE = "gazetype.accountProfile.";
const token = async () => (account && auth ? auth.token() : null);

function collectPrefs(): SyncedPrefs {
  const p = profiles.active;
  return { settings: { ...settings }, profile: { name: p.name, about: p.about, people: p.people, samples: p.samples } };
}

function applyRemotePrefs(r: SyncedPrefs) {
  const s = settings as unknown as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = r.settings?.[k];
    if (v !== undefined && typeof v === typeof DEFAULTS[k]) s[k] = v; // ignore anything this build doesn't understand
  }
  storeSettings();
  applyLook();
  baseKb.withPrediction = settings.baselinePrediction;
  if (r.profile) {
    const { name, about, people, samples } = r.profile;
    profiles.update(profiles.active.id, {
      ...(typeof name === "string" && name ? { name } : {}),
      ...(typeof about === "string" ? { about } : {}),
      ...(Array.isArray(people) ? { people: people.filter((x) => typeof x === "string") } : {}),
      ...(Array.isArray(samples) ? { samples: samples.filter((x) => typeof x === "string") } : {}),
    });
    predictor.setPinned(profiles.active.people);
    predictor.setTopics(profiles.active.about);
  }
  applyProfile(profiles.active);
  render();
}

/** The local profile that belongs to this account: the one used last time, else the current one if no other account claimed it, else a new one. */
function profileFor(user: SignedInUser): string {
  const linked = localStorage.getItem(ACCOUNT_PROFILE + user.sub);
  if (linked && profiles.list().some((p) => p.id === linked)) return linked;
  const claimed = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(ACCOUNT_PROFILE)) claimed.add(localStorage.getItem(k) ?? "");
  }
  const id = claimed.has(profiles.active.id) ? profiles.create("Me").id : profiles.active.id;
  localStorage.setItem(ACCOUNT_PROFILE + user.sub, id);
  return id;
}

const prefsSync = new PrefsSync(
  accountApi,
  token,
  collectPrefs,
  (e) => {
    if (e.status === 401) void signOut("Your sign-in has ended. Sign in again to keep settings in step.");
  },
  1500,
  () => account !== null,
);
prefsChanged = () => prefsSync.schedule();

async function startAccount(user: SignedInUser) {
  account = user;
  setSkippedSignIn(localStorage, false);
  setTokenProvider(token); // "My voice" now belongs to this Auth0 user
  setLlmToken(token); // and AI suggestions are allowed (the deployed site requires a sign-in for them)
  void refreshServices(1);
  switchProfile(profileFor(user));
  applyProfile(profiles.active);
  void voiceCtl.refresh().then(updateTtsLine);
  try {
    const t = await token();
    if (t) void accountApi.me(t).catch(() => {}); // lets the service save this person's email and name next to their data
    const remote = await prefsSync.pull(); // the service's copy wins; a brand-new account gets this computer's
    if (remote) applyRemotePrefs(remote);
  } catch (e) {
    showToast(`Signed in, but settings couldn't be loaded: ${esc((e as Error).message)}`);
  }
}

async function signOut(message?: string) {
  if (account) await prefsSync.flush(); // don't lose a change made in the last second
  account = null;
  setTokenProvider(null);
  setLlmToken(null);
  if (message) showToast(esc(message), 6000);
  render();
  await auth?.signOut(); // ends the Auth0 session too, then comes back to this page signed out
}

/** Why sign-in can't be offered on this copy. */
function onboardAuthWhy(): string {
  return !auth0Cfg
    ? "Sign-in isn't set up on this copy yet (VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID and VITE_AUTH0_AUDIENCE in VisualEyes/.env)."
    : "Sign-in needs the web version of VisualEyes.";
}

/** Finish an Auth0 redirect or restore the last session, before anything asks the service about this user's voice. */
async function initAccount() {
  if (!auth) return;
  try {
    const user = await auth.init();
    if (user) await startAccount(user);
  } catch (e) {
    showToast(`Sign-in problem: ${esc((e as Error).message)}`, 8000);
  }
}

// ---------- onboarding ----------
const onboard = new Onboarding(onboardRoot, {
  settings,
  saveSettings,
  toast: showToast,
  calibrated: () => gaze.source === "mouse" || (gaze.source === "camera" && gaze.calibrated),
  mouse: () => gaze.source === "mouse",
  head: () => true,
  cameraOn: () => cameraStarted || gaze.source === "mouse",
  faceVisible: () => gaze.faceVisible,
  cameraStream: () => (video.srcObject instanceof MediaStream ? video.srcObject : null),
  startCamera,
  afterCamera,
  calibrate,
  auth: () => ({
    available: !!auth,
    why: auth ? null : onboardAuthWhy(),
    signedIn: !!account,
    who: account?.name || account?.email || "",
  }),
  signIn: (signUp) => (auth ? auth.signIn(signUp) : Promise.reject(new Error("sign-in is not set up"))),
  signOut: () => void signOut(),
  skipSignIn: () => setSkippedSignIn(localStorage, true),
  finish: (d, about) => {
    const p = profiles.active;
    const name = (d.call.trim() || d.full.trim().split(/\s+/)[0] || p.name).slice(0, 60);
    const people = d.people.slice(0, 40);
    profiles.update(p.id, { name, about, people });
    if (d.learned && d.consent && d.writing.trim()) {
      predictor.ingest(d.writing);
      profiles.update(p.id, { samples: pickSamples([...p.samples, ...splitSentences(d.writing)]) });
    }
    predictor.setPinned(people);
    predictor.setTopics(about);
    localStorage.setItem(profiles.keyFor(p.id, ONBOARDED), "1");
    // Their writing is learned now; keep the answers, not the text, for the next review.
    localStorage.setItem(profiles.keyFor(p.id, DRAFT), JSON.stringify({ ...d, writing: "", learned: d.learned }));
    applyProfile(profiles.active);
    settings.ai = d.ai;
    saveSettings();
    showMain();
    showToast(`Saved. Suggestions now use what you chose${d.ai ? "" : ". AI suggestions are off"}.`, 3500);
    if (gaze.source === "camera" && !gaze.calibrated) void calibrate();
  },
  cancel: () => {
    showMain();
    if (gaze.source === "camera" && !gaze.calibrated) void calibrate();
  },
  examples: async (d, about) => {
    if (!d.ai || !(await llmAvailable())) return null;
    const p = profiles.active;
    setLlmProfile({ id: `preview-${Date.now()}`, name: d.call || p.name, about, people: d.people, samples: d.learned ? pickSamples(splitSentences(d.writing)) : p.samples });
    try {
      const out = await llmPredict({ task: "continue", text: "I would like", n: 3 });
      return out.map((s) => s.replace(/^\s*i would like\s*/i, "").trim()).filter(Boolean);
    } finally {
      setLlmProfile({ id: p.id, name: p.name, about: p.about, people: p.people, samples: p.samples });
    }
  },
  sentences: (t) => splitSentences(t).length,
  profileName: () => profiles.active.name,
  profiles: () => profiles.list(),
  activeProfile: () => profiles.active.id,
  switchProfile: (id) => switchProfile(id),
  statusLines: () => [llmLine, ttsLine],
  shown: () => {
    appRoot.hidden = true;
    clearHover();
    hideLostHint();
  },
});

voiceCtl.subscribe(() => {
  if (screenName === "voice" || screenName === "voiceSetup") render();
  else if (!appRoot.hidden) renderHeader();
});

// ---------- boot ----------
async function boot() {
  applyLook();
  // 30k English words by frequency (wordfreq, CC BY-SA 4.0; see public/data/WORDS-LICENSE.txt).
  const words = await fetch("./data/words-30k.txt").then((r) => r.text());
  predictor.load(words.split("\n"), CORE_WORDS, SEED_PHRASES);
  await initAccount();
  applyProfile(profiles.active);
  gazeKb.update();
  // Back from the caretaker's sign-in page: carry on where they were. Otherwise the start screen.
  if (!onboard.resume()) onboard.showStart();
  void voiceCtl.refresh().then(updateTtsLine); // learn whether this user already has a voice; harmless if the service is not running
  void refreshServices();
  try {
    const le = localStorage.getItem("gazetype.lastError.v1");
    if (le) lastError = JSON.parse(le);
  } catch {
    /* ignore */
  }
  if (settings.voice) void enableVoice();
  syncListener();
  if (bridge) showToast(`Toggle: ${esc(bridge.shortcut)} · say “gaze type” · or look at the top-right corner`, 5000);
  updateStatus();
}
void boot();
