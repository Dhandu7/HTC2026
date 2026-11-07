# LLM prediction flow: Claude Haiku 5.5 on Bedrock, per-user speech profile

Status: **planned, not built.** Branch: `llm/bedrock-haiku-prediction`. Written 7 Nov 2026.
Companion doc (other branch): `docs/VOICE_ENGINE_FLOW.md` (`voice/openvoice-engine`).

Goal: suggest replies and continuations that sound like *this* user, cost them one or two selections instead of ten, and come out in *their* voice, adapted to how accurately their gaze calibrated.

## Today vs. target

| | Today (`server/llm.ts`, `src/predict/*`) | Target |
|---|---|---|
| Model | `claude-opus-5-5` via the direct Anthropic API | `claude-haiku-5-5` via Amazon Bedrock |
| Context | last ≤20 sentences from the caller | Style card, people and lexicon, retrieved exemplars, conversation, audience, time of day |
| Tasks | `continue`, `expand` | Adds `reply` (answer what the partner just said) |
| Personalisation | Local bigram and phrase store only | Plus an LLM-distilled **style card** and retrieved exemplars |
| Calibration | Not used | Sets how many suggestions, how long, and how much to trust the LLM vs. local phrases |
| Voice | Not connected | Output feeds the voice router; suggestions pre-render |

## Bedrock facts (from the Claude API reference, 7 Nov 2026)

- Package `@anthropic-ai/bedrock-sdk`, class `AnthropicBedrockMantle`, `new AnthropicBedrockMantle({ awsRegion })`. The older `AnthropicBedrock` class is the legacy InvokeModel path; use Mantle.
- Model ID: **`anthropic.claude-haiku-5-5`**. Keep it in `BEDROCK_MODEL_ID` so it can change without a code edit. **Confirm it appears in the team's Bedrock console and that model access is enabled in the chosen region.**
- Auth: the AWS default credential chain on the **server process only** (env vars, SSO profile, or role). The renderer never holds credentials.
- Supported on Bedrock: streaming, structured outputs (`output_config.format`), `effort`, prompt caching (5m and 1h), tool use.
- **Not** on Bedrock: server-side `fallbacks` (the current `server/llm.ts` sends it, so it must go), Message Batches, Models API, `inference_geo`.
- Haiku 5.5 request rules: omit `temperature`, `top_p` and `top_k` (non-default values 400); no assistant prefill; adaptive thinking is **on by default** and counts toward `max_tokens`; default effort is `medium`. For autocomplete: `output_config.effort: "low"` and a `max_tokens` with headroom (start at 1024). Read content blocks by `type`, never `content[0]`.
- Price (first-party rates; Bedrock bills separately, check the AWS page): $0.10 / $0.50 per MTok in/out up to 100K prompt tokens.
- Refusals: Haiku 5.5 has no server-side fallback. On `stop_reason: "refusal"` return `[]` and let the local engine answer.

Open items to settle in the spike: whether `client.messages.parse` with a Zod schema works on the Mantle client or the schema needs to be passed as plain JSON Schema; the observed `cache_read_input_tokens` for our prefix (Haiku has a minimum cacheable prefix length).

## Architecture

```
Renderer (Electron/Vite)
  PredictionEngine (local, <50 ms)  ──┐
  Partner speech-to-text  ───────────┐│     merge + rerank + validate
  Gaze selection / typed words ──────┴┴─►  suggestion strip (4 chips)
        │                                         │
        │ POST /api/predict  (hard timeout 2.5 s) │ selected text
        ▼                                         ▼
  server/llm.ts (local Node proxy)          Voice router (T0–T3)
    ├─ builds prompt from UserProfile slice
    ├─ AnthropicBedrockMantle → Haiku 5.5
    └─ validates, dedupes, returns {suggestions[], ms, cached}
```

Rules that carry over from the current code: local results always show first; the LLM can only add or reorder, never block; every LLM call has a hard timeout; LLM output is validated locally (prefix match for `continue`, initials fit for `expand`).

## Flow A: what happens on each interaction

