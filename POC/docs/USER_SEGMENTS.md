# Expanding GazeType by user segment

Research compiled 5 Nov 2026. For each segment: what's different about these users, where the current build fails them, and what to build. Evidence is cited, and thin evidence is labelled as thin.

**Summary.** "People who can't use their hands or voice" covers at least six different user groups with conflicting needs. ALS users want speed and their own voice. Locked-in users may only move their eyes **vertically**. ICU patients can't tolerate calibration at all. Children with cerebral palsy have involuntary head movement and may not read yet. The current build serves one of these (literate adults with stable heads and full 2D eye control), and only partly. The biggest expansion opportunities:
1. Treat **access modes** as a first-class setting. The same app should run 2D gaze, vertical-only gaze, blink-only, or gaze + switch.
2. Add a **calibration-free "needs board"** for ICU and bedside use.
3. Add **symbol-based vocabularies** for pre-literate and aphasic users.

---

## Segment map

| Segment | Size signal | Eye control | Literacy | Calibration tolerance | Fit today | Priority |
|---|---|---|---|---|---|---|
| **ALS / MND** | ~16.5k prevalent US; 80–95% lose speech | 2D, but **declines late**; ptosis and fatigue | Literate adults | Good early, poor late | 🟡 partial | **P0: primary pitch** |
| **ICU, ventilated** | Large and recurring (every ICU) | Present but **arousal fluctuates**; lying down | Mixed, often impaired by sedation | **Very low** | 🔴 poor | **P1: best buyer** |
| **Locked-in (brainstem stroke)** | Rare; ~25% of LIS cases are stroke | **Often vertical-only + blinks** in classic LIS | Literate adults | Moderate | 🔴 UI needs 2D | **P1: small effort, big story** |
| **Cerebral palsy (dyskinetic), children** | ~17M CP worldwide; 25–35% severe speech impairment | 2D, **involuntary head movement** | Often pre-literate | Low | 🔴 poor | P2 |
| **Rett syndrome** | Rare, mostly girls; gaze is the main way they express themselves | 2D, apraxia | Mostly pre-literate | Low | 🔴 poor | P2 |
| **Post-stroke aphasia** | ~795k US strokes/yr; 20–40% have speech impairment | Usually hands available | **Language impaired** | — | 🔴 text-based UI is wrong | P3 (gaze is rarely the bottleneck) |
| **Low- and middle-income countries (all of the above)** | Access is as low as ~3% in some countries | Varies | Local languages | Varies | 🔴 English, laptop-only | **P1 for the impact story** |
| **Caregivers / speech therapists (secondary users)** | Every deployment | n/a | n/a | n/a | 🔴 no tools for them | **P0: unblocks every segment** |

---

## 1. ALS / MND (primary segment)

