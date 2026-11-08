# GazeType

A webcam-only eye-gaze communicator for people who can't use their hands or voice (ALS, cerebral palsy, locked-in syndrome). It needs no infrared tracker and runs on any laptop. Typing is prediction-first, the targets are large enough for webcam error, and all vision processing stays on the device.

It runs in two ways:

- **Browser app.** Open a page and start typing with your eyes. This is the easiest way for judges to try it.
- **Electron overlay.** An always-on-top keyboard that opens over any app with a **global keybind** (`⌘⇧G` / `Ctrl+Shift+G`), an **offline voice command** ("gaze type"), or by **looking at the top-right corner**. **Insert** pastes the sentence into the app you were using.

> Communication aid prototype. Not a medical device.

## Quick start

```bash
npm install
npm run setup               # downloads the face model so it works offline (~3.6 MB)
npm run dev                 # browser app at http://localhost:5173
```

Overlay:

```bash
npm run overlay             # Vite + Electron
npm run overlay:all         # also starts the optional LLM proxy
```

Optional extras:

```bash
npm run setup -- --voice    # offline voice-command model (~40 MB, Vosk)
cp .env.example .env        # add ANTHROPIC_API_KEY to enable LLM sentence suggestions
npm run dev:all             # browser app + LLM proxy
npm test                    # unit tests (regression, filters, selection, prediction, metrics)
```

On macOS the overlay asks for Camera access. Auto-paste needs **Accessibility** permission (System Settings → Privacy & Security → Accessibility → Electron). Without it, **Insert** still copies the text to the clipboard.

## How it works

```
webcam ─► MediaPipe Face Landmarker (478 landmarks + blendshapes + face pose, on-device, ~30 fps)
        ─► features: iris-in-eye (x,y), eyeLook blendshapes, face yaw/pitch, face position/scale
        ─► ridge regression (z-scored, quadratic gaze terms) fit by 9-point calibration
        ─► One Euro filter ─► target tracker (snap + hysteresis) ─► dwell | deliberate-blink selector
        ─► keyboard ─► prediction engine (+ optional LLM) ─► speak / insert / learn
```

| Piece | File | Notes |
|---|---|---|
| Tracking | `src/gaze/tracker.ts` | MediaPipe Tasks Vision. Uses local wasm/model if present, otherwise the CDN. GPU delegate with CPU fallback. |
| Features | `src/gaze/features.ts` | Pure function and unit-tested. The cursor freezes during blinks. |
| Calibration | `src/ui/calibration.ts` | 9 calibration points and 4 validation points take about 25 s. Reports **mean error and precision in degrees**, with the assumed screen size and distance shown. |
| Drift | `src/gaze/engine.ts` | **Implicit recalibration**: a selection that isn't undone within 2 s becomes a down-weighted training sample at the target's centre. |
| Accuracy units | `src/gaze/accuracy.ts` | Converts px to degrees. Viewing distance is estimated from iris size (11.7 mm) and can be overridden. |
| Selection | `src/input/selection.ts` | **Dwell** (700 ms on GazeType, 1000 ms on the baseline). **Deliberate blink** (dwell-free) needs both eyes closed for 350–1500 ms after aiming for at least 150 ms. Involuntary blinks are **counted and reported**, not hidden. |
| Keyboard | `src/ui/keyboards.ts` | GazeType has **16 targets in a 4×4 grid**: 4 prediction chips, 8 letter-group keys, delete, accept, phrases/expand, and done. The baseline is a dwell QWERTY. |
| Prediction | `src/predict/engine.ts` | Decodes ambiguous letter-group keys through a **key-sequence index** (one bucket lookup per key, ~0.4 ms), completes words, and predicts the next word from personal **trigram → bigram** context. Personal and global frequencies are blended, with the personal share growing as the user talks; personal words decay over 30 days; a suggestion picked and deleted within 2 s is ranked lower in that context. Keeps a **personal phrase store** that learns every sentence you speak or insert. **Abbreviation expansion** turns one key per word into a full sentence. |
| Profiles | `src/profile/profiles.ts` | Each user has separate words, phrases and calibration. A caregiver can add **people's names** (pinned, keep their capitals), an **about** note, and **writing samples** (pasted text or a .txt file) that give prediction a head start. Switch user by gaze from **☰ Done → 👤 Switch user**. Export/import a profile as JSON. All on-device. |
| LLM (optional) | `server/llm.ts` | Claude via a local proxy with structured output. Live sentence chips use a fast model (`GAZETYPE_FAST_MODEL`, default `claude-haiku-5-5`, no thinking); the abbreviation-expansion panel uses `GAZETYPE_MODEL` (default `claude-opus-5-5`). The profile goes in a cached system block so suggestions match the user's style. Requests are debounced 150 ms, cancelled when the text changes, cached by typed text, and time out after 2.5 s (6 s for expansion). Only text is sent, never video. |
| Voice (optional) | `voice-sidecar/`, `src/voice/`, `src/ui/myVoice.ts` | **🗣 My voice** creates a voice from the user's own recordings (ElevenLabs, per user) and Speak uses it, falling back to the system voice. Put `ELEVENLABS_API_KEY` in `VisualEyes/.env`, then `npm run dev:voice`. See [voice-sidecar/README.md](voice-sidecar/README.md). `server/elevenlabs.ts` and [docs/ELEVENLABS_VOICE.md](docs/ELEVENLABS_VOICE.md) are an older single fixed voice and are not used by the app. |
| Metrics | `src/metrics/session.ts` | WPM ((T−1)/5), selections per character, minimum-string-distance error, and likely false selections (an undo within 2 s). |
| Overlay | `electron/main.mjs` | Transparent, click-through when collapsed, non-focusable so the target app keeps focus. Global shortcut, tray menu, and paste via the OS. |
| Voice | `src/input/voice.ts` | Vosk wasm with a fixed grammar ("gaze type", "open/hide keyboard", "read it out"). Works offline, and other speech can't trigger it. |