```
1. Trigger
   - partner utterance finalised by STT          → task "reply"
   - user committed a word / typed text changed  → task "continue" (debounced 250 ms)
   - user typed an initials abbreviation          → task "expand"
2. Local pass (instant): phrase store, bigrams, word completions → chips render immediately.
3. Budget (from calibration, Flow D): n suggestions, max words, LLM weight.
4. Build request: task, text, partner utterance + last 6 turns, audience, topic hint,
   profile slice (style card, relevant people/lexicon, k exemplars), n, constraints.
5. Haiku call (low effort, structured output). Hard timeout 2.5 s.
6. Validate: prefix / initials / length / banned-content / duplicates of local chips.
7. Merge: score = w_llm·rank + w_local·localScore + w_phrase·phraseBoost; keep top n.
8. Hand the visible chips to the voice pre-render queue.
9. On selection: speak (voice router), learn(text), record outcome (picked rank, undone?).
```

## Flow B: the per-user speech profile

Stored locally (IndexedDB or `userData`), versioned, exportable and deletable like the voice profile. Only text derived from it is ever sent to Bedrock.

| Part | Contents | Built from | Exists today |
|---|---|---|---|
| Phrase store | Phrases with count and last-used | Every spoken message | yes (`PredictionEngine.learn`) |
| Bigrams, personal words | Next-word statistics | Every spoken message | yes |
| **Style card** | ≤200 words: typical length, formality, contractions, humour, how they open and close, pet phrases, things they never say | Haiku summarising recent messages | no |
| **People and lexicon** | Names, relationship, nicknames, places, medical terms, with a short note each | Onboarding plus mentions in spoken text | no |
| **Audience registers** | Per relationship (partner, kids, nurse, friend): length and tone deltas | Spoken messages tagged with the audience chosen in the UI | no |
| **Routines** | Time-of-day and day-of-week patterns ("good morning", meal, medication, bedtime) | Timestamps on spoken messages | no |
| **Signals** | Chips shown and ignored, chips undone within 2 s, rank picked | Selection log | partly (undo exists) |

### Building it

**Cold start (day 0)**: onboarding questionnaire (name, who they talk to most, how they greet, 5 phrases they say daily, topics, anything they never want suggested) plus a seed set. Optional import of past messages (text only) with explicit consent. Result: a first style card from one Haiku call.

**Online learning (every Speak)**: `learn(text)`; update audience and routine counters; append to the exemplar log; log which chip was picked.

**Distillation (idle, or every ~25 new messages)**: one Haiku call over the latest messages and the old style card produces a new card and a list of new names or terms. The result is shown to the user for edit or delete before it is used. It is cached in the profile, so it costs almost nothing per prediction.

**Retrieval at prediction time**: pick *k* = 5–8 past messages most similar to the current text and partner utterance, with the same audience first. Plain token overlap or BM25 is enough; no embedding service. These few-shot lines do more for "sounds like me" than any prose description.

**Forgetting**: delete one message, one person, or everything. Decay old counts so stale habits fade. "Local only" mode disables all Bedrock calls and keeps the local engine.

## Flow C: prompt and request shape

Prompt caching: the stable prefix is `system` plus the style card plus people and lexicon. Volatile content (conversation, exemplars, typed text) goes after the cache breakpoint. Any byte change before the breakpoint invalidates the cache, so keep the prefix deterministic and sort keys. Verify with `usage.cache_read_input_tokens`.

```ts
// Request from renderer to the local proxy
interface PredictRequest {
  task: "reply" | "continue" | "expand";
  text: string;                       // typed so far (may be empty for "reply")
  slots?: string[];                   // expand only
  partner?: { utterance: string; speaker?: string };
  recent: { who: "user" | "partner"; text: string }[];   // last ≤6 turns
  audience?: string;                  // relationship id
  localTime: string;                  // for routines
  n: number;                          // from the budget
  maxWords: number;                   // from the budget
  profile: {                          // slice only, never the whole store
    styleCard: string;
    people: { name: string; note: string }[];
    exemplars: string[];
    avoid: string[];
  };
}

// Structured response from Haiku (output_config.format)
interface Suggestion { text: string; intent: "answer" | "question" | "need" | "social" | "other"; urgency: "normal" | "urgent" }
```