**What's different**
- Eye movement is usually preserved longest, which is why eye-tracking speech devices are the standard prescription. But eye control **can decline in late stages**: tracking becomes unreliable, and some users stop using their device altogether. Some progress to a completely locked-in state ([Peters et al., *Front. Hum. Neurosci.* 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7715037)).
- **Voice identity matters.** Banking or cloning the user's voice before it's lost is now practical. Apple Personal Voice is free but limited to newer iOS devices, and few iOS eye-gaze devices support it ([ALS Association webinar](https://www.als.org/sites/default/files/2024-05/CS%20Webinar_%20Voice%20Preservation_%205.20.24.pdf)). ElevenLabs and Bridging Voice offer cloning for ALS patients, and one ALS clinic source says about a minute of audio is enough.
- Conversation is the main use, and phrases repeat heavily. SpeakFaster's Observer dataset holds 5,000+ utterances from one user.

**Gaps in the current build**
- System TTS voice only. No personal voice.
- It doesn't adapt as the disease progresses: same dwell time, same 16 targets, same 2D requirement for ever.
- No pause target, so the user can't watch TV or read without typing by accident.
- No way to reach a caregiver in an emergency.

**Build**
- **Personal voice:** let the user import a cloned or banked voice (ElevenLabs API, or a local voice model) and use it for **Speak**. Keep the system voice as an offline fallback.
- **Progression-aware access:** track the user's selection error and fatigue over weeks. Suggest a larger dwell, fewer targets (3×3) or a blink-only mode when performance drops. Show the trend to their speech therapist.
- **Hand off to a brain-computer interface (BCI):** keep the selection layer independent of the input, so a BCI selector (EEG/SSVEP) can replace gaze later. Same keyboard, new input.
- **Conversation mode:** the LLM proposes *replies* to what the partner just said (using speech-to-text on the partner's voice). This was SpeakFaster's biggest win.
- **Emergency target:** a persistent "🔔 Call" target that plays a loud alert and/or sends a phone notification.

## 2. ICU, mechanically ventilated patients (best buyer)

**What's different**
- Intubated patients are awake but can't speak. Hospitals currently use writing boards. Two **2026 registered trials** test eye-tracking tablets for this population: [NCT07251530](https://clinicaltrials.gov/study/NCT07251530) in France (60 patients) and [NCT07205419](https://tundraspace.com/directory/studies/nct07205419) (a randomized feasibility trial against traditional AAC). That's clear demand, and the results aren't in yet.
- Earlier work (n=44) found that **fluctuating arousal** made eye gaze hard to detect ([Research Square preprint](https://www.researchsquare.com/article/rs-1644919/v2)). A 2025 review concluded that eye-tracking devices can meaningfully improve communication ([Cyprus J Med Sci](https://cyprusjmedsci.com/articles/doi/cjms.2025.2025-28)).
- Patients lie down, use is short-term, a nurse operates it, and the hardware has to be cleanable. The buyer is the **hospital**, not the patient. That gives a procurement path for sustainability.

**Gaps in the current build**
- It needs a 25-second, 13-point calibration with a still head. ICU patients can't do that.
- 16 text targets are too many for a sedated patient. There's no pain scale.

**Build**
- **Calibration-free needs board:** 4–6 huge quadrant targets (Pain · Suction · Reposition · Family · Yes · No) that work from **head pose + rough gaze direction alone**, with no calibration. Our regression can fall back to a pre-trained population model, and the quadrant error budget is ~10°+, which matches what we have *uncalibrated*.
- **Pain scale (0–10)** and a body map ("where does it hurt?") as two-step gaze choices.
- **Nurse mode:** start in one tap, support a tablet mounted at an angle over the bed, show big text the nurse can read from the doorway, keep a timestamped log (with consent) in the patient's notes.
- **Multilingual by default:** ICU patients often don't speak the staff's language.

## 3. Locked-in syndrome from brainstem stroke (small effort, big story)

**What's different**
- In **classic locked-in syndrome**, voluntary **vertical** eye movement and blinking are often the *only* preserved movements. Horizontal gaze may be lost. ALS causes ~55% of LIS and brainstem stroke ~25% (Pels et al. 2019, cited in the market research).

**Gaps in the current build**
- The 4×4 grid needs 2D gaze, so a user with vertical-only movement can't reach a whole column of keys.

**Build**
- **Vertical-only mode:** a single column of 3–5 large rows. Look up or down to move a highlight, and blink to select. Or use row/column scanning: the rows highlight automatically, and the user looks up to pick the current one.
- **Blink-code mode:** yes = one long blink, no = two blinks, plus a partner-assisted alphabet ("blink when I say the letter"). The app reads the alphabet aloud and records the blinks.
- This reuses the selection and prediction engine. Only the layout and input mapping are new, so it's a strong judge moment ("here's the same app for someone who can only look up").

## 4. Children with dyskinetic cerebral palsy

**What's different**
- **Involuntary head movement** breaks trackers that assume a stable head. Approaches that work: head-movement prediction plus fixation smoothing ([AAAI 2024 student abstract](https://ojs.aaai.org/index.php/AAAI/article/view/30519)), **slower, user-paced calibration**, and calibrating only part of the screen ([PrAACtical AAC](https://praacticalaac.org/praactical/aac-assessment-corner-with-vicki-clarke-the-eyes-have-it-assessment-considerations-for-high-tech-eye-gaze-access-2/)).
- A pilot with 5 children (mean age ~4) showed gains in goals and performance. Parents valued **written set-up and calibration guides** ([Karlsson et al. 2018](https://read.qxmd.com/read/30252561/eyes-on-communication-trialling-eye-gaze-control-technology-in-young-children-with-dyskinetic-cerebral-palsy)).
- Accuracy and calibration demands can be an "entry barrier" for some children.
- Many of these children can't read yet, so they need **symbols**, not letter groups.

**Gaps in the current build**
- The fixed 650 ms-per-point calibration with a "keep your head still" instruction.
- A text-only vocabulary.
- No motivation or learning path.

**Build**
- **Caregiver-paced, playful calibration:** animated targets (an animal that pops when looked at). The caregiver advances points with a click, and points can be re-done individually.
- **Head-motion-tolerant tracking:** use the `headPos` already captured. Predict head motion, stretch the snap radius while the head moves, and hold selection until it's still again.
- **Symbol boards:** a grid of images (open symbol sets such as ARASAAC or Mulberry) sized to the child's measured accuracy, with a "core vocabulary" layout.
- **Learning games:** cause-and-effect games, where looking makes something happen, build gaze control before communication.

## 5. Rett syndrome

**What's different**
- Eye gaze is the main way people with Rett express themselves. In a Dutch survey of 63 families, 20 had used eye gaze and 28 more wanted to try it. 11 systems were funded after trials. Families wanted **more training and support** than they got ([Townend et al. 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC4785214/)).
- All 4 participants in a case study improved on their goals ([Vessoyan et al. 2018](https://scite.ai/authors/kelli-vessoyan-LpJ8DE)). The evidence is small and mostly descriptive. Researchers caution that a *fixation* isn't necessarily a deliberate choice.

**Build**
- **Choice-making boards** (2–4 photos), plus an **intent check**: hold, then confirm, to separate a choice from passive looking.
- **Progress reports for therapists:** accuracy and response time per session, shareable with consent.
- Low cost matters: families want to keep using the system long-term but run into cost barriers.

## 6. Post-stroke aphasia (low priority for gaze)

**What's different**
- The impairment is in **language**, not motor control. Most people with aphasia can use their hands. AAC is recommended from early recovery onwards ([MedStar](https://www.medstarhealth.org/services/augmentative-alternative-communication-aac)), with low-tech support and family training before discharge. Inpatient AAC trials are still in progress.

**Implication**
- Letter-group typing with word prediction is the wrong interface. If we serve this segment, it's via photo or symbol boards and scripted phrases, often with touch rather than gaze. **Leave it out of the hackathon pitch** and don't claim to serve it.

## 7. Low- and middle-income countries

**What's different**
- Gaze-based AAC rarely reaches low-resource settings. Access is as low as ~3% in some countries, and a Tobii PCEye camera alone costs ~£2,000 ([UCL / Ghana study](https://discovery.ucl.ac.uk/id/eprint/10210053)).
- **The key lesson: cost alone doesn't solve it.** Google's free **Look to Speak** was tested in Ghana with 15 clients and 10 therapists, and it "largely failed to deliver substantial communication benefits". The barriers were unintended selections when users preferred touch, **poor postural support**, **cognitive demands** (6 of 15 clients unsuitable), and **therapists with little gaze-AAC training** ([Disability Innovation Hub](https://www.disabilityinnovation.com/publications/exploring-the-usability-of-gaze-based-mobile-communication-in-ghana)). Secondary sources add English-only output and culturally irrelevant default content.
- Experts call for low-tech AAC that can be built and taught locally.
- Low-cost Android phones are widespread. Laptops are not.

**Build**
- **Android / phone version** (the same engine runs in a mobile browser, or wrap it with Capacitor). Look to Speak proves phone-gaze is possible. We'd differentiate on prediction and measured accuracy.
- **Local languages:** lexicon, phrases and TTS per language. Start with one where a partner exists (Twi, Hindi or Swahili).
- **Mixed access:** let users with some hand control touch as well, so touch and gaze don't fight each other (a Look to Speak failure).
- **Printable low-tech twin:** a paper board that mirrors the app layout, for power cuts, and so families learn one layout.
- **Therapist training pack:** a 1-page assessment checklist ("is gaze the right access method?") plus set-up and posture guidance.

## 8. Caregivers and speech therapists (secondary users)

Every segment above depends on someone setting the system up. Look to Speak's settings still need touch. Rett and CP families say support matters as much as the device. The market research notes that **device abandonment falls from 20–30% to 5–8% with telehealth assessment and home trials**.

**Build**
- **Caregiver console** (a phone web page, paired by QR code): edit phrases and categories, change dwell and access mode, start calibration remotely, see a fatigue and accuracy trend.
- **Trial kit:** GazeType as a free **home-trial and bridge device** while families wait for a funded clinical device. This is our most defensible market position, and it doesn't compete head-on with Tobii.

---

## Cross-cutting features (ranked)

| # | Feature | Segments helped | Effort | Hackathon? |
|---|---|---|---|---|
| 1 | **Fully gaze-operable app + pause/rest target** | All | S | ✅ Saturday |
| 2 | **Access modes:** 2D gaze · vertical-only · blink-code · gaze+switch | LIS, late ALS, CP | M | ✅ vertical-only demo |
| 3 | **Calibration-free needs board** (quadrants, pain scale) | ICU, late ALS, children | S–M | ✅ stretch |
| 4 | **Emergency "call" target** | ALS, LIS, ICU | S | ✅ |
| 5 | **Head-motion guard** (pause + hint) | CP, ICU, everyone | S | ✅ (already in the plan) |
| 6 | **Personal voice** (cloned or banked) | ALS | S (API) / M (local) | 🟡 if there's time |
| 7 | **Symbol boards** (ARASAAC) | CP, Rett, aphasia, ICU | M | ❌ post-hackathon |
| 8 | **Caregiver console** (QR-paired phone page) | All | M | ❌ post (mock it on a slide) |
| 9 | **Conversation-reply LLM** (listens to the partner) | ALS | M | ❌ post |
| 10 | **Android/phone build + local languages** | LMIC | M–L | ❌ post |
| 11 | **Progression and fatigue analytics for therapists** | ALS, Rett | M | ❌ post |
| 12 | **BCI-ready selector interface** | Late ALS, complete LIS | L | ❌ architecture note only |

## Recommended pitch positioning

> **GazeType is a free, webcam-only communication aid for adults with ALS and locked-in syndrome. Families can use it at home today while they wait for a funded clinical device. It also runs as a calibration-free bedside board for ventilated ICU patients.**

- The **primary user** is literate adults with ALS or locked-in syndrome. That's where the evidence (SpeakFaster) and our design (prediction-first) line up.
- **Expansion 1:** ICU bedside board. Hospitals are the buyer, and two 2026 trials show demand.
- **Expansion 2:** low- and middle-income countries via a phone build. Lead with the Look to Speak lessons to show we know cost alone doesn't solve it.
- **Explicitly out of scope:** aphasia (wrong interface) and pre-literate children (needs symbol boards, which we'll name as future work).
