# Saturday plan: gaps in the prototype and how to close them

Written Thu 5 Nov 2026 after the first real-camera session. Ordered by impact on the demo.
Related: [SCORECARD.md](SCORECARD.md) (current grade: ~6/10) · [USER_SEGMENTS.md](USER_SEGMENTS.md) (who else this serves and how).

## Should we use SAM 3.1?

**No, not in the live tracking loop.** It could help offline.

SAM 3.1 (Meta, 27 Mar 2026) is a promptable segmentation and video-tracking model. The 3.1 update adds "Object Multiplex", which tracks many objects in one pass. Meta's headline numbers are about **32 fps on an H100**. That is the wrong tool for this job:

| | What we need | SAM 3.1 |
|---|---|---|
| Hardware | Any laptop CPU or iGPU, in a browser or Electron | Datacenter GPU for real time |
| Latency | < 30 ms per frame, total budget < 100 ms | Built for video segmentation, not 30 fps on a laptop |
| Output | Gaze direction or screen point | Masks. The iris boundary is already a MediaPipe landmark ring (469–477) |
| Privacy pitch | Fully on-device | Would mean a GPU server, which streams a disabled user's face off the device |
| Access | — | Weights are gated on Hugging Face |

Our error isn't really segmentation error. MediaPipe already finds the iris to within a pixel or two. The error comes from **mapping eye appearance to gaze** (vertical especially), from **head movement**, and from **calibration drift**. Better segmentation doesn't fix any of those.

**Where SAM 3.1 *could* earn a place (offline, optional):**
- **Labelling tool:** run it on recorded calibration videos to get pupil and eyelid masks. That would tell us how accurate MediaPipe's iris landmarks are under glasses, droopy lids and low light, and give eye-crop training data.
- **Eyelid-occlusion research:** masks give a better "eye openness" signal than landmark distances, which matters for ptosis (droopy eyelids, common in ALS and myasthenia). That's a post-hackathon idea.