System prompt additions to the existing text: reply as the user, first person; match the style card; use exemplars as examples of voice, not text to copy; prefer one selection over many; **never invent medical facts, names or commitments** not present in the profile or conversation; return the schema only.

`server/llm.ts` changes:
- Replace `new Anthropic()` with `new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION })`.
- `MODEL = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-haiku-5-5"`.
- Remove `betas` and `fallbacks`. Remove nothing else from the validation path.
- `output_config: { effort: "low", format: … }`, `max_tokens` ≥ 1024, no sampling parameters.
- Add the `reply` task and the profile slice. Keep the zod `Request` schema strict and bounded.
- Map errors: throttling → 429 with `retry-after`, access denied / model not enabled → a clear 502 message, refusal → `[]`.
- Never log prompts or profile text. Log only task, latency, token counts and cache read.

## Flow D: combining with the voice profile and calibration

All three live in one `UserProfile` document. Each branch owns one section and nothing else, so they merge without conflict.

```ts
interface UserProfile {
  version: 1;
  id: string;
  voice: VoiceSection;          // owned by voice/openvoice-engine
  speech: SpeechSection;        // owned by llm/bedrock-haiku-prediction
  calibration: CalibrationSection; // read-only here; written by the existing gaze calibration
}
interface CalibrationSection {
  ts: number;
  meanDeg: number;              // from summarizeErrors()
  precisionDeg: number;
  dwellMs: number;
  missRate: number;             // rolling: undone selections / selections
}
```

Shared file: `src/profile/index.ts` re-exports `types` from each branch. Each branch adds only its own file (`voice.ts` or `speech.ts`) and one export line.

### D1. Calibration sets the suggestion budget

The cost of a wrong or long suggestion is higher when gaze is less accurate. Derive a budget from `CalibrationSection` once per session and whenever recalibration or `missRate` changes:

| Calibration | Chips shown (`n`) | `maxWords` | LLM weight | Notes |
|---|---|---|---|---|
| Good (error ≲ 1.5°, miss rate low) | 4–6 | 12 | high | Longer, richer suggestions are worth it |
| Fair | 4 | 8 | medium | Default layout |
| Poor (error ≳ 3° or miss rate high) | 2–3 | 5 | low, phrase store first | Fewer, bigger targets; short replies; yes/no/need chips pinned |

The thresholds are starting points. Tune them from the session export (selection time and undo rate per band), and put the numbers in the doc once measured. The budget also tells the model what a selection costs: the prompt says "each selection takes the user about X seconds", so Haiku trades suggestion length against effort the same way a person would.

### D2. Speech profile feeds the voice

- **Phrase boost → T0/T1**: suggestions that normalize-match a recorded phrase are marked `recorded` and shown with a small speaker badge; they play the real clip.
- **Top phrases → pre-render**: `topPhrases(20)` plus emergency phrases are the voice cache's standing queue.
- **Visible chips → speculative pre-render**: after each merge (step 8), the chips are sent to the voice pre-render queue in rank order. This hides most of the sidecar's render time.
- **Urgency**: `urgency: "urgent"` suggestions pin to the top and use the T0/T1 path only, so help is never waiting on a render.
- **Speakable text**: normalise numbers, abbreviations and units before synthesis, and keep a `display` and a `speak` string if they differ.
- **Delivery**: the voice section's `delivery.pace` applies to every render. Style hints beyond pace only if the voice spike shows OpenVoice V2 exposes them.

### D3. Voice and calibration feed back into the speech profile

- Every Speak writes `learn(text)` and the audience and routine counters, whichever tier played it.
- If a suggestion is picked and then undone, add it to `avoid` for that audience for a while.
- Voice tier and latency go in the session export next to gaze error, so one export tells the whole story.

### D4. Consent and privacy across the three parts

- Each part can be paused, exported and deleted on its own, and "delete everything" removes all three.
- Bedrock receives text only: the profile slice, the conversation turns and the typed text. No audio, embeddings, gaze data or video.
- The user sees the style card and the people list, can edit or remove entries, and can switch to local-only mode at any time.
- Suggestions are never spoken without a selection. Cloned speech is labelled AI-assisted (voice doc).

