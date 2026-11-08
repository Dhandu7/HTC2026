import { describe, expect, it } from "vitest";
import { PredictionEngine, memoryStore } from "../src/predict/engine";
import { GazeTypeKeyboard, type KeyboardHost } from "../src/ui/keyboards";

const fakeRoot = () => ({ innerHTML: "", className: "" }) as unknown as HTMLElement;

describe("typing grid layout", () => {
  it("puts the letter groups in alphabetical order and the controls on the bottom row", () => {
    const engine = new PredictionEngine(memoryStore(), () => 1_000_000);
    engine.load(["hello"], ["yes"], ["Thank you"]);
    const host = { refresh: () => {}, action: () => {}, overlay: false, profiles: () => [], activeProfileId: () => "" } as unknown as KeyboardHost;
    const kb = new GazeTypeKeyboard(engine, host);
    kb.select("keyboard"); // the app opens on the home screen; the grid is one step away
    const root = fakeRoot();
    kb.render(root);
    // Each key is a gaze target (.g) around a keycap; blank cells are a .g with no target.
    const cells = [...root.innerHTML.matchAll(/<div class="g(?: [^"]*)?"(?: data-target="([^"]*)")?/g)].map((m) => m[1] ?? "empty");
    expect(cells).toHaveLength(16);
    const at = (row: number, col: number) => cells[(row - 1) * 4 + (col - 1)];
    // Row 2: ABC DEF GHI JKL. Row 3: MNO PQRS TUV WXYZ.
    expect([1, 2, 3, 4].map((c) => at(2, c))).toEqual(["g:0", "g:1", "g:2", "g:3"]);
    expect([1, 2, 3, 4].map((c) => at(3, c))).toEqual(["g:4", "g:5", "g:6", "g:7"]);
    // Row 4: Delete, Space, Phrases/Expand, Done.
    expect([1, 2, 3, 4].map((c) => at(4, c))).toEqual(["del", "space", "phrases", "menu"]);
  });
});
