import { describe, expect, it } from "vitest";
import { PredictionEngine, memoryStore } from "../src/predict/engine";
import { GazeTypeKeyboard, type KeyboardHost } from "../src/ui/keyboards";

const fakeRoot = () => ({ innerHTML: "", className: "" }) as unknown as HTMLElement;

describe("typing grid layout", () => {
  it("keeps ⌫ out of the corners (row 3, column 2) and puts WXYZ in the bottom-left corner", () => {
    const engine = new PredictionEngine(memoryStore(), () => 1_000_000);
    engine.load(["hello"], ["yes"], ["Thank you"]);
    const host = { refresh: () => {}, action: () => {}, overlay: false, profiles: () => [], activeProfileId: () => "" } as unknown as KeyboardHost;
    const kb = new GazeTypeKeyboard(engine, host);
    kb.select("keyboard"); // the app opens on the home screen; the grid is one step away
    const root = fakeRoot();
    kb.render(root);
    const cells = [...root.innerHTML.matchAll(/<(?:button|div) class="key[^"]*"(?: data-target="([^"]*)")?/g)].map((m) => m[1] ?? "empty");
    expect(cells).toHaveLength(16);
    const at = (row: number, col: number) => cells[(row - 1) * 4 + (col - 1)];
    expect(at(3, 2)).toBe("del");
    expect(at(4, 1)).toBe("g:7");
    expect([at(1, 1), at(1, 4), at(4, 1), at(4, 4)]).not.toContain("del");
  });
});
