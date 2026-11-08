import { describe, expect, it } from "vitest";
import { eraseLocalData, isAppKey } from "../src/account/erase";
import { ProfileManager, memoryKV } from "../src/profile/profiles";
import { DEFAULTS } from "../src/settings";
import { makeScreens, type ScreensCtx } from "../src/ui/screens";

describe("delete my data", () => {
  it("removes every key the app writes and nothing else", () => {
    const kv = memoryKV();
    // What a used installation holds: a profile with its data, settings, history, onboarding, account and voice keys.
    const pm = new ProfileManager(kv);
    const p = pm.create("Frank");
    kv.setItem(pm.keyFor(p.id, "gazetype.phrases.v1"), "[]");
    kv.setItem(pm.keyFor(p.id, "gazetype.calibration.v1"), "{}");
    kv.setItem(pm.keyFor(p.id, "visualeyes.history.v1"), '["Hello"]');
    kv.setItem("gazetype.settings.v1", "{}");
    kv.setItem("gazetype.runs.v1", "[]");
    kv.setItem("gazetype.session.skipped.v1", "1");
    kv.setItem("gazetype.voiceApi.v1", "{}");
    kv.setItem("gazetype.accountProfile.auth0|abc", p.id);
    kv.setItem("visualeyes.onboard.v1", "{}");
    kv.setItem("@@auth0spajs@@::client::audience::scope", "{}"); // the sign-in library's own cache
    kv.setItem("somebody-elses-key", "keep");
    const before = kv.length;

    const removed = eraseLocalData(kv);

    expect(removed.length).toBe(before - 2);
    expect(removed.every(isAppKey)).toBe(true);
    expect(kv.length).toBe(2);
    expect(kv.getItem("somebody-elses-key")).toBe("keep");
    expect(kv.getItem("@@auth0spajs@@::client::audience::scope")).toBe("{}");
    expect(kv.getItem("gazetype.profiles.v1")).toBeNull();
    expect(kv.getItem(pm.keyFor(p.id, "gazetype.phrases.v1"))).toBeNull();
    // A fresh manager on the erased store starts from scratch.
    expect(new ProfileManager(kv).list().map((x) => x.name)).not.toContain("Frank");
  });

  it("is safe to run on an empty store", () => {
    expect(eraseLocalData(memoryKV())).toEqual([]);
  });
});

describe("Settings screen: Your data", () => {
  function ctx(signedIn: boolean, calls: string[]): ScreensCtx {
    return {
      settings: { ...DEFAULTS },
      saveSettings: () => calls.push("save"),
      toast: () => {},
      open: (n) => calls.push(`open:${n}`),
      insertPhrase: () => {},
      sayAgain: () => {},
      history: () => [],
      frequent: () => [],
      recalibrate: () => {},
      aiPrefs: () => {},
      account: () => ({ line: "", signedIn, available: true }),
      signIn: () => {},
      signOut: () => {},
      tools: () => [],
      aiStatus: () => "",
      listenStatus: () => "",
      eraseData: () => calls.push("erase"),
      speak: () => {},
    };
  }

  it("shows what is stored, mentions the account only when signed in, and has a gaze target to delete it", () => {
    const out = makeScreens(ctx(false, [])).settings.render();
    expect(out).toContain("Your data");
    expect(out).toContain("Video never leaves it.");
    expect(out).toContain("never audio or video");
    expect(out).not.toContain("In your account");
    expect(out).toContain('data-target="s:erase"');
    expect(makeScreens(ctx(true, [])).settings.render()).toContain("In your account");
  });

  it("asks the app to erase on selection, without saving settings", () => {
    const calls: string[] = [];
    makeScreens(ctx(true, calls)).settings.select("s:erase");
    expect(calls).toEqual(["erase"]);
  });
});
