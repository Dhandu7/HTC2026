# Research notes behind the design

This is a condensed version of the team's market and technical research (compiled 4 Nov 2026), plus implementation notes. Figures are as the sources state them. Don't quote anything here on stage without its caveat.

## The gap

- Clinical eye-gaze devices pair software with a dedicated **infrared** tracker. A typical US price tier is about **$8,000–12,500** (QYResearch 2025). UK lists run £5,600–£7,950.
- Free options either still need a tracker (OptiKey), only move a cursor (GazePointer), or are libraries with region-level accuracy (naive WebGazer.js measured **10.3–13.6°** in a 2026 evaluation).
- Gaze typing usually runs **below 10 WPM**. One ALS user's measured baseline was **8.1 WPM** (SpeakFaster, *Nature Communications* 2024).
- LLM abbreviation expansion made text entry **29–60% faster** in two ALS eye-gaze users (SpeakFaster). That was measured on an IR Tobii keyboard, not a webcam.
- "Webcam + LLM" alone is **not novel**. 2026 hackathon prototypes such as GazeKeys and My Voice already combine it. What still stands out is **measured accuracy in degrees**, a **UI designed for 2–3° error**, **personalisation that works offline**, and **dwell-free selection with false-trigger rates reported**.

## Accuracy budget → UI

| Method | Error | Smallest reliable target at 60 cm |
|---|---|---|
| Research IR (EyeLink 1000) | 0.44–0.50° | ~0.5 cm |
| Best neural webcam (Labvanced; Kaduk et al. 2024) | 1.4–1.8° | ~1.5–1.9 cm |
| MediaPipe-based systems | ~1.1–3.0° | ~1.2–3.1 cm |
| Naive WebGazer.js | 10.3–13.6° | ~11–15 cm |

MediaPipe-landmark systems with per-user regression report **1.12° with head movement and 1.3° without** (Chhimpa et al., *IEEE Access* 2024, 5-point calibration, 13 participants). A geometric descriptor approach reports **under 1.9°** (arXiv 2401.00406). GazeType's pipeline follows that family: MediaPipe landmarks, blendshapes and head pose, then a regularised regression. We design for **3°** so the UI holds up for a typical implementation.

## Selection

- Dwell costs 500–1,000 ms per key, and expert users reach 200–300 ms. It also causes the **Midas touch** problem: anything you look at can be selected.
- Blink selection takes about 120 ms, but involuntary blinks trigger it falsely. GazeType asks for a **deliberate** blink: both eyes closed for 350–1500 ms after a 150 ms aim fixation. It **counts rejected blinks** so the false-trigger behaviour is measured.
- Other dwell-free work worth borrowing from: EyeSwipe's reverse crossing (Kurauchi et al., CHI 2016), robust dwell-free word inference (Liu et al. 2015), and Filteryedping.

## Prediction

- Incumbent devices use dictionary or n-gram prediction. **Per-user phrase learning** is barely shipped, even though AAC users repeat phrases heavily (SpeakFaster's Observer dataset has 5,000+ utterances from one user).
- GazeType ships **local** ambiguous-key decoding, a bigram model and a phrase store. The LLM is only an opt-in layer for sentence continuation and abbreviation expansion, and its output is validated locally.

## What would count as winning

1. Calibration in under 60 seconds, with a stated way of handling drift (implicit recalibration).
2. Measured gaze error in degrees, with the test conditions stated.
3. A **new user** composes sentences faster than on a dwell QWERTY baseline, in both WPM and selections per word.
4. Dwell-free selection, plus a phrase store that visibly learns during the demo.
5. Runs fully on-device, apart from an optional, clearly labelled LLM call.

## Sources (selected)

- SpeakFaster, Nature Communications 2024 — LLM abbreviation expansion, ALS users
- Chhimpa et al., IEEE Access 2024 — MediaPipe + regression, 1.12°/1.3° — https://doaj.org/article/21ad3ac72299486a9497a31f1eb60713
- MediaPipe 3D landmark gaze, <1.9° — https://www.arxiv.org/pdf/2401.00406
- NeuGaze (MediaPipe + LASSO) — https://arxiv.org/pdf/2504.15101
- Kurauchi et al., EyeSwipe, CHI 2016 — https://www.cs.bu.edu/fac/betke/papers/Kurauchi-etal-CHI-2016.pdf
- Kaduk et al. 2024 — webcam 1.4° vs EyeLink
- Labvanced webcam eye tracking 2.0 — 1.8° / 1.4° / 1.3°
- WebGazer 2026 systematic evaluation — 10.3–13.6°
- Casiez et al., One Euro filter, CHI 2012
- GazeKeys (Mar 2026), My Voice (LA Hacks 2026) — prior hackathon prototypes
