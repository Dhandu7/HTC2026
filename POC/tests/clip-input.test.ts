import { describe, expect, it } from "vitest";
import { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, checkInputs, formatSeconds, formatSize } from "../src/voice/clipInput";

const f = (name: string, size = 1000) => ({ name, size });

describe("which files are accepted", () => {
  it("never looks at the type: any name, any extension, no extension", () => {
    const names = ["voice.mp3", "memo.m4a", "clip.WAV", "talk.webm", "movie.mkv", "recording", "my recording (final) v2.XYZ", "weird.🎤", "notes.pdf", "photo.png"];
    const r = checkInputs([], names.map((n) => f(n)));
    expect(r.accepted).toHaveLength(names.length);
    expect(r.problems).toEqual([]); // whether the service can read a pdf is the service's call, and it will say so
  });

  it("refuses empty files and files over the size limit, and says which and why", () => {
    const r = checkInputs([], [f("empty.wav", 0), f("huge.mp4", MAX_FILE_BYTES + 1), f("ok.wav")]);
    expect(r.accepted).toEqual([2]);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toMatch(/empty\.wav is empty/);
    expect(r.problems[1]).toMatch(/huge\.mp4 .*over the 100 MB limit.*shorter excerpt/);
  });

  it("a file exactly at the limit is fine", () => {
    expect(checkInputs([], [f("edge.wav", MAX_FILE_BYTES)]).accepted).toEqual([0]);
  });

  it("stops at the file count limit, counting what is already added", () => {
    const existing = Array.from({ length: MAX_FILES - 2 }, (_, i) => f(`e${i}.wav`));
    const r = checkInputs(existing, [f("a.wav"), f("b.wav"), f("c.wav")]);
    expect(r.accepted).toEqual([0, 1]);
    expect(r.problems).toEqual([`c.wav was not added: at most ${MAX_FILES} files.`]);
  });

  it("stops at the total size limit, counting what is already added, and still accepts smaller files after a big one is left out", () => {
    const MB = 1024 * 1024;
    const existing = [f("one.wav", 100 * MB), f("two.wav", 90 * MB)]; // 190 MB so far
    const r = checkInputs(existing, [f("too-much.wav", 20 * MB), f("small.wav", 5 * MB)]);
    expect(r.accepted).toEqual([1]);
    expect(r.problems[0]).toMatch(/too-much\.wav was not added.*200 MB in total/);
    expect(MAX_TOTAL_BYTES).toBe(200 * MB);
  });

  it("an empty selection is nothing to do", () => {
    expect(checkInputs([f("a.wav")], [])).toEqual({ accepted: [], problems: [] });
  });
});

describe("formatting", () => {
  it("sizes and times read naturally", () => {
    expect(formatSize(500)).toBe("1 KB");
    expect(formatSize(300 * 1024)).toBe("300 KB");
    expect(formatSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(formatSize(100 * 1024 * 1024)).toBe("100 MB");
    expect(formatSeconds(0)).toBe("0:00");
    expect(formatSeconds(65.7)).toBe("1:05");
    expect(formatSeconds(180)).toBe("3:00");
  });
});
