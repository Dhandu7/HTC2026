# Judge's scorecard (self-assessment)

An objective review of the build as of **Thu 5 Nov 2026** (commit `9d37c4d`). It scores what works today, not what's planned. Re-score after Saturday.

| Category | Score | Verdict |
|---|---|---|
| **Sustainability** | **6 / 10** | Strong on hardware and environmental footprint; weak on long-term viability. |
| **Accessibility** | **5 / 10** | The concept is excellent, but the build still assumes the user has hands. |
| **Technology** | **6.5 / 10** | The engineering approach is sound, but the core accuracy claim isn't proven yet. |
| **Overall** | **~6 / 10** | A solid prototype with an honest framing. Not ready to win yet. The Saturday plan could take it to 8+. |

## Sustainability: 6/10

**Strengths**
- **No new hardware.** It runs on a laptop the user already owns, instead of a $8–12k device with dedicated electronics. That's a real e-waste and cost argument.
- **Low compute.** Tracking ran on-device at ~31 fps with ~10 ms per frame on an M-series MacBook, with no GPU server. Measured in the live session.
- **No per-use cloud cost** by default. The LLM is optional, and the app works offline.
- **Maintainable code.** It's split into clear modules, has 22 unit tests, and is typed throughout. The README and research docs mean a new contributor could pick it up.

**Weaknesses**
- **No path to keeping it alive.** No LICENSE file, no named maintainer, and no funding or distribution model. A judge will ask who keeps this running after Sunday.
- **The word list is licensed for research and education only.** That's a legal blocker for any real deployment.
- **Old or deprecated dependencies.** vosk-browser dates from 2022 and uses ScriptProcessor, and MediaPipe is a single point of failure.
- **No clinical or partner pathway.** No speech therapist or ALS organisation is involved, and no plan to involve one is written down.

## Accessibility: 5/10

**Strengths**
- **Targets are sized for webcam error.** The 16 large targets come from the error budget, not from shrinking a desktop keyboard.
- **Prediction cuts the effort per sentence.** On the same sentence, GazeType took 12 selections against 24 on the baseline (synthetic clicks).
- **Several ways to select and open it:** dwell, deliberate blink, a voice command, and looking at a screen corner.
- **Honest framing.** Errors are reported in degrees, it's labelled "not a medical device", and video stays on-device.

**Critical failures**
1. **You can't start it hands-free.** "Start with camera", Settings, Benchmark, the keyboard toggle and Results are mouse-only and can't be selected by gaze. A user with locked-in syndrome can't get past the first screen without a caregiver. Escape-to-cancel calibration doesn't work in the overlay, because the window never gets keyboard focus.
2. **No pause or rest mode.** Anything the user looks at gets selected. They can't read a reply, watch TV or rest their eyes without typing by accident.
3. **No testing with disabled users,** and only one able-bodied person, once.
4. **Blink selection hasn't been tried with a real camera.** Its thresholds are guesses.
5. **Calibration assumes the user can follow a dot and keep their head still for about 25 seconds.** No alternative for nystagmus or unsteady heads, and no way for a caregiver to help.
6. **English only**, with the default system voice and no voice banking.
7. **Fatigue is never measured or managed.**

## Technology: 6.5/10

**Strengths**
- **The pipeline design is right:** on-device landmarks, features, a regression model, smoothing, target snapping, then dwell or blink selection. Each stage is separate and testable.
- **Accuracy is measured and reported the way the literature does it:** error in degrees, precision reported separately, assumptions shown on screen.
- **It recalibrates as you use it:** a selection you don't undo within 2 seconds becomes a new calibration sample.
- **Debugging was driven by data.** The 10.6° first run was replayed offline, and the root cause (face-position inputs given too much weight) was fixed on principle.
- **The LLM layer is sensible:** structured output, re-checked locally against what was typed, a timeout so typing never waits on it, and text only.

**Weaknesses**
- **The headline number is unproven.** The only live measurement is **10.6°**. The fix improved held-out error on that one recorded session to about 1.3°, but it hasn't been re-measured live.
- **Simple model.** Hand-picked features feed a quadratic ridge regression, with no appearance model and no head-pose normalisation. Vertical gaze is weak.
- **Limited novelty.** GazeKeys and My Voice (2026) already combine webcam, MediaPipe and an LLM. What's new here is the large-target layout plus honest measurement, and only if it's demonstrated.
- **Large untested surface:** Insert/paste, voice commands, the corner trigger and the LLM path have never run end to end.
- **No end-to-end tests,** and no session recorder for repeatable evaluation.

## What would move each score fastest

| Fix | Category | Score impact |
|---|---|---|
| Make the whole app gaze-operable (start, settings, calibration cancel) **plus a pause/rest target** | Accessibility | **+2** |
| Live accuracy under ~2° on 3+ people, with conditions stated | Technology | **+1.5** |
| One session with a real AAC user or a speech therapist (even 20 minutes) | Accessibility + Sustainability | **+1.5** |
| Benchmark results from non-developer users showing GazeType beats the baseline | Technology | **+1** |
| A license, an open word list, and a one-slide distribution plan | Sustainability | **+1** |
| Insert working in a real app on stage | Technology | **+0.5** |
