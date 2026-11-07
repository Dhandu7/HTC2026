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
| Voice (optional) | `server/elevenlabs.ts`, `src/voice/elevenlabsVoice.ts` | Set `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` to speak in the user's cloned voice; falls back to the system voice. See [docs/ELEVENLABS_VOICE.md](docs/ELEVENLABS_VOICE.md). |
| Metrics | `src/metrics/session.ts` | WPM ((T−1)/5), selections per character, minimum-string-distance error, and likely false selections (an undo within 2 s). |
| Overlay | `electron/main.mjs` | Transparent, click-through when collapsed, non-focusable so the target app keeps focus. Global shortcut, tray menu, and paste via the OS. |
| Voice | `src/input/voice.ts` | Vosk wasm with a fixed grammar ("gaze type", "open/hide keyboard", "read it out"). Works offline, and other speech can't trigger it. |

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
