import { describe, expect, it } from "vitest";
import { PcmPlayer, float32ToInt16, int16ToFloat32, wavToPcm, type AudioContextLike } from "../src/voice/pcmPlayer";

function wav(samples: number[], opts: { channels?: number; rate?: number; bits?: number; format?: number; extraChunk?: boolean } = {}): ArrayBuffer {
  const { channels = 1, rate = 24000, bits = 16, format = 1, extraChunk = false } = opts;
  const dataBytes = samples.length * 2;
  const extra = extraChunk ? 8 + 3 + 1 : 0; // odd-sized chunk plus its pad byte
  const buf = new ArrayBuffer(44 + extra + dataBytes);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + extra + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, bits, true);
  let o = 36;
  if (extraChunk) {
    str(o, "LIST");
    dv.setUint32(o + 4, 3, true);
    o += 12;
  }
  str(o, "data");
  dv.setUint32(o + 4, dataBytes, true);
  samples.forEach((s, i) => dv.setInt16(o + 8 + i * 2, s, true));
  return buf;
}

describe("PCM conversion", () => {
  it("scales Int16 to [-1, 1)", () => {
    const f = int16ToFloat32(Int16Array.of(0, 16384, -32768, 32767));
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(0.5);
    expect(f[2]).toBe(-1);
    expect(f[3]).toBeLessThan(1);
  });

  it("round-trips and clamps", () => {
    const back = float32ToInt16(Float32Array.of(0, 0.5, -1, 2, -2));
    expect([...back]).toEqual([0, 16383, -32768, 32767, -32768]);
    expect(int16ToFloat32(back)[2]).toBe(-1);
  });
});

describe("wavToPcm", () => {
  it("reads sample rate and samples", () => {
    const pcm = wavToPcm(wav([0, 16384, -16384], { rate: 22050 }));
    expect(pcm.sampleRate).toBe(22050);
    expect(pcm.samples.length).toBe(3);
    expect(pcm.samples[1]).toBeCloseTo(0.5);
  });

  it("averages stereo to mono", () => {
    const pcm = wavToPcm(wav([1000, 3000, -2000, -4000], { channels: 2 }));
    expect(pcm.samples.length).toBe(2);
    expect(pcm.samples[0]).toBeCloseTo(2000 / 32768);
    expect(pcm.samples[1]).toBeCloseTo(-3000 / 32768);
  });

  it("skips unknown chunks, including odd-sized padded ones", () => {
    expect(wavToPcm(wav([100, 200], { extraChunk: true })).samples.length).toBe(2);
  });

  it("rejects non-WAV, float and 8-bit input", () => {
    expect(() => wavToPcm(new ArrayBuffer(8))).toThrow(/not a WAV/);
    expect(() => wavToPcm(wav([0], { format: 3 }))).toThrow(/unsupported/);
    expect(() => wavToPcm(wav([0], { bits: 8 }))).toThrow(/unsupported/);
  });
});

describe("PcmPlayer", () => {
  function fakeCtx(state = "running") {
    const log: string[] = [];
    let ended: (() => void) | null = null;
    const ctx: AudioContextLike = {
      currentTime: 1.5,
      state,
      destination: {},
      resume: async () => void log.push("resume"),
      createBuffer: (_c, length, rate) => {
        log.push(`buffer ${length}@${rate}`);
        return { getChannelData: () => new Float32Array(length), duration: length / rate };
      },
      createBufferSource: () => {
        const src = {
          buffer: null as unknown,
          onended: null as null | (() => void),
          connect: () => void log.push("connect"),
          start: (when?: number) => {
            log.push(`start ${when}`);
            ended = () => src.onended?.();
          },
          stop: () => void log.push("stop"),
        };
        return src;
      },
    };
    return { ctx, log, end: () => ended?.() };
  }

  it("schedules a clip and resolves done when it ends", async () => {
    const { ctx, log, end } = fakeCtx();
    const p = new PcmPlayer(ctx).play({ samples: new Float32Array(100), sampleRate: 24000 });
    await p.started;
    expect(log).toEqual(["buffer 100@24000", "connect", "start 1.5"]);
    end();
    await p.done;
  });

  it("cancel stops the source and settles both promises", async () => {
    const { ctx, log } = fakeCtx();
    const p = new PcmPlayer(ctx).play({ samples: new Float32Array(10), sampleRate: 24000 });
    p.cancel();
    await Promise.all([p.started, p.done]);
    expect(log).toContain("stop");
  });

  it("resumes a suspended context before starting", async () => {
    const { ctx, log } = fakeCtx("suspended");
    const p = new PcmPlayer(ctx).play({ samples: new Float32Array(10), sampleRate: 24000 });
    await p.started;
    expect(log.indexOf("resume")).toBeLessThan(log.indexOf("start 1.5"));
  });
});
