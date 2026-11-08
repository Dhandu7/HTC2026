// "Delete my data": everything VisualEyes keeps on this computer. Every key the app writes starts with one of
// these prefixes (profiles and their words, phrases and calibration; settings; recent messages; onboarding
// answers; voice and account bookkeeping; benchmark runs), so removing those is a full local erase and anything
// another site or library stored is left alone. Pure, so it is unit-tested with a Map-backed store.
import type { KV } from "../profile/profiles";

export const APP_KEY_PREFIXES = ["gazetype.", "visualeyes."] as const;

export const isAppKey = (k: string) => APP_KEY_PREFIXES.some((p) => k.startsWith(p));

/** Removes every app key from `kv` and returns the keys removed, for a test or a log line. */
export function eraseLocalData(kv: KV): string[] {
  const keys: string[] = [];
  for (let i = 0; i < kv.length; i++) {
    const k = kv.key(i);
    if (k && isAppKey(k)) keys.push(k);
  }
  for (const k of keys) kv.removeItem(k);
  return keys;
}
