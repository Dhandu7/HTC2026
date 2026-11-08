// Audio plumbing shared by the recorded-clip, cache and cloned tiers:
// WAV parsing, Int16→Float32, and a small Web Audio player.
// The conversions are pure so they are unit-tested without a browser.

import type { ProviderPlayback } from "./provider";

export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

/** PCM16 little-endian → floats in [-1, 1). */
export function int16ToFloat32(src: Int16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] / 32768;
  return out;
}

/** Floats → PCM16, clamped. Used when caching audio. */
export function float32ToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = Math.max(-1, Math.min(1, src[i]));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

/** Parse a canonical RIFF/WAVE file holding 16-bit PCM. Mono is kept; stereo is averaged to mono. */
export function wavToPcm(bytes: ArrayBuffer): Pcm {
  const dv = new DataView(bytes);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (dv.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  let offset = 12;
  while (offset + 8 <= dv.byteLength) {
    const id = tag(offset);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt");
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV (format ${fmt.format}, ${fmt.bits}-bit)`);
      const end = Math.min(body + size, dv.byteLength);
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const out = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += dv.getInt16(body + (f * fmt.channels + c) * 2, true);
        out[f] = sum / fmt.channels / 32768;
      }
      return { samples: out, sampleRate: fmt.sampleRate };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}

// ---- playback ----

/** The slice of AudioContext we use, so tests can inject a fake. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state?: string;
  resume?(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): {
    getChannelData(c: number): Float32Array;
    duration: number;
  };
  createBufferSource(): {
    buffer: unknown;
    onended: (() => void) | null;
    connect(dest: unknown): void;
    start(when?: number): void;
    stop(): void;
  };
  readonly destination: unknown;
}

export class PcmPlayer {
  /** `destination` lets the browser put a volume control in between; it defaults to the speakers. */
  constructor(
    private readonly ctx: AudioContextLike,
    private readonly destination?: unknown,
  ) {}

  /** Play one clip now. `started` resolves once it is scheduled; `done` when it ends or is cancelled. */
  play(pcm: Pcm): ProviderPlayback {
    const ctx = this.ctx;
    let finish!: () => void;
    let begin!: () => void;
    let fail!: (e: Error) => void;
    const started = new Promise<void>((res, rej) => {
      begin = res;
      fail = rej;
    });
    const done = new Promise<void>((res) => (finish = res));
    started.catch(() => {});
    let src: ReturnType<AudioContextLike["createBufferSource"]> | null = null;
    try {
      const buf = ctx.createBuffer(1, pcm.samples.length, pcm.sampleRate);
      buf.getChannelData(0).set(pcm.samples);
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.destination ?? ctx.destination);
      src.onended = () => finish();
      const go = () => {
        src!.start(ctx.currentTime);
        begin();
      };
      if (ctx.state === "suspended" && ctx.resume) void ctx.resume().then(go, (e) => fail(e instanceof Error ? e : new Error(String(e))));
      else go();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      fail(err);
      const failed = Promise.reject(err);
      failed.catch(() => {});
      return { started, done: failed, cancel() {} };
    }
    return {
      started,
      done,
      cancel: () => {
        try {
          src?.stop();
        } catch {
          /* already stopped */
        }
        begin();
        finish();
      },
    };
  }
}