**What to use instead for accuracy: an appearance-based gaze model that runs in the browser.**
- **WebEyeTrack / BlazeGaze** ([paper](https://www.emergentmind.com/papers/2508.19544), MIT, TF.js). A tiny CNN (about 0.2–0.7 M parameters) with MAML few-shot personalization from **about 9 calibration samples**, on-device. Reported about 2.3 cm error on GazeCapture. That is the closest drop-in match for our architecture: MediaPipe goes in, gaze comes out, and calibration personalises it.
- **EyeTheia** ([arXiv 2601.06279](https://arxiv.org/abs/2601.06279v1), code public). An iTracker-style CNN on MediaPipe crops, trained on MPIIFaceGaze, built for laptop webcams, with per-user fine-tuning. A good second candidate. Check the license and the export format on Saturday.

**Decision rule:** keep the current landmark + ridge pipeline as the fallback. Add BlazeGaze as a second gaze source behind the same `GazeEngine` interface. Use whichever wins on **held-out error measured on the same recorded sessions** (see Block 1). Don't switch on vibes.

---

## Gaps in the current implementation

Severity: 🔴 hurts the demo, 🟠 a judge could poke at it, 🟢 polish or later.

### Accessibility (from the scorecard; these cost the most points)
A1. 🔴 **Not hands-free.** Start, Settings, Benchmark, Results and the keyboard toggle are mouse-only. A locked-in user can't start the app without a caregiver. → Make every screen gaze-operable: a gaze "Start" target, a gaze settings panel (dwell +/−, access mode, recalibrate), and a gaze cancel for calibration.
A2. 🔴 **No pause or rest mode.** Anything the user looks at gets selected, so they can't read, watch TV or rest. → A persistent "⏸ Pause" target. Resume by holding gaze for 2 s on the 👁 badge, or with a long blink.
A3. 🔴 **No emergency call.** → A "🔔 Call" target that plays a loud alert. A phone notification can come later.
A4. 🟠 **2D gaze only.** Classic locked-in users may move their eyes only vertically. → A vertical-only access mode (one column of rows, up/down + blink). See USER_SEGMENTS §3.
A5. 🟠 **Calibration is rigid.** It's fixed-pace and needs a still head. → A caregiver-paced mode (click to advance), redo of single points, and a calibration-free quadrant board for ICU and bedside use.
A6. 🟠 **System voice only, English only.** → Hook up a personal or cloned voice (stretch). Add one more language post-hackathon.

### Sustainability (from the scorecard)
S1. 🟠 **No LICENSE, maintainer or distribution plan.** → Pick a license (MIT or Apache-2.0 are the usual for this) and add one slide: "free home-trial and bridge device, distributed through ALS associations and speech therapists".
S2. 🟠 **The word list is licensed for research only.** → Swap in an openly licensed frequency list (check the data license) before any public release.

### Tracking and accuracy
1. 🔴 **Validated on one person, once, before the fix.** The first session showed 10.6°. Re-scoring that same data offline with the fixed features gives about 61 px (~1.3°) of error on held-out points. No live re-validation yet.
2. 🔴 **Hand-crafted features + quadratic ridge regression.** There's no appearance model, so vertical gaze is weak (a webcam sees little vertical iris movement). → An appearance-based model (BlazeGaze), or eye-crop features added to the ridge.
3. 🔴 **Head-movement sensitivity.** Yaw and pitch are linear inputs, and there's no eye-patch normalization. Head position is now *captured* (`headPos`) but unused. → Warn when the head moves more than X from the calibration pose. Normalise eye crops for head pose, the standard ETH-XGaze/MPII approach.
4. 🟠 **Calibration is thin.** 9 points for training and 4 interior points for validation, with no per-region error map and no check of quality as the points are collected. → Show per-point error after validation, re-collect bad points automatically, and add an edge-validation point for the chip row.
5. 🟠 **Implicit recalibration can poison itself.** A wrong selection that isn't undone becomes a training sample. → Only accept samples whose fixation was stable (low dispersion) and near the target centre. Cap their influence, and fall back to full recalibration when the residuals grow.
6. 🟠 **The degree figure rests on assumptions.** It uses a 60° FOV and a 14" screen by default. → One-time "credit card on screen" step for the screen size, and an FOV preset per camera.
7. 🟢 No confidence indicator, no glasses mode, no low-light warning.

### Selection
8. 🔴 **Dwell and blink thresholds are untuned on real people.** Blink selection hasn't been tried with a camera at all. → A tuning session on 3+ people, logging rejected blinks and false selections.
9. 🟠 **The dwell is fixed.** → Adaptive dwell: shorter on chips the engine is confident about, longer right after an undo.
10. 🟠 **Escape can't cancel calibration in the overlay.** The window is non-focusable, so it never gets key events. → Add a gaze or click "cancel" target, or briefly make the window focusable during calibration.
11. 🟢 No saccade or crossing selection, which would be the fastest dwell-free option for chips.

### Prediction and UI
12. 🟠 **The letter groups are T9 groups, not optimised.** Ambiguous pairs like if/he and good/home cost extra selections. → An offline script that picks the 8 groups that minimise expected selections on our corpus.
13. 🟠 **The language model is thin.** It's a 10k-word unigram list (research-only licence), plus bigrams learned only from the user. → Add a small open bigram corpus, and swap the word list before any commercial use.
14. 🟠 **LLM path never exercised live.** No API key run yet, and latency unmeasured. → Run with a key, log p50/p95 latency, and decide between Opus at low effort and Haiku.
15. 🟠 **Phrase panel limits.** It shows 6 items with no paging, no categories, and no way to edit the store. → Paging, categories (needs / people / feelings), and a caregiver editor.
16. 🟢 Spell mode is two steps per letter. English only.

### Overlay (Electron)
17. 🔴 **Insert/paste untested.** It needs Accessibility permission, and it overwrites the user's clipboard. → Test on Notes and Slack, and restore the clipboard afterwards.
18. 🟠 **Voice command untested.** The model isn't downloaded, and vosk-browser is from 2022 and uses the deprecated ScriptProcessor. → Test it, or swap in the Web Speech API for the demo and keep Vosk for offline use.
19. 🟠 **The hot corner may clash** with macOS hot corners and the menu bar, and it's untested with real gaze.
20. 🟠 **Primary display only.** No packaging (electron-builder), no CSP, dev mode only.

### Evaluation (where we win or lose against judges)
21. 🔴 **Benchmark numbers so far come from synthetic clicks.** We have no data from real users.
22. 🔴 **No session recorder.** Only the calibration samples persist, so we can't replay a session offline to compare models.
23. 🟠 **No written protocol or consent note** for the people who test it.

---

## Saturday schedule (about 10 hours)

Split three ways if there are three of us: **Tracking**, **Typing UX**, **Demo/Overlay**. Merge every 2 hours.

### Block 0 · 09:00–09:30 · Setup (everyone)
- `git pull && npm install && npm run setup -- --voice`
- One person runs calibration on 2 laptops to confirm the post-fix error. Write the numbers on the board.

### Block 1 · 09:30–11:00 · Measurement first + hands-free (A1–A3)
- **Tracking:** build a **session recorder** that saves per-frame features, head pose, blinks and the shown target to JSON. Never save video, only numbers. Add a `scripts/eval-gaze.ts` that replays recordings through any `GazeSource` and prints leave-one-point-out error in px and degrees, overall and per screen region. (The offline CV script used Thursday is the seed for this.)
- **Typing UX:** **A1–A3 first.** Gaze-operable start/settings/cancel, the ⏸ Pause target, and the 🔔 Call target. Then a test protocol of 3 sentences per keyboard with order counterbalanced, plus a short consent note, then a results CSV export.
- **Demo:** write the 90-second demo script and slide skeleton. Capture the honest-limitations slide.

### Block 2 · 11:00–13:30 · Accuracy upgrade (Tracking lead)
1. Head-movement guard: compare `headPos` to the calibration mean, show a "move back to centre" hint, and pause selection beyond a threshold.
2. Calibration quality: show per-point error and re-collect any point above 2× the median. Add stable-fixation filtering to implicit recalibration.
3. Try **BlazeGaze/WebEyeTrack** as `GazeSource #2` (TF.js in a worker). Score it with `eval-gaze` on the morning's recordings. **Keep it only if it beats ridge on held-out error.**
4. If time remains: eye-crop pixel features (a downsampled 16×8 grey patch per eye) fed into the ridge as a cheap appearance signal.

### Block 2 (parallel) · Typing UX lead
1. Modular layouts, steps 1–5 of [LAYOUTS_PLAN.md](LAYOUTS_PLAN.md): layouts as data, plus Colemak/Dvorak/ABC as familiarity options. Then step 6: optimise the letter groups offline (`scripts/optimize-groups.ts`) and A/B them against T9 in the benchmark.
2. Adaptive dwell and phrase paging/categories.
3. Exercise the LLM with a key, record its latency, and pick a model.

### Block 2 (parallel) · Demo/Overlay lead
1. Test Insert on Notes and Slack, and restore the clipboard after pasting.
2. Calibration cancel target, and make the window focusable during calibration.
3. Test voice and the hot corner. Drop whichever one is flaky from the live demo and keep it on the slide.

### Block 3 · 14:00–16:30 · Real users
- Run **at least 3 people who aren't developers**, with and without glasses, through calibration and the benchmark on both keyboards, in the venue lighting.
- Tune the dwell and blink thresholds from their data. Record false selections and rejected blinks.
- Fix the top 3 issues they hit.

### Block 4 · 16:30–18:30 · Demo hardening
- Clear the results table. Pre-seed the demo persona's phrases.
- Rehearse the live side-by-side twice, with a fallback video recorded in case the venue Wi-Fi or lighting fails.
- Final slide numbers: measured degrees (with conditions), WPM and selections per character vs the baseline, false-selection rate, n users.

### Stretch (only if everything above is done), in order
1. **Vertical-only access mode (A4).** The strongest "same app, different user" demo moment.
2. **Calibration-free ICU needs board:** Pain · Suction · Reposition · Family · Yes · No, plus a 0–10 pain scale.
3. Personal/cloned voice for Speak via VoiceStudio. See [VOICE_PLAN.md](VOICE_PLAN.md). Steps 1–5 (~3 h) are the demoable core.
4. Caregiver console mock (QR-paired phone page), as a slide if it isn't built.
5. A second language lexicon. Packaged `.app` build.

## Definition of done for Saturday
- [ ] A user can go from launch to a spoken sentence **without touching the mouse or keyboard** (A1), and can pause and resume by gaze (A2).
- [ ] Post-fix calibration error measured on 3+ people, reported in degrees with the conditions.
- [ ] Replayable session recordings + `eval-gaze` script; model choice backed by held-out numbers.
- [ ] GazeType beats the baseline on selections per character *and* WPM for non-developer users. Show it even if the WPM gap is small, and say so.
- [ ] Insert works in at least one real app on stage.
- [ ] Honest-limitations slide: able-bodied testers only, lighting conditions, n.
- [ ] Re-score with SCORECARD.md. Target 8/10.
