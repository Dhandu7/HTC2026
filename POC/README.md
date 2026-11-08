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
webcam ─► MediaPipe Face Landmarker (478 landmarks + blendshapes + head pose, on-device, ~30 fps)
        ─► features: iris-in-eye (x,y), eyeLook blendshapes, head yaw/pitch, face position/scale
        ─► kernel ridge (RBF on z-scored features; quadratic ridge selectable) fit by 25-point calibration
        ─► One Euro filter ─► target tracker (snap + hysteresis) ─► dwell | deliberate-blink selector
        ─► keyboard ─► prediction engine (+ optional LLM) ─► speak / insert / learn
```

| Piece | File | Notes |
|---|---|---|
| Tracking | `src/gaze/tracker.ts` | MediaPipe Tasks Vision. Uses local wasm/model if present, otherwise the CDN. GPU delegate with CPU fallback. |
| Features | `src/gaze/features.ts` | Pure function and unit-tested. The cursor freezes during blinks. |
| Calibration | `src/ui/calibration.ts` | **25 points by default** (13 or 9 in Settings), shuffled, about 1 min, plus 4 validation points. Reports the **hit rate for 6 large buttons and a 4×4 grid** (distance-independent), plus mean error and precision in degrees with the assumed screen size and distance shown. No "keep still" demand: users calibrate in their natural posture. |
| Posture guard | `src/gaze/engine.ts` | Each gaze point carries a **confidence** (0–1). It drops when the face is lost or the head moves far from the calibration pose (position, distance, rotation). Below 0.3, dwell doesn't build up. If it stays low for 2 s, the app suggests moving back or recalibrating. |
| Drift | `src/gaze/engine.ts` | **Implicit recalibration**: a selection that isn't undone within 2 s becomes a down-weighted training sample at the target's centre. |
| Accuracy units | `src/gaze/accuracy.ts` | Converts px to degrees. Viewing distance is estimated from iris size (11.7 mm) and can be overridden. |
| Selection | `src/input/selection.ts` | **Dwell** (700 ms on GazeType, 1000 ms on the baseline) with **evidence accumulation**: a brief slip off a button keeps most of the progress, and a pass over a neighbour drains away (decay 0.5, 200 ms switch time). Chosen from the dwell simulation in `npm run replay`. **Deliberate blink** (dwell-free) needs both eyes closed for 350–1500 ms after aiming for at least 150 ms. Involuntary blinks are **counted and reported**, not hidden. |
| Keyboard | `src/ui/keyboards.ts` | GazeType has **16 targets in a 4×4 grid**: 4 prediction chips, 8 letter-group keys, delete, accept, phrases/expand, and done. The baseline is a dwell QWERTY. |
| Prediction | `src/predict/engine.ts` | Decodes ambiguous letter-group keys, completes words, predicts the next word from a personal bigram model, and keeps a **personal phrase store** that learns every sentence you speak or insert. **Abbreviation expansion** turns one key per word into a full sentence. |
| LLM (optional) | `server/llm.ts` | Claude via a local proxy with structured output. Only text is sent, never video. Results are re-checked locally against the typed pattern. A 6 s timeout means typing never waits on it. |
| Metrics | `src/metrics/session.ts` | WPM ((T−1)/5), selections per character, minimum-string-distance error, and likely false selections (an undo within 2 s). |
| Overlay | `electron/main.mjs` | Transparent, click-through when collapsed, non-focusable so the target app keeps focus. Global shortcut, tray menu, and paste via the OS. |
| Voice | `src/input/voice.ts` | Vosk wasm with a fixed grammar ("gaze type", "open/hide keyboard", "read it out"). Works offline, and other speech can't trigger it. |

### Recording and replaying gaze sessions (offline evaluation)

Every tracking change is judged on the same recorded data, not on a fresh live run.

1. Start with the camera, then press **● Record**. Fill in participant (use the **same ID for the same person** across sessions, or the pooled test treats them as two people), glasses and lighting. Leave the distance at 0: in a demo it's unknown, so we judge by hit rate. Sit naturally; don't hold your head still.
   - **Full (team), about 12 min:** 25-point grid, 16 validation points, then the validation points again at +2, +5 and +10 min to measure drift. Stay seated between checks.
   - **Quick trial, about 80 s:** the 25-point grid plus 8 validation points (no drift). Use it for fast A/B checks; replay still compares 25/13/9/5 points.
   - **Short (stranger), about 1 min:** the app's 9 calibration points plus the 16 validation points.
   - **Every ◎ Calibrate** also saves `gazecal-<id>-<time>.json` (the calibration dots plus the 4 check points) when "Save each calibration" is on in ⚙ Settings (default on). Set your Participant ID there. These replay like any session, so normal use builds up test data.
2. The browser downloads `gazesession-<id>-<time>.json` (raw landmarks, blendshapes and head pose per frame, about 50 MB for a full session) and, if ticked, a local `.webm` video. Move them to `POC/recordings/`, which git ignores.
3. Run `npm run replay -- recordings/*.json` (add `--json results.json` to save the rows; `--train-from 1100` / `--test-from 1100` use only frames that many ms after each dot appeared). It prints:
   - **Personal:** each calibration set (25/13/9/5 points) × ridge λ (0.1/1/10/100), scored on the validation points. The app now defaults to 25 points with λ=1.
   - **Drift:** one calibration scored at +0, +2, +5 and +10 min, with the median head movement from the calibration pose, and with a simulated one-dot re-centre.
   - **Dwell simulation:** runs the app's filter, snapping and dwell over each test dot with buttons laid out around it (4-chip, 6-chip, 16-grid) and reports correct / wrong / no selection, before vs. the app's current settings.
   - **Pooled (needs 2+ participants):** leave one participant out. Prior trained on everyone else vs. personal 9/5 points vs. prior + offset vs. prior + fine-tune.

**Hit rate is the main metric**: the share of frames inside a cell-sized box centred on the target, for a 6-chip (3×2) and a 16-grid (4×4) layout. It doesn't depend on viewing distance. Accuracy (offset of the mean gaze from the target, with x and y separately) and precision (SD and RMS sample-to-sample) are also reported, in degrees. Degrees use the measured distance, or the iris-size estimate if none was entered. Replay scores raw predictions, without the One Euro filter, like the app's validation step.

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
- Accuracy depends on lighting, glasses, camera and head pose. Report the conditions with every number.
- The degree figure assumes a screen size (in Settings) and an estimated viewing distance.
- The word list is the Google 10k list (research/educational use). Swap it before any commercial use.
- English only for now. Multilingual support is on the roadmap.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md), the gap analysis + day plan in [docs/SATURDAY_PLAN.md](docs/SATURDAY_PLAN.md), the self-assessment in [docs/SCORECARD.md](docs/SCORECARD.md), expansion by user segment in [docs/USER_SEGMENTS.md](docs/USER_SEGMENTS.md), the own-voice (VoiceStudio) plan in [docs/VOICE_PLAN.md](docs/VOICE_PLAN.md), and modular keyboard layouts in [docs/LAYOUTS_PLAN.md](docs/LAYOUTS_PLAN.md).
