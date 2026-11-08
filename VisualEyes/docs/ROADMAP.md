# Roadmap (hackathon iteration list)

Ordered by demo impact per hour.

## Before the demo
- [ ] Test calibration on 3+ people, with and without glasses, in the venue lighting. Record the degrees.
- [ ] Tune `dwellMs` and the blink thresholds on a new user. Record rejected-blink counts.
- [ ] Run each benchmark sentence on both keyboards with a person who isn't the developer. Export the JSON for the slide.
- [ ] Pre-seed the phrase store with the demo persona's phrases (call `learn()` from the console for now; a seed-phrases editor is a TODO).

## Accuracy
- [ ] Head-pose compensation: re-centre the features on a neutral pose captured at calibration.
- [ ] Per-eye regressors, weighted by eye openness (helps droopy eyelids).
- [ ] Small MLP or kernel ridge instead of the quadratic ridge, if there's enough data.
- [ ] Show a live confidence indicator and auto-prompt recalibration when the implicit samples disagree with the model.

## Speed
- [ ] Optimise the letter grouping for this lexicon (minimise ambiguity) instead of using T9 groups.
- [ ] Use SpeakFaster-style initials mode as the default when an LLM is available.
- [ ] Adaptive dwell: shorten the dwell for chips the engine is confident about, lengthen it after an undo.
- [ ] Saccade-crossing selection for chips: glance off the far edge to confirm.

## Product
- [ ] Multilingual lexicons and TTS voices (Hindi, Spanish first).
- [ ] Caregiver mode: big "yes / no / pain / help" board that one gaze opens.
- [ ] A local small model (Gemma or Phi on WebGPU) so the LLM also works offline.
- [ ] Package signed builds (electron-builder) with the camera and accessibility entitlements.
