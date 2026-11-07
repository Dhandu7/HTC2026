// The "My voice" screen. It is for the person setting up the voice, or a carer helping, and works with a mouse or
// keyboard; speaking in the voice afterwards works with gaze like everything else.
//
// All content is built with DOM calls and textContent, never innerHTML, so text that came from the service can
// never become markup. The logic lives in voice/hostedController.ts; this file only draws it.

import type { VoiceApiSettings } from "../voice/hostedConfig";
import type { HostedVoiceController, State, UploadFile } from "../voice/hostedController";
import { startRecording, type Recording } from "../voice/recorder";

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

const PROMPTS = [
  "Hello, it's me. I'm okay, and I'm glad you're here.",
  "Could you please turn the light off? It's a little too bright for me.",
  "I need some help, and I'd like you to stay with me for a moment.",
  "Yes, that sounds good. No, I don't think so. Maybe later this afternoon.",
  "Thank you so much for everything you've done today. It really means a lot.",
  "I'd love a cup of tea, and maybe something small to eat, if that's alright.",
  "What time is it? Have the children called yet? Tell them I said hello.",
  "The weather looks lovely today. Let's open the window and let some air in.",
];

const MODELS: [string, string][] = [
  ["eleven_flash_v2_5", "eleven_flash_v2_5 (fast, the default)"],
  ["eleven_v4_turbo", "eleven_v4_turbo (fast)"],
  ["eleven_multilingual_v2", "eleven_multilingual_v2"],
  ["eleven_v4", "eleven_v4"],
];

interface Pending extends UploadFile {
  seconds?: number;
  source: "recorded" | "file";
}

export interface MyVoiceDeps {
  dialog: HTMLDialogElement;
  controller: HostedVoiceController;
  getApiSettings: () => VoiceApiSettings;
  saveApiSettings: (s: VoiceApiSettings) => void;
  usingDevLogin: () => boolean;
}

