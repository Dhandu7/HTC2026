import { describe, expect, it } from "vitest";
import { PredictionEngine, memoryStore } from "../src/predict/engine";
import { GazeTypeKeyboard, HOME_CHIPS, type KeyboardHost } from "../src/ui/keyboards";

// Minimal DOM stand-in: render() only sets innerHTML / className.
const fakeRoot = () => ({ innerHTML: "", className: "" }) as unknown as HTMLElement;

function setup() {
  const engine = new PredictionEngine(memoryStore(), () => 1_000_000);
  engine.load(["hello", "water", "thank", "you", "please"], ["yes", "no"], ["I need water", "Thank you", "Yes please", "Can you help me", "I'm tired", "Hello"]);
  const actions: string[] = [];
  const host: KeyboardHost = { refresh: () => {}, action: (a) => actions.push(a), overlay: false };
  const kb = new GazeTypeKeyboard(engine, host);
  return { kb, actions };
}

describe("home screen", () => {
  it("starts on 6 targets: 5 phrases + Keyboard", () => {
    const { kb } = setup();
    const root = fakeRoot();
    kb.render(root);
    expect(kb.onHome).toBe(true);
    expect(root.className).toContain("home");
    expect((root.innerHTML.match(/data-target="home:/g) ?? []).length).toBe(HOME_CHIPS);
    expect(root.innerHTML).toContain('data-target="keyboard"');
  });

  it("speaks a phrase in one selection", () => {
    const { kb, actions } = setup();
    kb.render(fakeRoot());
    expect(kb.select("home:0")).toBe("phrase");
    expect(kb.text().length).toBeGreaterThan(0);
    expect(actions).toEqual(["speak"]);
  });

  it("opens the typing grid, and returns home on clear", () => {
    const { kb } = setup();
    kb.render(fakeRoot());
    kb.select("keyboard");
    expect(kb.onHome).toBe(false);
    const root = fakeRoot();
    kb.render(root);
    expect(root.innerHTML).toContain('data-target="g:0"');
    kb.clear();
    expect(kb.onHome).toBe(true);
  });

  it("skips home during benchmarks", () => {
    const { kb } = setup();
    kb.useHome = false;
    kb.clear();
    expect(kb.onHome).toBe(false);
  });

  it("takes phrases from a pluggable source (for conversation replies)", () => {
    const { kb } = setup();
    kb.homeSource = () => ["Reply A", "Reply B"];
    const root = fakeRoot();
    kb.render(root);
    expect(root.innerHTML).toContain("Reply A");
    expect((root.innerHTML.match(/key empty/g) ?? []).length).toBe(HOME_CHIPS - 2);
  });
});
