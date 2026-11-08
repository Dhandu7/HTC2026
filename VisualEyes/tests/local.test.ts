import { describe, expect, it } from "vitest";
import { makeScreens, type ScreenName, type ScreensCtx } from "../src/ui/screens";
import { LOCAL_HELP } from "../src/ui/local";
import { DEFAULTS } from "../src/settings";

function setup() {
  const spoken: string[] = [];
  const opened: (ScreenName | null)[] = [];
  const toasts: string[] = [];
  const ctx: ScreensCtx = {
    settings: { ...DEFAULTS },
    saveSettings: () => {},
    toast: (h) => toasts.push(h),
    open: (n) => opened.push(n),
    insertPhrase: () => {},
    sayAgain: () => {},
    speak: (t) => spoken.push(t),
    history: () => [],
    frequent: () => [],
    recalibrate: () => {},
    aiPrefs: () => {},
    account: () => ({ line: "", signedIn: false, available: false }),
    signIn: () => {},
    signOut: () => {},
    tools: () => [],
    aiStatus: () => "",
    listenStatus: () => "",
    eraseData: () => {},
  };
  return { screens: makeScreens(ctx), spoken, opened, toasts };
}

describe("Calgary help", () => {
  it("lists real entries with a spoken request each", () => {
    expect(LOCAL_HELP.length).toBeGreaterThanOrEqual(6);
    for (const h of LOCAL_HELP) {
      expect(h.org.trim()).not.toBe("");
      expect(h.what.trim()).not.toBe("");
      expect(h.ask.trim()).not.toBe("");
      expect(h.ask).toMatch(/[.?!]$/);
      expect(h.verified).toBe(true);
    }
  });

  it("renders one gaze target per entry, readable before selecting", () => {
    const { screens } = setup();
    const html = screens.local.render();
    expect((html.match(/data-target="s:lh:/g) ?? []).length).toBe(LOCAL_HELP.length);
    expect((html.match(/data-read/g) ?? []).length).toBe(LOCAL_HELP.length);
    expect(html).toContain(LOCAL_HELP[0].org);
  });

  it("speaks the request and returns to the message screen", () => {
    const { screens, spoken, opened, toasts } = setup();
    screens.local.select("s:lh:0");
    expect(spoken).toEqual([LOCAL_HELP[0].ask]);
    expect(opened).toEqual([null]);
    expect(toasts.length).toBe(1);
  });

  it("ignores an unknown card id", () => {
    const { screens, spoken, opened } = setup();
    screens.local.select("s:lh:999");
    expect(spoken).toEqual([]);
    expect(opened).toEqual([]);
  });
});
