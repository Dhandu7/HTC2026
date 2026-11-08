// "My voice" and "Create my voice", operated by gaze. The logic is voice/hostedController.ts (the same one the
// caretaker dialog in myVoice.ts uses); this file only draws it and keeps the unsent recordings.
//
// Text from the service (errors, notices, consent statements) is escaped before it goes into markup.
import { esc, fmtTime, g, honeycomb } from "./dom";
import type { Screen, ScreenName } from "./screens";
import type { HostedVoiceController } from "../voice/hostedController";
import { startRecording, type Recording } from "../voice/recorder";
import { MAX_RECORDING_SECONDS, checkInputs } from "../voice/clipInput";

/** A live recording must be at least this long to be added. */
export const MIN_RECORDING_S = 10;
const SAMPLE = "Hello, it's me. This is my voice.";

export interface VoiceScreensCtx {
  controller: HostedVoiceController;
  toast(html: string, ms?: number): void;
  open(name: ScreenName | null): void;
  confirm(title: string, body: string, yes: string, onYes: () => void): void;
  /** Draw the open screen again (state changed). */
  rerender(): void;
  /** Speak a sample in the standard system voice, whatever voice is active. */
  speakSystem(text: string): void;
  /** The caretaker dialog: fine-tuning, someone else's voice with permission, service address. */
  advanced(): void;
}

interface Clip {
  name: string;
  blob: Blob;
  label: string;
  seconds?: number;
  source: "recorded" | "file";
}

