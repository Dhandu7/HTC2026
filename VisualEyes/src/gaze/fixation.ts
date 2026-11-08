// Pure helpers for calibration quality (no DOM, unit-tested).

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface CleanResult {
  /** Indices of frames to keep. */
  kept: number[];
  /** Enough frames survived the outlier rule. */
  steady: boolean;
  /** Spread (robust SD) of each gaze-direction feature at this dot, for comparing dots. */
  spread: number[];
}

/**
 * Drop frames that disagree with the rest while the user looks at one calibration dot
 * (a glance away, a half-blink, a tracking glitch). Uses the gaze-direction features
 * (the first `dims` entries) and a median/MAD rule, which isn't pulled by the outliers
 * themselves the way a mean/SD rule is.
 */
export function cleanFixation(vectors: number[][], dims = 4, k = 3, minKeepFrac = 0.6, minFrames = 8): CleanResult {
  if (vectors.length < minFrames) return { kept: vectors.map((_, i) => i), steady: false, spread: [] };
  const d = Math.min(dims, vectors[0].length);
  const med: number[] = [];
  const mad: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = vectors.map((v) => v[j]);
    const m = median(col);
    med.push(m);
    // 1.4826 * MAD estimates the SD for normal data; the floor stops a near-constant column rejecting everything.
    mad.push(Math.max(1.4826 * median(col.map((x) => Math.abs(x - m))), 1e-3 * (Math.abs(m) + 1e-3)));
  }
  const kept = vectors.flatMap((v, i) => (med.every((m, j) => Math.abs(v[j] - m) <= k * mad[j]) ? [i] : []));
  return { kept, steady: kept.length >= minFrames && kept.length >= minKeepFrac * vectors.length, spread: mad };
}

/**
 * Which dots were looked at much less steadily than the rest of this calibration (e.g. the
 * eyes wandered between two places). Compared with the user's own typical spread, since
 * the noise level depends on the camera, light and person.
 */
export function scatteredDots(spreads: number[][], factor = 3): number[] {
  const valid = spreads.filter((s) => s.length);
  if (valid.length < 3) return [];
  const dims = valid[0].length;
  const typical = Array.from({ length: dims }, (_, j) => median(valid.map((s) => s[j])));
  return spreads.flatMap((s, i) => (s.length && s.some((v, j) => v > factor * typical[j]) ? [i] : []));
}