## Fallbacks and failure handling

| Failure | Behaviour |
|---|---|
| No AWS credentials, region or model access | Proxy health check reports the reason; the UI shows "Suggestions: local only (reason)" |
| Throttled (429) | One retry after `retry-after` if it fits the 2.5 s budget; otherwise local only |
| Timeout | Local chips stay; late LLM results are dropped if the strip has changed |
| Refusal | `[]`, local chips only, no error shown to the user |
| Validation removes every suggestion | Local chips only; count recorded as a quality metric |
| Offline | Local engine; the phrase store still learns |

## Evaluation (before and after, on the same replay set)

Replay recorded sessions (`metrics/session.ts` already records runs) through three configs: local only, Haiku with no profile, Haiku with the full profile.

| Metric | Why |
|---|---|
| Keystroke or selection saving rate | The headline number for the README |
| Top-1 and top-4 hit rate | Whether the right reply was on screen |
| p50 / p95 time to suggestions | Must beat the dwell time to feel instant |
| Cache read ratio | Confirms prompt caching is working |
| Cost per 1,000 predictions | Budget check on Haiku and Bedrock rates |
| "Sounds like me" rating | 20 suggestions, user rates each 1–5; compares the style card on vs. off |

## Implementation steps

| # | Step | Files | Done when |
|---|---|---|---|
| 1 | **Spike**: Bedrock access in the chosen region, `anthropic.claude-haiku-5-5` call from Node, structured output works, measure p50/p95 and cache reads | `scripts/bedrock-probe.mjs` | Numbers recorded here; `parse` vs JSON Schema decided |
| 2 | Swap the client and model in `server/llm.ts`; drop `betas` and `fallbacks`; low effort; `max_tokens` headroom; error mapping | `server/llm.ts`, `package.json` | `npm run llm` serves `/api/predict` from Haiku |
| 3 | `UserProfile` types and local store (IndexedDB), export and delete | `src/profile/*` | Round-trips and deletes in tests |
| 4 | Speech profile builders: exemplar log, audience and routine counters, retrieval | `src/profile/speech.ts` | Retrieval returns sensible exemplars in tests |
| 5 | Prompt builder with a stable cached prefix and the profile slice | `server/prompt.ts` | Cache read tokens > 0 on the second call |
| 6 | `reply` task and STT trigger; debounce; merge and rerank | `server/llm.ts`, `src/predict/llm.ts`, `src/predict/engine.ts` | Partner utterance yields replies in the strip |
| 7 | Calibration-driven budget | `src/predict/budget.ts` | Budget changes with calibration band; unit tested |
| 8 | Onboarding questionnaire, style card distillation, edit and delete UI | `src/ui/profileSetup.ts` | A new user gets a first style card; edits persist |
| 9 | Voice hooks: recorded badge, urgent pinning, pre-render handoff, speakable text | `src/predict/engine.ts`, `src/voice/*` (once the voice branch lands) | Visible chips reach the pre-render queue |
| 10 | Replay harness and the evaluation table | `scripts/replay.ts`, this doc | Numbers filled in |

Steps 1, 2 and 6 give a demoable "Haiku replies to what the partner just said". Steps 3–5 and 8 are what make it sound like the user. Step 7 and step 9 tie it to calibration and voice.

## Risks and open questions

| Risk | Mitigation |
|---|---|
| Haiku quality below Opus on subtle personal tone | Exemplar retrieval and the style card carry most of the voice; run the "sounds like me" rating; allow a per-route model override by env var |
| Bedrock model ID, region or access not ready before the demo | Spike first; keep the direct Anthropic client behind the same interface as a switchable fallback |
| Thinking tokens eat `max_tokens` or add latency | Low effort, headroom, measure in the spike |
| The model invents facts about the user | Prompt rule plus validation against the people list and avoid list; user edits the card |
| Sensitive text sent to a cloud service | Text only, no logging, local-only mode, visible profile, consent at onboarding; say so in the README |
| Branches diverge on the profile contract | Section ownership; only `src/profile/index.ts` is shared |
