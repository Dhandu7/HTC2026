// User profiles. Each profile gets its own namespace in storage, so one person's
// words, phrases, calibration and voice settings never mix with another's.
// Everything stays on this device; export/import is a plain JSON file.
import type { Store } from "../predict/engine";

export interface Profile {
  id: string;
  name: string;
  /** Free text the LLM may use: who they are, what they like, how they talk. */
  about: string;
  /** Names of family, carers, pets. Pinned in prediction and given to the LLM. */
  people: string[];
  /** A stable sample of their own sentences, picked at import time (for the LLM prompt). */
  samples: string[];
  createdAt: number;
}

/** Minimal storage interface (localStorage in the browser, a Map in tests). */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

const INDEX_KEY = "gazetype.profiles.v1";
/** Keys that used to be global and now belong to a profile. */
const LEGACY_KEYS = ["gazetype.words.v1", "gazetype.bigrams.v1", "gazetype.phrases.v1", "gazetype.calibration.v1"];
const MAX_SAMPLES = 40;

const prefix = (id: string) => `gazetype.p.${id}.`;
const newId = () => Math.random().toString(36).slice(2, 10);

interface Index {
  profiles: Profile[];
  active: string;
}

export class ProfileManager {
  private idx: Index;

  constructor(private readonly kv: KV) {
    this.idx = this.loadIndex();
  }

  private loadIndex(): Index {
    try {
      const raw = this.kv.getItem(INDEX_KEY);
      if (raw) {
        const idx = JSON.parse(raw) as Index;
        if (idx.profiles?.length) return idx;
      }
    } catch {
      /* fall through to a fresh index */
    }
    // First run (or upgrade from the single-user build): copy existing data into a default profile.
    const p = blank("Me");
    for (const k of LEGACY_KEYS) {
      const v = this.kv.getItem(k);
      if (v !== null) this.kv.setItem(prefix(p.id) + k, v);
    }
    const idx = { profiles: [p], active: p.id };
    this.kv.setItem(INDEX_KEY, JSON.stringify(idx));
    return idx;
  }

  private save() {
    this.kv.setItem(INDEX_KEY, JSON.stringify(this.idx));
  }

  list(): Profile[] {
    return [...this.idx.profiles];
  }

  get active(): Profile {
    return this.idx.profiles.find((p) => p.id === this.idx.active) ?? this.idx.profiles[0];
  }

  setActive(id: string): Profile {
    if (this.idx.profiles.some((p) => p.id === id)) this.idx.active = id;
    this.save();
    return this.active;
  }

  create(name: string): Profile {
    const p = blank(name.trim() || `User ${this.idx.profiles.length + 1}`);
    this.idx.profiles.push(p);
    this.save();
    return p;
  }

  update(id: string, patch: Partial<Omit<Profile, "id" | "createdAt">>): Profile | undefined {
    const p = this.idx.profiles.find((x) => x.id === id);
    if (!p) return undefined;
    Object.assign(p, patch);
    if (patch.samples) p.samples = patch.samples.slice(0, MAX_SAMPLES);
    this.save();
    return p;
  }

  /** Delete a profile and all of its stored data. The last profile can't be deleted. */
  remove(id: string): boolean {
    if (this.idx.profiles.length <= 1) return false;
    this.idx.profiles = this.idx.profiles.filter((p) => p.id !== id);
    for (const k of this.keysOf(id)) this.kv.removeItem(k);
    if (this.idx.active === id) this.idx.active = this.idx.profiles[0].id;
    this.save();
    return true;
  }

  /** Storage for one profile's prediction data. */
  store(id: string): Store {
    const pre = prefix(id);
    return {
      get: (k) => this.kv.getItem(pre + k),
      set: (k, v) => {
        try {
          this.kv.setItem(pre + k, v);
        } catch {
          /* quota exceeded: keep working in memory */
        }
      },
    };
  }

  /** Full storage key for a per-profile item (e.g. calibration). */
  keyFor(id: string, key: string): string {
    return prefix(id) + key;
  }

  private keysOf(id: string): string[] {
    const pre = prefix(id);
    const out: string[] = [];
    for (let i = 0; i < this.kv.length; i++) {
      const k = this.kv.key(i);
      if (k?.startsWith(pre)) out.push(k);
    }
    return out;
  }

  /** One profile and all of its data, as JSON (backup, or moving to a new laptop). */
  exportProfile(id: string): string {
    const profile = this.idx.profiles.find((p) => p.id === id);
    const pre = prefix(id);
    const data: Record<string, string> = {};
    for (const k of this.keysOf(id)) data[k.slice(pre.length)] = this.kv.getItem(k)!;
    return JSON.stringify({ format: "gazetype-profile", version: 1, profile, data });
  }

  /** Import an exported profile as a new profile (never overwrites an existing one). */
  importProfile(json: string): Profile {
    const parsed = JSON.parse(json) as { format?: string; profile?: Profile; data?: Record<string, string> };
    if (parsed.format !== "gazetype-profile" || !parsed.profile) throw new Error("Not a VocalEyes profile file");
    const p: Profile = { ...blank(parsed.profile.name), ...parsed.profile, id: newId() };
    for (const [k, v] of Object.entries(parsed.data ?? {})) if (typeof v === "string") this.kv.setItem(prefix(p.id) + k, v);
    this.idx.profiles.push(p);
    this.save();
    return p;
  }
}

function blank(name: string): Profile {
  return { id: newId(), name, about: "", people: [], samples: [], createdAt: Date.now() };
}

/**
 * Pick a stable, representative sample of someone's own sentences for the LLM prompt:
 * everyday-length sentences, de-duplicated, spread across the text.
 */
export function pickSamples(sentences: string[], n = MAX_SAMPLES): string[] {
  const seen = new Set<string>();
  const good = sentences.filter((s) => {
    const words = s.split(/\s+/).length;
    const key = s.toLowerCase();
    if (words < 3 || words > 25 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (good.length <= n) return good;
  const step = good.length / n;
  return Array.from({ length: n }, (_, i) => good[Math.floor(i * step)]);
}

/** In-memory KV for tests. */
export function memoryKV(): KV {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}
