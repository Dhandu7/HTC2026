# Plan: modular keyboard layouts (Colemak, Dvorak, alphabetical, optimized, access modes)

Status: **planned, not built.** Written 5 Nov 2026.

## The honest take on Colemak for gaze

Colemak, Colemak-DH and Dvorak exist to reduce **finger** travel and strain on a physical keyboard. A gaze user has no fingers in the loop, so those layouts' ergonomic benefit **doesn't transfer**. What does matter for gaze:

1. **Visual search time.** How fast you *find* the key. Familiarity dominates this.
2. **Number and size of targets.** This is set by the accuracy budget.
3. **Ambiguity** (for grouped keys). How often a key sequence maps to several words.
4. **Gaze travel** between consecutive keys. Minor at our target sizes.

Evidence (small studies, mixed results):
- 16 neurotypical adults and 16 people with ALS showed **no difference in typing rate** between QWERTY, alphabetical-with-highlighted-vowels and frequency-based layouts. Most **preferred QWERTY** ([Raupp, ECU 2013](https://thescholarship.ecu.edu/handle/10342/4254)).
- In dwell-free eye typing, QWERTY won for experienced typists. People with **under a year of keyboard experience did as well on alphabetical** ([Univ. of Malta 2017](https://www.um.edu.mt/library/oar/handle/123456789/25897)).
- A layout optimized for letter-to-letter probability raised speed from **7.26 to 8.86 WPM** for expert users on a 1-row keyboard ([Špakov & Majaranta 2009](https://homepages.tuni.fi/oleg.spakov/publications/Spakov_PNJ_09.pdf)). A greedy minimal-eye-movement layout also beat QWERTY and alphabetical, though that study had only 6 participants ([CMS 2019](https://openaccess-api.cms-conferences.org/articles/download/978-1-7923-8988-7_130)).

**So:** offer Colemak and Dvorak **for people who already type that way** (familiarity is what helps), not as a speed feature. The bigger win is making layouts **data, not code**, so the same engine serves typists, non-typists, other languages and the access modes from [USER_SEGMENTS.md](USER_SEGMENTS.md).

## Design: layouts are data

Today the keyboards are two hard-coded classes, and the letter groups are a constant (`LETTER_GROUPS`). The prediction engine already matches typed slots *as letter sets*, so any grouping works without changing the engine. Only the rendering and the layout definitions need to become data-driven.

```ts
// src/layouts/types.ts
type Cell =
  | { t: "group"; letters: string; label?: string }        // ambiguous key ("abc")
  | { t: "key"; char: string; label?: string }             // exact letter (full keyboards)
  | { t: "chip"; index: number }                           // prediction slot
  | { t: "action"; id: "del" | "space" | "phrases" | "menu" | "speak" | "pause" | "call" | "insert" }
  | { t: "symbol"; text: string; image?: string }          // symbol/needs boards
  | { t: "empty" };

interface Layout {
  id: string;                     // "grouped-t9", "full-colemak-dh", "access-vertical"
  name: string;                   // shown in the gaze-operable picker
  kind: "grouped" | "full" | "board" | "scan";
  lang: string;                   // "en", "es", "hi"…
  grid: { cols: number; rows: number };
  cells: Cell[];                  // row-major, length = cols × rows
  defaults?: { dwellMs?: number; selection?: "dwell" | "blink"; minTargetDeg?: number };
  notes?: string;                 // why this layout exists, shown in settings
}
```

- One generic `LayoutKeyboard` renders any `Layout`. `GazeTypeKeyboard` and `BaselineKeyboard` become thin behaviours on top: grouped vs exact-letter input.
- **Validation at load:** every letter of the language appears exactly once, the grid is full, and targets ≥ the measured error (from calibration, in degrees) or the user gets a warning.
- **Layout picker:** gaze-operable (Saturday plan A1). The benchmark records `layout.id`, so the results table compares layouts automatically.
- **Custom layouts:** import or export JSON. A caregiver can make one; later there could be a visual editor in the caregiver console.

## Layout catalog

### Full keyboards (exact letters; baseline-style, best with good accuracy)
| id | Layout | For |
|---|---|---|
| `full-qwerty` | QWERTY (current baseline) | Most typists |
| `full-colemak` / `full-colemak-dh` | Colemak, Colemak-DH | Existing Colemak typists |
| `full-dvorak` | Dvorak | Existing Dvorak typists |
| `full-azerty`, `full-qwertz` | AZERTY, QWERTZ | French / German typists |
| `full-abc` | Alphabetical, vowels highlighted | Non-typists, children, low literacy |

### Grouped keyboards (the GazeType 4×4 grid; 8 ambiguous keys)
| id | Grouping | Trade-off |
|---|---|---|
| `grouped-t9` | abc def ghi jkl mno pqrs tuv wxyz (current) | Familiar from phones; not optimal |
| `grouped-abc` | Alphabetical runs, balanced by frequency | Easy to scan |
| `grouped-qwerty` | Groups follow QWERTY rows/positions ("qwe", "rty"…) | Familiar to typists |
| `grouped-colemak` | Same idea following Colemak positions | Colemak typists |
| `grouped-optimized` | **Computed:** minimises expected selections per word on our corpus | Fastest in theory; must be learned |

### Access-mode boards (from USER_SEGMENTS.md)
| id | Layout | For |
|---|---|---|
| `access-3x3` | 9 extra-large targets (6 groups + chips) | Fatigue, late ALS, poor accuracy |
| `access-vertical` | One column of 4–5 rows; up/down + blink | Classic locked-in syndrome (vertical eye movement only) |
| `board-icu-needs` | Pain · Suction · Reposition · Family · Yes · No | ICU, no calibration |
| `board-pain-scale` | 0–10 + body map | ICU, clinical |
| `board-core-symbols` | Core vocabulary symbols (ARASAAC, later) | CP, Rett, pre-literate users |

### Languages (later)
- `grouped-es` (adds ñ, accents via long-dwell), `full-es`.
- `grouped-hi`: Devanagari grouped by **varga** (consonant class), which is a natural ambiguous grouping for Hindi.
- Each language needs its own lexicon and phrases (`public/data/<lang>/`).

## Optimized grouping (the one layout likely to really help)

`scripts/optimize-groups.ts`:
1. Load the lexicon with frequencies, plus our phrase corpus.
2. Cost of a grouping = the expected number of selections to enter a word. That's key presses until the word appears in the top-4 chips, plus 1 to take it, weighted by word frequency. The engine already computes candidates, so reuse `PredictionEngine.wordCandidates`.
3. Search: start from T9, then simulated annealing that swaps letters between groups (with an optional alphabetical-order constraint for learnability).
4. Output a `Layout` JSON plus a report: selections per word vs T9 and alphabetical.
5. Guard against overfitting: hold out 20% of phrases, and report held-out cost.

This gives a measurable, defensible claim ("our grouping cuts expected selections per word by X% vs T9 on held-out text") rather than a layout chosen by taste.

## Implementation steps (when we build it)

| # | Step | Files | Est. |
|---|---|---|---|
| 1 | `Layout` types + validator + unit tests | `src/layouts/types.ts`, `validate.ts`, `tests/layouts.test.ts` | 40 min |
| 2 | Port the current two keyboards to layout data (`grouped-t9`, `full-qwerty`) with no behaviour change; existing tests still pass | `src/layouts/builtin/*.ts`, `src/ui/keyboards.ts` | 60 min |
| 3 | Add full layouts: Colemak, Colemak-DH, Dvorak, AZERTY, QWERTZ, ABC | `src/layouts/builtin/full.ts` | 30 min |
| 4 | Add grouped variants: abc, qwerty-position, colemak-position | `src/layouts/builtin/grouped.ts` | 30 min |
| 5 | Gaze-operable layout picker + persist choice; benchmark records `layout.id` | `main.ts`, `metrics/session.ts` | 40 min |
| 6 | `optimize-groups.ts` + generated `grouped-optimized` + report | `scripts/`, `docs/` | 90 min |
| 7 | `access-3x3` and `access-vertical` (the latter needs the scan/vertical selector) | `src/layouts/builtin/access.ts`, `src/input/scan.ts` | 90 min |
| 8 | JSON import/export for custom layouts | `main.ts` | 30 min |

**Total: about 7 hours.** For Saturday, **steps 1–5 (~3.5 h)** give a modular engine plus Colemak/Dvorak/ABC. Steps 6–7 are the ones that change outcomes. Do **6 (optimized groups)** if the Typing UX lead has time, and **7 (vertical)** if the accessibility demo needs it.

## How we'll verify it
- **Unit:** every built-in layout passes the validator (all letters present once, grid full); grouped decoding works for every grouping (round-trip: type a word's groups → the word appears in the candidates).
- **Benchmark:** the same 3 sentences on `grouped-t9`, `grouped-optimized` and `full-qwerty`, plus `full-colemak` for a Colemak typist if we can find one. Report selections per word and WPM per layout.
- **Optimizer:** held-out cost lower than T9. Commit the report with the numbers.

## Risks
| Risk | Mitigation |
|---|---|
| Layout choice becomes a rabbit hole before the accuracy and hands-free fixes | Hard rule: do the A1–A3 accessibility items and the measurement work first (Saturday plan order) |
| An optimized grouping is hard to learn (letters look "random") | Optional alphabetical-order constraint; show the letters clearly on each key; measure on a novice |
| Full keyboards on a laptop violate the 2–3° budget | The validator warns when keys are smaller than the measured error; recommend grouped layouts |
| Claiming "Colemak is faster" | Don't. Present it as a familiarity option, per the evidence above |