### Recording and replaying sessions (pointer tracker and eye tracker)

Tracking changes are judged on recorded data, averaged over **all** recordings, not on one live run.

1. Start the **🎯 Pointer tracker** (or 👁 Eye tracker) and press **● Record**. The recording follows the active mode. Use one Participant ID per person.
   - **Quick trial (~1.5 min):** 25-dot grid + 8 check dots. In pointer mode the check dots stay up 3.5 s so the 2 s dwell can be simulated.
   - **Full (~12 min):** adds 16 check dots and drift checks at +2, +5, +10 min. **Short:** 9 dots + 16 check dots, for strangers.
2. Every **◎ Calibrate** also downloads `gazecal-<pointer|eye>-<id>-<time>.json` when "Save each calibration" is on in ⚙ Settings (default on). The calibration toast now also shows the **hit rate for 6 large buttons and for the 4×4 grid** on the check dots.
3. Move the files to `VisualEyes/recordings/` (git-ignored) and run `npm run replay -- recordings/*.json` (`--json out.json` saves the rows). It rebuilds the features from the raw landmarks and fits **exactly the app's model** for each file's mode (pointer: yaw + pitch, straight-line ridge, λ=1, per-dot outlier trimming; eye: 7 features, ridge λ=1). Pointer recordings are also scored with the **original** 10-feature quadratic model, side by side, with a "beats original on N of M" count, so the model choice keeps being checked against data. It prints per recording and as a **mean per pointer mode**:
   - hit rates (4-chip, 6-chip, 16-grid), x/y offset, jitter, on the held-out check dots and drift checks;
   - a **dwell simulation** with main's cursor pipeline (pointer: smoothing, clamp, 10 px leash, off-screen cut-off) and 2 s dwell: correct / wrong / timed out.
   - `--as-pointer` forces the pointer pipeline on eye recordings (plumbing test only).

### Why a 4×4 grid of letter groups and not QWERTY

The best webcam gaze estimates have about 1.3–1.8° error. A typical student implementation gets 3° or more. At 60 cm, 3° is about 3.1 cm, so a 26-key QWERTY on a laptop screen can't be hit reliably. Sixteen large targets can. Prediction makes up for the ambiguous keys: one key press per letter, and usually 1–3 presses before the word appears as a chip. See [docs/RESEARCH.md](docs/RESEARCH.md).

## Demo script (side-by-side)

1. **Calibrate** (about 25 s). Read out the measured error in degrees and the stated conditions.
2. Turn on **⏱ Benchmark**. Type the target sentence on **GazeType** with your eyes.
3. Toggle **Keyboard → Baseline QWERTY**. The same sentence stays loaded. Type it again.
4. Open **📊 Results**. Compare WPM, selections per character, error and false selections. **Export JSON** for the slide.
5. Type a sentence and speak it. Then start it again: it now comes back as a **phrase chip** after one word, so the store is learning.
6. Overlay: press `⌘⇧G` over Notes or Slack, type with your eyes, choose **☰ Done → 📋 Insert**, and the text appears in that app.

Let judges try it. Mouse mode (hover to dwell) runs the same UI and metrics with no camera.

> Before the demo, clear the results table (📊 → Clear). Runs from testing with instant clicks show unrealistic WPM.

## Honest limitations

- No disabled-user evaluation yet. Every number is from able-bodied testers unless stated otherwise.
- Accuracy depends on lighting, glasses, camera and face pose. Report the conditions with every number.
- The degree figure assumes a screen size (in Settings) and an estimated viewing distance.
- The word list is the Google 10k list (research/educational use). Swap it before any commercial use.
- English only for now. Multilingual support is on the roadmap.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md), the gap analysis + day plan in [docs/SATURDAY_PLAN.md](docs/SATURDAY_PLAN.md), the self-assessment in [docs/SCORECARD.md](docs/SCORECARD.md), expansion by user segment in [docs/USER_SEGMENTS.md](docs/USER_SEGMENTS.md), the own-voice (VoiceStudio) plan in [docs/VOICE_PLAN.md](docs/VOICE_PLAN.md), and modular keyboard layouts in [docs/LAYOUTS_PLAN.md](docs/LAYOUTS_PLAN.md).