export function makeVoiceScreens(ctx: VoiceScreensCtx): { voice: Screen; voiceSetup: Screen; fileInput: HTMLInputElement } {
  const c = ctx.controller;
  const form = { ack: false, remote: false };
  let clips: Clip[] = [];
  let rec: { r: Recording; start: number } | null = null;
  let pending: Clip | null = null;
  let recMsg = "";
  let ticker = 0;
  let playing: { audio: HTMLAudioElement; url: string; key: string } | null = null;

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener("change", () => {
    const list = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    const { accepted, problems } = checkInputs(clips.map((x) => ({ name: x.name, size: x.blob.size })), list.map((f) => ({ name: f.name, size: f.size })));
    for (const i of accepted) {
      const clip: Clip = { name: list[i].name, blob: list[i], label: list[i].name, source: "file" };
      clips.push(clip);
      // Read the length so the list can show it; the service decides what it can use.
      const url = URL.createObjectURL(list[i]);
      const a = new Audio();
      a.preload = "metadata";
      a.onloadedmetadata = () => {
        if (Number.isFinite(a.duration)) clip.seconds = a.duration;
        URL.revokeObjectURL(url);
        ctx.rerender();
      };
      a.onerror = () => URL.revokeObjectURL(url);
      a.src = url;
    }
    if (problems.length) ctx.toast(esc(problems.join(" ")), 6000);
    ctx.rerender();
  });
  document.body.append(fileInput);

  const stopPlay = () => {
    if (!playing) return;
    playing.audio.pause();
    URL.revokeObjectURL(playing.url);
    playing = null;
  };
  const play = (key: string, blob: Blob) => {
    const same = playing?.key === key;
    stopPlay();
    if (!same) {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      playing = { audio, url, key };
      audio.onended = () => {
        stopPlay();
        ctx.rerender();
      };
      audio.play().catch(() => {
        stopPlay();
        ctx.toast("That recording can't be played in this browser. The voice service may still be able to use it.");
      });
    }
    ctx.rerender();
  };

  const recSecs = () => (rec ? (performance.now() - rec.start) / 1000 : 0);
  const tickRecording = () => {
    const root = document.querySelector("#screen");
    if (!root || !rec) return;
    const s = recSecs();
    const t = root.querySelector<HTMLElement>(".vtimer");
    const b = root.querySelector<HTMLElement>(".vbar > i");
    const n = root.querySelector<HTMLElement>(".vnote");
    if (t) t.textContent = fmtTime(s);
    if (b) {
      b.style.width = `${Math.min(100, (s / MIN_RECORDING_S) * 100)}%`;
      b.style.background = s >= MIN_RECORDING_S ? "var(--ok)" : "var(--brand)";
    }
    if (n) n.textContent = s >= MIN_RECORDING_S ? "Long enough. Stop whenever you like." : "Keep going…";
  };

  async function startRec() {
    recMsg = "";
    pending = null;
    try {
      const r = await startRecording(undefined, MAX_RECORDING_SECONDS, () => void stopRec());
      rec = { r, start: performance.now() };
      ticker = window.setInterval(tickRecording, 250);
    } catch (e) {
      recMsg = (e as Error).message;
    }
    ctx.rerender();
  }

  async function stopRec() {
    if (!rec) return;
    const r = rec;
    rec = null;
    clearInterval(ticker);
    try {
      const res = await r.r.stop();
      if (res.seconds < MIN_RECORDING_S) recMsg = `That was only ${fmtTime(res.seconds)}. Please record at least ${fmtTime(MIN_RECORDING_S)}.`;
      else pending = { name: res.filename, blob: res.blob, label: `Recording ${clips.filter((x) => x.source === "recorded").length + 1}`, seconds: res.seconds, source: "recorded" };
    } catch {
      recMsg = "The recording stopped unexpectedly. Please try again.";
    }
    ctx.rerender();
  }

  const totalSecs = () => clips.reduce((n, x) => n + (x.seconds ?? 0), 0);
  const canCreate = () => form.ack && form.remote && clips.length > 0 && !rec && !c.state.busy;

  const messages = () => {
    const st = c.state;
    return [st.error ? `<p class="hint" style="color:var(--bad);margin:0" role="alert">${esc(st.error)}</p>` : "", st.notice ? `<p class="hint" style="color:var(--ok);margin:0" role="status">${esc(st.notice)}</p>` : ""].join("");
  };

  const voice: Screen = {
    title: "My voice",
    sub: "Choose how VisualEyes sounds when you speak.",
    back: "message",
    render() {
      const st = c.state;
      const v = st.voice;
      if (st.phase === "loading") return `<div class="card grow centre" style="justify-content:center"><div style="height:8rem;display:flex;align-items:center">${honeycomb(true)}</div><h2>Checking your voice…</h2></div>`;
      if (st.phase === "unreachable" || st.phase === "signed-out" || st.phase === "deleting") {
        const body =
          st.phase === "deleting"
            ? "Your voice is switched off and waiting to be deleted."
            : st.phase === "signed-out"
              ? "Your own voice is kept with your account. A caretaker can sign in under Settings."
              : "The voice service can't be reached right now. VisualEyes is speaking in the standard voice.";
        return `<div class="card grow centre" style="justify-content:center"><h2 style="font-size:2.5rem">${esc(body)}</h2>${messages()}
          <div class="row">${st.phase === "deleting" ? g("s:v:delvoice", "Try deleting again", { face: "btn xl", faceStyle: "width:22rem" }) : g("s:v:retry", "Try again", { face: "btn xl", faceStyle: "width:18rem" })}${g("s:v:pvstd", "Listen to the standard voice", { face: "btn xl", faceStyle: "width:26rem" })}</div>
          <div class="tools"><button type="button" data-act="advanced">Voice service settings (caretaker)</button></div></div>`;
      }
      const has = !!v;
      const mineOn = c.usable();
      const mineBadge = !has ? (st.phase === "creating" ? "Building" : "Not created yet") : v!.needsVerification ? "Waiting for verification" : v!.status === "paused" ? "Not in use" : "In use";
      const secs = v ? v.clips.reduce((n, x) => n + x.seconds, 0) : 0;
      const mineInfo = !has
        ? st.phase === "creating"
          ? "Building your voice. This can take up to a minute."
          : "You have not created your voice yet. It takes a few minutes and a short recording."
        : "Made from your own recordings, with your agreement. Look at Listen to hear a sample.";
      const verify = v?.needsVerification
        ? `<div class="card" style="border-color:var(--coral);flex:none;padding:1rem 1.625rem"><div class="row" style="justify-content:space-between">
            <div><div class="lbl">ElevenLabs needs to check this is really your voice</div><div class="hint">A helper signs in at elevenlabs.io, opens Voices${v.voiceName ? `, finds “${esc(v.voiceName)}”` : ""} and completes its short check. Until then the standard voice speaks.</div></div>
            ${g("s:v:verify", "I've verified, check again", { face: "btn-teal", faceStyle: "width:24rem" })}</div></div>`
        : "";
      return `
        ${verify}
        <div class="row grow" style="gap:1.25rem;align-items:stretch">
          <div class="card col grow" style="gap:.75rem">
            <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-size:2.125rem">My voice</h2><span class="badge${mineOn ? "" : " soft"}">${esc(mineBadge)}</span></div>
            <p style="font-size:1.375rem">${esc(mineInfo)}</p>
            ${st.phase === "creating" ? `<div style="height:6rem;display:flex;align-items:center;justify-content:center">${honeycomb(true)}</div>` : ""}
            <div style="margin-top:auto;display:flex;flex-direction:column">
              ${
                has
                  ? `<div style="display:flex">${g("s:v:pvmine", "Listen", { face: "btn lg", style: "flex:1", off: !mineOn || st.busy })}${g("s:v:usemine", mineOn ? "In use" : "Use this voice", { face: "btn-teal", style: "flex:1", off: v!.status === "active" || st.busy })}</div>
                     <div style="display:flex">${g("s:v:retrain", "Retrain my voice", { face: "btn lg", style: "flex:1", off: st.busy })}${g("s:v:delvoice", "Delete my voice", { face: "btn lg danger", style: "flex:1", off: st.busy })}</div>`
                  : g("s:v:mkvoice", "Create my voice", { face: "btn-teal", faceStyle: "min-height:6rem;font-size:2rem", off: st.phase === "creating" })
              }
            </div>
          </div>
          <div class="card col grow" style="gap:.75rem">
            <div class="row" style="justify-content:space-between"><h2 style="margin:0;font-size:2.125rem">Standard voice</h2><span class="badge${mineOn ? " soft" : ""}">${mineOn ? "Not in use" : "In use"}</span></div>
            <p style="font-size:1.375rem">A clear voice built into this device. It works without any setup and is always available.</p>
            <div style="margin-top:auto;display:flex">${g("s:v:pvstd", "Listen", { face: "btn lg", style: "flex:1" })}${g("s:v:usestd", mineOn ? "Use this voice" : "In use", { face: "btn-teal", style: "flex:1", off: !mineOn || st.busy })}</div>
          </div>
        </div>
        <div class="card" style="flex:none;padding:1rem 1.625rem;display:flex;align-items:center;gap:1.25rem">
          <div class="grow">
            <div class="lbl" style="font-size:1.5rem">Your recordings: ${v ? `${v.clips.length} used (${fmtTime(secs)})` : "none"}</div>
            <div class="hint">They are used only for your voice. Speech from your voice is AI-generated. Deleting your voice removes it at ElevenLabs too.</div>
            ${messages()}
          </div>
          <div class="tools"><button type="button" data-act="advanced">Fine-tune (caretaker)</button></div>
        </div>`;
    },
    select(id) {
      const a = id.split(":")[2];
      const v = c.state.voice;
      switch (a) {
        case "retry":
          return void c.refresh();
        case "pvmine":
          return void c.test(SAMPLE);
        case "pvstd":
          return ctx.speakSystem(SAMPLE);
        case "usemine":
          return void c.setPaused(false);
        case "usestd":
          if (v && v.status === "active") void c.setPaused(true);
          return;
        case "verify":
          return void c.recheckVerification();
        case "mkvoice":
          return ctx.open("voiceSetup");
        case "retrain":
          return ctx.confirm("Make a new voice?", "Your current voice is deleted first, then you record again. The standard voice speaks in between.", "Make a new one", () => {
            void c.remove().then((ok) => ok && ctx.open("voiceSetup"));
          });
        case "delvoice":
          return ctx.confirm("Delete your voice?", "Your voice is removed here and at ElevenLabs. This can't be undone. You can create a new voice later.", "Delete my voice", () => void c.remove());
      }
    },
  };

  const voiceSetup: Screen = {
    title: "Create my voice",
    sub: "VisualEyes can speak in a voice that sounds like yours.",
    back: "message",
    render() {
      const st = c.state;
      if (st.phase === "creating")
        return `<div class="card grow centre" style="justify-content:center"><div style="width:18.75rem;height:14.375rem;display:flex;align-items:center;justify-content:center">${honeycomb(true)}</div>
          <h2 style="font-size:2.5rem;margin:0">Building your voice…</h2><p style="font-size:1.625rem">This can take up to a minute. You can keep this screen open.</p></div>`;
      if (st.phase === "ready" && st.voice) {
        // Created (or already had one): the manage screen says what happens next.
        queueMicrotask(() => ctx.open("voice"));
        return "";
      }
      const statements = st.consent?.statements ?? [
        "Your recordings are used only to build your voice.",
        "You can listen to them, replace them or delete them at any time.",
        "You can delete your voice completely whenever you like.",
      ];
      const recOn = !!rec;
      const s = recOn ? recSecs() : pending?.seconds ?? 0;
      const note = recMsg || (recOn ? (s >= MIN_RECORDING_S ? "Long enough. Stop whenever you like." : "Keep going…") : pending ? `Recorded ${fmtTime(pending.seconds ?? 0)}. Replay it, redo it, or add it.` : "Say anything you like, in your own words.");
      const recBtns = recOn
        ? g("s:vs:recstop", "Stop", { face: "btn lg", style: "flex:1" })
        : pending
          ? g("s:vs:replay", playing?.key === "pending" ? "Stop" : "Replay", { face: "btn lg", style: "flex:1" }) + g("s:vs:redo", "Redo", { face: "btn lg", style: "flex:1" }) + g("s:vs:add", "Add it", { face: "btn-teal", style: "flex:1.4" })
          : g("s:vs:recstart", "Start recording", { face: "btn-teal", style: "flex:1" });
      const total = totalSecs();
      const hint = !form.ack || !form.remote ? "Agree to both points on the left, then add recordings." : clips.length === 0 ? "Add at least one recording. A minute or two sounds best." : "Ready when you are. More recordings usually sound better.";
      return `
        <div class="row grow" style="gap:1.25rem;align-items:stretch">
          <div class="col" style="width:30rem;flex:none;gap:.75rem;min-height:0">
            <div class="card grow" style="overflow:auto;padding:1.125rem 1.375rem"><h2 style="font-size:1.5rem">Your voice belongs to you</h2>
              ${statements.map((t, i) => `<p style="margin-bottom:.5rem;font-size:1.0625rem"><b style="color:var(--ink)">${i + 1}.</b> ${esc(t)}</p>`).join("")}</div>
            <div class="card" style="padding:.75rem 1rem;display:flex;flex-direction:column;gap:.25rem">
              <div class="row" style="gap:.875rem">${g("s:vs:ack", form.ack ? "Agreed" : "Agree", { face: "btn lg", on: form.ack, style: "flex:none", faceStyle: "width:8.5rem" })}<div style="font-size:1.125rem;font-weight:700;line-height:1.3">This is my own voice. Use my recordings to build it.</div></div>
              <div class="row" style="gap:.875rem">${g("s:vs:remote", form.remote ? "Agreed" : "Agree", { face: "btn lg", on: form.remote, style: "flex:none", faceStyle: "width:8.5rem" })}<div style="font-size:1.125rem;font-weight:700;line-height:1.3">My recordings, and what I say later, go to ElevenLabs to make the voice.</div></div>
            </div>
          </div>
          <div class="col grow" style="gap:.75rem">
            <div class="row" style="gap:1rem;align-items:stretch;flex:none">
              <div class="card grow" style="display:flex;flex-direction:column;padding:1.125rem 1.375rem">
                <div class="row" style="justify-content:space-between"><h2 style="margin:0">Record now</h2>${recOn ? `<span class="chip" style="height:2.375rem;font-size:1rem"><i class="rec"></i>Recording</span>` : ""}</div>
                <div class="row" style="gap:.875rem;margin:.5rem 0 .25rem;height:3.5rem">
                  <span class="vtimer" style="font-size:3rem;font-weight:900;font-variant-numeric:tabular-nums">${fmtTime(s)}</span>
                  <span class="hint">needs at least ${fmtTime(MIN_RECORDING_S)}</span>
                </div>
                <div class="bar vbar" style="margin-bottom:.625rem"><i style="width:${Math.min(100, (s / MIN_RECORDING_S) * 100)}%;background:${s >= MIN_RECORDING_S ? "var(--ok)" : "var(--brand)"}"></i></div>
                <div class="vnote" style="min-height:2.125rem;font-size:1.1875rem;font-weight:700;color:${recMsg ? "var(--bad)" : "var(--mute)"}">${esc(note)}</div>
                <div style="display:flex;margin-top:auto">${recBtns}</div>
              </div>
              <div class="card grow" style="display:flex;flex-direction:column;padding:1.125rem 1.375rem">
                <h2 style="margin:0 0 .375rem">Add recordings</h2>
                <p>Clips you already have, such as voicemails or videos. Most audio and video files work.</p>
                <p class="fine" style="margin-top:.375rem">The computer's file window needs a mouse, so a helper may need to choose the files.</p>
                <div style="margin-top:auto">${g("s:vs:files", "Choose from my files", { face: "btn-teal" })}</div>
              </div>
            </div>
            <div class="card grow" style="padding:1rem 1.375rem;display:flex;flex-direction:column">
              <div class="row" style="justify-content:space-between;flex:none;margin-bottom:.375rem"><h2 style="margin:0;font-size:1.5625rem">Your recordings</h2><span class="hint" style="font-weight:800;color:var(--ink)">${clips.length ? `${clips.length} · ${fmtTime(total)}` : "None yet"}</span></div>
              <div class="grow" style="overflow:hidden">${
                clips.length
                  ? clips
                      .map(
                        (x, i) => `<div class="row" style="min-height:4.25rem;border-top:1px solid var(--line);gap:.875rem">
                          <div class="grow"><div style="font-size:1.375rem;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.label)}</div>
                          <div class="hint">${x.seconds ? fmtTime(x.seconds) : "…"} · ${x.source === "recorded" ? "recorded here" : "from a file"}${playing?.key === `c${i}` ? ` · <b style="color:var(--brandText)">playing</b>` : ""}</div></div>
                          ${g(`s:vs:play:${i}`, playing?.key === `c${i}` ? "Stop" : "Play", { face: "btn", faceStyle: "width:7.5rem;min-height:2.875rem;font-size:1.3125rem" })}
                          ${g(`s:vs:rm:${i}`, "Remove", { face: "btn", faceStyle: "width:8.125rem;min-height:2.875rem;font-size:1.3125rem" })}</div>`,
                      )
                      .join("")
                  : `<p style="padding-top:1.125rem">No recordings yet. Record now, or add some you already have.</p>`
              }</div>
            </div>
            <div class="row" style="flex:none;justify-content:space-between;gap:1.25rem">
              <div class="grow"><div style="font-size:1.3125rem;font-weight:700;color:var(--mute);line-height:1.3">${esc(hint)}</div>${messages()}</div>
              ${g("s:vs:create", "Create my voice", { face: "btn-teal", faceStyle: "width:23.75rem;min-height:5.25rem;font-size:2rem", off: !canCreate() })}
            </div>
          </div>
        </div>`;
    },
    select(id) {
      const [, , a, arg] = id.split(":");
      switch (a) {
        case "ack":
          form.ack = !form.ack;
          break;
        case "remote":
          form.remote = !form.remote;
          break;
        case "recstart":
          return void startRec();
        case "recstop":
          return void stopRec();
        case "replay":
          if (pending) play("pending", pending.blob);
          return;
        case "redo":
          stopPlay();
          pending = null;
          recMsg = "";
          break;
        case "add":
          if (pending) {
            stopPlay();
            clips.push(pending);
            pending = null;
            ctx.toast("Recording added.", 2000);
          }
          break;
        case "files":
          // Works from a click; browsers block opening the file window without one.
          fileInput.click();
          return;
        case "play": {
          const x = clips[Number(arg)];
          if (x) play(`c${arg}`, x.blob);
          return;
        }
        case "rm":
          stopPlay();
          clips.splice(Number(arg), 1);
          ctx.toast("Recording removed.", 2000);
          break;
        case "create":
          if (!canCreate()) return;
          stopPlay();
          void c.create({ mode: "self", authorizedBy: "", acknowledged: form.ack, remoteProcessingAcknowledged: form.remote }, clips.map(({ name, blob }) => ({ name, blob }))).then((ok) => {
            if (ok) {
              clips = [];
              ctx.open("voice");
            }
          });
          break;
      }
      ctx.rerender();
    },
  };

  return { voice, voiceSetup, fileInput };
}