export function mountMyVoice(d: MyVoiceDeps): { open(): void } {
  const { dialog, controller } = d;
  // Local, unsent form state. It survives re-renders so a state change never wipes what someone typed or recorded.
  const form = { mode: "self" as "self" | "authorized", authorizedBy: "", ack: false, remoteAck: false, testText: "Hello, it's me. I'm okay, and I'm glad you're here.", confirmDelete: "", deleting: false };
  let files: Pending[] = [];
  let recording: { rec: Recording; prompt: number; level: number } | null = null;
  let recordError: string | null = null;
  let state: State = controller.state;

  const root = h("div", { class: "mv" });
  dialog.replaceChildren(root);
  controller.subscribe((s) => {
    state = s;
    if (dialog.open || s.phase === "creating") draw();
  });

  const close = () => {
    recording?.rec.cancel();
    recording = null;
    dialog.close();
  };

  function banner(): Node[] {
    const out: Node[] = [];
    if (state.error) out.push(h("p", { class: "mv-msg bad", role: "alert" }, state.error));
    if (state.notice) out.push(h("p", { class: "mv-msg ok", role: "status" }, state.notice));
    if (state.skipped.length)
      out.push(h("ul", { class: "mv-skipped" }, ...state.skipped.map((s) => h("li", {}, `${s.label}: ${s.errors.join("; ")}`))));
    return out;
  }

  function connection(): Node {
    const s = d.getApiSettings();
    const url = h("input", { type: "text", value: s.baseUrl, "aria-label": "Voice service address" });
    return h(
      "details",
      { class: "mv-conn" },
      h("summary", {}, "Connection"),
      h("label", {}, "Voice service address ", url),
      h("p", { class: "fine" }, d.usingDevLogin() ? `Sign-in is not set up yet, so this uses a test login (${s.devUserId}), which only works with a service on this computer.` : "Signed in."),
      h("button", { type: "button", onclick: () => { d.saveApiSettings({ ...s, baseUrl: url.value.trim() }); void controller.refresh(); } }, "Save and reconnect"),
    );
  }

  const spinner = (text: string) => h("p", { class: "mv-wait" }, text);

  function consentCard(): Node {
    const c = state.consent;
    const own = h("input", { type: "radio", name: "mv-mode", checked: form.mode === "self", onchange: () => { form.mode = "self"; draw(); } });
    const auth = h("input", { type: "radio", name: "mv-mode", checked: form.mode === "authorized", onchange: () => { form.mode = "authorized"; draw(); } });
    return h(
      "section",
      { class: "mv-card" },
      h("h3", {}, "1. Consent"),
      h("p", { class: "fine" }, "A voice is only created with the voice owner's consent. Please read this:"),
      c ? h("ul", { class: "mv-consent" }, ...c.statements.map((t) => h("li", {}, t))) : h("p", { class: "mv-msg bad" }, "The consent text could not be loaded."),
      h("label", { class: "mv-radio" }, own, " This is my own voice"),
      h("label", { class: "mv-radio" }, auth, " I have the voice owner's permission"),
      form.mode === "authorized" ? h("input", { type: "text", placeholder: "Name of the voice owner who gave permission", value: form.authorizedBy, oninput: (e: Event) => (form.authorizedBy = (e.target as HTMLInputElement).value) }) : null,
      h("label", { class: "mv-check" }, h("input", { type: "checkbox", checked: form.ack, onchange: (e: Event) => { form.ack = (e.target as HTMLInputElement).checked; draw(); } }), " I agree to the statements above."),
      h("label", { class: "mv-check" }, h("input", { type: "checkbox", checked: form.remoteAck, onchange: (e: Event) => { form.remoteAck = (e.target as HTMLInputElement).checked; draw(); } }), " I understand that my recordings and the text I speak are sent to ElevenLabs."),
    );
  }

  async function toggleRecord(prompt: number) {
    recordError = null;
    if (recording) {
      const r = recording;
      recording = null;
      try {
        const res = await r.rec.stop();
        files.push({ name: res.filename, blob: res.blob, seconds: res.seconds, source: "recorded" });
      } catch {
        /* cancelled or failed: nothing to add */
      }
      return draw();
    }
    try {
      const rec = await startRecording(
        (lvl) => {
          if (recording) {
            recording.level = lvl;
            const m = root.querySelector<HTMLElement>(".mv-meter > i");
            if (m) m.style.width = `${Math.round(lvl * 100)}%`;
          }
        },
        30,
        () => void toggleRecord(prompt),
      );
      recording = { rec, prompt, level: 0 };
    } catch (e) {
      recordError = (e as Error).message;
    }
    draw();
  }

  function addFiles(list: FileList | File[]) {
    for (const f of Array.from(list)) files.push({ name: f.name, blob: f, source: "file" });
    draw();
  }

  function clipsCard(): Node {
    const input = h("input", { type: "file", accept: "audio/*,video/*,.mp3,.m4a,.aac,.mp4,.webm,.ogg,.opus,.flac,.wav", multiple: true, hidden: true, onchange: (e: Event) => { addFiles((e.target as HTMLInputElement).files!); (e.target as HTMLInputElement).value = ""; } });
    const drop = h("div", { class: "mv-drop" }, "Drop audio files here, or ", h("button", { type: "button", class: "link", onclick: () => input.click() }, "choose files"), input);
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer) addFiles(e.dataTransfer.files); });
    const recordedSeconds = files.reduce((n, f) => n + (f.seconds ?? 0), 0);
    return h(
      "section",
      { class: "mv-card" },
      h("h3", {}, "2. Recordings"),
      h("p", { class: "fine" }, "Record a few sentences, or add audio you already have (MP3, M4A, WAV, WebM and more; long recordings are split automatically). Around 30 seconds to 2 minutes of clear speech works best. Only the voice owner should be speaking, with no music."),
      ...PROMPTS.map((p, i) =>
        h("div", { class: "mv-prompt" }, h("span", {}, p), h("button", { type: "button", class: recording?.prompt === i ? "rec on" : "rec", disabled: recording !== null && recording.prompt !== i, onclick: () => void toggleRecord(i) }, recording?.prompt === i ? "■ Stop" : "● Record")),
      ),
      recording ? h("div", { class: "mv-meter", "aria-label": "microphone level" }, h("i", {})) : null,
      recordError ? h("p", { class: "mv-msg bad", role: "alert" }, recordError) : null,
      drop,
      files.length
        ? h(
            "ul",
            { class: "mv-files" },
            ...files.map((f, i) => h("li", {}, `${f.source === "recorded" ? "🎙" : "📄"} ${f.name}${f.seconds ? ` · ${f.seconds.toFixed(0)} s` : ""}`, h("button", { type: "button", class: "link", onclick: () => { files.splice(i, 1); draw(); } }, "remove"))),
          )
        : h("p", { class: "fine" }, "Nothing added yet."),
      files.length && recordedSeconds ? h("p", { class: "fine" }, `Recorded so far: ${recordedSeconds.toFixed(0)} s.`) : null,
    );
  }

  function noneView(): Node[] {
    const ready = form.ack && form.remoteAck && files.length > 0 && (form.mode === "self" || form.authorizedBy.trim().length > 0);
    return [
      h("p", {}, "Create a voice that sounds like you from your own recordings. When you speak, VocalEyes uses it, and falls back to the standard voice if it is not available."),
      consentCard(),
      clipsCard(),
      h(
        "button",
        {
          type: "button",
          class: "primary mv-create",
          disabled: !ready || state.busy,
          onclick: async () => {
            const ok = await controller.create({ mode: form.mode, authorizedBy: form.authorizedBy, acknowledged: form.ack, remoteProcessingAcknowledged: form.remoteAck }, files.map(({ name, blob }) => ({ name, blob })));
            if (ok) files = [];
            draw();
          },
        },
        "Create my voice",
      ),
      !ready ? h("p", { class: "fine" }, "To continue: tick both boxes and add at least one recording.") : null,
    ].filter((n): n is Node => !!n);
  }

  const slider = (label: string, key: "stability" | "similarityBoost" | "style" | "speed", min: number, max: number, step: number, hint: string) => {
    const v = state.voice!.settings[key];
    const out = h("span", { class: "fine" }, v.toFixed(2));
    return h("label", { title: hint }, label, " ", h("input", { type: "range", min, max, step, value: v, "data-key": key, oninput: (e: Event) => (out.textContent = Number((e.target as HTMLInputElement).value).toFixed(2)) }), " ", out);
  };

  function readyView(): Node[] {
    const v = state.voice!;
    const secs = v.clips.reduce((n, c) => n + c.seconds, 0);
    const model = h("select", { "data-key": "modelId" }, ...MODELS.map(([id, label]) => h("option", { value: id, selected: id === v.settings.modelId }, label)));
    const boost = h("input", { type: "checkbox", checked: v.settings.useSpeakerBoost, "data-key": "useSpeakerBoost" });
    const settings = h(
      "section",
      { class: "mv-card" },
      h("h3", {}, "Voice settings"),
      slider("Stability", "stability", 0, 1, 0.05, "Lower is more expressive, higher is steadier."),
      slider("Likeness", "similarityBoost", 0, 1, 0.05, "How closely the speech follows your recordings."),
      slider("Style", "style", 0, 1, 0.05, "Exaggerates your speaking style. Can make speech slower to start."),
      slider("Speed", "speed", 0.7, 1.2, 0.05, "Speaking speed."),
      h("label", {}, "Model ", model),
      h("label", { class: "mv-check" }, boost, " Speaker boost"),
      h("button", { type: "button", disabled: state.busy, onclick: () => {
        const num = (k: string) => Number(root.querySelector<HTMLInputElement>(`input[data-key="${k}"]`)!.value);
        void controller.saveSettings({ stability: num("stability"), similarityBoost: num("similarityBoost"), style: num("style"), speed: num("speed"), modelId: model.value, useSpeakerBoost: boost.checked });
      } }, "Save settings"),
    );
    const test = h(
      "section",
      { class: "mv-card" },
      h("h3", {}, "Try it"),
      h("textarea", { rows: 2, value: form.testText, oninput: (e: Event) => (form.testText = (e.target as HTMLTextAreaElement).value) }),
      h("button", { type: "button", class: "primary", disabled: state.busy || v.status !== "active", onclick: () => void controller.test(form.testText) }, "🔊 Speak in my voice"),
      v.status !== "active" ? h("p", { class: "fine" }, "Resume the voice to try it.") : null,
      h("p", { class: "fine" }, "Speech from this voice is AI-generated."),
    );
    const manage = h(
      "section",
      { class: "mv-card" },
      h("h3", {}, "Your voice"),
      h("p", {}, v.status === "active" ? "✅ Active: VocalEyes speaks in it." : "⏸ Paused: VocalEyes uses the standard voice."),
      h("p", { class: "fine" }, `${v.clips.length} recording${v.clips.length === 1 ? "" : "s"} used · ${secs.toFixed(0)} s · consent: ${v.consent.mode === "authorized" ? `permission from ${v.consent.authorizedBy ?? "the voice owner"}` : "own voice"}${v.consent.acknowledgedAt ? ` on ${new Date(v.consent.acknowledgedAt).toLocaleDateString()}` : ""}`),
      h("button", { type: "button", disabled: state.busy, onclick: () => void controller.setPaused(v.status === "active") }, v.status === "active" ? "Pause my voice" : "Resume my voice"),
      form.deleting
        ? h("div", { class: "mv-danger" }, h("p", {}, "This deletes your voice at ElevenLabs and here. It cannot be undone. Type ", h("b", {}, "delete"), " to confirm."), h("input", { type: "text", value: form.confirmDelete, oninput: (e: Event) => { form.confirmDelete = (e.target as HTMLInputElement).value; (root.querySelector(".mv-confirm") as HTMLButtonElement).disabled = form.confirmDelete !== "delete"; } }), h("button", { type: "button", class: "danger mv-confirm", disabled: form.confirmDelete !== "delete" || state.busy, onclick: async () => { await controller.remove(); form.deleting = false; form.confirmDelete = ""; draw(); } }, "Delete my voice"), h("button", { type: "button", onclick: () => { form.deleting = false; draw(); } }, "Cancel"))
        : h("button", { type: "button", class: "danger", onclick: () => { form.deleting = true; draw(); } }, "Delete my voice…"),
    );
    return [manage, test, settings];
  }

  function draw() {
    const kids: Node[] = [];
    kids.push(h("div", { class: "mv-head" }, h("h2", {}, "🗣 My voice"), h("button", { type: "button", class: "mv-close", "aria-label": "Close", onclick: close }, "✕")));
    kids.push(...banner());
    switch (state.phase) {
      case "loading":
        kids.push(spinner("Checking your voice…"));
        break;
      case "unreachable":
        kids.push(h("button", { type: "button", onclick: () => void controller.refresh() }, "Try again"), connection());
        break;
      case "signed-out":
        kids.push(h("p", {}, "Sign in to set up your voice."), h("button", { type: "button", onclick: () => void controller.refresh() }, "Try again"), connection());
        break;
      case "creating":
        kids.push(spinner("Creating your voice… this can take up to a minute. Please keep this window open."));
        break;
      case "deleting":
        kids.push(h("p", {}, "Your voice is switched off and waiting to be deleted."), h("button", { type: "button", class: "danger", disabled: state.busy, onclick: () => void controller.remove() }, "Try deleting again"), connection());
        break;
      case "none":
        kids.push(...noneView(), connection());
        break;
      case "ready":
        kids.push(...readyView(), connection());
        break;
    }
    const scroll = root.scrollTop;
    root.replaceChildren(...kids);
    root.scrollTop = scroll;
  }

  return {
    open() {
      state = controller.state;
      draw();
      dialog.showModal();
      void controller.refresh();
    },
  };
}
