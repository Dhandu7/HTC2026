// Offline voice command for showing/hiding the overlay (for carers, or users with
// some residual speech). Uses Vosk in WebAssembly with a tiny fixed grammar, so
// nothing is streamed anywhere and random speech can't trigger commands.
// Model: run `npm run setup -- --voice` to download it into public/models/.

export type VoiceCommand = "show" | "hide" | "speak";

const PHRASES: Record<string, VoiceCommand> = {
  "gaze type": "show",
  "open keyboard": "show",
  "show keyboard": "show",
  "hide keyboard": "hide",
  "close keyboard": "hide",
  "read it out": "speak",
};

export async function startVoiceCommands(
  onCommand: (c: VoiceCommand, heard: string) => void,
  modelUrl = "./models/vosk-model-small-en-us-0.15.tar.gz",
): Promise<() => void> {
  const head = await fetch(modelUrl, { method: "HEAD" }).catch(() => null);
  if (!head?.ok || (head.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error("voice model not installed (npm run setup -- --voice)");
  }
  const Vosk = await import("vosk-browser");
  const model = await Vosk.createModel(modelUrl);
  const ctx = new AudioContext();
  const recognizer = new model.KaldiRecognizer(ctx.sampleRate, JSON.stringify([...Object.keys(PHRASES), "[unk]"]));
  recognizer.on("result", (msg: unknown) => {
    const text = ((msg as { result?: { text?: string } }).result?.text ?? "").trim();
    const cmd = PHRASES[text];
    if (cmd) onCommand(cmd, text);
  });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    video: false,
  });
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but is what vosk-browser expects; fine for a short buffer.
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    try {
      recognizer.acceptWaveform(e.inputBuffer);
    } catch {
      /* ignore transient decode errors */
    }
  };
  source.connect(node);
  node.connect(ctx.destination);
  return () => {
    node.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    model.terminate();
  };
}
