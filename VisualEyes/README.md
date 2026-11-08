# VisualEyes

A webcam-only, hands-free communicator for people who can't use their hands or voice. It uses a webcam **pointer tracker** (no special hardware) and runs on any laptop. It opens on six large ready-to-speak phrases, typing is prediction-first, targets are large enough for webcam error, and all vision processing stays on the device.

It runs in two ways:

- **Browser app.** Open a page, choose **🎯 Pointer tracker** and start. This is the easiest way for judges to try it.
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
        ─► pointer features (yaw, pitch; 10 are recorded) ─► straight-line ridge model fit by a 20-dot calibration
        ─► One Euro filter + small leash, kept on screen ─► target tracker (snap + hysteresis) ─► dwell | deliberate-blink selector
        ─► keyboard ─► prediction engine (+ optional LLM) ─► speak / insert / learn
```

| Piece | File | Notes |
|---|---|---|
| Tracking | `src/gaze/tracker.ts` | MediaPipe Tasks Vision. Uses local wasm/model if present, otherwise the CDN. GPU delegate with CPU fallback. |
| Features | `src/gaze/features.ts` | Pure function and unit-tested. Extracts the full feature vector (its layout is kept so recordings stay comparable); the pointer uses `pointerVector()`, and its model reads yaw and pitch. Blinks don't move or freeze the pointer. The eye-tracker mode was removed; it lives on the parked `improve-eyetracking-confidence` branch. |
| Calibration | `src/ui/calibration.ts` | 20 dots (2 s each) plus 4 check dots (3.5 s each), about 55 s. Reports the **hit rate for 6 large buttons and the 4×4 grid**, a direction check, and error in degrees with the assumed screen size and distance shown; warns instead if the face was lost during the check. |
| Drift | `src/gaze/engine.ts` | **Implicit recalibration**: a selection that isn't undone within 2 s becomes a down-weighted training sample at the target's centre. |
| Accuracy units | `src/gaze/accuracy.ts` | Converts px to degrees. Viewing distance is estimated from iris size (11.7 mm) and can be overridden. |
| Selection | `src/input/selection.ts` | **Dwell** (2 s by default, set in ⚙ Settings). **Deliberate blink** (dwell-free) needs both eyes closed for 350–1500 ms after aiming for at least 150 ms. Involuntary blinks are **counted and reported**, not hidden. |
| Home | `src/ui/keyboards.ts` | The app opens on **6 large chips (3×2)**: 5 ready-to-speak phrases (one selection speaks a message) and **⌨ Keyboard**, which opens the 4×4 grid. Recorded pointer sessions hit 6 large buttons far more often than the 16-key grid (open loop, mean of 7 calibrations on 8 Nov 2026: 62% vs 36%; closed-loop Target test: 100% on both, 2 testers). See [docs/replay-results-2026-11-08.json](docs/replay-results-2026-11-08.json). Phrases come from a pluggable source (`homeSource`) so the conversation engine can supply replies. **🗑 Clear** (top bar, or ☰ Done → 🏠 Home) clears the text and returns here. Benchmarks skip it. |
| Keyboard | `src/ui/keyboards.ts` | The VisualEyes keyboard has **16 targets in a 4×4 grid**: 4 prediction chips, 8 letter-group keys, delete, accept, phrases/expand, and done. The baseline is a dwell QWERTY. |
| Prediction | `src/predict/engine.ts` | Decodes ambiguous letter-group keys through a **key-sequence index** (one bucket lookup per key, ~0.4 ms), completes words, and predicts the next word from personal **trigram → bigram** context. Personal and global frequencies are blended, with the personal share growing as the user talks; personal words decay over 30 days; a suggestion picked and deleted within 2 s is ranked lower in that context. Keeps a **personal phrase store** that learns every sentence you speak or insert. **Abbreviation expansion** turns one key per word into a full sentence. |
| Profiles | `src/profile/profiles.ts` | Each user has separate words, phrases and calibration. A caregiver can add **people's names** (pinned, keep their capitals), an **about** note, and **writing samples** (pasted text or a .txt file) that give prediction a head start. Switch user by gaze from **☰ Done → 👤 Switch user**. Export/import a profile as JSON. All on-device. |
| Your data | `src/account/erase.ts` | Settings shows what is stored where, and **Delete my data** (a gaze target, with a confirmation) deletes the voice and resets the synced settings in the account when signed in, erases every key the app wrote on this computer, and signs out. Unit-tested against a store holding every kind of key the app writes. |
| Calgary help | `src/ui/local.ts`, `src/ui/screens.ts` | A gaze screen of **real Calgary and Alberta services** (ALS Society of Alberta, Health Link 811, AHS Home Care, Alberta Aids to Daily Living, Calgary Transit Access, Vecova adapted aquatics, the Cerebral Palsy Association in Alberta, Calgary Public Library Homebound Readers, Calgary 311). Each card **speaks a request** to the person in the room ("Please call the ALS Society of Alberta for me."), so the user asks and the partner calls or looks it up. Entries were checked against the organisations' own sites on 8 Nov 2026; no numbers are stored. Kept out of the way on purpose: open it from ☰ Done → Calgary help. |
| LLM (optional) | `server/llm.ts` | Claude via a local proxy with structured output. Live sentence chips use a fast model (`GAZETYPE_FAST_MODEL`, default `claude-haiku-5-5`, no thinking); the abbreviation-expansion panel uses `GAZETYPE_MODEL` (default `claude-opus-5-5`). The profile goes in a cached system block so suggestions match the user's style. Requests are debounced 150 ms, cancelled when the text changes, cached by typed text, and time out after 2.5 s (6 s for expansion). Only text is sent, never video. |
| Voice (optional) | `voice-sidecar/`, `src/voice/`, `src/ui/myVoice.ts` | **🗣 My voice** creates a voice from the user's own recordings (ElevenLabs, per user) and Speak uses it, falling back to the system voice. Put `ELEVENLABS_API_KEY` in `VisualEyes/.env`, then `npm run dev:voice`. See [voice-sidecar/README.md](voice-sidecar/README.md). `server/elevenlabs.ts` and [docs/ELEVENLABS_VOICE.md](docs/ELEVENLABS_VOICE.md) are an older single fixed voice and are not used by the app. |
| Metrics | `src/metrics/session.ts` | WPM ((T−1)/5), selections per character, minimum-string-distance error, and likely false selections (an undo within 2 s). |
| Overlay | `electron/main.mjs` | Transparent, click-through when collapsed, non-focusable so the target app keeps focus. Global shortcut, tray menu, and paste via the OS. |
| Voice | `src/input/voice.ts` | Vosk wasm with a fixed grammar ("gaze type", "open/hide keyboard", "read it out"). Works offline, and other speech can't trigger it. |
| Listening | `src/listen/partner.ts`, `src/listen/conversation.ts` | **Listen to the other person** (Settings, or the Listen chip in the top bar; off by default). The partner's speech is transcribed with the browser's speech recognition (Chrome and Edge; Chrome sends the microphone audio to Google to be transcribed, which the setting says). Each finished sentence goes to the AI as a **"reply"** task with the user's profile and the last few turns, and the replies (up to 5, in the user's voice) take over the home screen chips, marked "reply", so one glance answers. The panel shows what was heard. The microphone is muted while the app speaks and anything that matches what it just said is dropped as an echo. No audio is stored. |

### Recording and replaying sessions

Tracking changes are judged on recorded data, averaged over **all** recordings, not on one live run.

1. Start the **🎯 Pointer tracker** and press **● Record**. Use one Participant ID per person.
   - **Quick trial (~1.5 min):** 25-dot grid + 8 check dots. In pointer mode the check dots stay up 3.5 s so the 2 s dwell can be simulated.
   - **Target test (~1.5 min, closed loop):** after calibrating, the live pointer is visible and you steer it onto each highlighted button until the dwell selects something: all 6 buttons of the 3×2 layout, then 8 keys of the 4×4 grid including all four corners. It saves `gazetarget-pointer-<id>-<time>.json`, and the replay reports correct / wrong / timed out, corners, and time per selection. This is the number that matches real use; the check dots measure blind aiming.
   - **Full (~12 min):** adds 16 check dots and drift checks at +2, +5, +10 min. **Short:** 9 dots + 16 check dots, for strangers.
2. Every **◎ Calibrate** also downloads `gazecal-pointer-<id>-<time>.json` when "Save each calibration" is on in ⚙ Settings (default on). The calibration toast now also shows the **hit rate for 6 large buttons and for the 4×4 grid** on the check dots (or a warning to recalibrate if the face was lost on half the check dots). In pointer mode the 4 check dots stay up 3.5 s, so every calibration also gives dwell-simulation data.
3. Move the files to `VisualEyes/recordings/` (git-ignored) and run `npm run replay -- recordings/*.json` (`--json out.json` saves the rows). It rebuilds the features from the raw landmarks and fits **exactly the app's model** for each file's mode (pointer: yaw + pitch, straight-line ridge, λ=1, per-dot outlier trimming; eye: 7 features, ridge λ=1). Pointer recordings are also scored with the **original** 10-feature quadratic model, side by side, with a "beats original on N of M" count, so the model choice keeps being checked against data. It prints per recording and as a **mean per pointer mode**:
   - hit rates (4-chip, 6-chip, 16-grid), x/y offset, jitter, on the held-out check dots and drift checks;
   - a **dwell simulation** with main's cursor pipeline (pointer: smoothing, clamp, 10 px leash, off-screen cut-off) and 2 s dwell: correct / wrong / timed out.
   - Files recorded with the old eye-tracker mode are listed as skipped.

### Why a 4×4 grid of letter groups and not QWERTY

A webcam pointer can't hit a 26-key QWERTY on a laptop screen reliably; large targets work far better (recorded pointer sessions, open loop, 7 calibrations on 8 Nov 2026: 6 large buttons 62% of frames on target vs 16 keys 36%, so the app opens on 6 and keeps the 16-key grid one step away; in the closed-loop Target test both testers selected 6 of 6 and 8 of 8 correctly at a median 2.3 to 2.9 s per selection). Prediction makes up for the ambiguous keys: one key press per letter, and usually 1–3 presses before the word appears as a chip. See [docs/RESEARCH.md](docs/RESEARCH.md).

## Demo script (side-by-side)

1. **Calibrate** (about 25 s). Read out the measured error in degrees and the stated conditions.
2. Turn on **⏱ Benchmark**. Type the target sentence on the **VisualEyes** keyboard.
3. Toggle **Keyboard → Baseline QWERTY**. The same sentence stays loaded. Type it again.
4. Open **📊 Results**. Compare WPM, selections per character, error and false selections. **Export JSON** for the slide.
5. Type a sentence and speak it. Then start it again: it now comes back as a **phrase chip** after one word, so the store is learning.
6. Overlay: press `⌘⇧G` over Notes or Slack, type with the pointer, choose **☰ Done → 📋 Insert**, and the text appears in that app.

Let judges try it. Mouse mode (hover to dwell) runs the same UI and metrics with no camera.

> Before the demo, clear the results table (📊 → Clear). Runs from testing with instant clicks show unrealistic WPM.

## Honest limitations

- No disabled-user evaluation yet. Every number is from able-bodied testers unless stated otherwise. The 8 Nov 2026 numbers are from two people on one laptop; the raw recordings (about 10 MB each) are kept out of git and are available on request.
- Accuracy depends on lighting, glasses, camera and face pose. Report the conditions with every number.
- The degree figure assumes a screen size (in Settings) and an estimated viewing distance.
- The word list is the 30,000 most frequent English words from wordfreq (CC BY-SA 4.0, attribution in `public/data/WORDS-LICENSE.txt`). It replaced the research-only Google 10k list on 8 Nov 2026; on the held-out persona sentences (`npx tsx scripts/eval-suggestions.ts --local-only`) it needs fewer selections per character for every persona (for example 0.612 → 0.596 with no profile, 0.454 → 0.429 with one).
- English only for now. Multilingual support is on the roadmap.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md), the gap analysis + day plan in [docs/SATURDAY_PLAN.md](docs/SATURDAY_PLAN.md), the self-assessment in [docs/SCORECARD.md](docs/SCORECARD.md), expansion by user segment in [docs/USER_SEGMENTS.md](docs/USER_SEGMENTS.md), the own-voice (VoiceStudio) plan in [docs/VOICE_PLAN.md](docs/VOICE_PLAN.md), and modular keyboard layouts in [docs/LAYOUTS_PLAN.md](docs/LAYOUTS_PLAN.md).
