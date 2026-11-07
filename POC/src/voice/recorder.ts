// Microphone recording for voice setup. Browser-only (MediaRecorder), so it has no unit tests; the service
// accepts whatever the browser produces (WebM/Opus in Chrome, MP4/AAC in Safari) and converts it itself.

export interface RecordingResult {
  blob: Blob;
  filename: string;
  seconds: number;
}

export interface Recording {
  /** Stop and get the recording. */
  stop(): Promise<RecordingResult>;
  /** Stop and throw the recording away. */
  cancel(): void;
}

const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

const extensionFor = (mime: string): string => (mime.includes("webm") ? "webm" : mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "audio");

/**
 * Start recording. `onLevel` gets 0..1 about 20 times a second, for a level meter. Recording stops by itself after
 * `maxSeconds` (and `onAutoStop` is called) so a forgotten recording cannot grow without limit.
 * Throws a message fit to show a person if the microphone cannot be used.
 */
export async function startRecording(onLevel?: (level: number) => void, maxSeconds = 180, onAutoStop?: () => void): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser cannot record audio. Add audio files instead.");
  let stream: MediaStream;
  try {
    // Noise suppression and echo cancellation off: they smear the voice, and a clean reference matters more than a quiet room.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 } });
  } catch {
    throw new Error("The microphone is not available. Allow microphone access for this page, or add audio files instead.");
  }
  const mime = MIME_PREFERENCE.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  const started = performance.now();

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const meter = onLevel
    ? window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        onLevel(Math.min(1, peak / 100));
      }, 50)
    : 0;

  let discard = false;
  const finished = new Promise<RecordingResult>((resolve, reject) => {
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = () => reject(new Error("Recording failed."));
    rec.onstop = () => {
      clearInterval(meter);
      clearTimeout(limit);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      if (discard) return reject(new Error("cancelled"));
      const type = rec.mimeType || mime || "audio/webm";
      resolve({ blob: new Blob(chunks, { type }), filename: `recording-${Date.now()}.${extensionFor(type)}`, seconds: (performance.now() - started) / 1000 });
    };
  });
  finished.catch(() => {});
  const limit = window.setTimeout(() => {
    if (rec.state === "recording") {
      rec.stop();
      onAutoStop?.();
    }
  }, maxSeconds * 1000);
  rec.start();

  return {
    stop: () => {
      if (rec.state === "recording") rec.stop();
      return finished;
    },
    cancel: () => {
      discard = true;
      if (rec.state === "recording") rec.stop();
    },
  };
}
